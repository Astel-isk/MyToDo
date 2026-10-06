import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planSync, formatJst, applySync, listDue, linkKey } from "../src/myfit-sync.js";

// node:sqlite は Node 22.13 未満ではフラグなしで読み込めない。読めない環境では飛ばす
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync ? false : "node:sqlite が使えない環境";

// --- planSync ---------------------------------------------------------------

const NOW = "2026-10-06 12:00";

const item = (over = {}) => ({
  courseCode: "A123",
  courseName: "線形代数",
  name: "第3回レポート",
  start: "2026-10-01 09:00",
  end: "2026-10-08 23:59",
  status: "未提出",
  unsubmitted: true,
  ...over,
});
const KEY = linkKey(item());

const plan = ({ items, links = [], tasks = [], now = NOW, hasAcademicTag = true }) =>
  planSync({
    items,
    links: new Map(links),
    tasks: new Map(tasks),
    now,
    hasAcademicTag,
  });

test("planSync: 未提出で締切が先の未連携の課題は作成する(title・due・note・タグの形)", () => {
  assert.deepEqual(plan({ items: [item()] }), [
    {
      type: "create",
      key: KEY,
      end: "2026-10-08 23:59",
      fields: {
        title: "線形代数 第3回レポートを提出する",
        due: "2026-10-08",
        note: "myFIT・締切 23:59",
      },
      tags: ["学業"],
    },
  ]);
});

test("planSync: 科目名が空なら科目コードをタイトルに使う", () => {
  const [op] = plan({ items: [item({ courseName: "" })] });
  assert.equal(op.fields.title, "A123 第3回レポートを提出する");
});

test("planSync: 学業タグが無ければタグは付けない", () => {
  const [op] = plan({ items: [item()], hasAcademicTag: false });
  assert.deepEqual(op.tags, []);
});

test("planSync: end が空の未連携は作らない", () => {
  assert.deepEqual(plan({ items: [item({ end: "" })] }), []);
});

test("planSync: 締切後(end <= now)の未連携は作らない。ちょうど今も作らない", () => {
  assert.deepEqual(plan({ items: [item({ end: "2026-10-06 11:59" })] }), []);
  assert.deepEqual(plan({ items: [item({ end: NOW })] }), []);
  assert.equal(plan({ items: [item({ end: "2026-10-06 12:01" })] }).length, 1);
});

test("planSync: 提出済みの未連携の課題は作らない", () => {
  assert.deepEqual(plan({ items: [item({ unsubmitted: false })] }), []);
});

test("planSync: 同じ key が一覧に2度出ても最初の1件だけを見る", () => {
  const ops = plan({
    items: [item({ end: "2026-10-08 23:59" }), item({ end: "2026-10-09 12:00", status: "別" })],
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].end, "2026-10-08 23:59");
});

test("planSync: 別の科目の同名の課題は別の key として扱う", () => {
  const ops = plan({ items: [item(), item({ courseCode: "B456", courseName: "解析" })] });
  assert.equal(ops.length, 2);
});

test("planSync: 連携済みで締切が変わったら update(due・note を作り直す)", () => {
  const ops = plan({
    items: [item({ end: "2026-10-10 17:30" })],
    links: [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]],
    tasks: [[7, { done: false }]],
  });
  assert.deepEqual(ops, [
    {
      type: "update",
      key: KEY,
      taskId: 7,
      end: "2026-10-10 17:30",
      fields: { due: "2026-10-10", note: "myFIT・締切 17:30" },
    },
  ]);
});

test("planSync: 連携済みで締切が同じなら何もしない。end が空になっても何もしない", () => {
  const links = [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]];
  const tasks = [[7, { done: false }]];
  assert.deepEqual(plan({ items: [item()], links, tasks }), []);
  assert.deepEqual(plan({ items: [item({ end: "" })], links, tasks }), []);
});

test("planSync: 提出済みになったら complete", () => {
  const ops = plan({
    items: [item({ unsubmitted: false })],
    links: [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]],
    tasks: [[7, { done: false }]],
  });
  assert.deepEqual(ops, [{ type: "complete", taskId: 7 }]);
});

test("planSync: 提出済みかつ end が変わっていても complete だけ", () => {
  const ops = plan({
    items: [item({ unsubmitted: false, end: "2026-10-20 10:00" })],
    links: [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]],
    tasks: [[7, { done: false }]],
  });
  assert.deepEqual(ops, [{ type: "complete", taskId: 7 }]);
});

