/**
 * PWAとREST APIを受けるハンドラ。OAuthProvider の defaultHandler として使われる。
 *
 *   GET    /api/health                       疎通確認(認証不要)
 *   POST   /api/login                        パスワード認証。セッションのクッキーを配る
 *   POST   /api/logout                       クッキーを消す
 *   GET    /api/tasks?status=open|done|all&tag=…  一覧(tagは複数指定可)
 *   GET    /api/tags                         タグと使用数(未使用のものも含む)
 *   POST   /api/tags                        タグを作る  {name}
 *   DELETE /api/tags/:name                   タグを消す(タスクは残る)
 *   POST   /api/tasks                        追加  {title, note?, due?, tags?}
 *   PATCH  /api/tasks/:id                    更新  {title?, note?, due?, done?}
 *   DELETE /api/tasks/:id                    削除
 *   GET    /api/push/key                     購読に使うVAPIDの公開鍵
 *   POST   /api/push/subscribe               通知の宛先を登録
 *   DELETE /api/push/subscribe               通知の宛先を削除
 *   POST   /api/push/test                    通知を1通送る(動作確認用)
 *   GET    /authorize                        OAuthの同意画面
 *
 * 静的ファイル(PWA本体)はWorkerに来る前にアセットとして返る。
 */

import { error, json } from "./http.js";
import { authenticate, handleLogin, handleLogout } from "./auth.js";
import {
  handleList,
  handleTags,
  handleCreateTag,
  handleDeleteTag,
  handleCreate,
  handleUpdate,
  handleDelete,
} from "./api.js";
import { handleAuthorize } from "./authorize.js";
import { handleKey, handleSubscribe, handleUnsubscribe, handleTest } from "./push.js";

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

    if (pathname === "/api/tags") {
      if (request.method === "GET") return handleTags(env);
      if (request.method === "POST") return handleCreateTag(request, env);
      return error("Method Not Allowed", 405);
    }

    // タグ名はそのままパスに入るため、比較の前にデコードする
    if (pathname.startsWith("/api/tags/")) {
      if (request.method !== "DELETE") return error("Method Not Allowed", 405);
      return handleDeleteTag(env, decodeURIComponent(pathname.slice("/api/tags/".length)));
    }

    if (pathname === "/api/push/key") {
      return request.method === "GET" ? handleKey(env) : error("Method Not Allowed", 405);
    }

    if (pathname === "/api/push/subscribe") {
      if (request.method === "POST") return handleSubscribe(request, env);
      if (request.method === "DELETE") return handleUnsubscribe(request, env);
      return error("Method Not Allowed", 405);
    }

    if (pathname === "/api/push/test") {
      return request.method === "POST" ? handleTest(env) : error("Method Not Allowed", 405);
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
