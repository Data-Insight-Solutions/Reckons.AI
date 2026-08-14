#!/usr/bin/env bash
# Set up the MCP workspace with symlinks to every TTL graph in static/.
# KB discovery is by folder name + {folder}.ttl (legacy fallback: kb.ttl) — no meta.json needed.
#
# WHY THIS IS DATA-DRIVEN (2026-07-19): this script used to symlink a HARDCODED SIX graphs
# out of 23. The other 17 were invisible to kb_search — including reckons-shipped.ttl, which
# holds the PRODUCTION-status features. A search for completed work returned nothing, and
# "nothing" is indistinguishable from "does not exist", which invites an agent to rebuild
# something that already ships. A coverage gap in search is not a search bug; it is a hole in
# the core claim that the graph prevents duplicated work.
#
# So: every static/*.ttl is linked, and the verify step FAILS if any is unreachable. Adding a
# new graph to static/ must never again silently exclude it from search.
#
# Run once after cloning, or if symlinks are broken.
# Usage: bash scripts/setup-mcp-workspace.sh

set -euo pipefail
cd "$(dirname "$0")/.."

WORKSPACE="mcp-workspace/kbs"

echo "Setting up MCP workspace..."

# Clean up legacy meta.json files and stale kb.ttl symlinks (superseded by {folder}.ttl)
find "$WORKSPACE" -name meta.json -delete 2>/dev/null || true
find "$WORKSPACE" -name kb.ttl -delete 2>/dev/null || true

# Folder name = filename minus the reckons-/docs- prefix and .ttl suffix.
# The six original folders (roadmap, production, features, architecture, testing, codebase)
# fall out of this rule unchanged, so existing KB references keep working.
kb_folder() {
  local base="${1%.ttl}"
  case "$base" in
    docs-all) echo "docs-hub" ;;          # the hub graph; "all" reads as an aggregate, which it is not
    reckons-*) echo "${base#reckons-}" ;;
    docs-*)    echo "${base#docs-}" ;;
    *)         echo "$base" ;;
  esac
}

LINKED=0
for ttl in static/*.ttl; do
  base="$(basename "$ttl")"
  folder="$(kb_folder "$base")"
  mkdir -p "$WORKSPACE/$folder"
  ln -sf "$(pwd)/$ttl" "$WORKSPACE/$folder/$folder.ttl"
  LINKED=$((LINKED + 1))
done
echo "  linked $LINKED graph(s)"

# ── Coverage guard: every static/*.ttl must be reachable, or fail loudly ──────
echo "Verifying coverage..."
MISSING=0
for ttl in static/*.ttl; do
  folder="$(kb_folder "$(basename "$ttl")")"
  target="$WORKSPACE/$folder/$folder.ttl"
  if [ ! -e "$target" ]; then
    echo "  MISSING: $ttl is not reachable as $target"
    MISSING=$((MISSING + 1))
  fi
done
if [ "$MISSING" -gt 0 ]; then
  echo "FAILED: $MISSING graph(s) unreachable by kb_search. A silent empty search result is the dangerous failure."
  exit 1
fi

# Prune dangling links (a graph deleted from static/ leaves a broken symlink that
# the MCP server would report as a parse failure on every load).
PRUNED=$(find "$WORKSPACE" -xtype l -print -delete 2>/dev/null | wc -l)
[ "$PRUNED" -gt 0 ] && echo "  pruned $PRUNED dangling link(s)"

# ── Verify the server actually reads them ────────────────────────────────────
# kb_stats returns a human-readable text blob ("Triples:      1267"); extract the count.
# `|| true` keeps set -e/pipefail from silently aborting when grep finds nothing.
TRIPLE_COUNT=$(cd mcp-server && echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_stats","arguments":{}}}' | timeout 15 node dist/index.js --kb ../mcp-workspace 2>/dev/null | grep -oE 'Triples: *[0-9]+' | grep -oE '[0-9]+' | head -1 || true)

# Read the KB count the SERVER reports, not the number of symlinks we made. Those differ
# whenever a graph fails to parse — and a coverage script that reports its own intent rather
# than the observed result is the exact failure it exists to prevent.
KB_COUNT=$(cd mcp-server && echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_stats","arguments":{}}}' | timeout 15 node dist/index.js --kb ../mcp-workspace 2>/dev/null | grep -oE 'KBs: *[0-9]+' | grep -oE '[0-9]+' | head -1 || true)

if [ -n "$TRIPLE_COUNT" ] && [ "$TRIPLE_COUNT" -gt 0 ]; then
  echo "MCP workspace ready: $TRIPLE_COUNT triples across ${KB_COUNT:-?} KBs"
  if [ -n "$KB_COUNT" ] && [ "$KB_COUNT" -ne "$LINKED" ]; then
    echo "WARNING: linked $LINKED graph(s) but the server loaded $KB_COUNT — $((LINKED - KB_COUNT)) failed to parse or were skipped."
    exit 1
  fi
  echo ""
  echo "Claude Code will auto-detect the MCP server on next session."
  echo "To test manually: cd mcp-server && echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"kb_list_kbs\",\"arguments\":{}}}' | node dist/index.js --kb ../mcp-workspace"
else
  # Do not blame dist/ specifically — a 15s timeout on a cold/large load looks identical here,
  # and misattributing the cause sends people to fix the wrong thing.
  echo "Warning: MCP server test returned no triples. Either the build is missing (cd mcp-server && npm run build) or the load exceeded the 15s timeout."
  exit 1
fi
