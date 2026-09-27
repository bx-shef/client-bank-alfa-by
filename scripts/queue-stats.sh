#!/usr/bin/env bash
# Queue observability: per-queue job counts straight from Redis (#757).
#
# Runs redis-cli INSIDE the redis container, so access to the server is the whole authorisation —
# no token. Until #757 this went through GET /api/queues guarded by B24_APPLICATION_TOKEN; that
# variable is gone. The operator page /queues (session) shows the same numbers in a browser.
#
# The counting mirrors BullMQ's own getCounts script: lists (LLEN) for `wait` and `active`,
# sorted sets (ZCARD) for the rest, under the default key prefix `bull:<queue>:<state>`.
# ⚠ The queue list must match QUEUE_NAMES in server/queue/topology.ts
# (tests/queueStatsScript.test.ts holds that): a queue missing here would simply never be shown.
#
# Only non-zero states are printed, one queue per line: the operator's terminal is a phone, and a
# seven-column table wraps into noise there.
#
# Usage (normally through `make queue-stats`):
#   bash queue-stats.sh "docker compose -f docker-compose.prod.yml"
set -u

QUEUES="b24-events bank-fetch bank-fetch-prior file-parse crm-sync b24-deletions feedback-post trigger-fire registry-write activity-bind"
STATES="wait active prioritized delayed waiting-children failed completed"

dc="${1:-docker compose -f docker-compose.prod.yml}"

# One exec for all queues: every `docker compose exec` costs a noticeable fraction of a second.
# shellcheck disable=SC2086 # $dc is a command line on purpose (`docker compose -f …`)
$dc exec -T redis sh -c '
  for q in '"$QUEUES"'; do
    line=""
    for s in '"$STATES"'; do
      case "$s" in
        wait|active) n=$(redis-cli --raw LLEN "bull:$q:$s") ;;
        *)           n=$(redis-cli --raw ZCARD "bull:$q:$s") ;;
      esac
      case "$n" in ""|0) ;; *) line="$line $s=$n" ;; esac
    done
    printf "%s:%s\n" "$q" "${line:- пусто}"
  done'
