/**
 * 試行回数の制限。2段構えにしている。
 *
 * 1段目 CloudflareのRate Limiting binding(`ratelimits`)
 *   拠点ごとの概算で、並列に投げられるとほとんど素通りする。
 *   実測(2026/9/3、本番)では30本同時のうち429になったのは1本だけだった。
 *   安いので前段のふるいとして残すが、これだけでは止まらない。
 *
 * 2段目 D1に失敗回数を記録して断つ
 *   D1は書き込み先が1つなので数が正確になる。ここが実際の関門である。
 *
 * 失敗時に800ミリ秒待たせる処理も残してあるが、あれは総当たりを止めない。
 * Workersはリクエストを並列に処理するため、1本ずつ遅くしても同時に何本でも投げられる。
 */

const MAX_FAILURES = 5; // これを超えたら断つ
const LOCK_MINUTES = 15; // 断つ時間。最後に数えた失敗からの経過で測る

/** 発信元。CF-Connecting-IP は Cloudflare が付けるため詐称できない */
export const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";

/** 拠点ごとの概算。バインディングが無い環境(ローカル開発など)では素通しする */
async function allow(limiter, key) {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true; // 制限の仕組み自体が落ちても、本人が締め出されない側に倒す
  }
}

/** APIの総量。無料枠(1日10万リクエスト)を1つの発信元で使い切らせない */
export const allowApiRequest = (env, request) =>
  allow(env.API_LIMITER, `api:${clientIp(request)}`);

/**
 * パスワードを試してよいか。断つときは false。
 * 断っているあいだは数を増やさないので、書き込みは1つのIPにつき最大5回で頭打ちになる。
 */
export async function allowPasswordAttempt(env, request) {
  const ip = clientIp(request);
  if (!(await allow(env.AUTH_LIMITER, `password:${ip}`))) return false;
  if (!env.DB) return true;

  const row = await env.DB.prepare(
    `SELECT count FROM login_attempts
      WHERE ip = ? AND window_start > datetime('now', ?)`
  )
    .bind(ip, `-${LOCK_MINUTES} minutes`)
    .first();

  return !row || row.count < MAX_FAILURES;
}

/** 失敗を1つ数える。時間が空いていれば数え直す */
export async function recordPasswordFailure(env, request) {
  if (!env.DB) return;
  const ip = clientIp(request);
  const ago = `-${LOCK_MINUTES} minutes`;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, count, window_start)
          VALUES (?, 1, datetime('now'))
     ON CONFLICT(ip) DO UPDATE SET
          count = CASE WHEN window_start > datetime('now', ?) THEN count + 1 ELSE 1 END,
          window_start = datetime('now')`
  )
    .bind(ip, ago)
    .run();
}

/** 成功したら記録を消す。次に間違えたときにまた5回から始まる */
export async function clearPasswordFailures(env, request) {
  if (!env.DB) return;
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(clientIp(request)).run();
}
