/** タスクのCRUD。REST(/api/*)とMCPツールの双方から呼ばれる */

import { json, error, readJson } from "./http.js";

/** DBの行をAPIの表現へ。done は 0/1、tags は結合済みの文字列で入ってくる */
const toTask = (row) => ({
  ...row,
  done: row.done === 1,
  tags: row.tags ? row.tags.split("\u001f") : [],
});

/** 受け取った本文から、書き込んでよいフィールドだけを取り出す */
function pickFields(body) {
  const fields = {};
  if (typeof body.title === "string") fields.title = body.title.trim();
  if (typeof body.note === "string" || body.note === null) fields.note = body.note;
  if (typeof body.due === "string" || body.due === null) fields.due = body.due;
  if (typeof body.done === "boolean") fields.done = body.done ? 1 : 0;
  return fields;
}

/** 表記ゆれで同じタグが増えないよう、前後の空白を落として重複を除く */
export function normalizeTags(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Map();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/\s+/g, " ").slice(0, 20);
    if (name) seen.set(name, true);
  }
  return [...seen.keys()];
}

// --- タグ -------------------------------------------------------------------

/**
 * まだ存在しない名前を返す。
 * タグは打ち間違いや言い換えで際限なく増えるため、作成は明示的に許した名前だけに限る。
 */
