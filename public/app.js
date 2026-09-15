/** 画面。依存なし。データはすべて /api/* 経由で読み書きする */

const $ = (id) => document.getElementById(id);
const login = $("login");
const app = $("app");

let tasks = []; // 表示中のタブの一覧(やること=未完了、完了=完了済み)
let tagCatalog = [];
let activeTags = new Set();
let currentView = "open";
let loadSeq = 0;

// 追加・編集のシートの状態
let editingTask = null;
let sheetDue = null;
let sheetTags = new Set();

let undoTimer = null;

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

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

/** fetch 自体の失敗(圏外など)は TypeError になる。APIが返した理由はそのまま出す */
const failureText = (caught) =>
  caught instanceof TypeError ? "通信できませんでした。もう一度押してください" : caught.message;

function showLogin() {
  login.hidden = false;
  app.hidden = true;
  $("password").focus();
}

function showApp() {
  login.hidden = true;
  app.hidden = false;
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** 「3件」を、単位を一回り小さくしたDOM断片で返す */
function countFragment(n) {
  const frag = document.createDocumentFragment();
  frag.append(String(n), el("span", "count-unit", "件"));
  return frag;
}

// --- 日付と期限 -------------------------------------------------------------

const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString("sv-SE");
};
const daysFromToday = (due) => Math.round((new Date(due) - new Date(today())) / 86400000);

const weekday = (y, m, d) => WEEKDAY_JA[new Date(y, m - 1, d).getDay()];

function shortDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${weekday(y, m, d)})`;
}

function longDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}月${d}日(${weekday(y, m, d)})`;
}

function renderHeaderDate() {
  $("header-date").textContent = longDate(today());
}

/** 一覧を「いつやるか」で区分けする。並べ替えの順序はサーバ側と揃えてある */
const GROUPS = ["期限切れ", "今日", "明日", "今週", "この先", "期限なし"];

function groupOf(task) {
  if (!task.due) return "期限なし";
  const days = daysFromToday(task.due);
  if (days < 0) return "期限切れ";
  if (days === 0) return "今日";
  if (days === 1) return "明日";
  if (days <= 7) return "今週";
  return "この先";
}

/** 行の右端に出す期限。「今日」「明日」は見出しと重複するので出さない */
function dueLabel(task) {
  if (!task.due || task.done) return "";
  const days = daysFromToday(task.due);
  if (days < 0) return `${-days}日超過`;
  if (days <= 1) return "";
  return shortDate(task.due);
}

/** 完了日時はUTCの "YYYY-MM-DD HH:MM:SS" で入っている。端末の日付に直す */
function doneDate(task) {
  const stamp = task.done_at || task.updated_at;
  return new Date(`${stamp.replace(" ", "T")}Z`).toLocaleDateString("sv-SE");
}

// --- 通信できないときの帯 -----------------------------------------------------

function setConnError(show) {
  $("conn-banner").hidden = !show;
}

async function refresh() {
  try {
    await load();
    setConnError(false);
  } catch (caught) {
    if (caught.message !== "unauthorized") setConnError(true);
  }
}

$("conn-retry").addEventListener("click", refresh);

// --- 読み込み -----------------------------------------------------------------

async function load() {
  const seq = ++loadSeq;
  const query = new URLSearchParams({ status: currentView === "done" ? "done" : "open" });
  for (const name of activeTags) query.append("tag", name);

  const [{ tags }, list] = await Promise.all([
    api("/tags"),
    currentView === "settings" ? null : api(`/tasks?${query}`),
  ]);
  if (seq !== loadSeq) return; // タブを切り替えたあとに古い応答が届いた

  tagCatalog = tags;
  if (list) tasks = list.tasks;

  // 選んでいたタグが消えたら、絞り込みからも外す
  const known = new Set(tags.map((t) => t.name));
  for (const name of activeTags) if (!known.has(name)) activeTags.delete(name);

  render();
}

// --- 画面の切り替え -----------------------------------------------------------

