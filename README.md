# MyToDo

自作のToDoアプリ。Cloudflare Workers + D1 + KV の上で動き、**PWA**として使い、同時に**MCPサーバ**としてClaudeのカスタムコネクタから読み書きできる。

公開URL: https://todo.astelisk.com

旧URL `https://todo.astelisk.workers.dev` は2026/9/9に閉じた(PWA・コネクタ・通知の宛先を移設後)。

## なぜ作ったか

コネクタで接続できるToDoリストのアプリがなかったため(2026/9/2着手)。要件は2つ。

1. **常時稼働のPCを持たない前提で動くこと** — サーバレスにし、リクエスト時だけ起動する
2. **スマホ(Android / Galaxy S25)からアプリとして起動できること** — Notionを開いて目的のページまで辿る手間をなくすことが主な動機。利用機会はスマホが最も多い

## 決めたこと(2026/9/2)

- **OAuthまで実装する** — claude.aiの設定画面にヘッダ認証の欄がないため、スマホのClaudeアプリから使うには自前のOAuth認可サーバが要る
- **PIRのタスク台帳とは役割を分ける** — このアプリは日々の実行タスク(買い物・提出物・雑務)、台帳はClaudeとの運用に関わる事項(確認待ち・手続き)。同期はしない。この分担はMCPツールの説明文にも書いてある
- **追加前の重複確認は期限の範囲で絞って行う**(2026/10/3) — `list_tasks` に `due_from` / `due_to`(両端を含む。指定すると期限のないものは除く)を足し、`add_task` の説明文に「完了済みを含め、期限の前後7日で同じタスクがないか確認してから追加する」と書いた。完了済みを全件読むと、件数とともに読む量が増え続けるため。似たタイトルをサーバ側で自動判定する案は、確認の手順が守られても重複が出た場合に足す
- **初回リリースは最小構成** — 追加・一覧・完了・削除と期限だけ(タグは2026/9/3に追加)

## 構成

```
                    OAuthProvider (Workerの入口 / src/index.js)
                    ├─ /mcp              → MCPサーバ(アクセストークンで保護)
                    ├─ /oauth/token      → ライブラリが処理
                    ├─ /oauth/register   → ライブラリが処理(動的クライアント登録)
                    └─ それ以外          → src/app-handler.js
                                            ├─ /authorize  OAuthの同意画面
                                            ├─ /api/*      REST API
                                            └─ 静的ファイル PWA本体(public/)
```

認証は3経路。いずれも同じ `tasks` テーブルを見る。

| 経路 | 方式 |
|---|---|
| PWA(スマホ・ブラウザ) | パスワード → 署名付きHttpOnlyクッキー(90日) |
| Claude(全クライアント) | OAuth 2.1 アクセストークン(PKCE / S256) |
| スクリプト・疎通確認 | `TODO_TOKEN` の Bearer |

パスワードを受ける経路(ログイン画面とOAuthの同意画面)には試行回数の制限がある。詳細は「総当たりへの備え」。

### ファイル

| パス | 役割 |
|---|---|
| `src/index.js` | OAuthProviderの組み立てとルーティング |
| `src/app-handler.js` | PWAとREST APIのハンドラ(defaultHandler) |
| `src/api.js` | タスクのCRUD。RESTとMCPで共有する |
| `src/auth.js` | 3経路の認証、クッキーの署名と検証 |
| `src/authorize.js` | OAuthの同意画面 |
| `src/ratelimit.js` | 試行回数の制限(パスワードとAPIの総量) |
| `src/mcp.js` | MCPツール6つの定義 |
| `src/push.js` | プッシュ通知(VAPIDの署名・送信・宛先の管理、`dueCounts` による期限の集計) |
| `src/discord.js` | Discordのメンション付き警報(Webhookへの送信) |
| `src/myfit-sync.js` | myFITの課題の同期。規則の純粋関数 `planSync`、DBへの反映 `applySync`、締切の読み出し `listDue` |
| `src/http.js` | 共通ヘルパ |
| `schema.sql` / `migrations/` | 初期スキーマと追加分 |
| `public/` | PWA一式(HTML / CSS / JS / manifest / Service Worker) |
| `tools/make-icons.mjs` | アイコンPNG生成(Node標準の zlib のみ) |
| `tools/make-vapid.mjs` | 通知に使うVAPID鍵ペアの生成(最初に一度だけ) |
| `tools/oauth-smoke.mjs` | OAuth登録〜ツール呼び出しの通し確認 |
| `smoke.sh` | REST APIの疎通確認 |

