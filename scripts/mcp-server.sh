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

# Another repository's workspace (F274.1): `--kb <path>` serves THAT workspace instead of this
# repository's mcp-workspace, read relative to the folder the caller started in (Claude Code starts an
# MCP server in the project that configured it). Its review queue then defaults to that same workspace,
# so a managed site's proposals land in its own knowledge.pending.jsonl, never in this public repo's.
CALLER="$PWD"
KB=""
REST=()
while [ $# -gt 0 ]; do
  case "$1" in
    --kb) KB="${2:-}"; shift 2 || shift ;;
    --kb=*) KB="${1#--kb=}"; shift ;;
    *) REST+=("$1"); shift ;;
  esac
done
if [ -n "$KB" ]; then
  case "$KB" in /*) ;; *) KB="$CALLER/$KB" ;; esac
  if [ ! -e "$KB" ]; then
    echo "reckons-mcp: --kb $KB does not exist; not falling back to this repository's graphs." >&2
    exit 1
  fi
  [ -d "$KB" ] && export RECKONS_QUEUE_WORKSPACE="${RECKONS_QUEUE_WORKSPACE:-$KB}"
fi

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

# WHY THIS FALLBACK — measured 2026-11-03. mcp-server/dist is a build output and mcp-workspace/
# is local, so neither exists in a git worktree under .claude/worktrees/. Every deputy session
# running there lost all kb_* tools (CONNECTION_CLOSED) on the FATAL below. The main checkout has
# the same repo at a different root, already built: in a LINKED worktree .git is a FILE (a normal
# checkout has a directory), and its git common dir is the main checkout's .git, so the parent of
# that dir is the main checkout's root. Serve its build, and — when --kb was not given — its
# mcp-workspace: the server resolves the relative --kb and the queue dir against its own cwd,
# which is now the main root. A caller-supplied --kb was already resolved to an absolute path
# against the caller's folder above, so it keeps pointing at the caller's own workspace.
if [ ! -f mcp-server/dist/index.js ] && [ -f .git ]; then
  COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || COMMON_DIR=""
  if [ -n "$COMMON_DIR" ]; then
    MAIN_ROOT="$(dirname "$COMMON_DIR")"
    if [ -f "$MAIN_ROOT/mcp-server/dist/index.js" ]; then
      echo "[reckons-mcp] this worktree has no build; serving the main checkout at $MAIN_ROOT" >&2
      cd "$MAIN_ROOT"
    fi
  fi
fi

if [ ! -f mcp-server/dist/index.js ]; then
  echo "[reckons-mcp] FATAL: mcp-server/dist/index.js is missing." >&2
  echo "[reckons-mcp] Build it with: npm --prefix mcp-server install && npm --prefix mcp-server run build" >&2
  exit 1
fi

# The offline jobs write their queue to reckons-workspace/knowledge.pending.jsonl. The review tools
# read it too, and journal verdicts beside it where the app drains them. Override with
# RECKONS_QUEUE_WORKSPACE=/path; if unset and the directory is absent, only per-graph queues show.
# Local model tools (kb_local_summarize, kb_local_extract, kb_generate_page) are opt-in per call and
# answer "set OLLAMA_BASE_URL" when it is unset. Default it to the local Ollama port so a session asked
# to use the local tier can (Matt, 2026-10-13). If Ollama is not running, the tools say so.
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

if [ -z "$KB" ] && [ -z "${RECKONS_QUEUE_WORKSPACE:-}" ] && [ -d reckons-workspace ]; then
  export RECKONS_QUEUE_WORKSPACE="$PWD/reckons-workspace"
fi

exec node mcp-server/dist/index.js --kb "${KB:-mcp-workspace}" ${REST[@]+"${REST[@]}"}