function switchView(view) {
  currentView = view;
  for (const button of document.querySelectorAll(".nav-btn")) {
    button.setAttribute("aria-selected", String(button.dataset.view === view));
  }
  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  tasks = [];
  $("primary-count").textContent = "—";
  $("primary-sub").hidden = true;
  $("open-add").hidden = view !== "open";
  renderFilters();
  window.scrollTo(0, 0);
  refresh();
}

document.querySelectorAll(".nav-btn").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

// --- 描画 -------------------------------------------------------------------

function render() {
  renderFilters();
  if (currentView === "open") renderOpen();
  if (currentView === "done") renderDone();
  if (currentView === "settings") renderSettings();
}

function renderOpen() {
  const filtered = activeTags.size > 0;
  const none = tasks.length === 0;
  $("open-empty").hidden = !none || filtered;
  $("filter-empty").hidden = !none || !filtered;
  $("open-primary").hidden = none;
  $("open-add").hidden = none && !filtered;
  if (!none) renderPrimary();

  const groups = GROUPS.map((name) => [name, tasks.filter((t) => groupOf(t) === name)])
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => group(name, items, name === "期限切れ" ? "overdue" : ""));
  $("open-groups").replaceChildren(...groups);
}

/** 主役: 今日までにやることの件数。朝の通知と同じく「期限が今日・超過」を数える */
function renderPrimary() {
  const due = tasks.filter((t) => t.due && daysFromToday(t.due) <= 0);
  const overdue = due.filter((t) => daysFromToday(t.due) < 0);
  $("primary-count").replaceChildren(countFragment(due.length));

  const sub = $("primary-sub");
  sub.classList.toggle("alert", overdue.length > 0);
  if (overdue.length > 0) {
    sub.textContent = `うち期限切れ ${overdue.length}件`;
  } else if (due.length > 0) {
    sub.textContent = "";
  } else {
    const next = tasks.find((t) => t.due); // サーバが期限の近い順に並べて返す
    sub.textContent = next
      ? `今日までの期限はありません。次は ${shortDate(next.due)}「${next.title}」`
      : "期限のあるタスクはありません";
  }
  sub.hidden = !sub.textContent;
}

/** 完了タブは、完了した日ごとに新しい順でまとめる */
function renderDone() {
  $("done-empty").hidden = tasks.length > 0 || activeTags.size > 0;

  const byDate = new Map();
  for (const task of [...tasks].sort((a, b) => doneStamp(b).localeCompare(doneStamp(a)))) {
    const date = doneDate(task);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(task);
  }
  const groups = [...byDate].map(([date, items]) =>
    group(date === today() ? `今日 ${longDate(date)}` : longDate(date), items)
  );
  if (groups.length === 0 && activeTags.size > 0) {
    groups.push(el("p", "empty-hint", "選んだタグの完了したタスクはありません"));
  }
  $("done-groups").replaceChildren(...groups);
}

const doneStamp = (task) => task.done_at || task.updated_at;

function group(name, items, className = "") {
  const wrapper = el("section", `group ${className}`.trim());
  const heading = el("h2", "group-heading");
  const count = el("span", "group-count");
  count.append(countFragment(items.length));
  heading.append(el("span", "", name), count);

  const ul = el("ul", "task-list");
  ul.append(...items.map(row));
  wrapper.append(heading, ul);
  return wrapper;
}

function row(task) {
  const li = el("li", task.done ? "task-row done" : "task-row");
  li.dataset.id = task.id;

  // チェックだけは行の編集と分けて、その場で完了にする
  const label = el("label", "check");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = task.done;
  check.ariaLabel = task.done ? `${task.title} を未完了に戻す` : `${task.title} を完了にする`;
  check.addEventListener("change", () => setDone(task, check.checked, li));
  label.addEventListener("click", (event) => event.stopPropagation());
  label.append(check);

  const main = el("div", "task-main");
  main.append(el("span", "task-title", task.title));
  const sub = [task.tags.join("、"), task.note].filter(Boolean).join(" ・ ");
  if (sub) main.append(el("span", "task-sub", sub));

  li.append(label, main);

  const due = dueLabel(task);
  if (due) {
    const overdue = daysFromToday(task.due) < 0;
    li.append(el("span", overdue ? "task-due alert" : "task-due", due));
  }

  li.addEventListener("click", () => openEditSheet(task));
  return li;
}

