/**
 * PWAとREST APIを受けるハンドラ。OAuthProvider の defaultHandler として使われる。
 *
 *   GET    /api/health                       疎通確認(認証不要)
 *   POST   /api/login                        パスワード認証。セッションのクッキーを配る
 *   POST   /api/logout                       クッキーを消す
 *   GET    /api/tasks?status=open|done|all   一覧
 *   POST   /api/tasks                        追加  {title, note?, due?}
 *   PATCH  /api/tasks/:id                    更新  {title?, note?, due?, done?}
 *   DELETE /api/tasks/:id                    削除
 *   GET    /authorize                        OAuthの同意画面
 *
 * 静的ファイル(PWA本体)はWorkerに来る前にアセットとして返る。
 */

import { error, json } from "./http.js";
import { authenticate, handleLogin, handleLogout } from "./auth.js";
import { handleList, handleCreate, handleUpdate, handleDelete } from "./api.js";
import { handleAuthorize } from "./authorize.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/authorize") return handleAuthorize(request, env);

    if (pathname === "/api/health") return json({ ok: true });

    if (pathname === "/api/login") {
      return request.method === "POST"
        ? handleLogin(request, env)
        : error("Method Not Allowed", 405);
    }

    if (!pathname.startsWith("/api/")) return error("Not Found", 404);

    if (!(await authenticate(request, env, ctx))) return error("Unauthorized", 401);

    if (pathname === "/api/logout") {
      return request.method === "POST" ? handleLogout() : error("Method Not Allowed", 405);
    }

    if (pathname === "/api/tasks") {
      if (request.method === "GET") return handleList(env, url);
      if (request.method === "POST") return handleCreate(request, env);
      return error("Method Not Allowed", 405);
    }

    const match = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (request.method === "PATCH") return handleUpdate(request, env, id);
      if (request.method === "DELETE") return handleDelete(env, id);
      return error("Method Not Allowed", 405);
    }

    return error("Not Found", 404);
  },
};
