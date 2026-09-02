#!/usr/bin/env bash
# ローカルのwrangler devに対する疎通確認。BASE と TOKEN を渡せば本番にも使える。
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${TOKEN:-$(grep '^TODO_TOKEN=' .dev.vars | cut -d= -f2-)}"
auth=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")

say() { printf '\n=== %s ===\n' "$1"; }

say "health (認証不要)"
curl -s "$BASE/api/health"

say "認証なしで一覧 → 401 のはず"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/tasks"

say "追加"
id=$(curl -s "${auth[@]}" -X POST "$BASE/api/tasks" \
  -d '{"title":"smoke test task","due":"2026-09-03"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
echo "id=$id"

say "一覧 (open)"
curl -s "${auth[@]}" "$BASE/api/tasks"

say "完了にする"
curl -s "${auth[@]}" -X PATCH "$BASE/api/tasks/$id" -d '{"done":true}'

say "一覧 (open) → 空のはず"
curl -s "${auth[@]}" "$BASE/api/tasks"

say "削除"
curl -s "${auth[@]}" -X DELETE "$BASE/api/tasks/$id"

say "通知の公開鍵"
curl -s "${auth[@]}" "$BASE/api/push/key"

say "通知の宛先を登録して消す"
curl -s "${auth[@]}" -X POST "$BASE/api/push/subscribe" -d '{"endpoint":"https://example.invalid/smoke"}'
curl -s "${auth[@]}" -X DELETE "$BASE/api/push/subscribe" -d '{"endpoint":"https://example.invalid/smoke"}'

say "不正なendpoint → 400 のはず"
curl -s -o /dev/null -w '%{http_code}
' "${auth[@]}" -X POST "$BASE/api/push/subscribe" -d '{"endpoint":"ftp://x"}'

say "存在しないidを削除 → 404 のはず"
curl -s -o /dev/null -w '%{http_code}\n' "${auth[@]}" -X DELETE "$BASE/api/tasks/999999"

printf '\n完了\n'