### Cloudflare側のリソース

- Worker `todo`(Cron Trigger 2つ: `0 23 * * *` = 毎日8:00 JST〈Web Push〉、`0 9 * * *` = 毎日18:00 JST〈Discordの警報〉)
- D1 `todo`(uuid `8baccd43-e7e0-4674-94b7-8b876bce991b`、APAC)
- KV `todo-oauth`(id `744b365434e74420a4551b67354ee437`、`OAUTH_KV` としてバインド)
- Rate Limiting binding 2つ(`AUTH_LIMITER` 5回/60秒、`API_LIMITER` 120回/60秒)
- シークレット6つ: `TODO_TOKEN`(スクリプト用)、`TODO_PASSWORD`(ログイン)、`COOKIE_SECRET`(セッション署名)、
  `VAPID_PRIVATE_KEY`(通知の署名)、`DISCORD_WEBHOOK_URL`(Discordの警報の送信先)、`DISCORD_USER_ID`(メンション先)

すべて無料枠に収まる。

`astelisk.com` は2026/9/9に取得し、同日 `todo.astelisk.com` をCustom Domainとして割り当てた。
`routes` を書くとworkers.devの経路は既定で切れる。移行中だけ `"workers_dev": true` で両方を生かし、
移設が済んだ時点で `false` に戻した(同日)。最初にこれを知らずデプロイし、新ドメインのDNSが
行き渡る前に旧URLが404になって1分ほど落ちた。

移行に伴う後始末: プッシュ通知の宛先はオリジンごとに別物になるため、旧オリジンの購読(2026/9/2登録)を
`push_subscriptions` から削除した。放置すると毎朝2通届く。

## 開発

```sh
npm install
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # .dev.vars の値を作る
npx wrangler d1 execute todo --local --file=schema.sql
npx wrangler d1 execute todo --local --file=migrations/002_tags.sql
npx wrangler d1 execute todo --local --file=migrations/003_push.sql
npx wrangler d1 execute todo --local --file=migrations/004_login_attempts.sql
npx wrangler d1 execute todo --local --file=migrations/005_myfit_links.sql
npx wrangler dev
```

`.dev.vars`(gitignore済み)に `TODO_TOKEN` / `TODO_PASSWORD` / `COOKIE_SECRET` / `VAPID_PRIVATE_KEY` を置く。
Discordの警報(下記)をローカルで試す場合は `DISCORD_WEBHOOK_URL` / `DISCORD_USER_ID` も同様に置く。
未設定でも他の機能の開発には支障がない(警報だけが送られない)。

```sh
npm test   # Discordの警報の本文生成・secret未設定時の抑止・fetch失敗時の扱い、一覧の期限範囲の絞り込み、myFIT課題の同期の規則をnode:testで検証
```

### 検証

| 対象 | 方法 |
|---|---|
| REST API | `./smoke.sh`(本番は `BASE=... TOKEN=... ./smoke.sh`) |
| OAuthとMCP | `node tools/oauth-smoke.mjs` — 登録→同意→トークン→6ツールの呼び出しまで通す |
| PWA | ブラウザで操作。375px幅とダークモードを確認する |
| 通知の送信(Web Push) | `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+23+*+*+*"` でcronを手で起こす。結果はログに出る |
| 通知の受信(Web Push) | 実機で「通知」を入りにしてから `POST /api/push/test`(期限の有無によらず1通送る) |
| Discordの警報の送信 | `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=0+9+*+*+*"` でcronを手で起こす。結果はログに出る。実際にDiscordへ送るには `.dev.vars` に本物のWebhook URLとユーザーIDが要る |
| Discordの警報の組み立て・抑止 | `npm test`(node:test。fetchはモックし、実際の送信は行わない) |
| 一覧の期限範囲の絞り込み | `npm test`(node:sqliteのメモリDBに本物のスキーマを当てる。Node 22.13未満では飛ばされる) |
| myFIT課題の同期の規則 | `npm test`(`planSync` は純粋関数の単体テスト。`applySync` はメモリDBに schema.sql と migrations 002〜005 を当てて通す) |

