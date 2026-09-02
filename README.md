# MyToDo

自作のToDoアプリ。Cloudflare Workers + D1 + KV の上で動き、**PWA**として使い、同時に**MCPサーバ**としてClaudeのカスタムコネクタから読み書きできる。

公開URL: https://todo.astelisk.workers.dev

## なぜ作ったか

コネクタで接続できるToDoリストのアプリがなかったため(2026/9/2着手)。要件は2つ。

1. **常時稼働のPCを持たない前提で動くこと** — サーバレスにし、リクエスト時だけ起動する
2. **スマホ(Android / Galaxy S25)からアプリとして起動できること** — Notionを開いて目的のページまで辿る手間をなくすことが主な動機。利用機会はスマホが最も多い

## 決めたこと(2026/9/2)

- **OAuthまで実装する** — claude.aiの設定画面にヘッダ認証の欄がないため、スマホのClaudeアプリから使うには自前のOAuth認可サーバが要る
- **PIRのタスク台帳とは役割を分ける** — このアプリは日々の実行タスク(買い物・提出物・雑務)、台帳はClaudeとの運用に関わる事項(確認待ち・手続き)。同期はしない。この分担はMCPツールの説明文にも書いてある
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

### ファイル

| パス | 役割 |
|---|---|
| `src/index.js` | OAuthProviderの組み立てとルーティング |
| `src/app-handler.js` | PWAとREST APIのハンドラ(defaultHandler) |
| `src/api.js` | タスクのCRUD。RESTとMCPで共有する |
| `src/auth.js` | 3経路の認証、クッキーの署名と検証 |
| `src/authorize.js` | OAuthの同意画面 |
| `src/mcp.js` | MCPツール5つの定義 |
| `src/http.js` | 共通ヘルパ |
| `schema.sql` / `migrations/` | 初期スキーマと追加分 |
| `public/` | PWA一式(HTML / CSS / JS / manifest / Service Worker) |
| `tools/make-icons.mjs` | アイコンPNG生成(Node標準の zlib のみ) |
| `tools/oauth-smoke.mjs` | OAuth登録〜ツール呼び出しの通し確認 |
| `smoke.sh` | REST APIの疎通確認 |

### Cloudflare側のリソース

- Worker `todo`
- D1 `todo`(uuid `8baccd43-e7e0-4674-94b7-8b876bce991b`、APAC)
- KV `todo-oauth`(id `744b365434e74420a4551b67354ee437`、`OAUTH_KV` としてバインド)
- シークレット3つ: `TODO_TOKEN`(スクリプト用)、`TODO_PASSWORD`(ログイン)、`COOKIE_SECRET`(セッション署名)

すべて無料枠に収まる。9/16以降に `astelisk.com` を取得したら `todo.astelisk.com` へ付け替えられる。

## 開発

```sh
npm install
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # .dev.vars の値を作る
npx wrangler d1 execute todo --local --file=schema.sql
npx wrangler d1 execute todo --local --file=migrations/002_tags.sql
npx wrangler dev
```

`.dev.vars`(gitignore済み)に `TODO_TOKEN` / `TODO_PASSWORD` / `COOKIE_SECRET` を置く。

### 検証

| 対象 | 方法 |
|---|---|
| REST API | `./smoke.sh`(本番は `BASE=... TOKEN=... ./smoke.sh`) |
| OAuthとMCP | `node tools/oauth-smoke.mjs` — 登録→同意→トークン→5ツールの呼び出しまで通す |
| PWA | ブラウザで操作。375px幅とダークモードを確認する |

## 状態(2026/9/3)

段階1〜3まで完了し、本番で動作している。

- REST API・PWA・MCPサーバのすべてが本番で確認済み
- スマホのホーム画面から起動して操作できることを実機で確認済み
- Claudeのカスタムコネクタとして登録し、`list_tasks` と `add_task` の往復を確認済み
- GUIは2026/9/3に作り直した(無彩色のダーク基調、期限による区分け、下部固定の入力欄)
- タグを2026/9/3に実装した。行に表示し、ヘッダのチップで絞り込む(複数選択はOR)
- タグの新規作成は本人が画面から明示的に行うときだけに限る。入力欄は既存タグを押して選ぶ形で、
  「＋ 新規」から名前を入れると、その場に確認が出てから作られる。APIは許可した名前以外の作成を拒む
  (`allowNewTags`)。MCPからは新規作成できず、未知の名前は使えるタグを添えて断る

### 残っていること

1. **Service Workerの動作確認** — オフライン時に画面の骨組みが出るか。開発用の埋め込みブラウザでは登録が拒否され未検証
2. **初回で見送った機能の候補** — 期限のプッシュ通知(Web Push + Cron Trigger)、繰り返しタスク。使ってみて必要になったら足す
