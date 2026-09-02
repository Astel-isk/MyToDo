/**
 * 画面の骨組みだけをキャッシュする。データ(/api/*)は常にネットワークへ行く。
 * オフラインでの編集は入れていない(同期の仕組みが要るため)。
 *
 * あわせてプッシュ通知を受ける。push には本文が入っていないので、
 * 文面はここで /api/tasks を読んで組み立てる。
 */

const VERSION = "v5";
const SHELL = ["/", "/style.css", "/app.js", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // 骨組みは更新を優先し、通信できないときだけキャッシュを使う
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("/")))
  );
});

// --- プッシュ通知 -----------------------------------------------------------

self.addEventListener("push", (event) => {
  event.waitUntil(notifyDueSummary());
});

/**
 * 通知を出さずに終えるとブラウザが「バックグラウンドで更新されました」を代わりに出すため、
 * 一覧を読めなかったときも必ず何かを出す。
 */
async function notifyDueSummary() {
  let body = "期限のあるタスクを確認してください";
  try {
    const response = await fetch("/api/tasks?status=open", { credentials: "include" });
    if (response.ok) body = summarize((await response.json()).tasks);
  } catch {
    // 圏外やセッション切れ。既定の文面のまま出す
  }

  await self.registration.showNotification("ToDo", {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "due-summary", // 前日の通知が残っていれば置き換える
    renotify: true,
    data: { url: "/" },
  });
}

function summarize(tasks) {
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const dueToday = tasks.filter((task) => task.due === today);
  const overdue = tasks.filter((task) => task.due && task.due < today);

  const targets = [...dueToday, ...overdue];
  if (targets.length === 0) return "今日が期限のタスクはありません";

  const parts = [];
  if (dueToday.length > 0) parts.push(`今日が期限:${dueToday.length}件`);
  if (overdue.length > 0) parts.push(`期限切れ:${overdue.length}件`);

  // 1件だけなら、開かなくても何のことか分かるように題名を添える
  return targets.length === 1 ? `${parts[0]} ・ ${targets[0].title}` : parts.join(" / ");
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp());
});

async function openApp() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === self.location.origin) return client.focus();
  }
  return self.clients.openWindow("/");
}

// 配信サービス側で宛先が振り直されたら、登録し直して古い宛先を伝える
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
  if (!applicationServerKey) return;

  const subscription = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      previousEndpoint: event.oldSubscription?.endpoint,
    }),
  });
}
