#!/usr/bin/env bash
# PreToolUse guard (Bash): refuse `npm ci` / `npm install` where node_modules is a SYMLINK.
#
# Agent worktrees share the main checkout's node_modules through a symlink
# (.claude/settings.local.json worktree.symlinkDirectories, kept on purpose: fast and cheap).
# npm ci deletes node_modules before installing, and through the symlink that empties the MAIN
# checkout's — 2026-10-20 and again 2026-10-28, both times from an agent brief that said "npm ci".
# Matt, 2026-10-28: keep the symlinks, add a guard.
#
# Reads the hook JSON on stdin; exit 2 blocks the call and shows stderr to the agent.
input="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$input")"
cwd="$(jq -r '.cwd // empty' <<<"$input")"
grep -qE '(^|[;&|[:space:]])npm([[:space:]]+--?[a-z-]+(=|[[:space:]]+)[^[:space:]]+)*[[:space:]]+(ci|install|i|clean-install)([[:space:]]|$)' <<<"$cmd" || exit 0

dirs=("$cwd")
while read -r d; do [ -n "$d" ] && dirs+=("$d"); done < <(grep -oE '(^|[;&|[:space:]])cd[[:space:]]+[^;&|[:space:]]+' <<<"$cmd" | awk '{print $NF}')
while read -r d; do [ -n "$d" ] && dirs+=("$d"); done < <(grep -oE -- '--prefix(=|[[:space:]]+)[^;&|[:space:]]+' <<<"$cmd" | sed -E 's/--prefix(=|[[:space:]]+)//')

for d in "${dirs[@]}"; do
  [ -z "$d" ] && continue
  case "$d" in /*) ;; *) d="$cwd/$d" ;; esac
  for nm in "$d/node_modules" "$d/mcp-server/node_modules" "$d/cli/node_modules"; do
    if [ -L "$nm" ]; then
      echo "BLOCKED: $nm is a symlink to $(readlink "$nm"). npm ci/install here would empty THAT directory (the main checkout's node_modules — happened 2026-10-20 and 2026-10-28). The shared node_modules is already installed: just run the tests. If this branch really changes dependencies, first replace the link with a real directory: rm \"$nm\" && mkdir \"$nm\", then install." >&2
      exit 2
    fi
  done
done
exit 0
