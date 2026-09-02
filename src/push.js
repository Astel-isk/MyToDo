/**
 * プッシュ通知。毎朝8時(JST)に、期限が今日・超過のタスクがあれば1通だけ送る。
 *
 * 本文の入らない「起こすだけ」の push を投げ、通知の文面は Service Worker が
 * /api/tasks を読んで組み立てる。本文を積む形は RFC 8291 の暗号化(ECDH + HKDF +
 * AES-GCM)が要るのに対し、この形は VAPID の署名だけで済む。
 *
 *   GET    /api/push/key         購読に使う公開鍵
 *   POST   /api/push/subscribe   宛先の登録   {endpoint, previousEndpoint?}
 *   DELETE /api/push/subscribe   宛先の削除   {endpoint}
 *   POST   /api/push/test        いま1通送る(動作確認用)
 */

import { json, error, readJson } from "./http.js";

const TTL = 6 * 60 * 60; // 端末が圏外でも配ってもらう時間。翌朝の分と重ならない長さにする
const JWT_LIFETIME = 3 * 60 * 60;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const b64urlJson = (value) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** JSTの今日。期限は日付だけを持つので、送るかどうかもJSTの日付で決める */
export const todayInJst = (now = Date.now()) =>
  new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

// --- 送信 -------------------------------------------------------------------

/**
 * VAPIDのJWT。宛先の配信サービス(Androidなら fcm.googleapis.com)に対し、
 * この送信元が購読時と同じ鍵を持っていることを示す。
 */
async function vapidToken(env, endpoint) {
  const data = [
    b64urlJson({ typ: "JWT", alg: "ES256" }),
    b64urlJson({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME,
      sub: env.VAPID_SUBJECT,
    }),
  ].join(".");

  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(env.VAPID_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // Web Crypto の ECDSA は r||s をそのまま返す。JWS の ES256 が要る形と同じ
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(data)
  );
  return `${data}.${b64url(signature)}`;
}

/** 1つの宛先へ送り、HTTPのステータスを返す。届かなかった場合は 0 */
async function sendTo(env, endpoint) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        TTL: String(TTL),
        Authorization: `vapid t=${await vapidToken(env, endpoint)}, k=${env.VAPID_PUBLIC_KEY}`,
      },
    });
    return response.status;
  } catch {
    return 0;
  }
}

/** 全宛先へ送る。配信サービスが失効を告げた宛先はその場で消す */
async function broadcast(env) {
  const { results } = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").all();
  let sent = 0;
  let removed = 0;

  for (const { endpoint } of results) {
    const status = await sendTo(env, endpoint);
    if (status === 404 || status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
      removed++;
    } else if (status >= 200 && status < 300) {
      sent++;
    }
  }
  return { sent, removed, total: results.length };
}

const configured = (env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/** Cron Trigger から呼ばれる。対象が無い日は、用のない通知で端末を起こさない */
export async function notifyDue(env) {
  if (!configured(env)) return { skipped: "鍵が未設定" };

  const today = todayInJst();
  const counts = await env.DB.prepare(
    `SELECT SUM(CASE WHEN due = ? THEN 1 ELSE 0 END) AS due_today,
            SUM(CASE WHEN due < ? THEN 1 ELSE 0 END) AS overdue
       FROM tasks
      WHERE done = 0 AND due IS NOT NULL`
  )
    .bind(today, today)
    .first();

  const target = (counts?.due_today ?? 0) + (counts?.overdue ?? 0);
  if (target === 0) return { skipped: "対象なし" };

  return { target, ...(await broadcast(env)) };
}

// --- HTTPの層 ---------------------------------------------------------------

export function handleKey(env) {
  return configured(env)
    ? json({ publicKey: env.VAPID_PUBLIC_KEY })
    : error("通知の鍵がサーバに設定されていません", 503);
}

export async function handleSubscribe(request, env) {
  const body = await readJson(request);
  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return error("endpoint が不正です", 400);
  }

  // 配信サービス側で宛先が振り直されたときは、古い行を残さない
  if (typeof body.previousEndpoint === "string" && body.previousEndpoint !== endpoint) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .bind(body.previousEndpoint)
      .run();
  }

  await env.DB.prepare("INSERT OR IGNORE INTO push_subscriptions (endpoint) VALUES (?)")
    .bind(endpoint)
    .run();
  return json({ ok: true });
}

export async function handleUnsubscribe(request, env) {
  const body = await readJson(request);
  if (typeof body?.endpoint !== "string") return error("endpoint が不正です", 400);

  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(body.endpoint)
    .run();
  return json({ ok: true });
}

/** 期限の有無によらず送る。端末まで届くかを確かめるためのもの */
export async function handleTest(env) {
  if (!configured(env)) return error("通知の鍵がサーバに設定されていません", 503);
  return json(await broadcast(env));
}
