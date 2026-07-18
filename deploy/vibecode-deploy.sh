#!/usr/bin/env bash
# vibecode-deploy.sh — deploy a Nuxt 4 / Nitro app to a Bitrix24 Vibecode Black Hole server.
#
# Idempotent: finds a server by APP_NAME, creates it if missing, waits until the tunnel
# is CONNECTED, then runs a full deploy (install → optional preStart → start on :3000).
# Pulls source straight from a public archive URL (both bx-shef repos are public), so no
# git token is needed on the VM.
#
# Requires (env):
#   VIBE_KEY     vibe_api_...  (personal key; owns the server + billing)
#   APP_NAME     server/app name, e.g. "client-bank-alfa-by"
#   SOURCE_URL   tar.gz of the exact commit, e.g.
#                https://codeload.github.com/bx-shef/client-bank-alfa-by/tar.gz/<sha>
#   ENV_JSON     JSON object of RUNTIME env for the app (secrets: B24_*, DATABASE_URL, ...)
# Optional (env, with defaults):
#   VIBE_BASE    default https://vibecode.bitrix24.tech/v1
#   VIBE_PLAN    default bc-micro   (only bc-micro is allowed on RU/BY demo access)
#   VIBE_REGION  default ru-central1-b
#   VIBE_RUNTIME default node22
#   INSTALL_CMD  default: cd /opt/app && corepack enable && pnpm install --frozen-lockfile && pnpm build
#   PRESTART_CMD default: (empty) — put pg/redis provisioning + apt toolchain here
#   START_CMD    default: cd /opt/app && HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs
#   PORT         default 3000  (Black Hole always tunnels :3000 — don't change without reason)
#   ACCESS_POLICY  default PUBLIC — REQUIRED for self-OAuth B24 apps (webhook + cross-portal iframe)
#
# NOTE: written against the documented Deploy API (docs: /docs/infra, /docs/infra/deploy).
# Verify the FIRST run interactively (see runbook) before trusting it in CI.

set -euo pipefail

: "${VIBE_KEY:?set VIBE_KEY (vibe_api_...)}"
: "${APP_NAME:?set APP_NAME}"
: "${SOURCE_URL:?set SOURCE_URL (public tar.gz of the build context)}"
: "${ENV_JSON:={}}"

BASE="${VIBE_BASE:-https://vibecode.bitrix24.tech/v1}"
PLAN="${VIBE_PLAN:-bc-micro}"
REGION="${VIBE_REGION:-ru-central1-b}"
RUNTIME="${VIBE_RUNTIME:-node22}"
INSTALL_CMD="${INSTALL_CMD:-cd /opt/app && corepack enable && pnpm install --frozen-lockfile && pnpm build}"
PRESTART_CMD="${PRESTART_CMD:-}"
START_CMD="${START_CMD:-cd /opt/app && HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs}"
PORT="${PORT:-3000}"
ACCESS_POLICY="${ACCESS_POLICY:-PUBLIC}"

api() { curl -fsS -H "X-Api-Key: $VIBE_KEY" "$@"; }

echo "==> Looking up server '$APP_NAME'"
sid="$(APP_NAME="$APP_NAME" api "$BASE/infra/servers" | python3 -c '
import sys, json, os
d = json.load(sys.stdin)
name = os.environ["APP_NAME"]
print(next((s["id"] for s in d.get("data", []) if s.get("name") == name), ""))
')"

if [ -z "$sid" ]; then
  echo "==> Not found. Creating (provider=bitrix-cloud plan=$PLAN region=$REGION)"
  sid="$(api -X POST "$BASE/infra/servers" -H 'Content-Type: application/json' \
    -d "{\"provider\":\"bitrix-cloud\",\"name\":\"$APP_NAME\",\"plan\":\"$PLAN\",\"region\":\"$REGION\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"
fi
echo "    server id: $sid"

echo "==> Waiting for status=running AND blackholeStatus=CONNECTED"
st=""; bh=""
for _ in $(seq 1 90); do
  # Tolerate a transient poll error: `|| true` keeps a network/HTTP blip from tripping
  # `set -e`/`pipefail` and aborting the whole deploy mid-wait — we just retry next tick.
  line="$(api "$BASE/infra/servers/$sid" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("status"),d.get("blackholeStatus"))' 2>/dev/null || true)"
  read -r st bh <<<"$line" || true
  echo "    status=${st:-?} blackhole=${bh:-?}"
  [ "${st:-}" = "running" ] && [ "${bh:-}" = "CONNECTED" ] && break
  [ "${st:-}" = "error" ] && { echo "server entered error state"; exit 1; }
  sleep 10
done
# Timed out without CONNECTED → do NOT proceed to deploy against a not-ready server.
[ "${st:-}" = "running" ] && [ "${bh:-}" = "CONNECTED" ] || {
  echo "timed out waiting for running+CONNECTED (last: status=${st:-?} blackhole=${bh:-?})"; exit 1
}

echo "==> Setting accessPolicy=$ACCESS_POLICY"
# PUBLIC is REQUIRED for this app (webhook + cross-portal iframe), but this call is SOFT on
# purpose: the exact access-policy endpoint/shape must be confirmed on the first live run
# (docs/DEPLOY_VIBECODE.md). A failure here does NOT abort the deploy — VERIFY the policy is
# actually PUBLIC in the cabinet after the first deploy; otherwise the webhook/iframe break.
api -X PATCH "$BASE/infra/servers/$sid/access-policy" -H 'Content-Type: application/json' \
  -d "{\"accessPolicy\":\"$ACCESS_POLICY\"}" >/dev/null || \
  echo "    (access-policy call failed — set it MANUALLY in the cabinet; PUBLIC is required)"

echo "==> Deploying"
body="$(python3 - <<'PY'
import json, os
d = {
    "source":  {"url": os.environ["SOURCE_URL"]},
    "runtime": os.environ["RUNTIME"],
    "install": os.environ["INSTALL_CMD"],
    "start":   os.environ["START_CMD"],
    "port":    int(os.environ["PORT"]),
    "env":     json.loads(os.environ["ENV_JSON"]),
}
pre = os.environ.get("PRESTART_CMD", "")
if pre:
    d["preStart"] = pre
print(json.dumps(d))
PY
)"

api -X POST "$BASE/infra/servers/$sid/deploy?stream=false" \
  -H 'Content-Type: application/json' \
  -H 'X-Skip-Source-Snapshot: CI deploy from public archive' \
  -d "$body" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("==> appUrl:",d.get("data",{}).get("appUrl","<none>"))'

echo "==> Done. Health: curl https://app-${sid}.vibecode.bitrix24.tech/api/health  (URL is in appUrl above)"
