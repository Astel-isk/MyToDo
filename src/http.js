/** JSONレスポンスとエラー応答の共通ヘルパ */

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export const error = (message, status) => json({ error: message }, status);

/** 本文をJSONとして読む。壊れていれば null */
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** 長さの違いも比較時間に出さない定数時間比較 */
export function constantTimeEquals(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i % (b.length || 1)];
  return diff === 0;
}
