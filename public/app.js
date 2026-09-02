/** 画面。依存なし。データはすべて /api/* 経由で読み書きする */

const $ = (id) => document.getElementById(id);
const login = $("login");
const app = $("app");
const list = $("tasks");

let tasks = [];
let showDone = false;

/** APIを叩く。未認証ならログイン画面へ戻す */
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw new Error(error || `HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

function showLogin() {
  login.hidden = false;
  app.hidden = true;
  $("password").focus();
}

function showApp() {
  login.hidden = true;
  app.hidden = false;
}

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD

function formatDue(due) {
  if (!due) return "";
  const diff = Math.round((new Date(due) - new Date(today())) / 86400000);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  if (diff === -1) return "昨日";
  const [, month, day] = due.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function render() {
  const visible = tasks.filter((task) => showDone || !task.done);
  list.replaceChildren(...visible.map(row));
  $("empty").hidden = visible.length > 0;
  $("toggle-done").textContent = showDone ? "完了したものを隠す" : "完了したものを表示";
}

function row(task) {
  const li = document.createElement("li");
  li.className = task.done ? "done" : "";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = task.done;
  check.ariaLabel = "完了";
  check.addEventListener("change", () => setDone(task, check.checked));

  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = task.title;
  body.append(title);

  if (task.due) {
    const due = document.createElement("span");
    due.className = "due" + (!task.done && task.due < today() ? " overdue" : "");
    due.textContent = formatDue(task.due);
    body.append(document.createElement("br"), due);
  }

  const remove = document.createElement("button");
  remove.className = "delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.ariaLabel = "削除";
  remove.addEventListener("click", () => remove_(task));

  li.append(check, body, remove);
  return li;
}

async function load() {
  const { tasks: fetched } = await api(`/tasks?status=${showDone ? "all" : "open"}`);
  tasks = fetched;
  render();
}

/** 完了のトグルは先に画面を書き換え、失敗したら戻す */
async function setDone(task, done) {
  const before = task.done;
  task.done = done;
  render();
  try {
    await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done }) });
    if (!showDone && done) await load();
  } catch {
    task.done = before;
    render();
  }
}

async function remove_(task) {
  const index = tasks.indexOf(task);
  tasks.splice(index, 1);
  render();
  try {
    await api(`/tasks/${task.id}`, { method: "DELETE" });
  } catch {
    tasks.splice(index, 0, task);
    render();
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("login-error");
  error.hidden = true;
  try {
    await api("/login", {
      method: "POST",
      body: JSON.stringify({ password: $("password").value }),
    });
    $("password").value = "";
    showApp();
    await load();
  } catch (caught) {
    error.textContent = caught.message === "unauthorized" ? "パスワードが違います" : caught.message;
    error.hidden = false;
  }
});

$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = $("title").value.trim();
  if (!title) return;
  const due = $("due").value || null;
  $("title").value = "";
  $("due").value = "";
  await api("/tasks", { method: "POST", body: JSON.stringify({ title, due }) });
  await load();
});

$("toggle-done").addEventListener("click", async () => {
  showDone = !showDone;
  await load();
});

$("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  showLogin();
});

// クッキーが生きていればそのまま一覧へ、切れていればログイン画面へ
load().then(showApp).catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