## 総当たりへの備え

公開リポジトリにするとURLが見つけやすくなるため、パスワードの総当たりに備えている(2026/9/3)。

失敗時に800ミリ秒待たせる処理は**総当たりを止めない**。Workersはリクエストを並列に処理するので、
1本ずつ遅くしても同時に何本でも投げられる。そこで実際に回数を数える。

| 段 | 仕組み | 実測(本番、2026/9/3) |
|---|---|---|
| 1 | CloudflareのRate Limiting binding | 40本同時のうち止まったのは概ね1本。**これだけでは効かない** |
| 2 | D1に失敗回数を記録し、IPごとに5回で15分断つ | 逐次10回 → 5回目まで401、6回目以降は429。40本同時 → 通ったのは9本、残り31本は429 |

2段目が実際の関門である。D1は書き込み先が1つなので数が正確になる。同時に投げると数え切る前に
数本が通るが、通ったあとは断たれ続ける。攻撃者が試せるのは15分あたり10回弱に収まる。

- 断っているあいだは数を増やさないので、書き込みは1つのIPにつき最大5回で頭打ちになる
- ログインに成功すると記録を消す
- IPを変えられると1段目も2段目も回避できる。ここを塞ぐには全体の上限が要るが、それは本人を
  締め出す手段にもなるため置いていない
- 3段目としてCloudflareのRate Limiting Ruleを置いた(2026/9/9、独自ドメインへ移して使えるようになった)。
  Workerが動く前に弾くため、無料枠の消費を防げる
  - 条件は `/api/` で始まるパス、IPごとに10秒で20回を超えたら10秒Block
  - 無料プランの制約: ルールは1つ、条件に使えるのはパスのみ、計測期間もブロック時間も10秒固定、
    数える単位はIPのみ。じわじわ試す総当たりには効かない(そちらは2段目が止める)
  - 20回の根拠: 通常の利用で1回アプリを開いて発生するAPI呼び出しは2〜3回。上限としては、
    1つのIPが1日に出せるAPIリクエストが約86,000回に抑えられ、無料枠の10万を下回る
  - 実測(2026/9/9): 30本同時 → 23本が200、7本が429(`Retry-After: 10`、Cloudflareが返す1015)。
    counterは拠点ごとに遅延があるため20をやや超えて通る。12秒後には復帰。画面のファイルは対象外で影響なし

## プッシュ通知

期限が今日・超過のタスクがあれば、**毎朝8時(JST)に要約を1通**送る。無い日は送らない。

送るのは本文の入らない「起こすだけ」のpushで、通知の文面はService Workerが `/api/tasks` を読んで組み立てる。
本文を積む形はRFC 8291の暗号化(ECDH + HKDF + AES-GCM)が要るのに対し、この形はVAPIDの署名だけで済む。
代わりに、通知が出る時点で通信とセッションが要る(読めなければ「期限のあるタスクを確認してください」に落ちる)。

```
Cron Trigger (0 23 * * *)
  └─ src/index.js の scheduled → notifyDue()
       ├─ 期限が今日・超過の未完了タスクを数える。0件なら送らない
       └─ push_subscriptions の各宛先へ空のpushを投げる(404/410 が返った宛先は消す)
            └─ 端末の Service Worker が push を受け、/api/tasks を読んで通知を出す
```

