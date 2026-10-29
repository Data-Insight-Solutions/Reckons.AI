#!/usr/bin/env bash
# The local deputy (F89 phase 7, kb:loop-local-deputy) — Claude Code, driven by a LOCAL model.
#
# Matt, 2026-10-23: "I want a more intelligent local model to use claude code harness, to do what
# Opus does when I have usage credits left." Ollama (0.14+) serves an Anthropic-compatible
# /v1/messages, so the real Claude Code harness runs unchanged against a model on this machine:
# same AGENTS.md, same hooks, same reckons MCP, same tools. Interactive by default; any extra
# arguments go to `claude` (so `-- -p "…"` runs headless).
#
#   npm run local:claude                          talk to the deputy (qwen3.8, 160k context)
#   npm run local:claude -- --model=qwen3-coder   a different base model
#   npm run local:claude -- -p "…"                one headless task
#   npm run local:claude -- --repo=../my-site      work in ANOTHER git repository (F274.1): Claude Code
#                                                 starts there, so it loads that repository's CLAUDE.md,
#                                                 .mcp.json and project memory. The safety envelope
#                                                 below is identical: it comes from this launcher's
#                                                 environment and config folder, not from the repository.
#
# n8n is deliberately NOT given to the deputy: its MCP config and API key live in the user settings of
# Matt's own sessions (~/.claude/settings.json env), which this separate config folder does not load.
# /doctor here warns about missing N8N_* variables; that is expected.
#
# WHAT MAKES IT A DEPUTY, NOT A SECOND OPUS — enforced by the environment, not by asking nicely:
#   - Its own CLAUDE_CONFIG_DIR holds no Anthropic login, and every model name (opus/sonnet/haiku,
#     subagents included) maps to the local alias, so it cannot spend subscription or API quota.
#   - No GitHub credential reaches it: GH_CONFIG_DIR is an empty folder, git's credential helpers
#     are reset through GIT_CONFIG_* and the keyring's D-Bus socket is unreachable. An empty
#     GH_CONFIG_DIR ALONE IS NOT ENOUGH — `gh auth git-credential` still read the token from the
#     keyring (found 2026-10-23). Checked: push --dry-run refused, gh unauthenticated, fetch works.
#   - It commits only to branches it creates (agent/local-*); the Opus session reviews them next.
#   NOT A SANDBOX: it runs as Matt's Unix user, so a model set on escaping could read
#   ~/.git-credentials or re-point D-Bus. The deny rules below cover the obvious spellings; a real
#   boundary is a separate user or container, not built.
#
# CONTEXT IS THE TRAP. Claude Code's system prompt plus AGENTS.md is ~35k tokens before the first
# message, and Ollama's default window silently TRUNCATED it (measured 2026-10-23: 34,944 cut to
# 16,386, the model lost its tool definitions and answered from nothing). So this creates a
# <model>-<n>k alias (same weights, no download; 160k by default, qwen3.6 supports 256k and uses
# 26 GB of the two cards at 128k) and refuses to start if Ollama is down.
#
# Measured 2026-10-23 on two 3090s, one task ("count .ts files directly in scripts/agent"):
# qwen3.6-128k right (39) in 3 turns, 2.5 min cold; qwen3-coder-128k ran the tool but ignored
# "not subdirectories" (63). One task is an anecdote, not a benchmark.
#
# WEAKNESS, said out loud: project memory is a COPY taken at launch, so the deputy sees today's
# memory but what it writes there is moved aside on the next launch (printed), never merged; and
# with gh unauthenticated it cannot read PR or CI state either.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# A relative --repo means relative to where the person typed it; npm run moves to the package root
# but keeps that folder in INIT_CWD.
CALLER="${INIT_CWD:-$PWD}"
cd "$ROOT"

OLLAMA="${OLLAMA_BASE_URL:-http://localhost:11434}"; OLLAMA="${OLLAMA%/}"
MODEL="${RECKONS_DEPUTY_MODEL:-qwen3.8}"
CTX="${RECKONS_DEPUTY_CTX:-163840}"
PASS=()
REPO=""
for a in "$@"; do
  case "$a" in
    --model=*) MODEL="${a#--model=}" ;;
    --ctx=*) CTX="${a#--ctx=}" ;;
    --repo=*) REPO="${a#--repo=}" ;;
    *) PASS+=("$a") ;;
  esac
