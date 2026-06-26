#!/usr/bin/env bash
# Set up the Reckons workspace with real copies of TTL documentation KBs.
#
# This workspace serves two purposes:
#   1. MCP server reads from it (Claude Code, VS Code, etc.)
#   2. Reckons.AI app syncs with it (via Settings > Workspace folder)
#
# Run after cloning or when TTL sources change:
#   bash scripts/setup-reckons-workspace.sh
#
# The workspace uses real file copies (not symlinks) because the browser
# File System Access API cannot follow symlinks.

set -euo pipefail
cd "$(dirname "$0")/.."

WORKSPACE="reckons-workspace"
KBS="$WORKSPACE/kbs"

echo "Setting up Reckons workspace..."

# Create directories
mkdir -p "$KBS"/{production,roadmap,features,docs,quickstart}

# Copy TTL files (real copies, not symlinks)
cp static/reckons-production.ttl "$KBS/production/kb.ttl"
cp static/reckons-roadmap.ttl    "$KBS/roadmap/kb.ttl"
cp static/docs-features.ttl      "$KBS/features/kb.ttl"
cp static/starter-quickstart.ttl "$KBS/quickstart/kb.ttl"

# Docs KB: merge all documentation sub-graphs into one
cat static/starter-guide.ttl \
    static/docs-triples-rdf.ttl \
    static/docs-llm.ttl \
    static/docs-use-cases.ttl \
    static/docs-integrations-tech.ttl \
    static/docs-tips-security.ttl \
    static/docs-timeline-ecosystem.ttl \
    > "$KBS/docs/kb.ttl"

# Write meta.json files (preserve existing stableIds if present)
write_meta() {
  local dir="$1" name="$2" desc="$3" db="$4"
  local meta="$dir/meta.json"
  local ts=$(date +%s)000

  # Preserve existing stableId if meta.json exists
  local stableId=""
  if [ -f "$meta" ]; then
    stableId=$(python3 -c "import json; print(json.load(open('$meta')).get('stableId',''))" 2>/dev/null || true)
  fi
  if [ -z "$stableId" ]; then
    stableId=$(python3 -c "import uuid; print(uuid.uuid4())")
  fi

  cat > "$meta" << EOFMETA
{
  "stableId": "$stableId",
  "name": "$name",
  "description": "$desc",
  "dbName": "$db",
  "createdAt": $ts,
  "lastModified": $ts,
  "statementCount": 0,
  "sourceCount": 0
}
EOFMETA
}

write_meta "$KBS/production" "Production" \
  "Reckons.AI production status, test suite health, architecture, and tech stack." "production"

write_meta "$KBS/roadmap" "Roadmap" \
  "Reckons.AI product design, roadmap, and feature status. Consult before planning new work." "roadmap"

write_meta "$KBS/features" "Features" \
  "Reckons.AI feature documentation — ingest, review, graph, Shelly, compare, multi-KB, safety, etc." "features"

write_meta "$KBS/docs" "Documentation" \
  "Complete Reckons.AI documentation — starter guide, RDF/triples, LLM concepts, use cases, integrations, tips, and timeline." "docs"

write_meta "$KBS/quickstart" "Quickstart" \
  "Quickstart guide — hands-on walkthrough for new users." "quickstart"

# Verify with MCP server
echo "Verifying..."
TRIPLE_COUNT=$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kb_stats","arguments":{}}}\n' | timeout 5 node mcp-server/dist/index.js --kb "$WORKSPACE" 2>/dev/null | tail -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['content'][0]['text'])" 2>/dev/null | grep -o 'Triples:.*[0-9]*' | head -1 || echo "")

if [ -n "$TRIPLE_COUNT" ]; then
  echo "$TRIPLE_COUNT across 5 KBs"
  echo ""
  echo "Workspace ready at: $WORKSPACE/"
  echo ""
  echo "Next steps:"
  echo "  1. Open Reckons.AI in Chrome/Edge"
  echo "  2. Go to Settings > Workspace"
  echo "  3. Click 'pick Reckons home folder' and select the '$WORKSPACE' directory"
  echo "  4. The app will discover all 5 KBs and sync with them"
else
  echo "Warning: MCP server test failed. Check mcp-server/dist/ exists (run: cd mcp-server && npm run build)"
fi