- 宛先は端末ごとに1行。画面右上の「通知」で入り切りする(許可の要求はブラウザの操作を伴うため、押したときにしか出せない)
- 鍵は `tools/make-vapid.mjs` で作る。公開鍵は `wrangler.jsonc` の vars、秘密鍵はシークレット。
  **作り直すと既存の購読は無効になり、端末で登録し直しが要る**
- iOSは対象外(Androidのみ)。ホーム画面から起動したPWAで動く

## Discordの警報(2026/9/25)

Web Push(上記、毎朝8:00 JST)とは別に、**夕方18:00 JST**にもう一段強い催促として、
Discordの個人サーバーの `#alerts` チャンネルへ、アプリごとのWebhook経由でメンション付きの
通知を送る。危うい場面(期限が今日・超過の未完了タスクがある)だけ送り、無ければ何も送らない。

Web Pushと違い、Discordは他社サーバーであるためタスクの題名・内容は載せない。件数だけを伝える。

```
Cron Trigger (0 9 * * *)
  └─ src/index.js の scheduled → notifyUrgent() (src/discord.js)
       ├─ 期限が今日・超過の未完了タスクを数える(push.js の dueCounts、Web Pushと同じ基準)
       ├─ 0件なら送らない。DISCORD_WEBHOOK_URL / DISCORD_USER_ID が未設定でも送らない
       └─ Webhookへ POST { content: "<@ユーザーID> ToDo: ...", allowed_mentions: { users: [ユーザーID] } }
```

- 本文の例: `<@ユーザーID> ToDo: 期限が今日の未完了2件・期限切れ1件`(片方が0件ならその項目を省く)
- `username` は指定しない。送り主はWebhookに設定した名前(`ToDo`)のまま
- 送信失敗(fetch例外・非2xxレスポンス)は `console.error` に残し、例外は外へ投げない(cronを壊さない)
- 重複の抑止: Cron Triggerが1日1回であることに任せ、送信済みかどうかの状態は持たない
- 設定はシークレット2つ。値そのものは公開リポジトリに書かないため、ここには手順だけを置く

```sh
npx wrangler secret put DISCORD_WEBHOOK_URL   # Discordのチャンネル設定 → 連携サービス → Webhook のURL
npx wrangler secret put DISCORD_USER_ID       # 開発者モードでユーザーを右クリック →「ユーザーIDをコピー」
```

## myFITの課題の同期(TodoSync)

myFIT(大学のLMS)の課題を、タスクとして自動で作成・更新・完了する。課題の「未提出」の印と、
MyToDoの完了とが別々に管理されていたため、1つにまとめる目的。経路は次のとおり。

```
Chrome拡張(myfit-front) → PUT /api/myfit/assignments → MyBrief
  → Service Binding(RPC) → MyToDo の TodoSync.syncAssignments(items)
```

MyBriefが受け取った一覧を、許可リストを通した後の形で渡してくる。呼ぶ条件や `TODO_SYNC` の運用は
MyBriefのDESIGN.md §17が正で、ここには受け側の仕様だけを置く。

### TodoSync(RPC)

`src/index.js` の名前付きexport `TodoSync`(WorkerEntrypoint)。**Service Bindingからしか届かない**。
公開URL(todo.astelisk.com)のルーティングには乗らず、PWA・REST API・MCPとは別の入口である。

| メソッド | 内容 |
|---|---|
| `syncAssignments(items)` | 課題の一覧をタスクへ反映し、件数 `{created, updated, completed}` を返す。items は配列であることだけを確かめる(中身の検証は送り側のMyBriefが許可リストで済ませている) |
| `listDue(dueTo)` | dueTo(`YYYY-MM-DD`、不正なら例外)以前が期限の未完了タスク。期限切れを含み、期限なしは含まない。`{id, title, due, note, tags}` だけを返す。MyBriefの `GET /api/todo/due` が使う |

課題の1件は `{courseCode, courseName, name, start, end, status, unsubmitted}`。start・end は日本時間の
`YYYY-MM-DD HH:mm` か空文字。ログに科目名・課題名・タスク名は出さない(件数だけ)。

