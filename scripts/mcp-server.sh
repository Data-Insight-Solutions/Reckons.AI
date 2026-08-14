#!/usr/bin/env bash
# Launcher for the Reckons.AI MCP server (the `reckons` entry in .mcp.json).
#
# WHY THIS EXISTS — measured 2026-08-13. .mcp.json used to spawn `node` directly. Claude
# Code starts MCP servers from a NON-INTERACTIVE shell, and node here comes from nvm,
# which only puts node on PATH from ~/.bashrc for INTERACTIVE shells (not even a login
# shell picks it up). So `node --version` worked fine in a terminal while the spawned
# server died instantly with ENOENT, and the failure was silent from inside a session:
# every kb_* tool was simply absent, with no error naming the cause. A session that
# cannot query the graphs falls back to reading TTL by hand, which is the exact
# behaviour the MCP server exists to replace.
#
# So: resolve node the way the developer's shell would, and if that fails, say so on
# stderr rather than exiting into silence.

set -eo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # nvm.sh trips over `set -u`; it is sourced deliberately without it.
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    nvm use "$(cat .nvmrc 2>/dev/null || echo default)" >/dev/null 2>&1 \
      || nvm use default >/dev/null 2>&1 \
      || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[reckons-mcp] FATAL: no 'node' on PATH, and no usable nvm at ${NVM_DIR:-$HOME/.nvm}." >&2
  echo "[reckons-mcp] The MCP server cannot start, so every kb_* tool will be missing." >&2
  exit 127
fi

if [ ! -f mcp-server/dist/index.js ]; then
  echo "[reckons-mcp] FATAL: mcp-server/dist/index.js is missing." >&2
  echo "[reckons-mcp] Build it with: npm --prefix mcp-server install && npm --prefix mcp-server run build" >&2
  exit 1
fi

exec node mcp-server/dist/index.js --kb mcp-workspace "$@"