test("planSync: 完了済みのタスクは触らない(開き直さない・更新しない)", () => {
  const links = [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]];
  const tasks = [[7, { done: true }]];
  assert.deepEqual(plan({ items: [item({ end: "2026-10-10 17:30" })], links, tasks }), []);
  assert.deepEqual(plan({ items: [item({ unsubmitted: false })], links, tasks }), []);
});

test("planSync: 削除済みのタスクは作り直さない・何もしない", () => {
  const links = [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]];
  // tasks に taskId が無い = 削除済み
  assert.deepEqual(plan({ items: [item()], links }), []);
  assert.deepEqual(plan({ items: [item({ end: "2026-10-10 17:30" })], links }), []);
  assert.deepEqual(plan({ items: [item({ unsubmitted: false })], links }), []);
});

test("planSync: task_id が NULL(対象外)は何もしない", () => {
  const links = [[KEY, { taskId: null, lastEnd: null }]];
  assert.deepEqual(plan({ items: [item()], links }), []);
  assert.deepEqual(plan({ items: [item({ end: "2026-10-10 17:30" })], links }), []);
  assert.deepEqual(plan({ items: [item({ unsubmitted: false })], links }), []);
});

test("planSync: 一覧から消えた課題は何もしない", () => {
  const ops = plan({
    items: [],
    links: [[KEY, { taskId: 7, lastEnd: "2026-10-08 23:59" }]],
    tasks: [[7, { done: false }]],
  });
  assert.deepEqual(ops, []);
});

test("formatJst: UTCの時刻を日本時間の YYYY-MM-DD HH:mm にする(日付をまたぐ)", () => {
  assert.equal(formatJst(new Date("2026-10-06T03:00:00.000Z")), "2026-10-06 12:00");
  assert.equal(formatJst(new Date("2026-10-06T15:30:59.000Z")), "2026-10-07 00:30");
  assert.equal(formatJst(new Date("2026-12-31T14:59:00.000Z")), "2026-12-31 23:59");
});

// --- applySync(node:sqlite のメモリDB) ---------------------------------------

/** 本物のスキーマと移行を当てたメモリDBを、D1の prepare/bind/run/first/all/batch の形で包む */
function makeEnv({ tags = ["学業"] } = {}) {
  const db = new DatabaseSync(":memory:");
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  db.exec(read("../schema.sql"));
  for (const name of ["002_tags", "003_push", "004_login_attempts", "005_myfit_links"]) {
    db.exec(read(`../migrations/${name}.sql`));
  }
  for (const name of tags) db.prepare("INSERT INTO tags (name) VALUES (?)").run(name);

  return {
    sqlite: db,
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        let params = [];
        const self = {
          bind: (...values) => ((params = values), self),
          run: async () => ({ meta: { changes: Number(stmt.run(...params).changes) } }),
          first: async () => stmt.get(...params) ?? null,
          all: async () => ({ results: stmt.all(...params) }),
        };
        return self;
      },
      // D1の batch と同じく、全体を1つのトランザクションで行い、各文の結果を返す
      batch: async (statements) => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all());
          db.exec("COMMIT");
          return results;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
}

// node:sqlite の行はプロトタイプを持たないため、deepEqual できるよう素のオブジェクトにする
const rows = (env, sql) => env.sqlite.prepare(sql).all().map((row) => ({ ...row }));

test("applySync: 作成→再実行で重複なし→期限変更→提出済みで完了、までを通す", { skip }, async () => {
  const env = makeEnv();
  // 2026-10-06 12:00 JST
  const at = new Date("2026-10-06T03:00:00.000Z");

  // 1回目: 作成(タグ付き)、締切後の課題は作らない
  let counts = await applySync(env, [item(), item({ name: "過去の課題", end: "2026-10-01 10:00" })], at);
  assert.deepEqual(counts, { created: 1, updated: 0, completed: 0 });
  const [task] = rows(env, "SELECT * FROM tasks");
  assert.equal(task.title, "線形代数 第3回レポートを提出する");
  assert.equal(task.due, "2026-10-08");
  assert.equal(task.note, "myFIT・締切 23:59");
  assert.equal(task.done, 0);
  assert.deepEqual(
    rows(env, "SELECT tags.name AS name FROM task_tags JOIN tags ON tags.id = task_tags.tag_id"),
    [{ name: "学業" }]
  );
  assert.deepEqual(rows(env, "SELECT key, task_id, last_end FROM myfit_links"), [
    { key: KEY, task_id: task.id, last_end: "2026-10-08 23:59" },
  ]);

  // 2回目: 同じ一覧では何も起きない
  counts = await applySync(env, [item()], at);
  assert.deepEqual(counts, { created: 0, updated: 0, completed: 0 });
  assert.equal(rows(env, "SELECT * FROM tasks").length, 1);

  // 期限の変更
  counts = await applySync(env, [item({ end: "2026-10-10 17:30" })], at);
  assert.deepEqual(counts, { created: 0, updated: 1, completed: 0 });
  const [moved] = rows(env, "SELECT due, note FROM tasks");
  assert.deepEqual({ ...moved }, { due: "2026-10-10", note: "myFIT・締切 17:30" });
  assert.equal(rows(env, "SELECT last_end FROM myfit_links")[0].last_end, "2026-10-10 17:30");

  // 提出済みで完了(done_at も入る)
  counts = await applySync(env, [item({ unsubmitted: false, end: "2026-10-10 17:30" })], at);
  assert.deepEqual(counts, { created: 0, updated: 0, completed: 1 });
  const [done] = rows(env, "SELECT done, done_at FROM tasks");
  assert.equal(done.done, 1);
  assert.ok(done.done_at);

  // 完了後は開き直さない
  counts = await applySync(env, [item({ end: "2026-10-12 09:00" })], at);
  assert.deepEqual(counts, { created: 0, updated: 0, completed: 0 });
  assert.equal(rows(env, "SELECT done FROM tasks")[0].done, 1);
});