### myfit_links

課題とタスクの結び付き(`migrations/005_myfit_links.sql`)。1行が1課題。

| 列 | 内容 |
|---|---|
| `key` | 課題の同一性。`JSON.stringify([courseCode, name])` |
| `task_id` | 結び付いたタスクのid。**NULL は「対象外」**で、同期は何もしない |
| `last_end` | 最後に反映した end。締切の変更を見分けるために使う |

`tasks` への外部キーは張らない。タスクは画面やMCPからいつでも消されうるため、CASCADEなら行も消えて
次の同期でタスクが作り直され、消した意図が覆る。制限にすると、結び付いたタスクを消せなくなる。
行を残したまま、タスクが無ければ「削除済み」として扱う。

既存のタスクと突き合わせる(同じ課題のタスクを重複して作らせない)には、その課題の行を先に入れておく。
既存のタスクに結び付けるなら `task_id` にそのid、同期の対象から外すなら NULL にする。

```sh
npx wrangler d1 execute todo --remote --command "INSERT INTO myfit_links (key, task_id, last_end) VALUES ('[\"A123\",\"第3回レポート\"]', NULL, NULL)"
```

### 規則

key が同じ課題が一覧に2度出たら、最初の1件だけを見る。

| 記号 | 条件 | 操作 |
|---|---|---|
| a | 未提出、end が空でない、end が現在(JST)より後、key が myfit_links に無い | タスクを作成し、myfit_links に行を足す |
| b | 提出済み、key が links にあり task_id が非NULL、タスクが存在して未完了 | 完了にする(end が変わっていても完了だけ) |
| c | 未提出、同上(links・task_id・存在・未完了)、end が空でなく last_end と違う | 期限とメモを作り直し、last_end を更新する |
| d | それ以外 | 何もしない |

d の具体例: task_id が NULL(対象外)、タスクが完了済み・削除済み(作り直さない・開き直さない)、
一覧から消えた課題、締切を過ぎた未連携の課題、連携済みで end が空文字になったもの。

作成するタスクの形:

- 題名: `<科目名(空なら科目コード)> <課題名>を提出する`
- 期限: end の日付部分
- メモ: `myFIT・締切 HH:mm`
- タグ: 「学業」が存在すればそれを付ける。無ければ付けない(`setTags` は存在しないタグを作るため、
  `findUnknownTags` で確かめてから渡す)

更新・完了は `api.js` の `updateTask` を使うので、`done_at`・`updated_at` の扱いは手入力のタスクと同じ。
作成だけは、タスクと `myfit_links` の行を1つの `batch`(トランザクション)で書く。別々に書くと、
行の記録だけが失敗したときに次の同期で同じ課題のタスクがもう1つ作られるため。同期が2本並行して
同じ課題を作ろうとしても、後の方は key の重複で丸ごと取り消される(例外はMyBriefのログに残り、
残りの課題は次の取り込みで反映される)。

### マイグレーション 005 の適用

MyBrief側の同期は既定で off なので、先にMyToDoだけを反映してよい。順序は次のとおり。

```sh
npx wrangler d1 execute todo --remote --file=migrations/005_myfit_links.sql   # 1. テーブルを作る
npx wrangler deploy                                                            # 2. TodoSync を含めてデプロイする
```

その後でMyBriefをデプロイする(binding の宛先 `TodoSync` が先に存在している必要がある)。
`TODO_SYNC` を on にするのは、既存のタスクとの突き合わせを済ませてから。

### 既知のリスク

- **課題名の変更で二重になる**: key は課題名を含むため、先生が課題名を変えると別の課題と見なされ、
  タスクが二重になる。古い方は手で消す(消したタスクは作り直されない)
- **締切後の印の挙動は未確認**: unsubmitted はmyFITの「未提出」の列から作られる。締切後の受付終了で、
  提出していなくても印が消えるかは確かめていない。消える場合は、未提出のまま締切を過ぎた課題が
  自動で完了になる