/** 絞り込みのチップ。選択は複数可で、いずれかに一致するものを出す */
function renderFilters() {
  const filters = $("filters");
  filters.hidden = currentView === "settings" || tagCatalog.length === 0;
  $("clear-filter").hidden = activeTags.size === 0;

  const chips = tagCatalog.map((tag) => {
    const active = activeTags.has(tag.name);
    const chip = el("button", "chip", tag.name);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(active));
    const count = currentView === "done" ? tag.count - tag.open_count : tag.open_count;
    chip.append(el("span", "chip-count", String(count)));
    chip.addEventListener("click", () => {
      if (active) activeTags.delete(tag.name);
      else activeTags.add(tag.name);
      refresh();
    });
    return chip;
  });
  $("filter-tags").replaceChildren(...chips);
}

function clearFilter() {
  activeTags.clear();
  refresh();
}

$("clear-filter").addEventListener("click", clearFilter);
document.querySelector(".clear-filter-action").addEventListener("click", clearFilter);

// 区分けの見出しを、固定したヘッダの直下に貼り付けるための高さ
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--header-h", `${$("header").offsetHeight}px`);
}).observe($("header"));

// --- 設定 -------------------------------------------------------------------

function renderSettings() {
  $("settings-tags-empty").hidden = tagCatalog.length > 0;
  const rows = tagCatalog.map((tag) => {
    const li = el("li", "settings-row");
    const left = el("div", "settings-left");
    left.append(
      el("span", "settings-name", tag.name),
      el(
        "span",
        "settings-sub",
        tag.count ? `未完了 ${tag.open_count}件・全部で ${tag.count}件` : "どのタスクにも付いていません"
      )
    );
    const remove = el("button", "btn-text alert", "削除");
    remove.type = "button";
    remove.ariaLabel = `タグ「${tag.name}」を削除`;
    remove.addEventListener("click", () => deleteTag(tag));
    li.append(left, remove);
    return li;
  });
  $("settings-tags").replaceChildren(...rows);
}

/** 消すと戻せないので、影響する件数を見せてから確認する */
async function deleteTag(tag) {
  const affected = tag.count
    ? `${tag.count}件のタスクから外れます(タスク自体は残ります)。`
    : "どのタスクにも付いていません。";
  if (!confirm(`タグ「${tag.name}」を削除します。${affected}`)) return;

  activeTags.delete(tag.name);
  sheetTags.delete(tag.name);
  try {
    await api(`/tags/${encodeURIComponent(tag.name)}`, { method: "DELETE" });
  } catch (caught) {
    if (caught.message !== "unauthorized") setConnError(true);
    return;
  }
  await refresh();
}

$("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// --- 追加・編集のシート -------------------------------------------------------

function showOverlay() {
  const overlay = $("task-overlay");
  overlay.hidden = false;
  overlay.classList.remove("open");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => overlay.classList.add("open"));
  });
}

function hideOverlay() {
  const overlay = $("task-overlay");
  overlay.hidden = true;
  overlay.classList.remove("open");
  closeCreatePrompt();
  $("new-tag-field").hidden = true;
}

function prepareSheet(task) {
  editingTask = task;
  $("title").value = task ? task.title : "";
  sheetDue = task ? task.due : null;
  sheetTags = new Set(task ? task.tags : []);
  $("task-error").hidden = true;
  $("task-delete").hidden = !task;
  $("task-save").textContent = task ? "変更を保存" : "追加する";
  renderSheet();
  showOverlay();
}

/** 追加。押した操作の中でフォーカスし、キーボードをすぐ上げる */
function openAddSheet() {
  prepareSheet(null);
  $("title").focus();
}

function openEditSheet(task) {
  prepareSheet(task);
}

