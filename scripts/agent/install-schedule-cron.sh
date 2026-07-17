#!/usr/bin/env bash
# Install the hourly trigger for the offline job scheduler (F81 / kb:local-orchestration).
#
# The SCHEDULE (what runs, and how often) lives in reckons-workspace/schedules.ttl — a graph you
# can search, diff and review. This script only installs the TRIGGER that wakes `npm run schedule`
# once an hour; schedule.ts then runs only the jobs whose interval (kpred:every) is actually due
# (drain-queue 1h, reconcile 6h, orchestrate 24h), computing next-due from when each ACTUALLY ran.
# So an hourly trigger is correct even for the 6h/24h jobs — it is drain-not-cron.
#
# Everything it runs is the FREE tier (script + local-agent): zero cloud tokens.
#
# Idempotent: re-running replaces the prior entry. Remove with:
#   crontab -l | grep -v '# reckons-schedule' | crontab -
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODEBIN="$(dirname "$(command -v node)")"
LOG="$REPO/reckons-workspace/schedule-cron.log"
LINE="0 * * * * cd $REPO && PATH=$NODEBIN:\$PATH npm run schedule -- --run >> $LOG 2>&1 # reckons-schedule"

( crontab -l 2>/dev/null | grep -v '# reckons-schedule'; echo "$LINE" ) | crontab -

echo "Installed hourly schedule trigger:"
crontab -l 2>/dev/null | grep '# reckons-schedule'
echo "Log: $LOG"
echo "Schedules (the plan): reckons-workspace/schedules.ttl"
