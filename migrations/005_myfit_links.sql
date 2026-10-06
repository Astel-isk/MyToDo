-- myFITの課題とタスクの結び付き。MyBriefが受け取った課題の一覧をMyToDoへ渡すとき、
-- 同じ課題を二重に作らず、提出済みになったら完了にするために、課題ごとに1行を持つ。
--
-- key は課題の同一性で、JSON.stringify([courseCode, name]) の文字列。
-- task_id が NULL の行は「対象外」で、同期は何もしない(手で入れる。既存のタスクと
-- 突き合わせ済みの課題を、重複して作らないための印)。
--
-- tasks への外部キーは張らない。タスクは画面・MCPからいつでも消されうる。
-- CASCADE で行も消えると、次の同期で同じ課題のタスクが作り直され、消した意図が覆る。
-- 制限(RESTRICT)にすると、結び付いたタスクを消せなくなる。
-- どちらも困るので、消えたタスクは「削除済み」として行を残し、作り直さない。

CREATE TABLE IF NOT EXISTS myfit_links (
  key TEXT PRIMARY KEY,        -- JSON.stringify([courseCode, name])
  task_id INTEGER,             -- NULL は「対象外」(同期が何もしない)
  last_end TEXT,               -- 最後に反映した end
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
