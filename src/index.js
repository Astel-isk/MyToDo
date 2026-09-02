/**
 * Workerの入口。OAuthProvider がすべてのリクエストを受け、
 *
 *   /mcp        → MCPサーバ(OAuthのアクセストークンで保護される)
 *   /oauth/*    → トークン発行・クライアント登録(ライブラリが処理)
 *   それ以外    → src/app-handler.js(PWA・REST API・同意画面)
 *
 * へ振り分ける。
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp.js";
import appHandler from "./app-handler.js";

const mcpHandler = {
  // env をツールへ渡すため、リクエストごとにサーバを組み立てる
  fetch: (request, env, ctx) => createMcpHandler(() => createServer(env))(request, env, ctx),
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: appHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["tasks:rw"],
});
