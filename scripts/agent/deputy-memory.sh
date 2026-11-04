#!/usr/bin/env bash
# The local deputy's project memory (kb:deputy-memory-readback).
#
#   deputy-memory.sh sync    --src=<Opus memory dir> --cfg=<deputy config dir> --key=<project key>
#   deputy-memory.sh pending [--cfg=<deputy config dir>]
#
# sync (run by local-claude.sh at each launch): the deputy works on a COPY of Opus's memory. A baseline
# of that copy (memory.base) is kept beside it, so what the DEPUTY changed is the copy against its own
# baseline, never against Opus's current memory, which moves between launches (the old launcher
# reported every Opus-side change as a deputy write). The deputy's changes are set aside as
# memory-written/<UTC time>/changes.patch; then the copy and its baseline are refreshed from Opus.
#
# pending (run by review-backlog-hook.sh at session start): one line naming every patch whose folder
# has no REVIEWED file, or nothing. A deputy write is a proposal: a reviewing session applies what is
# right and creates REVIEWED. Folders from before this script hold no patch and are not counted.
set -euo pipefail

cmd="${1:-}"; shift || true
SRC="" KEY=""
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/reckons/local-claude"
for a in "$@"; do
  case "$a" in
    --src=*) SRC="${a#--src=}" ;;
    --cfg=*) CFG="${a#--cfg=}" ;;
    --key=*) KEY="${a#--key=}" ;;
    *) echo "deputy-memory: unknown argument $a" >&2; exit 2 ;;
  esac
done
KEPT_ROOT="$CFG/memory-written"

case "$cmd" in
  sync)
    [ -n "$SRC" ] && [ -n "$KEY" ] || { echo "deputy-memory sync: --src and --key are required" >&2; exit 2; }
    PARENT="$CFG/projects/$KEY"; DST="$PARENT/memory"; BASE="$PARENT/memory.base"
    if [ -d "$DST" ] && [ -d "$BASE" ]; then
      patch="$(cd "$PARENT" && diff -ruN memory.base memory || true)"
      if [ -n "$patch" ]; then
        KEPT="$KEPT_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
        mkdir -p "$KEPT"; printf '%s\n' "$patch" > "$KEPT/changes.patch"
        echo "local-claude: the last deputy session changed its memory; its changes are at $KEPT/changes.patch for review (not merged)."
      fi
    fi
    rm -rf "$DST" "$BASE"
    if [ -d "$SRC" ]; then mkdir -p "$PARENT"; cp -r "$SRC" "$DST"; cp -r "$SRC" "$BASE"; fi
    ;;
  pending)
    [ -d "$KEPT_ROOT" ] || exit 0
    found=()
    for d in "$KEPT_ROOT"/*/; do
      [ -f "$d/changes.patch" ] && [ ! -e "$d/REVIEWED" ] && found+=("${d%/}/changes.patch")
    done
    [ "${#found[@]}" -gt 0 ] || exit 0
    echo "Deputy memory: ${#found[@]} set-aside change(s) written by the local deputy await review: ${found[*]}. Read each patch; apply what is right to your project memory (by hand, or patch -p1 -d <memory dir>); then create REVIEWED in that folder."
    ;;
  *) echo "usage: deputy-memory.sh sync|pending [--src= --cfg= --key=]" >&2; exit 2 ;;
esac
