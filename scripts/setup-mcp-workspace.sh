#!/usr/bin/env bash
# Set up the MCP workspace with symlinks to TTL documentation KBs.
# KB discovery is by folder name + kb.ttl — no meta.json needed.
#
# Run once after cloning, or if symlinks are broken.
# Usage: bash scripts/setup-mcp-workspace.sh

set -euo pipefail
cd "$(dirname "$0")/.."

WORKSPACE="mcp-workspace/kbs"

echo "Setting up MCP workspace..."

# Create directories
mkdir -p "$WORKSPACE/roadmap" "$WORKSPACE/production" "$WORKSPACE/features"

# Clean up legacy meta.json files
find "$WORKSPACE" -name meta.json -delete 2>/dev/null || true

# Symlink TTL files
ln -sf "$(pwd)/static/reckons-roadmap.ttl" "$WORKSPACE/roadmap/kb.ttl"
ln -sf "$(pwd)/static/reckons-production.ttl" "$WORKSPACE/production/kb.ttl"
ln -sf "$(pwd)/static/docs-features.ttl" "$WORKSPACE/features/kb.ttl"

# Verify
echo "Verifying..."
TRIPLE_COUNT=$(cd mcp-server && echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_stats","arguments":{}}}' | timeout 5 node dist/index.js --kb ../mcp-workspace 2>/dev/null | grep -o '"tripleCount":[0-9]*' | head -1 | cut -d: -f2)

if [ -n "$TRIPLE_COUNT" ] && [ "$TRIPLE_COUNT" -gt 0 ]; then
  echo "MCP workspace ready: $TRIPLE_COUNT triples across 3 KBs"
  echo ""
  echo "Claude Code will auto-detect the MCP server on next session."
  echo "To test manually: cd mcp-server && echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"kb_list_kbs\",\"arguments\":{}}}' | node dist/index.js --kb ../mcp-workspace"
else
  echo "Warning: MCP server test returned no triples. Check mcp-server/dist/ exists (run: cd mcp-server && npm run build)"
fi