function renderSheet() {
  $("due-today").setAttribute("aria-pressed", String(sheetDue === today()));
  $("due-tomorrow").setAttribute("aria-pressed", String(sheetDue === tomorrow()));
  $("due-none").setAttribute("aria-pressed", String(sheetDue === null));
  $("due").value = sheetDue || "";
  renderTagPicker();
}

/**
 * タグ選択。既存のタグを押して付ける形にし、新規作成は「＋ 新しいタグ」から
 * 確認を挟んで行う。自由入力にすると打ち間違いや言い換えで似たタグが増えるため。
 */
function renderTagPicker() {
  const chips = tagCatalog.map(({ name }) => {
    const chip = el("button", "chip", name);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(sheetTags.has(name)));
    chip.addEventListener("click", () => {
      if (sheetTags.has(name)) sheetTags.delete(name);
      else sheetTags.add(name);
      renderTagPicker();
    });
    return chip;
  });
  $("tag-picker").replaceChildren(...chips);
  $("tag-picker").hidden = chips.length === 0;
}

$("due-today").addEventListener("click", () => {
  sheetDue = today();
  renderSheet();
});
$("due-tomorrow").addEventListener("click", () => {
  sheetDue = tomorrow();
  renderSheet();
});
$("due-none").addEventListener("click", () => {
  sheetDue = null;
  renderSheet();
});
$("due").addEventListener("change", (event) => {
  sheetDue = event.target.value || null;
  renderSheet();
});

$("new-tag-open").addEventListener("click", () => {
  closeCreatePrompt();
  $("new-tag-field").hidden = false;
  $("new-tag-name").focus();
});

/** 新規作成。既存と同じ名前ならそれを選ぶだけにし、本当に新しいときだけ確認する */
function proposeNewTag() {
  const field = $("new-tag-name");
  const name = field.value.trim().replace(/ +/g, " ").slice(0, 20);
  field.value = "";
  $("new-tag-field").hidden = true;
  if (!name) return;

  if (tagCatalog.some((tag) => tag.name === name)) {
    sheetTags.add(name);
    renderTagPicker();
    return;
  }
  askToCreate(name);
}

/** 画面を塞ぐダイアログにせず、タグ欄のすぐ下に確認を出す */
function askToCreate(name) {
  const existing = tagCatalog.map((tag) => tag.name);
  $("new-tag-message").textContent = existing.length
    ? `「${name}」は新しいタグです。今あるのは ${existing.join("、")} です。`
    : `「${name}」を最初のタグとして作ります。`;
  $("new-tag-confirm").hidden = false;
  $("new-tag-yes").onclick = async () => {
    closeCreatePrompt();
    sheetTags.add(name);
    try {
      // タスクの保存を待たずに作る。タグはタスクと独立して存在する
      const { tags } = await api("/tags", { method: "POST", body: JSON.stringify({ name }) });
      tagCatalog = tags;
    } catch {
      sheetTags.delete(name);
    }
    renderFilters();
    renderTagPicker();
  };
  $("new-tag-no").onclick = closeCreatePrompt;
}

function closeCreatePrompt() {
  $("new-tag-confirm").hidden = true;
  $("new-tag-message").textContent = "";
}

// 日本語入力で変換を確定するEnterは、送信や作成の合図にしない
const isSubmitEnter = (event) => event.key === "Enter" && !event.isComposing && event.keyCode !== 229;

$("new-tag-name").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault(); // フォーム全体の送信にしない
  if (isSubmitEnter(event)) proposeNewTag();
});

$("title").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (isSubmitEnter(event)) $("task-sheet").requestSubmit();
});
$("new-tag-name").addEventListener("blur", proposeNewTag);

