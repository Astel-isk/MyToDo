import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { buildAlertBody, notifyUrgent } from "../src/discord.js";

const USER_ID = "111111111111111111"; // ダミー値。実際のIDではない
const WEBHOOK_URL = "https://discord.example.invalid/api/webhooks/dummy";

function makeEnv({ dueToday = 0, overdue = 0, withSecrets = true } = {}) {
  return {
    ...(withSecrets ? { DISCORD_WEBHOOK_URL: WEBHOOK_URL, DISCORD_USER_ID: USER_ID } : {}),
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ due_today: dueToday, overdue }),
        }),
      }),
    },
  };
}

test("buildAlertBody: 両方0件なら null(送らない)", () => {
  assert.equal(buildAlertBody(USER_ID, { dueToday: 0, overdue: 0 }), null);
});

test("buildAlertBody: 期限切れが0件なら期限切れの文言を省く", () => {
  const body = buildAlertBody(USER_ID, { dueToday: 2, overdue: 0 });
  assert.equal(body.content, `<@${USER_ID}> ToDo: 期限が今日の未完了2件\nhttps://todo.astelisk.com`);
});

test("buildAlertBody: 今日の分が0件なら今日の分の文言を省く", () => {
  const body = buildAlertBody(USER_ID, { dueToday: 0, overdue: 3 });
  assert.equal(body.content, `<@${USER_ID}> ToDo: 期限切れ3件\nhttps://todo.astelisk.com`);
});

test("buildAlertBody: 両方あれば「・」で繋ぎ、メンションとallowed_mentionsを持つ", () => {
  const body = buildAlertBody(USER_ID, { dueToday: 2, overdue: 1 });
  assert.equal(
    body.content,
    `<@${USER_ID}> ToDo: 期限が今日の未完了2件・期限切れ1件\nhttps://todo.astelisk.com`
  );
  assert.ok(body.content.startsWith(`<@${USER_ID}>`));
  assert.deepEqual(body.allowed_mentions, { users: [USER_ID] });
  assert.equal(body.username, undefined);
});

test("notifyUrgent: secretが未設定なら送らない(fetchを呼ばない)", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("呼ばれてはいけない");
  });

  const result = await notifyUrgent(makeEnv({ dueToday: 5, withSecrets: false }));

  assert.equal(result.skipped, "未設定");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("notifyUrgent: 対象0件なら送らない(fetchを呼ばない)", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("呼ばれてはいけない");
  });

  const result = await notifyUrgent(makeEnv({ dueToday: 0, overdue: 0 }));

  assert.equal(result.skipped, "対象なし");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("notifyUrgent: fetchが失敗しても例外を外に投げない", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ネットワークエラー(模擬)");
  });

  await assert.doesNotReject(async () => {
    const result = await notifyUrgent(makeEnv({ dueToday: 1, overdue: 0 }));
    assert.equal(result.sent, true);
  });
});

test("notifyUrgent: 非2xxレスポンスでも例外を外に投げない", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 500 }));

  await assert.doesNotReject(async () => {
    await notifyUrgent(makeEnv({ dueToday: 1, overdue: 2 }));
  });
});

test("notifyUrgent: 送信時はWebhook URLへ正しいペイロードでPOSTする", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 204 }));

  await notifyUrgent(makeEnv({ dueToday: 1, overdue: 1 }));

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, WEBHOOK_URL);
  assert.equal(init.method, "POST");
  const payload = JSON.parse(init.body);
  assert.equal(payload.content, `<@${USER_ID}> ToDo: 期限が今日の未完了1件・期限切れ1件\nhttps://todo.astelisk.com`);
  assert.deepEqual(payload.allowed_mentions, { users: [USER_ID] });
});