done
# Where the deputy works: this repository, or with --repo the top of another git repository. A folder
# that is not a git repository is refused: its work must land on a branch Opus can review.
WORKDIR="$ROOT"
if [ -n "$REPO" ]; then
  case "$REPO" in /*) ;; *) REPO="$CALLER/$REPO" ;; esac
  if ! WORKDIR="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "local-claude: --repo=$REPO is not inside a git repository; the deputy only works where its changes can be reviewed on a branch." >&2
    exit 1
  fi
fi
if [ "${RECKONS_DEPUTY_PRINT_REPO:-}" = 1 ]; then echo "$WORKDIR"; exit 0; fi
case "$MODEL" in *:*) BASE="$MODEL" ;; *) BASE="$MODEL:latest" ;; esac
ALIAS="${BASE%%:*}-$((CTX / 1024))k"

# Compaction threshold = max(100k, 3/4 of the window): Claude Code will not compact below 100k, and 3/4
# leaves room for the reply. When 3/4 is under 100k we compact at 100k, which must still leave >= 24k of
# headroom or Ollama truncates first, so we refuse. This lets gpt-oss:120b (native maximum 131072) run at
# its trained length instead of being refused under the old 136k floor.
COMPACT=$((CTX * 3 / 4)); [ "$COMPACT" -lt 100000 ] && COMPACT=100000
if [ $((CTX - COMPACT)) -lt 24576 ]; then
  echo "local-claude: --ctx=$CTX is too small: Claude Code compacts no earlier than 100k tokens, leaving under 24k of headroom, so Ollama would truncate first. Use --ctx=124928 or more." >&2
  exit 1
fi
if [ "${RECKONS_DEPUTY_PRINT_WINDOW:-}" = 1 ]; then echo "$COMPACT"; exit 0; fi

if ! curl -sf -m 3 "$OLLAMA/api/version" >/dev/null; then
  echo "local-claude: Ollama is not answering at $OLLAMA — start it (systemctl start ollama); not falling back to a cloud model." >&2
  exit 1
fi
TAGS="$(curl -sf -m 5 "$OLLAMA/api/tags")"
if ! grep -q "\"name\":\"$ALIAS:latest\"" <<<"$TAGS"; then
  if ! grep -q "\"name\":\"$BASE\"" <<<"$TAGS"; then
    echo "local-claude: base model $BASE is not pulled (ollama pull $BASE)." >&2
    exit 1
  fi
  MF="$(mktemp)"; printf 'FROM %s\nPARAMETER num_ctx %s\n' "$BASE" "$CTX" >"$MF"
  echo "local-claude: creating $ALIAS (same weights as $BASE, num_ctx $CTX)…"
  ollama create "$ALIAS" -f "$MF" >/dev/null
  rm -f "$MF"
fi

CFG="${XDG_CONFIG_HOME:-$HOME/.config}/reckons/local-claude"
mkdir -p "$CFG/gh-none"
[ -f "$CFG/.claude.json" ] || echo '{"hasCompletedOnboarding":true}' >"$CFG/.claude.json"
# Rewritten every launch: this file is the policy, so a deputy that edits it gains nothing.
cat >"$CFG/settings.json" <<'JSON'
{
  "enabledMcpjsonServers": ["reckons"],
  "includeCoAuthoredBy": false,
  "permissions": {
    "deny": ["Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(gh pr create:*)", "Bash(gh auth:*)", "Bash(git checkout dev:*)", "Bash(git checkout main:*)", "Bash(git switch dev:*)", "Bash(git switch main:*)",
             "Read(~/.git-credentials)", "Read(~/.config/gh/**)", "Read(~/.local/share/keyrings/**)", "Bash(cat ~/.git-credentials:*)"]
  }
}
JSON

# Project memory: a fresh copy each launch. Anything the deputy wrote last time is set aside, not lost.
KEY="${WORKDIR//\//-}"
SRC="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$KEY/memory"
DST="$CFG/projects/$KEY/memory"
if [ -d "$DST" ] && [ -d "$SRC" ] && ! diff -rq "$SRC" "$DST" >/dev/null 2>&1; then
  KEPT="$CFG/memory-written/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$(dirname "$KEPT")"; mv "$DST" "$KEPT"
  echo "local-claude: the last deputy session changed its memory copy; kept at $KEPT for review (not merged)."
fi
if [ -d "$SRC" ]; then rm -rf "$DST"; mkdir -p "$(dirname "$DST")"; cp -r "$SRC" "$DST"; fi

SCOPE="- You are working in $WORKDIR."
if [ "$WORKDIR" != "$ROOT" ]; then
  SCOPE="- You are working in $WORKDIR, a repository MANAGED WITH Reckons.AI, not Reckons.AI itself. Follow
  that repository's own CLAUDE.md/AGENTS.md. Its spaces are private to it: never copy its content into
  $ROOT, and never edit $ROOT from here."
fi
read -r -d '' ROLE <<PROMPT || true
You are the LOCAL DEPUTY for Reckons.AI: model $ALIAS running on Matt's machine inside the Claude
Code harness, standing in for Opus while Matt's Anthropic usage is exhausted. Help Matt think and
decide; do real work; but everything you produce is a PROPOSAL that the next Opus session reviews.
$SCOPE
- Code: only on a branch you create, named agent/local-<topic>, in a worktree under .claude/worktrees/.
  Never commit to dev or main. You cannot push, open PRs or merge (no GitHub credential) — do not try
  to work around that; say what is ready instead.
- Every commit carries trailers "Model: $ALIAS" and "Intent: <one line>".
- Decisions Matt makes with you: record each with kb_add_note (type "status-update" or "question",
  agent "local-deputy:$ALIAS") so Opus finds them in the review queue, and add a dated entry at the
  top of HANDOFF.md on your branch naming what you did, what is unverified, and what Matt decided.
- Queue heavy or repetitive work for the local worker (npm run agent:queue -- add …) instead of doing
  it turn by turn.
- You are smaller than Opus. Say when a question is beyond what you can check, and leave it as a
  question rather than guessing. A wrong answer stated confidently is the failure to avoid.
PROMPT

export CLAUDE_CONFIG_DIR="$CFG"
export ANTHROPIC_BASE_URL="$OLLAMA"
export ANTHROPIC_AUTH_TOKEN=ollama
export ANTHROPIC_MODEL="$ALIAS"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ALIAS" ANTHROPIC_DEFAULT_SONNET_MODEL="$ALIAS" ANTHROPIC_DEFAULT_HAIKU_MODEL="$ALIAS"
export CLAUDE_CODE_SUBAGENT_MODEL="$ALIAS"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Claude Code does not know the alias, assumes a 200k window and would compact past the point where
# Ollama truncates. Compact at 3/4 of the real window, leaving room for the reply. Claude Code will not
# compact below 100k (it said so for 98,304 at the old 128k default), so a smaller window is refused.
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$COMPACT"
export GH_CONFIG_DIR="$CFG/gh-none" GIT_TERMINAL_PROMPT=0 DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= GIT_CONFIG_KEY_1=credential.https://github.com.helper GIT_CONFIG_VALUE_1=
unset ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN
export OLLAMA_BASE_URL="$OLLAMA"
# A managed repository's .mcp.json finds this checkout's MCP launcher through RECKONS_HOME (F274.1).
export RECKONS_HOME="$ROOT"

# Which claude: the Nix build on PATH here was 2.1.72 with no ripgrep, so the deputy's Grep tool did not
# work (/doctor: "Search: Not working (rg)"). The VS Code extension's native binary bundles ripgrep and
# tracks releases, so prefer the newest one; RECKONS_DEPUTY_CLAUDE overrides.
CLAUDE_BIN="${RECKONS_DEPUTY_CLAUDE:-}"
if [ -z "$CLAUDE_BIN" ]; then
  CLAUDE_BIN="$(ls -d "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)"
  [ -x "$CLAUDE_BIN" ] || CLAUDE_BIN=claude
fi

echo "local-claude: $ALIAS via $OLLAMA — no Anthropic quota, no push/merge. Config: $CFG"
cd "$WORKDIR"
exec "$CLAUDE_BIN" --model "$ALIAS" --append-system-prompt "$ROLE" ${PASS[@]+"${PASS[@]}"}
