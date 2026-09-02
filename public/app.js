/** 画面。依存なし。データはすべて /api/* 経由で読み書きする */

const $ = (id) => document.getElementById(id);
const login = $("login");
const app = $("app");
const listRoot = $("list");

let tasks = [];
let tagCatalog = [];
let activeTags = new Set();
let selectedTags = new Set();
let pendingNewTags = new Set();
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

  if (task.tags.length > 0) {
    const tags = document.createElement("div");
    tags.className = "tags";
    for (const name of task.tags) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = name;
      tags.append(tag);
    }
    body.append(tags);
  }

  const detail = [dueLabel(task), task.note].filter(Boolean).join(" ・ ");
  if (detail) {
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = detail;
    body.insertBefore(note, body.querySelector(".tags"));
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
  const query = new URLSearchParams({ status: showDone ? "all" : "open" });
  for (const name of activeTags) query.append("tag", name);

  const [{ tasks: fetched }, { tags }] = await Promise.all([
    api(`/tasks?${query}`),
    api("/tags"),
  ]);
  tasks = fetched;
  tagCatalog = tags;

  // 選んでいたタグが使われなくなったら、絞り込みからも外す
  const known = new Set(tags.map((t) => t.name));
  for (const name of activeTags) if (!known.has(name)) activeTags.delete(name);

  renderFilters();
  renderTagPicker();
  render();
}

/** 絞り込みのチップ。選択は複数可で、いずれかに一致するものを出す */
function renderFilters() {
  const filters = $("filters");
  filters.hidden = tagCatalog.length === 0;
  $("clear-filter").hidden = activeTags.size === 0;

  const chips = tagCatalog.map((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    const active = activeTags.has(tag.name);
    chip.setAttribute("aria-pressed", String(active));
    chip.textContent = tag.name;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = showDone ? tag.count : tag.open_count;
    chip.append(count);

    chip.addEventListener("click", async () => {
      if (active) activeTags.delete(tag.name);
      else activeTags.add(tag.name);
      await load();
    });
    return chip;
  });
  $("filter-tags").replaceChildren(...chips);
}

/**
 * 入力欄のタグ選択。既存のタグを押して付ける形にし、新規作成は「＋ 新規」から
 * 確認を挟んで行う。自由入力にすると打ち間違いや言い換えで似たタグが増えるため。
 */
function renderTagPicker() {
  const names = [...new Set([...tagCatalog.map((t) => t.name), ...pendingNewTags])];

  const chips = names.map((name) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(selectedTags.has(name)));
    chip.addEventListener("click", () => {
      if (selectedTags.has(name)) selectedTags.delete(name);
      else selectedTags.add(name);
      renderTagPicker();
    });
    return chip;
  });

  const create = document.createElement("button");
  create.type = "button";
  create.className = "chip chip-new";
  create.textContent = "＋ 新規";
  create.addEventListener("click", () => {
    closeCreatePrompt();
    const field = $("new-tag-name");
    field.hidden = false;
    field.focus();
  });
  chips.push(create);

  $("tag-picker").replaceChildren(...chips);
}

/** 新規作成。既存と同じ名前ならそれを選ぶだけにし、本当に新しいときだけ確認する */
function proposeNewTag() {
  const field = $("new-tag-name");
  const name = field.value.trim().replace(/ +/g, " ").slice(0, 20);
  field.value = "";
  field.hidden = true;
  if (!name) return;

  const known = tagCatalog.some((tag) => tag.name === name) || pendingNewTags.has(name);
  if (known) {
    selectedTags.add(name);
    renderTagPicker();
    return;
  }
  askToCreate(name);
}

/** 画面を塞ぐダイアログにせず、入力欄のすぐ上に確認を出す */
function askToCreate(name) {
  const existing = tagCatalog.map((tag) => tag.name);
  $("new-tag-message").textContent = existing.length
    ? `「${name}」は新しいタグです。今あるのは ${existing.join("、")} です。`
    : `「${name}」を最初のタグとして作ります。`;
  $("new-tag-confirm").hidden = false;
  $("new-tag-yes").onclick = () => {
    pendingNewTags.add(name);
    selectedTags.add(name);
    closeCreatePrompt();
    renderTagPicker();
  };
  $("new-tag-no").onclick = closeCreatePrompt;
}

function closeCreatePrompt() {
  $("new-tag-confirm").hidden = true;
  $("new-tag-message").textContent = "";
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
  const tags = [...selectedTags];
  const allowNewTags = [...pendingNewTags].filter((name) => selectedTags.has(name));

  $("title").value = "";
  $("due").value = "";
  selectedTags.clear();
  pendingNewTags.clear();
  closeCreatePrompt();
  $("add-form").classList.remove("expanded");

  await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title, due, tags, allowNewTags }),
  });
  await load();
});

$("clear-filter").addEventListener("click", async () => {
  activeTags.clear();
  await load();
});

// やることを書き始めたときだけ、タグと期限の欄を出す
const composer = $("add-form");
const expand = () => composer.classList.add("expanded");
$("title").addEventListener("focus", expand);
$("title").addEventListener("input", expand);
composer.addEventListener("focusout", () => {
  // 欄のあいだを移動しただけなら畳まない
  setTimeout(() => {
    if (composer.contains(document.activeElement)) return;
    if ($("title").value || $("due").value || selectedTags.size > 0) return;
    composer.classList.remove("expanded");
  }, 0);
});

$("new-tag-name").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault(); // フォーム全体の送信にしない
  proposeNewTag();
});

$("new-tag-name").addEventListener("blur", proposeNewTag);

$("toggle-done").addEventListener("click", async () => {
  showDone = !showDone;
  await load();
});

$("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" });
  showLogin();
});

// --- 通知 -------------------------------------------------------------------

/**
 * 毎朝8時の要約通知の入り切り。押した時点の状態から素直に反転させる。
 * 許可はブラウザの操作を伴うため、画面のボタンからしか要求できない。
 */

const pushSupported =
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let registration = null;

const currentSubscription = () =>
  registration ? registration.pushManager.getSubscription() : Promise.resolve(null);

/** VAPIDの公開鍵は base64url の文字列で届く。subscribe はバイト列を要求する */
function decodeKey(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function refreshNotifyButton() {
  const button = $("notify");
  const denied = Notification.permission === "denied";
  const on = Notification.permission === "granted" && Boolean(await currentSubscription());

  button.setAttribute("aria-pressed", String(on));
  button.disabled = denied;
  button.title = denied
    ? "ブラウザの設定で通知が拒否されています"
    : on
      ? "毎朝8時に期限の要約を通知します"
      : "毎朝8時に期限の要約を受け取る";
}

async function toggleNotify() {
  const existing = await currentSubscription();
  if (existing) {
    await existing.unsubscribe();
    await api("/push/subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: existing.endpoint }),
    });
    return refreshNotifyButton();
  }

  if ((await Notification.requestPermission()) !== "granted") return refreshNotifyButton();

  const { publicKey } = await api("/push/key");
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });
  await api("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await refreshNotifyButton();
}

async function initPush() {
  if (!pushSupported) return;
  registration = await navigator.serviceWorker.ready; // 登録できない環境ではここで止まる
  $("notify").hidden = false;
  await refreshNotifyButton();
  $("notify").addEventListener("click", () => toggleNotify().catch(refreshNotifyButton));
}

// クッキーが生きていればそのまま一覧へ、切れていればログイン画面へ
load().then(showApp).catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  initPush().catch(() => {});
}
