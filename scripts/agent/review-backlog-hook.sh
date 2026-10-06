#!/usr/bin/env bash
# SessionStart hook (F89 kb:loop-opus-review): tell the session whether local-agent work awaits
# review, so it dispatches the local-work-reviewer subagent instead of reading the queue itself.
# Prints one line or nothing; never fails the session.
root="$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null)" || exit 0
ws="$root/reckons-workspace"; cli="$root/cli/dist/index.js"
[ -f "$ws/knowledge.pending.jsonl" ] && [ -f "$cli" ] || exit 0
n=$(cd "$ws" && timeout 20 node "$cli" review --limit=1 2>/dev/null | grep -oE '^[0-9]+ decision' | grep -oE '^[0-9]+')
[ -n "$n" ] && [ "$n" -gt 0 ] || exit 0
echo "Review backlog: $n decision(s) await a verdict, many from local agents. Do not read the queue in the main thread. When the user's request allows, dispatch ONE batch to the local-work-reviewer subagent (it takes at most 10) and keep only its summary. The backlog is not a reason to review everything now."