export async function findUnknownTags(env, names) {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT name FROM tags WHERE name IN (${placeholders})`
  )
    .bind(...names)
    .all();
  const known = new Set(results.map((row) => row.name));
  return names.filter((name) => !known.has(name));
}

/** タスクに付けるタグを、渡された集合そのものに置き換える */
export async function setTags(env, taskId, names) {
  const statements = [env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(taskId)];

  for (const name of names) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(name),
      env.DB.prepare(
        "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, (SELECT id FROM tags WHERE name = ?))"
      ).bind(taskId, name)
    );
  }
  await env.DB.batch(statements);
}

/** 使われているタグを、使用数の多い順に返す。絞り込みの候補として使う */
export async function listTags(env) {
  const { results } = await env.DB.prepare(
    `SELECT tags.name AS name,
            COUNT(task_tags.task_id) AS count,
            SUM(CASE WHEN tasks.done = 0 THEN 1 ELSE 0 END) AS open_count
       FROM tags
       JOIN task_tags ON task_tags.tag_id = tags.id
       JOIN tasks ON tasks.id = task_tags.task_id
      GROUP BY tags.id
      ORDER BY open_count DESC, count DESC, tags.name ASC`
  ).all();
  return results;
}

/** どのタスクからも外れたタグを片付ける */
async function pruneTags(env) {
  await env.DB.prepare(
    "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM task_tags)"
  ).run();
}

// --- タスク -----------------------------------------------------------------

const SELECT_TASKS = `
  SELECT tasks.*, group_concat(tags.name, char(31)) AS tags
    FROM tasks
    LEFT JOIN task_tags ON task_tags.task_id = tasks.id
    LEFT JOIN tags ON tags.id = task_tags.tag_id`;

/**
 * 一覧。tags を渡すと、そのいずれかを持つタスクに絞る(OR)。
 * 単一の観点での複数選択は、絞り込むより広げる意図で使われるため。
 */
export async function listTasks(env, status = "open", tags = []) {
  const conditions = [];
  const values = [];

  if (status === "done") conditions.push("tasks.done = 1");
  else if (status !== "all") conditions.push("tasks.done = 0");

  if (tags.length > 0) {
    const placeholders = tags.map(() => "?").join(", ");
    conditions.push(`tasks.id IN (
      SELECT task_tags.task_id FROM task_tags
        JOIN tags ON tags.id = task_tags.tag_id
       WHERE tags.name IN (${placeholders}))`);
    values.push(...tags);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `${SELECT_TASKS}
     ${where}
     GROUP BY tasks.id
     ORDER BY tasks.done ASC, tasks.due IS NULL ASC, tasks.due ASC, tasks.created_at ASC`
  )
    .bind(...values)
    .all();
  return results.map(toTask);
}

async function findTask(env, id) {
  const row = await env.DB.prepare(`${SELECT_TASKS} WHERE tasks.id = ? GROUP BY tasks.id`)
    .bind(id)
    .first();
  return row ? toTask(row) : null;
}

export async function createTask(env, fields, tags = []) {
  const row = await env.DB.prepare(
    "INSERT INTO tasks (title, note, due) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(fields.title, fields.note ?? null, fields.due ?? null)
    .first();

  if (tags.length > 0) await setTags(env, row.id, tags);
  return findTask(env, row.id);
}

export async function updateTask(env, id, fields, tags = null) {
  if (Object.keys(fields).length > 0) {
    const assignments = Object.keys(fields).map((key) => `${key} = ?`);
    const values = Object.values(fields);
    // done を立てた/降ろしたときに done_at も揃える
    if ("done" in fields) {
      assignments.push(fields.done ? "done_at = datetime('now')" : "done_at = NULL");
    }
    assignments.push("updated_at = datetime('now')");

    const updated = await env.DB.prepare(
      `UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? RETURNING id`
    )
      .bind(...values, id)
      .first();
    if (!updated) return null;
  } else if (!(await findTask(env, id))) {
    return null;
  }

  if (tags) {
    await setTags(env, id, tags);
    await pruneTags(env);
  }
  return findTask(env, id);
}

export async function deleteTask(env, id) {
  const row = await env.DB.prepare("DELETE FROM tasks WHERE id = ? RETURNING id").bind(id).first();
  if (!row) return null;
  // 外部キーの連鎖に頼らず、結び付きと孤立したタグを明示的に片付ける
  await env.DB.prepare("DELETE FROM task_tags WHERE task_id = ?").bind(id).run();
  await pruneTags(env);
  return row.id;
}

// --- HTTPの層 ---------------------------------------------------------------

export async function handleList(env, url) {
  const tasks = await listTasks(
    env,
    url.searchParams.get("status") || "open",
    url.searchParams.getAll("tag")
  );
  return json({ tasks });
}

export async function handleTags(env) {
  return json({ tags: await listTags(env) });
}

export async function handleCreate(request, env) {
  const body = await readJson(request);
  if (!body) return error("リクエスト本文がJSONではありません", 400);

  const fields = pickFields(body);
  if (!fields.title) return error("title は必須です", 400);

  const tags = normalizeTags(body.tags) || [];
  const rejected = await rejectUnknownTags(env, tags, body.allowNewTags);
  if (rejected) return rejected;

  return json({ task: await createTask(env, fields, tags) }, 201);
}

export async function handleUpdate(request, env, id) {
  const body = await readJson(request);
  if (!body) return error("リクエスト本文がJSONではありません", 400);

  const fields = pickFields(body);
  const tags = normalizeTags(body.tags);
  if ("title" in fields && !fields.title) return error("title は空にできません", 400);
  if (Object.keys(fields).length === 0 && !tags) return error("更新する項目がありません", 400);

  if (tags) {
    const rejected = await rejectUnknownTags(env, tags, body.allowNewTags);
    if (rejected) return rejected;
  }

  const task = await updateTask(env, id, fields, tags);
  return task ? json({ task }) : error("該当するタスクがありません", 404);
}

/** 作成を許していない名前が混ざっていれば、使えるタグを添えて返す */
async function rejectUnknownTags(env, tags, allowNewTags) {
  const allowed = new Set(normalizeTags(allowNewTags) || []);
  const unknown = (await findUnknownTags(env, tags)).filter((name) => !allowed.has(name));
  if (unknown.length === 0) return null;

  const available = (await listTags(env)).map((tag) => tag.name);
  return json(
    {
      error: `存在しないタグです: ${unknown.join(", ")}`,
      unknownTags: unknown,
      availableTags: available,
    },
    400
  );
}

export async function handleDelete(env, id) {
  const deleted = await deleteTask(env, id);
  return deleted ? json({ deleted }) : error("該当するタスクがありません", 404);
}
