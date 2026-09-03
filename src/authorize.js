/**
 * OAuthの同意画面。Claudeがコネクタを繋ぐときにここへ来る。
 * 利用者は本人1人なので、確認するのはパスワードだけ。
 */

import { constantTimeEquals } from "./http.js";
import { allowPasswordAttempt, recordPasswordFailure, clearPasswordFailures } from "./ratelimit.js";

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body) => `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ToDo への接続</title><link rel="stylesheet" href="/style.css">
</head><body><section id="login">${body}</section></body></html>`;

function consentPage(info, client, message) {
  const name = client?.clientName || client?.clientId || "不明なクライアント";
  return page(`
    <h1>ToDo への接続</h1>
    <p><strong>${escape(name)}</strong> がタスクの読み書きを求めています。</p>
    ${message ? `<p class="error">${escape(message)}</p>` : ""}
    <form method="post">
      <input type="hidden" name="oauth" value="${escape(JSON.stringify(info))}">
      <input type="password" name="password" placeholder="パスワード" autocomplete="current-password" required autofocus>
      <button type="submit">許可する</button>
    </form>
    <p class="muted">許可すると、このクライアントはタスクの追加・変更・削除ができるようになります。</p>`);
}

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export async function handleAuthorize(request, env) {
  if (request.method === "GET") {
    try {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
      return html(consentPage(info, client));
    } catch (caught) {
      return html(page(`<h1>接続できません</h1><p class="error">${escape(caught.message)}</p>`), 400);
    }
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const form = await request.formData();
  const info = JSON.parse(form.get("oauth"));

  // ログイン画面と同じパスワードを受けるため、こちらにも同じ制限をかける
  if (!(await allowPasswordAttempt(env, request))) {
    const client = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
    return html(consentPage(info, client, "失敗が続いたため、しばらく受け付けません"), 429);
  }

  if (!env.TODO_PASSWORD || !constantTimeEquals(form.get("password") || "", env.TODO_PASSWORD)) {
    await recordPasswordFailure(env, request);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const client = await env.OAUTH_PROVIDER.lookupClient(info.clientId);
    return html(consentPage(info, client, "パスワードが違います"), 401);
  }

  await clearPasswordFailures(env, request);

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: info,
    userId: "owner",
    scope: info.scope?.length ? info.scope : ["tasks:rw"],
    metadata: { grantedAt: new Date().toISOString() },
    props: { userId: "owner" },
  });
  return Response.redirect(redirectTo, 302);
}
