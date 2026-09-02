-- 初期スキーマ。追加分は migrations/ にある(002以降)。
-- ローカル開発用DBの初期化:
--   npx wrangler d1 execute todo --local --file=schema.sql
--   npx wrangler d1 execute todo --local --file=migrations/002_tags.sql

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (done, due);
