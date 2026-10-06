/**
 * myFIT(大学のLMS)の課題をタスクへ同期する。MyBriefが受け取った課題の一覧を
 * Service Binding(RPC)で受け、タスクを自動で作成・更新・完了する(src/index.js の TodoSync)。
 *
 * 前半は規則だけの純粋関数(planSync)で、DBにも `cloudflare:workers` にも触れない。
 * node --test でそのまま読めるようにするため。後半(applySync)が計画をDBへ反映する。
 *
 * 課題の同一性は key = JSON.stringify([courseCode, name]) で決める。結び付きは
 * myfit_links に残し(migrations/005_myfit_links.sql)、同じ課題を二重に作らない。
 */

import { createTask, updateTask, findUnknownTags, listTasks } from "./api.js";

/** 同期で課題のタスクに付けるタグ。存在するときだけ付ける(作らない) */
const ACADEMIC_TAG = "学業";

// --- 日時 -------------------------------------------------------------------

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 指定時刻を日本時間の `YYYY-MM-DD HH:mm` にする。Workersの時計はUTCなので+9時間する */
export function formatJst(date = new Date()) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().slice(0, 16).replace("T", " ");
}

/** `YYYY-MM-DD` が実在する日付か。桁数も厳密に見る */
export function isValidDate(value) {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

// --- 規則(純粋関数) ---------------------------------------------------------

/** 課題の同一性。課題名を含むため、先生が名前を変えると別の課題として扱われる */
export const linkKey = (item) => JSON.stringify([item.courseCode, item.name]);

/** end(`YYYY-MM-DD HH:mm`)から、タスクの期限(日付部分)とメモを作る */
function dueFields(end) {
  return { due: end.slice(0, 10), note: `myFIT・締切 ${end.slice(11, 16)}` };
}

/**
 * 課題の一覧と現状から、行う操作を決める。DBは読まない。
 *
 *  - items: 課題の配列 { courseCode, courseName, name, end, unsubmitted, ... }
 *  - links: Map<key, { taskId: number|null, lastEnd: string|null }>。taskId が null は「対象外」
 *  - tasks: Map<taskId, { done: boolean }>。連携先のタスクだけ。Mapに無い taskId は削除済み
 *  - now: 日本時間の `YYYY-MM-DD HH:mm`。end との比較は文字列のまま行う(桁が揃っているため)
 *  - hasAcademicTag: 「学業」タグが存在するか。無いタグは付けられない(作らない)
 *
 * 戻り値は操作の配列:
 *   { type: "create", key, end, fields: { title, due, note }, tags }
 *   { type: "update", key, taskId, end, fields: { due, note } }
 *   { type: "complete", taskId }
 *
 * 何もしない場合(操作を返さない): 対象外(taskId が null)、完了済み・削除済みのタスク
 * (作り直さない・開き直さない)、一覧から消えた課題、締切を過ぎた未連携の課題、
 * 連携済みで end が空になったもの。手で完了・削除した意思を、同期が覆さないため。
 */
export function planSync({ items, links, tasks, now, hasAcademicTag }) {
  const operations = [];
  const seen = new Set();

  for (const item of items) {
    const key = linkKey(item);
    // 同じ課題が一覧に2度出ても、最初の1件だけを見る(同じ回に二重に作らないため)
    if (seen.has(key)) continue;
    seen.add(key);

    const link = links.get(key);

    if (!link) {
      // 未連携: 未提出で、締切がまだ先のものだけ作る。過ぎた課題を今さら作らない
      if (item.unsubmitted && item.end !== "" && item.end > now) {
        const label = item.courseName || item.courseCode;
        operations.push({
          type: "create",
          key,
          end: item.end,
          fields: { title: `${label} ${item.name}を提出する`, ...dueFields(item.end) },
          tags: hasAcademicTag ? [ACADEMIC_TAG] : [],
        });
      }
      continue;
    }

    // 連携済み: 対象外・削除済み・完了済みは触らない
    if (link.taskId === null) continue;
    const task = tasks.get(link.taskId);
    if (!task || task.done) continue;

    if (!item.unsubmitted) {
      // 提出済み。end が変わっていても、完了にするだけ
      operations.push({ type: "complete", taskId: link.taskId });
    } else if (item.end !== "" && item.end !== link.lastEnd) {
      operations.push({
        type: "update",
        key,
        taskId: link.taskId,
        end: item.end,
        fields: dueFields(item.end),
      });
    }
  }

  return operations;
}

// --- 実行部 -----------------------------------------------------------------

/** D1は1文に束縛できる値が100個までなので、IN句は分けて読む */
const CHUNK = 50;

async function readLinks(env) {
  const { results } = await env.DB.prepare("SELECT key, task_id, last_end FROM myfit_links").all();
  return new Map(results.map((row) => [row.key, { taskId: row.task_id, lastEnd: row.last_end }]));
}

async function readTasks(env, links) {
  const ids = [...new Set([...links.values()].map((link) => link.taskId).filter((id) => id !== null))];
  const tasks = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, done FROM tasks WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .all();
    for (const row of results) tasks.set(row.id, { done: row.done === 1 });
  }
  return tasks;
}

/**
 * 課題の一覧をタスクへ反映する。戻り値は件数 { created, updated, completed }。
 * 作成・更新・完了は api.js の関数を使い、done_at・updated_at の扱いを手入力のタスクとそろえる。
 * ログは呼び出し側が件数だけを出す(課題名・タスク名を含めないため、ここでは何も出さない)。
 */
export async function applySync(env, items, date = new Date()) {
  const links = await readLinks(env);
  const tasks = await readTasks(env, links);
  // setTags は存在しないタグを作ってしまうため、確かめてから渡す
  const hasAcademicTag = (await findUnknownTags(env, [ACADEMIC_TAG])).length === 0;

  const operations = planSync({ items, links, tasks, now: formatJst(date), hasAcademicTag });
  const counts = { created: 0, updated: 0, completed: 0 };

  for (const op of operations) {
    if (op.type === "create") {
      const task = await createTask(env, op.fields, op.tags);
      await env.DB.prepare("INSERT INTO myfit_links (key, task_id, last_end) VALUES (?, ?, ?)")
        .bind(op.key, task.id, op.end)
        .run();
      counts.created++;
    } else if (op.type === "update") {
      // 読んでから書くまでの間にタスクが消されていれば null が返る。そのときは何も記録しない
      const task = await updateTask(env, op.taskId, op.fields);
      if (!task) continue;
      await env.DB.prepare("UPDATE myfit_links SET last_end = ? WHERE key = ?")
        .bind(op.end, op.key)
        .run();
      counts.updated++;
    } else if (op.type === "complete") {
      const task = await updateTask(env, op.taskId, { done: 1 });
      if (task) counts.completed++;
    }
  }

  return counts;
}

/**
 * dueTo(`YYYY-MM-DD`)以前が期限の未完了タスク。期限切れを含み、期限なしは含まない。
 * MyBriefの毎朝のブリーフィングが締切を読むために使う。必要な項目だけを返す。
 */
export async function listDue(env, dueTo) {
  if (!isValidDate(dueTo)) throw new Error("dueTo は YYYY-MM-DD の実在する日付にしてください");
  const tasks = await listTasks(env, "open", [], { dueTo });
  return tasks.map(({ id, title, due, note, tags }) => ({ id, title, due, note, tags }));
}