## 画面(2026/9/16)

見た目と操作の形は、自作アプリ(My〇〇系)で共通のGUI規約に揃えている。規約そのものは非公開の個人リポジトリにあり、
ここにはMyToDo固有の決定だけを置く。規約を満たす参照実装はMyMoneyの `public/style.css`。

- **下部ナビは「やること」「完了」「設定」** — 以前の「完了分」の切り替えは完了タブになった。完了タブは完了した日ごとにまとめる
- **ホームの主役は「今日までにやること」の件数** — 期限が今日・超過の未完了タスクを数え、期限切れがあれば「うち期限切れ ◯件」を添える。
  朝の通知と同じ基準。0件なら次の期限を出す。その下に、これまでどおり期限による区分けの一覧を置く
- **追加はナビの上の「やることを追加」から下のシートで行う** — 押すと題名欄にフォーカスが当たり、キーボードが上がる。
  タップ回数は以前の常設の入力欄と同じ。期限は「今日/明日/なし」のチップと日付指定、タグは既存タグを押して選び、
  「＋ 新しいタグ」から確認を挟んで作る(作成の決まりは下の「状態」のとおり)
- **行のチェックで完了し、行を押すと編集シートが開く** — 完了・未完了に戻す・追加の直後は「取り消す」を5秒出す。
  編集シートでは題名・期限・タグを変えられ、削除もここで内容を確認してから行う
- **タグの削除とログアウトは設定タブ** — 絞り込みのチップは、やること・完了タブの上部に固定したまま残す
- 題名欄とタグ名の欄のEnterは、日本語入力の変換確定(`isComposing`)では送信しない

## 状態(2026/9/3)

段階1〜3まで完了し、本番で動作している。

- REST API・PWA・MCPサーバのすべてが本番で確認済み
- スマホのホーム画面から起動して操作できることを実機で確認済み
- Claudeのカスタムコネクタとして登録し、`list_tasks` と `add_task` の往復を確認済み
- GUIは2026/9/3に作り直した(無彩色のダーク基調、期限による区分け、下部固定の入力欄)。
  2026/9/16に共通のGUI規約へ揃え直した(上の「画面」)
- タグを2026/9/3に実装した。行に表示し、ヘッダのチップで絞り込む(複数選択はOR)
- タグはタスクと独立して存在する(2026/9/3改定)。`POST /api/tags` で単独に作り、
  `DELETE /api/tags/:name` で消す。タスクが1件も付いていないタグも一覧に残るため、
  先に語彙を決めてから使える。孤立したタグの自動削除は廃止した
  - 改定前は、タグはそれを持つタスクを保存したときにしか作られなかった。画面でタグだけを
    4つ作った本人の操作が保存されず、再読み込みで消えた(2026/9/3)。原因は
    「タグはタスクの属性」という設計と「先に語彙を決める」という使い方の食い違い
- タグの新規作成は本人が画面から明示的に行うときだけに限る。入力欄は既存タグを押して選ぶ形で、
  「＋ 新規」から名前を入れると、その場に確認が出てから作られる。APIはタスクに未知のタグを
  付けようとすると使えるタグを添えて断る。MCPからも新規作成はできない
- タグの削除は設定タブから行う(2026/9/16までは絞り込みの「編集」から)。
  影響するタスクの件数を見せてから確認する。タグを消してもタスクは残る
- プッシュ通知を2026/9/3に実装した。Galaxy S25への着信を実機で確認済み(`POST /api/push/test`)。
  あわせて、Service Workerが本番で登録され動作することも確かめられた(通知はSWの上で動くため)

### 残っていること

1. **オフライン時の表示** — 通信できないときに画面の骨組みが出るか。Service Workerの登録と稼働は
   通知が届いたことで確認できたが、キャッシュからの表示は未検証
2. **朝8時のcronの初回** — 手で起こした送信は確認済み。定時起動は2026/9/4の朝が最初になる
3. **初回で見送った機能の候補** — 繰り返しタスク。使ってみて必要になったら足す
