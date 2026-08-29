#!/usr/bin/env bash
# Install the quarter-hourly trigger for the offline job scheduler (F81 / kb:local-orchestration).
#
# QUARTER-HOURLY, NOT HOURLY, and the reason is capture latency. schedule.ts runs only the jobs
# whose kpred:every is actually DUE, so the trigger's cadence is a floor on granularity, not a
# work multiplier: a 6h job still fires every 6h whether the trigger wakes hourly or every 15
# minutes. But a note dictated into a ring should not sit in n8n for an hour, and with an hourly
# trigger a `15m` interval can never come due at all.
#
# The SCHEDULE (what runs, and how often) lives in reckons-workspace/schedules.ttl — a graph you
# can search, diff and review. This script only installs the TRIGGER that wakes `npm run schedule`;
# schedule.ts then runs only the jobs whose interval (kpred:every) is actually due (pull-notes 15m,
# drain-queue and offer-tasks 1h, reconcile 6h, orchestrate 24h), computing next-due from when each
# ACTUALLY ran. It is drain-not-cron.
#
# THE `cd $REPO` BELOW IS LOAD-BEARING. cron runs from $HOME, so without it npm looks for
# /home/<user>/package.json and dies with ENOENT — silently, into a log nobody reads. An installed
# line missing it produced 3,216 consecutive failures and never once ran (found 2026-08-28). If you
# are debugging a schedule that "fires" but does nothing, check the INSTALLED crontab line rather
# than this script: a stale entry survives every fix made here until the script is re-run.
#
# Everything it runs is the FREE tier (script + local-agent): zero cloud tokens.
#
# Idempotent: re-running replaces the prior entry. Remove with:
#   crontab -l | grep -v '# reckons-schedule' | crontab -
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODEBIN="$(dirname "$(command -v node)")"
LOG="$REPO/reckons-workspace/schedule-cron.log"
LINE="*/15 * * * * cd $REPO && PATH=$NODEBIN:\$PATH npm run schedule -- --run >> $LOG 2>&1 # reckons-schedule"

# THIS USED TO WIPE THE CRONTAB, and the failure is worth understanding before touching it.
# The old form was:
#     ( crontab -l 2>/dev/null | grep -v '# reckons-schedule'; echo "$LINE" ) | crontab -
# Under `set -euo pipefail`, when the reckons entry was the ONLY line, `grep -v` matched nothing,
# exited 1, and killed the subshell BEFORE the echo ran — so `crontab -` was handed an empty
# stream and dutifully installed nothing over everything. An installer that deletes a user's other
# cron jobs on a re-run is worse than one that never worked, because it fails destructively and
# quietly. Observed 2026-08-28.
#
# `|| true` on the grep, and a refusal to install an empty crontab, are both load-bearing.
EXISTING="$(crontab -l 2>/dev/null | grep -v '# reckons-schedule' || true)"
NEW="$(printf '%s\n%s\n' "$EXISTING" "$LINE" | grep -v '^[[:space:]]*$')"
if [ -z "$NEW" ]; then
  echo "Refusing to install an empty crontab — something is wrong." >&2
  exit 1
fi
printf '%s\n' "$NEW" | crontab -

echo "Installed quarter-hourly schedule trigger:"
crontab -l 2>/dev/null | grep '# reckons-schedule'
echo "Log: $LOG"
echo "Schedules (the plan): reckons-workspace/schedules.ttl"
