#!/usr/bin/env bash
# Queue observability: per-queue job counts straight from Redis (#757).
#
# Runs redis-cli INSIDE the redis container, so access to the server is the whole authorisation —
# no token. Until #757 this went through GET /api/queues guarded by B24_APPLICATION_TOKEN; that
# variable is gone. The operator page /queues (session) shows the same numbers in a browser.
#
# The counting mirrors BullMQ's own getCounts script: lists (LLEN) for `wait` and `active`,
# sorted sets (ZCARD) for the rest, under the default key prefix `bull:<queue>:<state>`.
# ⚠ Two things here are copies of someone else's truth, and tests/queueStatsScript.test.ts holds
# both: the queue list (QUEUE_NAMES in server/queue/topology.ts) and the key layout (the installed
# bullmq package — its getCounts script and its default state set). A queue missing here would
# simply never be shown; a layout change after a bullmq upgrade would show wrong numbers.
#
# Only non-zero states are printed, one queue per line: the operator's terminal is a phone, and a
# seven-column table wraps into noise there. The `wait` key is printed as `waiting` — the name the
# runbook, the /queues page and BullMQ's own getJobCounts use.
# ⚠ An unreadable Redis is an ERROR, not «пусто»: a failed redis-cli prints nothing, and treating
# that as zero would report idle queues exactly when the server is in trouble.
#
# Usage (normally through `make queue-stats`):
#   bash queue-stats.sh "docker compose -f docker-compose.prod.yml"
# ⚠ A bare compose FILE is still accepted (`bash queue-stats.sh docker-compose.prod.yml`): servers
# fetch this script fresh from main on every call, while their Makefile only changes on
# `make self-update` — and the old recipe passed the file name.
set -u

QUEUES="b24-events bank-fetch bank-fetch-prior file-parse crm-sync b24-deletions feedback-post trigger-fire registry-write activity-bind"
STATES="wait active prioritized delayed waiting-children failed completed"

dc="${1:-docker compose -f docker-compose.prod.yml}"
# A command line has spaces; a bare file name does not (and ends with .yml/.yaml).
case "$dc" in *" "*) ;; *.yml|*.yaml) dc="docker compose -f $dc" ;; esac

# One exec for all queues: every `docker compose exec` costs a noticeable fraction of a second.
# shellcheck disable=SC2086 # $dc is a command line on purpose (`docker compose -f …`)
$dc exec -T redis sh -c '
  bad=""
  for q in '"$QUEUES"'; do
    line=""
    for s in '"$STATES"'; do
      case "$s" in
        wait|active) n=$(redis-cli --raw LLEN "bull:$q:$s") ;;
        *)           n=$(redis-cli --raw ZCARD "bull:$q:$s") ;;
      esac
      label="$s"; [ "$s" = wait ] && label=waiting
      case "$n" in
        0) ;;
        ""|*[!0-9]*) bad=1; line="$line $label=?" ;;
        *) line="$line $label=$n" ;;
      esac
    done
    printf "%s:%s\n" "$q" "${line:- пусто}"
  done
  if [ -n "$bad" ]; then
    echo "✗ redis-cli ответил не на все запросы (помечено «?») — счётчики выше неполные" >&2
    exit 1
  fi'
