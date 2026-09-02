/** タスクのCRUD。REST(/api/tasks)とMCPツールの双方から呼ばれる */

import { json, error, readJson } from "./http.js";

/** DBの行をAPIの表現へ。done は 0/1 で入っているので真偽値に直す */
const toTask = (row) => ({ ...row, done: row.done === 1 });

/** 受け取った本文から、書き込んでよいフィールドだけを取り出す */
function pickFields(body) {
  const fields = {};
  if (typeof body.title === "string") fields.title = body.title.trim();
  if (typeof body.note === "string" || body.note === null) fields.note = body.note;
  if (typeof body.due === "string" || body.due === null) fields.due = body.due;
  if (typeof body.done === "boolean") fields.done = body.done ? 1 : 0;
  return fields;
}

// --- ここから下はDBの操作。MCPツールからも直接使う ---------------------------

export async function listTasks(env, status = "open") {
  const where =
    status === "all" ? "" : status === "done" ? "WHERE done = 1" : "WHERE done = 0";
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks ${where}
     ORDER BY done ASC, due IS NULL ASC, due ASC, created_at ASC`
  ).all();
  return results.map(toTask);
}

export async function createTask(env, fields) {
  const row = await env.DB.prepare(
    "INSERT INTO tasks (title, note, due) VALUES (?, ?, ?) RETURNING *"
  )
    .bind(fields.title, fields.note ?? null, fields.due ?? null)
    .first();
  return toTask(row);
}

export async function updateTask(env, id, fields) {
  const assignments = Object.keys(fields).map((key) => `${key} = ?`);
  const values = Object.values(fields);
  // done を立てた/降ろしたときに done_at も揃える
  if ("done" in fields) {
    assignments.push(fields.done ? "done_at = datetime('now')" : "done_at = NULL");
  }
  assignments.push("updated_at = datetime('now')");

  const row = await env.DB.prepare(
    `UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? RETURNING *`
  )
    .bind(...values, id)
    .first();
  return row ? toTask(row) : null;
}

export async function deleteTask(env, id) {
  const row = await env.DB.prepare("DELETE FROM tasks WHERE id = ? RETURNING id")
    .bind(id)
    .first();
  return row ? row.id : null;
}

// --- ここから下はHTTPの層 ----------------------------------------------------

export async function handleList(env, url) {
  return json({ tasks: await listTasks(env, url.searchParams.get("status") || "open") });
}

export async function handleCreate(request, env) {
  const body = await readJson(request);
  if (!body) return error("リクエスト本文がJSONではありません", 400);

  const fields = pickFields(body);
  if (!fields.title) return error("title は必須です", 400);

  return json({ task: await createTask(env, fields) }, 201);
}

export async function handleUpdate(request, env, id) {
  const body = await readJson(request);
  if (!body) return error("リクエスト本文がJSONではありません", 400);

  const fields = pickFields(body);
  if ("title" in fields && !fields.title) return error("title は空にできません", 400);
  if (Object.keys(fields).length === 0) return error("更新する項目がありません", 400);

  const task = await updateTask(env, id, fields);
  return task ? json({ task }) : error("該当するタスクがありません", 404);
}

export async function handleDelete(env, id) {
  const deleted = await deleteTask(env, id);
  return deleted ? json({ deleted }) : error("該当するタスクがありません", 404);
}
