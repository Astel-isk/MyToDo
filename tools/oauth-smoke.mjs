/**
 * OAuthの登録→同意→トークン発行→MCP呼び出しまでを通しで確認する。
 *
 *   BASE=http://127.0.0.1:8787 PASSWORD=... node tools/oauth-smoke.mjs
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const PASSWORD =
  process.env.PASSWORD ||
  readFileSync(".dev.vars", "utf8").match(/^TODO_PASSWORD=(.*)$/m)?.[1];

const REDIRECT = "http://localhost:9999/callback";
const b64url = (buf) => buf.toString("base64url");
const step = (name, detail) => console.log(`${name.padEnd(28)} ${detail}`);

// --- 1. 動的クライアント登録 -------------------------------------------------
const registration = await fetch(`${BASE}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "疎通確認クライアント",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const client = await registration.json();
if (!registration.ok) throw new Error("登録に失敗: " + JSON.stringify(client));
step("1. クライアント登録", `${registration.status} client_id=${client.client_id.slice(0, 12)}...`);

// --- 2. 認可リクエスト(同意画面の取得) -------------------------------------
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const authorizeUrl =
  `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=tasks%3Arw&state=xyz` +
  `&code_challenge=${challenge}&code_challenge_method=S256`;

const consent = await fetch(authorizeUrl);
const page = await consent.text();
const hidden = page.match(/name="oauth" value="([^"]*)"/)?.[1];
if (!hidden) throw new Error("同意画面にoauthの値がない:\n" + page.slice(0, 400));
const unescape = (s) => s.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
step("2. 同意画面", `${consent.status} クライアント名の表示=${/疎通確認クライアント/.test(page)}`);

// --- 3. 誤ったパスワード ----------------------------------------------------
const wrong = await fetch(`${BASE}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ oauth: unescape(hidden), password: "wrong" }),
  redirect: "manual",
});
step("3. 誤ったパスワード", `${wrong.status}(401であること)`);

// --- 4. 正しいパスワードで許可 ----------------------------------------------
const granted = await fetch(`${BASE}/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ oauth: unescape(hidden), password: PASSWORD }),
  redirect: "manual",
});
const location = granted.headers.get("location");
if (!location) throw new Error(`リダイレクトされなかった: ${granted.status} ${await granted.text()}`);
const code = new URL(location).searchParams.get("code");
step("4. 許可", `${granted.status} code=${code.slice(0, 12)}... state=${new URL(location).searchParams.get("state")}`);

// --- 5. トークン発行 --------------------------------------------------------
const tokenResponse = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
const token = await tokenResponse.json();
if (!token.access_token) throw new Error("トークン発行に失敗: " + JSON.stringify(token));
step("5. トークン発行", `${tokenResponse.status} type=${token.token_type} scope=${token.scope}`);

// --- 6. MCPの呼び出し -------------------------------------------------------
let mcpSession;
async function mcp(method, params) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  mcpSession ||= response.headers.get("mcp-session-id");
  const body = await response.text();
  // Streamable HTTP は SSE 形式で返ることがある
  const payload = body.startsWith("event:") || body.startsWith("data:")
    ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("")
    : body;
  if (!response.ok) throw new Error(`${method} が ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(payload).result;
}

await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0.0" },
});
step("6. initialize", "OK");

const { tools } = await mcp("tools/list", {});
step("7. tools/list", tools.map((t) => t.name).join(", "));

const LF = String.fromCharCode(10);

// タグは既存のものしか付けられない
const refused = await mcp("tools/call", {
  name: "add_task",
  arguments: { title: "存在しないタグの確認", tags: ["でっちあげ"] },
});
step("8. 未知のタグは断る", refused.content[0].text.split(LF)[0]);

const catalog = await mcp("tools/call", { name: "list_tags", arguments: {} });
step("9. list_tags", catalog.content[0].text.split(LF).join(" / "));
const firstTagLine = catalog.content[0].text.split(LF)[0];
const existing = firstTagLine.startsWith(String.fromCharCode(35))
  ? firstTagLine.slice(1, firstTagLine.indexOf(String.fromCharCode(40)))
  : null;

const added = await mcp("tools/call", {
  name: "add_task",
  arguments: {
    title: "OAuth疎通のテスト",
    due: "2026-09-30",
    ...(existing ? { tags: [existing] } : {}),
  },
});
step("10. add_task", added.content[0].text);

const listed = await mcp("tools/call", { name: "list_tasks", arguments: {} });
step("11. list_tasks", listed.content[0].text.split(LF).join(" / "));

const id = Number(added.content[0].text.match(/#([0-9]+)/)[1]);
const removed = await mcp("tools/call", { name: "delete_task", arguments: { id } });
step("12. delete_task", removed.content[0].text);

// --- 無効なトークン ---------------------------------------------------------
const rejected = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    authorization: "Bearer invalid-token",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
step("13. 無効なトークン", `${rejected.status}(401であること)`);

console.log(LF + "通し確認 完了");
