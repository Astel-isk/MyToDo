/** 画面。依存なし。データはすべて /api/* 経由で読み書きする */

const $ = (id) => document.getElementById(id);
const login = $("login");
const app = $("app");
const listRoot = $("list");

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

// --- 期限の扱い -------------------------------------------------------------

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const daysFromToday = (due) => Math.round((new Date(due) - new Date(today())) / 86400000);

/** 一覧を「いつやるか」で区分けする。並べ替えの順序はサーバ側と揃えてある */
const GROUPS = ["期限切れ", "今日", "明日", "今週", "この先", "期限なし", "完了"];

function groupOf(task) {
  if (task.done) return "完了";
  if (!task.due) return "期限なし";
  const days = daysFromToday(task.due);
  if (days < 0) return "期限切れ";
  if (days === 0) return "今日";
  if (days === 1) return "明日";
  if (days <= 7) return "今週";
  return "この先";
}

/** 区分けの中では、日付そのものは補助情報なので短く出す */
function dueLabel(task) {
  if (!task.due) return "";
  const days = daysFromToday(task.due);
  if (days === 0 || days === 1) return ""; // 「今日」「明日」の見出しと重複する
  const [, month, day] = task.due.split("-");
  const date = `${Number(month)}/${Number(day)}`;
  if (days < 0 && !task.done) return `${date}(${-days}日超過)`;
  return date;
}

// --- 描画 -------------------------------------------------------------------

function render() {
  const visible = tasks.filter((task) => showDone || !task.done);
  $("empty").hidden = visible.length > 0;

  const sections = GROUPS.map((name) => [name, visible.filter((t) => groupOf(t) === name)])
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => section(name, items));

  listRoot.replaceChildren(...sections);
  $("toggle-done").setAttribute("aria-pressed", String(showDone));
}

function section(name, items) {
  const wrapper = document.createElement("section");
  wrapper.className = "group" + (name === "期限切れ" ? " overdue" : "");

  const heading = document.createElement("h2");
  heading.textContent = `${name}(${items.length})`;

  const ul = document.createElement("ul");
  ul.append(...items.map(row));

  wrapper.append(heading, ul);
  return wrapper;
}

function row(task) {
  const li = document.createElement("li");
  li.className = task.done ? "done" : "";
  li.dataset.id = task.id;

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = task.done;
  check.ariaLabel = `${task.title} を完了にする`;
  check.addEventListener("change", () => setDone(task, check.checked, li));

  const body = document.createElement("div");
  body.className = "body";
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = task.title;
  body.append(title);

  const detail = [dueLabel(task), task.note].filter(Boolean).join(" ・ ");
  if (detail) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = detail;
    body.append(note);
  }

  const remove = document.createElement("button");
  remove.className = "delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.ariaLabel = `${task.title} を削除`;
  remove.addEventListener("click", () => removeTask(task, li));

  li.append(check, body, remove);
  return li;
}

// --- 操作 -------------------------------------------------------------------

async function load() {
  const { tasks: fetched } = await api(`/tasks?status=${showDone ? "all" : "open"}`);
  tasks = fetched;
  render();
}

/** 一覧から消える操作は、消えることを見せてから作り直す */
const fadeOut = (li) =>
  new Promise((resolve) => {
    li.classList.add("leaving");
    setTimeout(resolve, 180);
  });

async function setDone(task, done, li) {
  const before = task.done;
  task.done = done;
  const leaving = !showDone && done;
  if (leaving) await fadeOut(li);

  try {
    await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done }) });
    await load();
  } catch {
    task.done = before;
    render();
  }
}

async function removeTask(task, li) {
  const index = tasks.indexOf(task);
  await fadeOut(li);
  tasks.splice(index, 1);
  render();
  try {
    await api(`/tasks/${task.id}`, { method: "DELETE" });
  } catch {
    tasks.splice(index, 0, task);
    render();
  }
}

// --- 入力 -------------------------------------------------------------------

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
