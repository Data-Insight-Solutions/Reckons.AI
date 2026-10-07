#!/usr/bin/env bash
# Session heartbeat (F74.7). Wired as a Claude Code hook on SessionStart and UserPromptSubmit.
# The file's MTIME is the whole signal; nothing is written into it. Must be fast and must never
# fail: a hook that errors would nag every prompt, so every step swallows its own failure.
d="${XDG_STATE_HOME:-$HOME/.local/state}/reckons"
mkdir -p "$d" 2>/dev/null
touch "$d/session-heartbeat" 2>/dev/null
exit 0
