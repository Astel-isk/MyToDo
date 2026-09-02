-- プッシュ通知の宛先。端末ごとに1行で、ブラウザが返す endpoint をそのまま鍵にする。
-- 本文の入った push は送らない(通知の文面は Service Worker が /api/tasks を読んで作る)ため、
-- 本文の暗号化に要る鍵(p256dh / auth)は保存しない。

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
