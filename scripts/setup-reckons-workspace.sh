#!/usr/bin/env bash
# Set up the Reckons workspace with symlinks to TTL documentation KBs.
#
# This workspace serves two purposes:
#   1. MCP server reads from it (Claude Code, VS Code, etc.)
#   2. Reckons.AI app syncs with it (via Settings > Workspace folder)
#
# KB discovery is by folder name + {folder}.ttl (legacy fallback: kb.ttl) — no meta.json needed.
#
# Run after cloning or when symlinks break:
#   bash scripts/setup-reckons-workspace.sh

set -euo pipefail
cd "$(dirname "$0")/.."

WORKSPACE="reckons-workspace"
KBS="$WORKSPACE/kbs"

echo "Setting up Reckons workspace..."

mkdir -p "$KBS"/{production,roadmap,features,docs,quickstart,codebase,architecture}

# Clean up legacy meta.json files (no longer needed — discovery uses {folder}.ttl)
find "$KBS" -name meta.json -delete 2>/dev/null || true

# Clean up stale legacy kb.ttl symlinks (superseded by {folder}.ttl below)
find "$KBS" -name kb.ttl -delete 2>/dev/null || true

# Symlink TTL files (3 levels up from kbs/{name}/ to reach static/)
ln -sf ../../../static/reckons-production.ttl "$KBS/production/production.ttl"
ln -sf ../../../static/reckons-roadmap.ttl    "$KBS/roadmap/roadmap.ttl"
ln -sf ../../../static/docs-features.ttl      "$KBS/features/features.ttl"
ln -sf ../../../static/starter-quickstart.ttl "$KBS/quickstart/quickstart.ttl"
ln -sf ../../../static/reckons-codebase.ttl   "$KBS/codebase/codebase.ttl"
ln -sf ../../../static/docs-architecture.ttl  "$KBS/architecture/architecture.ttl"

# Docs KB: merge all sub-graphs into one file, then symlink
cat static/starter-guide.ttl \
    static/docs-triples-rdf.ttl \
    static/docs-llm.ttl \
    static/docs-use-cases.ttl \
    static/docs-integrations-tech.ttl \
    static/docs-tips-security.ttl \
    static/docs-timeline-ecosystem.ttl \
    > static/docs-all.ttl
ln -sf ../../../static/docs-all.ttl "$KBS/docs/docs.ttl"

echo "Workspace ready: $WORKSPACE/ (7 KBs, symlinked to static/*.ttl)"