test("applySync: 学業タグが存在しなければ作らずに、タグなしでタスクを作る", { skip }, async () => {
  const env = makeEnv({ tags: [] });
  await applySync(env, [item()], new Date("2026-10-06T03:00:00.000Z"));
  assert.equal(rows(env, "SELECT * FROM tasks").length, 1);
  assert.equal(rows(env, "SELECT * FROM tags").length, 0);
  assert.equal(rows(env, "SELECT * FROM task_tags").length, 0);
});

test("applySync: 削除したタスクは作り直さず、対象外の行は何もしない", { skip }, async () => {
  const env = makeEnv();
  const at = new Date("2026-10-06T03:00:00.000Z");
  await applySync(env, [item()], at);
  env.sqlite.exec("DELETE FROM tasks");

  const other = item({ name: "対象外の課題" });
  env.sqlite
    .prepare("INSERT INTO myfit_links (key, task_id, last_end) VALUES (?, NULL, NULL)")
    .run(linkKey(other));

  const counts = await applySync(env, [item({ end: "2026-10-10 17:30" }), other], at);
  assert.deepEqual(counts, { created: 0, updated: 0, completed: 0 });
  assert.equal(rows(env, "SELECT * FROM tasks").length, 0);
});

test("applySync: 結び付きが既にある課題を作ろうとしたら、タスクも作らずに取り消す", { skip }, async () => {
  // 同期が2本並行し、両方が「未連携」と読んだ場合を、読み取りの後に行を差し込んで再現する
  const env = makeEnv();
  const originalPrepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO tasks")) {
      env.sqlite
        .prepare("INSERT OR IGNORE INTO myfit_links (key, task_id, last_end) VALUES (?, 999, NULL)")
        .run(KEY);
    }
    return originalPrepare(sql);
  };

  await assert.rejects(applySync(env, [item()], new Date("2026-10-06T03:00:00.000Z")));
  assert.equal(rows(env, "SELECT * FROM tasks").length, 0);
  assert.deepEqual(rows(env, "SELECT task_id FROM myfit_links"), [{ task_id: 999 }]);
});

// --- listDue ----------------------------------------------------------------

test("listDue: dueTo 以前が期限の未完了だけを、必要な項目だけで返す。不正な日付は例外", { skip }, async () => {
  const env = makeEnv();
  const insert = env.sqlite.prepare("INSERT INTO tasks (title, due, note, done) VALUES (?, ?, ?, ?)");
  insert.run("期限切れ", "2026-10-01", "メモ", 0);
  insert.run("ちょうど", "2026-10-13", null, 0);
  insert.run("先", "2026-10-14", null, 0);
  insert.run("完了済み", "2026-10-02", null, 1);
  insert.run("期限なし", null, null, 0);

  const tasks = await listDue(env, "2026-10-13");
  assert.deepEqual(
    tasks.map((task) => task.title),
    ["期限切れ", "ちょうど"]
  );
  assert.deepEqual(Object.keys(tasks[0]).sort(), ["due", "id", "note", "tags", "title"]);
  assert.deepEqual(tasks[0].tags, []);

  for (const bad of ["2026-10-32", "2026-9-1", "", undefined, "2026-02-30"]) {
    await assert.rejects(() => listDue(env, bad), `不正: ${bad}`);
  }
});
