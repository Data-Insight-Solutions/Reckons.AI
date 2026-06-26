#!/usr/bin/env bash
# Set up the Reckons workspace with symlinks to TTL documentation KBs.
#
# This workspace serves two purposes:
#   1. MCP server reads from it (Claude Code, VS Code, etc.)
#   2. Reckons.AI app syncs with it (via Settings > Workspace folder)
#
# Run after cloning or when symlinks break:
#   bash scripts/setup-reckons-workspace.sh

set -euo pipefail
cd "$(dirname "$0")/.."

WORKSPACE="reckons-workspace"
KBS="$WORKSPACE/kbs"

echo "Setting up Reckons workspace..."

mkdir -p "$KBS"/{production,roadmap,features,docs,quickstart}

# Symlink TTL files (3 levels up from kbs/{name}/ to reach static/)
ln -sf ../../../static/reckons-production.ttl "$KBS/production/kb.ttl"
ln -sf ../../../static/reckons-roadmap.ttl    "$KBS/roadmap/kb.ttl"
ln -sf ../../../static/docs-features.ttl      "$KBS/features/kb.ttl"
ln -sf ../../../static/starter-quickstart.ttl "$KBS/quickstart/kb.ttl"

# Docs KB: merge all sub-graphs into one file, then symlink
cat static/starter-guide.ttl \
    static/docs-triples-rdf.ttl \
    static/docs-llm.ttl \
    static/docs-use-cases.ttl \
    static/docs-integrations-tech.ttl \
    static/docs-tips-security.ttl \
    static/docs-timeline-ecosystem.ttl \
    > static/docs-all.ttl
ln -sf ../../../static/docs-all.ttl "$KBS/docs/kb.ttl"

# Write meta.json (preserve existing stableIds)
write_meta() {
  local dir="$1" name="$2" desc="$3" db="$4"
  local meta="$dir/meta.json"

  # Preserve existing stableId
  local stableId=""
  if [ -f "$meta" ]; then
    stableId=$(python3 -c "import json; print(json.load(open('$meta')).get('stableId',''))" 2>/dev/null || true)
  fi
  [ -z "$stableId" ] && stableId=$(python3 -c "import uuid; print(uuid.uuid4())")

  cat > "$meta" << EOFMETA
{
  "stableId": "$stableId",
  "name": "$name",
  "description": "$desc",
  "dbName": "$db",
  "createdAt": $(date +%s)000,
  "lastModified": $(date +%s)000,
  "statementCount": 0,
  "sourceCount": 0
}
EOFMETA
}

write_meta "$KBS/production" "Production" \
  "Reckons.AI production status, test suite health, architecture, and tech stack." "production"
write_meta "$KBS/roadmap" "Roadmap" \
  "Reckons.AI product design, roadmap, and feature status." "roadmap"
write_meta "$KBS/features" "Features" \
  "Reckons.AI feature documentation." "features"
write_meta "$KBS/docs" "Documentation" \
  "Complete Reckons.AI documentation." "docs"
write_meta "$KBS/quickstart" "Quickstart" \
  "Quickstart guide for new users." "quickstart"

echo "Workspace ready: $WORKSPACE/ (5 KBs, symlinked to static/*.ttl)"
