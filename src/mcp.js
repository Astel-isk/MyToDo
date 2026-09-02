/**
 * MCPサーバ。Claudeのカスタムコネクタから呼ばれる。
 * DBの操作は src/api.js を共有し、REST側と実装を分けない。
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  listTasks,
  listTags,
  createTask,
  updateTask,
  deleteTask,
  normalizeTags,
  findUnknownTags,
} from "./api.js";

/** このアプリが何を置く場所かを、ツールの説明に一貫して書くための前置き */
const SCOPE_NOTE =
  "このアプリは日々の実行タスク(買い物・提出物・雑務など)を置く場所である。" +
  "Claudeとの運用に関わる事項(確認待ちの質問、PIRの手続きなど)はPIRのタスク台帳が正であり、ここには入れない。";

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** 一覧の1件を1行で表す */
const line = (task) =>
  [
    `#${task.id}`,
    task.done ? "[完了]" : "[未完了]",
    task.title,
    task.due ? `期限:${task.due}` : "",
    task.tags?.length ? task.tags.map((t) => `#${t}`).join(" ") : "",
    task.note ? `メモ:${task.note}` : "",
  ]
    .filter(Boolean)
    .join(" ");

const DUE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "期限は YYYY-MM-DD 形式で指定する")
  .describe("期限。YYYY-MM-DD 形式");

const TAGS = z
  .array(z.string().min(1).max(20))
  .describe(
    "タグ。すでに存在するものだけを指定できる。名前は list_tags で確認する。新しいタグを作れるのは本人がアプリの画面で操作したときだけなので、思いついた分類を勝手に足さない"
  );

/** 存在しないタグが混ざっていたら、使える名前を添えて断る */
async function checkTags(env, names) {
  const unknown = await findUnknownTags(env, names);
  if (unknown.length === 0) return null;

  const available = (await listTags(env)).map((tag) => tag.name);
  return text(
    [
      `存在しないタグは付けられない: ${unknown.join(", ")}`,
      `使えるタグ: ${available.length ? available.join(", ") : "(まだない)"}`,
      "新しいタグは本人がアプリの画面から作る。近い意味の既存タグを使うか、タグなしで追加する",
    ].join("\n")
  );
}

export function createServer(env) {
  const server = new McpServer({ name: "todo", version: "1.0.0" });

  server.registerTool(
    "list_tasks",
    {
      description: `ToDoの一覧を返す。期限の早い順、期限のないものは後ろ。${SCOPE_NOTE}`,
      inputSchema: {
        status: z
          .enum(["open", "done", "all"])
          .optional()
          .describe("既定は open(未完了のみ)"),
        tags: TAGS.optional().describe(
          "指定するとそのいずれかのタグを持つものだけを返す(いずれか1つでも一致すればよい)"
        ),
      },
    },
    async ({ status, tags }) => {
      const tasks = await listTasks(env, status || "open", normalizeTags(tags) || []);
      return text(tasks.length ? tasks.map(line).join("\n") : "該当するタスクはありません");
    }
  );

  server.registerTool(
    "add_task",
    {
      description: `ToDoを1件追加する。${SCOPE_NOTE}`,
      inputSchema: {
        title: z.string().min(1).describe("やること。短く具体的に"),
        due: DUE.optional(),
        note: z.string().optional().describe("補足。省略してよい"),
        tags: TAGS.optional(),
      },
    },
    async ({ title, due, note, tags }) => {
      const names = normalizeTags(tags) || [];
      const rejected = await checkTags(env, names);
      if (rejected) return rejected;

      const task = await createTask(
        env,
        { title: title.trim(), due: due ?? null, note: note ?? null },
        names
      );
      return text(`追加した: ${line(task)}`);
    }
  );

  server.registerTool(
    "complete_task",
    {
      description: "ToDoを完了にする。idは list_tasks で確認する",
      inputSchema: { id: z.number().int().positive().describe("タスクのid") },
    },
    async ({ id }) => {
      const task = await updateTask(env, id, { done: 1 });
      return text(task ? `完了にした: ${line(task)}` : `id ${id} のタスクが見つからない`);
    }
  );

  server.registerTool(
    "update_task",
    {
      description: "ToDoのタイトル・期限・メモ・完了状態を変える。変えたい項目だけ渡す",
      inputSchema: {
        id: z.number().int().positive().describe("タスクのid"),
        title: z.string().min(1).optional(),
        due: DUE.nullable().optional().describe("null を渡すと期限を外す"),
        note: z.string().nullable().optional(),
        done: z.boolean().optional(),
        tags: TAGS.nullable().optional().describe("渡すとタグをこの集合で置き換える。[] で全部外す"),
      },
    },
    async ({ id, tags, ...changes }) => {
      const fields = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        fields[key] = key === "done" ? (value ? 1 : 0) : value;
      }
      const nextTags = normalizeTags(tags);
      if (Object.keys(fields).length === 0 && !nextTags) {
        return text("変更する項目が指定されていない");
      }
      if (nextTags) {
        const rejected = await checkTags(env, nextTags);
        if (rejected) return rejected;
      }

      const task = await updateTask(env, id, fields, nextTags);
      return text(task ? `更新した: ${line(task)}` : `id ${id} のタスクが見つからない`);
    }
  );

  server.registerTool(
    "list_tags",
    {
      description:
        "使われているタグを、未完了のタスクが多い順に返す。add_task でタグを付ける前に、既存の名前を確かめて表記ゆれを避けるために使う",
      inputSchema: {},
    },
    async () => {
      const tags = await listTags(env);
      return text(
        tags.length
          ? tags.map((t) => `#${t.name}(未完了 ${t.open_count} / 全 ${t.count})`).join("\n")
          : "まだタグは使われていません"
      );
    }
  );

  server.registerTool(
    "delete_task",
    {
      description: "ToDoを削除する。完了にするだけなら complete_task を使う",
      inputSchema: { id: z.number().int().positive().describe("タスクのid") },
    },
    async ({ id }) => {
      const deleted = await deleteTask(env, id);
      return text(deleted ? `削除した: #${deleted}` : `id ${id} のタスクが見つからない`);
    }
  );

  return server;
}
