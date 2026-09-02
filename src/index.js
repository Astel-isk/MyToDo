/**
 * Workerの入口。OAuthProvider がすべてのリクエストを受け、
 *
 *   /mcp        → MCPサーバ(OAuthのアクセストークンで保護される)
 *   /oauth/*    → トークン発行・クライアント登録(ライブラリが処理)
 *   それ以外    → src/app-handler.js(PWA・REST API・同意画面)
 *
 * へ振り分ける。あわせて Cron Trigger からの起動(scheduled)を受ける。
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp.js";
import appHandler from "./app-handler.js";
import { notifyDue } from "./push.js";

const mcpHandler = {
  // env をツールへ渡すため、リクエストごとにサーバを組み立てる
  fetch: (request, env, ctx) => createMcpHandler(() => createServer(env))(request, env, ctx),
};

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: appHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["tasks:rw"],
});

// OAuthProvider はインスタンスなので、そのまま default export にすると
// scheduled を足せない。fetch を委譲する形に包む
export default {
  fetch: (request, env, ctx) => provider.fetch(request, env, ctx),

  // wrangler.jsonc の crons は毎日 23:00 UTC = 翌 8:00 JST。
  // 送ったかどうかは後から画面で見えないので、結果をログに残す(wrangler tail で読む)
  scheduled: (event, env, ctx) =>
    ctx.waitUntil(notifyDue(env).then((result) => console.log("通知:", JSON.stringify(result)))),
};
