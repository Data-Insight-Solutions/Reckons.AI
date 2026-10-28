#!/usr/bin/env bash
# PreToolUse guard (Bash): refuse `npm ci` / `npm install` where node_modules is a SYMLINK.
#
# Agent worktrees share the main checkout's node_modules through a symlink
# (.claude/settings.local.json worktree.symlinkDirectories, kept on purpose: fast and cheap).
# npm ci deletes node_modules before installing, and through the symlink that empties the MAIN
# checkout's — 2026-10-20 and again 2026-10-28, both times from an agent brief that said "npm ci".
# Matt, 2026-10-28: keep the symlinks, add a guard.
#
# Only npm in COMMAND position counts, and heredoc bodies are skipped: the first version blocked a
# heredoc that merely mentioned "npm ci" in prose (2026-10-28) — a gate that cries wolf gets
# switched off.
#
# Reads the hook JSON on stdin; exit 2 blocks the call and shows stderr to the agent.
input="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$input")"
cwd="$(jq -r '.cwd // empty' <<<"$input")"

# Drop heredoc bodies: from a line containing <<WORD / <<'WORD' / <<"WORD" / <<-WORD up to WORD.
code="$(awk '
  skip { if ($0 ~ "^[[:space:]]*" term "[[:space:]]*$") skip = 0; next }
  { print }
  match($0, /<<-?[[:space:]]*["'\'']?[A-Za-z_][A-Za-z0-9_]*/) {
    t = substr($0, RSTART, RLENGTH); sub(/<<-?[[:space:]]*["'\'']?/, "", t); term = t; skip = 1
  }' <<<"$cmd")"

# npm at the start of a line or after ; & | ( , then optional flags, then ci|install|i|clean-install.
grep -qE '(^|[;&|(])[[:space:]]*npm([[:space:]]+--?[a-z-]+(=|[[:space:]]+)[^[:space:]]+)*[[:space:]]+(ci|install|i|clean-install)([[:space:]]|$)' <<<"$code" || exit 0

dirs=("$cwd")
while read -r d; do [ -n "$d" ] && dirs+=("$d"); done < <(grep -oE '(^|[;&|(])[[:space:]]*cd[[:space:]]+[^;&|[:space:]]+' <<<"$code" | awk '{print $NF}')
while read -r d; do [ -n "$d" ] && dirs+=("$d"); done < <(grep -oE -- '--prefix(=|[[:space:]]+)[^;&|[:space:]]+' <<<"$code" | sed -E 's/--prefix(=|[[:space:]]+)//')

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
