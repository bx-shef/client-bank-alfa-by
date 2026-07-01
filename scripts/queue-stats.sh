#!/usr/bin/env bash
# Queue observability: print per-queue job counts (waiting/active/completed/failed/…)
# from the running backend — so you can watch the BullMQ pipeline move right now.
#
# Hits the guarded GET /api/queues INSIDE the backend container (localhost:3000),
# so nothing extra is exposed publicly. Needs B24_APPLICATION_TOKEN (same value as
# the backend's) to authenticate. For a live view, run it in a loop:
#   watch -n2 'B24_APPLICATION_TOKEN=... ./scripts/queue-stats.sh'
#
# Usage:
#   B24_APPLICATION_TOKEN=... ./scripts/queue-stats.sh [compose-file]
set -eu

compose_file="${1:-docker-compose.prod.yml}"
: "${B24_APPLICATION_TOKEN:?set B24_APPLICATION_TOKEN (same value as the backend)}"

docker compose -f "$compose_file" exec -T backend \
  wget -qO- \
    --header="X-Check-Token: ${B24_APPLICATION_TOKEN}" \
    "http://localhost:3000/api/queues"
echo
