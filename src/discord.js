/**
 * Discordのメンション付き警報。
 *
 * Web Push(毎朝8:00 JST、src/push.js)は残したまま、夕方(18:00 JST)にもう一段強い
 * 催促として、期限が今日・超過の未完了タスクがあるときだけ、本人のDiscord個人サーバーの
 * `#alerts` チャンネルへ、アプリごとのWebhook経由でメンション付きの通知を送る。
 *
 * タスクの題名・内容は載せない。Discordは他社サーバーであり、Web Pushを本文なしの
 * 「起こすだけ」にしているのと同じ理由による。
 *
 * 重複の抑止: Cron Trigger が1日1回(18:00 JST)であることに任せ、送信済みかどうかの
 * 状態は持たない。同じcronが二重に起動した場合の再送は許容する(現状そのおそれはない)。
 */

import { dueCounts } from "./push.js";

const TODO_URL = "https://todo.astelisk.com";

const configured = (env) => Boolean(env.DISCORD_WEBHOOK_URL && env.DISCORD_USER_ID);

/**
 * 件数からWebhookのペイロードを組み立てる。対象が0件なら null(送らない)。
 * 片方が0件のときはその項目を省く。
 */
export function buildAlertBody(userId, { dueToday, overdue }) {
  const parts = [];
  if (dueToday > 0) parts.push(`期限が今日の未完了${dueToday}件`);
  if (overdue > 0) parts.push(`期限切れ${overdue}件`);
  if (parts.length === 0) return null;

  return {
    content: `<@${userId}> ToDo: ${parts.join("・")}\n${TODO_URL}`,
    allowed_mentions: { users: [userId] },
  };
}

/** Webhookへ投げる。送信失敗(fetch例外・非2xx)は外へ投げず、ログに残すだけ */
async function post(webhookUrl, body) {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.error("Discord警報: 送信失敗", response.status);
    }
  } catch (err) {
    console.error("Discord警報: 送信例外", err);
  }
}

/** Cron Trigger(18:00 JST)から呼ばれる */
export async function notifyUrgent(env) {
  if (!configured(env)) {
    console.log("Discord警報: DISCORD_WEBHOOK_URL / DISCORD_USER_ID が未設定のため送らない");
    return { skipped: "未設定" };
  }

  const counts = await dueCounts(env);
  const body = buildAlertBody(env.DISCORD_USER_ID, counts);
  if (!body) return { skipped: "対象なし" };

  await post(env.DISCORD_WEBHOOK_URL, body);
  return { sent: true, ...counts };
}
