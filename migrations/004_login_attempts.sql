-- ログインの失敗回数。IPごとに数え、一定回数を超えたら一定時間断つ。
-- CloudflareのRate Limiting bindingは拠点ごとの概算で、並列に投げられると
-- ほとんど素通りする(実測で30本中29本が通過)。確実に止めるためD1で数える。

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
