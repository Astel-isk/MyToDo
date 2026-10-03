import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { listTasks } from "../src/api.js";

// node:sqlite は Node 22.13 未満ではフラグなしで読み込めない。読めない環境では飛ばす
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync ? false : "node:sqlite が使えない環境";

/** 本物のスキーマを当てたメモリ上のDBを、D1の prepare/bind/all の形で包む */
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const schemaUrl = new URL("../schema.sql", import.meta.url);
  db.exec(readFileSync(schemaUrl, "utf8"));
  db.exec(readFileSync(new URL("../migrations/002_tags.sql", import.meta.url), "utf8"));

  const insert = db.prepare("INSERT INTO tasks (title, due, done) VALUES (?, ?, ?)");
  insert.run("期限前", "2026-09-25", 0);
  insert.run("下端ちょうど", "2026-10-02", 1);
  insert.run("範囲内", "2026-10-05", 0);
  insert.run("上端ちょうど", "2026-10-16", 1);
  insert.run("期限後", "2026-10-17", 0);
  insert.run("期限なし", null, 0);

  return {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          all: async () => ({ results: db.prepare(sql).all(...values) }),
        }),
      }),
    },
  };
}

const titles = (tasks) => tasks.map((task) => task.title);

test("listTasks: 範囲を渡さなければ従来どおり全件(status: all)", { skip }, async () => {
  const tasks = await listTasks(makeEnv(), "all");
  assert.equal(tasks.length, 6);
});

test("listTasks: 両端を渡すと両端を含む範囲に絞り、期限のないものを除く", { skip }, async () => {
  const tasks = await listTasks(makeEnv(), "all", [], { dueFrom: "2026-10-02", dueTo: "2026-10-16" });
  assert.deepEqual(titles(tasks).sort(), ["上端ちょうど", "下端ちょうど", "範囲内"].sort());
});

test("listTasks: 片側だけでも絞れる", { skip }, async () => {
  const from = await listTasks(makeEnv(), "all", [], { dueFrom: "2026-10-16" });
  assert.deepEqual(titles(from).sort(), ["上端ちょうど", "期限後"].sort());

  const to = await listTasks(makeEnv(), "all", [], { dueTo: "2026-10-02" });
  assert.deepEqual(titles(to).sort(), ["下端ちょうど", "期限前"].sort());
});

test("listTasks: 範囲と完了状態の絞り込みを併用できる", { skip }, async () => {
  const tasks = await listTasks(makeEnv(), "open", [], { dueFrom: "2026-10-02", dueTo: "2026-10-16" });
  assert.deepEqual(titles(tasks), ["範囲内"]);
});
