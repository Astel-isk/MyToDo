/**
 * 認証。3つの経路を1つの関数で受ける。
 *
 *  1. PWA         : 署名付きクッキー `session`(パスワードでログインして得る)
 *  2. Claude      : OAuthアクセストークン(段階3。OAuthProviderが検証済みの情報を ctx.props に入れる)
 *  3. スクリプト  : Authorization: Bearer <TODO_TOKEN>
 */

import { error, json, readJson, constantTimeEquals } from "./http.js";

const COOKIE_NAME = "session";
const SESSION_DAYS = 90;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** `<payload>.<署名>` 形式のセッション値を作る */
async function issueSession(env) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ sub: "owner", exp: expires })));
  return `${payload}.${await hmac(env.COOKIE_SECRET, payload)}`;
}

async function validSession(env, value) {
  if (!env.COOKIE_SECRET || !value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  if (!constantTimeEquals(signature, await hmac(env.COOKIE_SECRET, payload))) return false;
  try {
    const { exp } = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function bearer(request) {
  const [scheme, value] = (request.headers.get("authorization") || "").split(" ");
  return scheme === "Bearer" && value ? value : null;
}

/** 認証できたら経路名、できなければ null を返す */
export async function authenticate(request, env, ctx) {
  // 段階3以降。OAuthProviderが検証を終えた利用者の情報がここに入る
  if (ctx?.props?.userId) return "oauth";

  const token = bearer(request);
  if (token && env.TODO_TOKEN && constantTimeEquals(token, env.TODO_TOKEN)) return "token";

  if (await validSession(env, readCookie(request, COOKIE_NAME))) return "session";

  return null;
}

/** パスワードを確かめてセッションのクッキーを配る */
export async function handleLogin(request, env) {
  const body = await readJson(request);
  if (!body) return error("リクエスト本文がJSONではありません", 400);
  if (!env.TODO_PASSWORD || !env.COOKIE_SECRET) return error("サーバ側の設定が未完了です", 500);

  if (typeof body.password !== "string" || !constantTimeEquals(body.password, env.TODO_PASSWORD)) {
    // 総当たりの速度を落とす。利用者が1人のため、遅延による実害はない
    await new Promise((resolve) => setTimeout(resolve, 800));
    return error("パスワードが違います", 401);
  }

  const cookie = [
    `${COOKIE_NAME}=${await issueSession(env)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ].join("; ");
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

export function handleLogout() {
  const cookie = `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return json({ ok: true }, 200, { "set-cookie": cookie });
}
