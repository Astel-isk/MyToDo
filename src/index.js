/**
 * Workerの入口。OAuthProvider がすべてのリクエストを受け、
 *
 *   /mcp        → MCPサーバ(OAuthのアクセストークンで保護される)
 *   /oauth/*    → トークン発行・クライアント登録(ライブラリが処理)
 *   それ以外    → src/app-handler.js(PWA・REST API・同意画面)
 *
 * へ振り分ける。あわせて Cron Trigger からの起動(scheduled)を受ける。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp.js";
import appHandler from "./app-handler.js";
import { notifyDue } from "./push.js";
import { notifyUrgent } from "./discord.js";
import { applySync, listDue } from "./myfit-sync.js";

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

  // wrangler.jsonc の crons は2つ。
  //   0 23 * * *  毎日 23:00 UTC = 翌 8:00 JST(Web Push)
  //   0  9 * * *  毎日  9:00 UTC =    18:00 JST(Discordの警報)
  // 送ったかどうかは後から画面で見えないので、結果をログに残す(wrangler tail で読む)
  scheduled: (event, env, ctx) => {
    const task =
      event.cron === "0 9 * * *"
        ? notifyUrgent(env).then((result) => console.log("Discord警報:", JSON.stringify(result)))
        : notifyDue(env).then((result) => console.log("通知:", JSON.stringify(result)));
    ctx.waitUntil(task);
  },
};

/**
 * Service Binding(RPC)の入口。MyBrief(Worker名 brief)から呼ばれる。
 *
 * ここには Service Binding からしか届かない。WorkerEntrypoint はURLにもルートにも
 * 結び付かないので、公開URL(todo.astelisk.com)のルーティングには乗らず、認証も要らない
 * (呼べるのは、同じアカウントで binding を宣言したWorkerだけ)。
 * 規則は src/myfit-sync.js、結び付きは myfit_links(migrations/005_myfit_links.sql)にある。
 */
export class TodoSync extends WorkerEntrypoint {
  /**
   * myFITの課題の一覧をタスクへ反映し、件数 { created, updated, completed } を返す。
   * 中身の検証はしない。許可リストを通した項目だけを送るのは送り側(MyBrief の src/myfit.js)で、
   * ここでは配列であることだけを確かめる。
   */
  async syncAssignments(items) {
    if (!Array.isArray(items)) throw new TypeError("items は配列です");
    return applySync(this.env, items);
  }

  /**
   * dueTo(YYYY-MM-DD、不正なら例外)以前が期限の未完了タスク。期限切れを含む。
   * {id, title, due, note, tags} だけを返す。
   */
  async listDue(dueTo) {
    return listDue(this.env, dueTo);
  }
}
