#!/usr/bin/env bash
# Server-side check: does the backend reach a portal's app-level setting (app.option)
# using ONLY the stored install token — no browser, no frame? Also the multi-tenant
# isolation test: run it for two portals' member_id and confirm each returns its own
# value (never the other's).
#
# Runs the guarded diagnostic endpoint INSIDE the backend container (localhost:3000),
# so nothing extra is exposed publicly. Needs B24_APPLICATION_TOKEN in the env (same
# value as the backend's) — it authenticates the check.
#
# Usage:
#   B24_APPLICATION_TOKEN=... ./scripts/check-app-option.sh <MEMBER_ID> [compose-file]
# Examples (two portals — values must differ / not cross):
#   ./scripts/check-app-option.sh MEMBER_ID_PORTAL_A
#   ./scripts/check-app-option.sh MEMBER_ID_PORTAL_B
set -eu

member_id="${1:?usage: check-app-option.sh <MEMBER_ID> [compose-file]}"
compose_file="${2:-docker-compose.prod.yml}"
: "${B24_APPLICATION_TOKEN:?set B24_APPLICATION_TOKEN (same value as the backend)}"

docker compose -f "$compose_file" exec -T backend \
  wget -qO- \
    --header="X-Check-Token: ${B24_APPLICATION_TOKEN}" \
    "http://localhost:3000/api/b24/app-option-check?memberId=${member_id}"
echo
