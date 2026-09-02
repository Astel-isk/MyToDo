/**
 * Web Push の VAPID 鍵ペアを作る。最初に一度だけ実行し、出力を控える。
 *
 *   node tools/make-vapid.mjs
 *
 *   公開鍵 → wrangler.jsonc の vars.VAPID_PUBLIC_KEY(ブラウザに配るもので、公開してよい)
 *   秘密鍵 → npx wrangler secret put VAPID_PRIVATE_KEY と、手元の .dev.vars
 *
 * 鍵を作り直すと既存の購読は無効になり、端末で登録し直しが要る。
 */

import { webcrypto as crypto } from "node:crypto";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

// 公開鍵は非圧縮点(65バイト)。applicationServerKey がこの形を要求する
const raw = await crypto.subtle.exportKey("raw", publicKey);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);

console.log(`VAPID_PUBLIC_KEY  = ${b64url(raw)}`);
console.log(
  `VAPID_PRIVATE_KEY = ${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })}`
);