$("task-sheet").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("task-error");
  const title = $("title").value.trim();
  if (!title) {
    error.textContent = "やることを入力してください";
    error.hidden = false;
    $("title").focus();
    return;
  }
  error.hidden = true;
  closeCreatePrompt();

  const body = JSON.stringify({ title, due: sheetDue, tags: [...sheetTags] });
  const save = $("task-save");
  save.disabled = true;
  try {
    if (editingTask) {
      await api(`/tasks/${editingTask.id}`, { method: "PATCH", body });
      hideOverlay();
      await refresh();
    } else {
      const { task } = await api("/tasks", { method: "POST", body });
      hideOverlay();
      await refresh();
      showUndoToast(`「${task.title}」を追加`, () =>
        api(`/tasks/${task.id}`, { method: "DELETE" })
      );
    }
  } catch (caught) {
    if (caught.message === "unauthorized") return;
    error.textContent = failureText(caught);
    error.hidden = false;
  } finally {
    save.disabled = false;
  }
});

$("task-delete").addEventListener("click", async () => {
  const task = editingTask;
  if (!task || !confirm(`「${task.title}」を削除します`)) return;
  try {
    await api(`/tasks/${task.id}`, { method: "DELETE" });
    hideOverlay();
    await refresh();
  } catch (caught) {
    if (caught.message === "unauthorized") return;
    $("task-error").textContent = failureText(caught);
    $("task-error").hidden = false;
  }
});

$("task-cancel").addEventListener("click", hideOverlay);

// 背景の暗幕を押したら閉じる
$("task-overlay").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) hideOverlay();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("task-overlay").hidden) hideOverlay();
});

$("open-add").addEventListener("click", openAddSheet);
$("empty-add").addEventListener("click", openAddSheet);

// --- 完了と取り消し -----------------------------------------------------------

/** 一覧から消える操作は、消えることを見せてから作り直す */
const fadeOut = (li) =>
  new Promise((resolve) => {
    li.classList.add("leaving");
    setTimeout(resolve, 180);
  });

/** 完了にしても未完了に戻しても、今のタブの一覧からは外れる */
async function setDone(task, done, li) {
  await fadeOut(li);
  try {
    await api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done }) });
  } catch (caught) {
    render();
    if (caught.message !== "unauthorized") setConnError(true);
    return;
  }
  await refresh();
  showUndoToast(done ? `「${task.title}」を完了` : `「${task.title}」を未完了に戻す`, () =>
    api(`/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done: !done }) })
  );
}

function showUndoToast(message, undo) {
  clearTimeout(undoTimer);
  const toast = $("toast");
  $("toast-message").textContent = message;
  toast.hidden = false;
  $("toast-undo").onclick = async () => {
    clearTimeout(undoTimer);
    toast.hidden = true;
    try {
      await undo();
    } catch (caught) {
      if (caught.message !== "unauthorized") setConnError(true);
    }
    await refresh();
  };
  undoTimer = setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

// --- ログイン -----------------------------------------------------------------

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
    renderHeaderDate();
    await refresh();
  } catch (caught) {
    error.textContent = caught.message === "unauthorized" ? "パスワードが違います" : failureText(caught);
    error.hidden = false;
  }
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

  button.hidden = denied;
  button.textContent = on ? "切る" : "入れる";
  $("notify-state").textContent = denied
    ? "ブラウザの設定で拒否されています"
    : on
      ? "毎朝8時に、今日までと期限切れのタスクを知らせます"
      : "切っています。入れると毎朝8時に期限の要約が届きます";
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
  if (!pushSupported) {
    $("notify-state").textContent = "この端末では使えません";
    return;
  }
  registration = await navigator.serviceWorker.ready; // 登録できない環境ではここで止まる
  await refreshNotifyButton();
  $("notify").addEventListener("click", () => toggleNotify().catch(refreshNotifyButton));
}

// --- 起動 -------------------------------------------------------------------

// クッキーが生きていればそのまま一覧へ、切れていればログイン画面へ
renderHeaderDate();
load()
  .then(showApp)
  .catch((caught) => {
    if (caught.message === "unauthorized") return;
    showApp();
    setConnError(true);
  });

// 日をまたいで開き直したときに、日付と区分けを今日に合わせる
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || app.hidden) return;
  renderHeaderDate();
  refresh();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  initPush().catch(() => {});
} else {
  $("notify-state").textContent = "この端末では使えません";
}
