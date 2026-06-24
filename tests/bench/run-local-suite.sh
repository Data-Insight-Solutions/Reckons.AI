#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Reckons.AI — Local Test & Bench Suite
# ══════════════════════════════════════════════════════════════════════════════
# Runs the full local test suite using Ollama (zero API credits).
#
# Usage:
#   ./tests/bench/run-local-suite.sh              # full suite
#   ./tests/bench/run-local-suite.sh --quick      # unit tests + Ollama ingest only
#   ./tests/bench/run-local-suite.sh --bench-only # skip unit/e2e, just benchmarks
#   ./tests/bench/run-local-suite.sh --model mistral-nemo  # specific Ollama model
#
# Requirements:
#   - Node.js >=20
#   - Ollama running locally (ollama serve)
#   - pnpm install already done
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")/../.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

QUICK=false
BENCH_ONLY=false
OLLAMA_MODEL=""
SAVE_RESULTS=false

for arg in "$@"; do
  case "$arg" in
    --quick)      QUICK=true ;;
    --bench-only) BENCH_ONLY=true ;;
    --save)       SAVE_RESULTS=true ;;
    --model)      ;; # handled below
    *)
      # Check if previous arg was --model
      if [[ "${PREV_ARG:-}" == "--model" ]]; then
        OLLAMA_MODEL="$arg"
      fi
      ;;
  esac
  PREV_ARG="$arg"
done

PASS=0
FAIL=0
SKIP=0
RESULTS=()

run_step() {
  local name="$1"
  local cmd="$2"
  local required="${3:-true}"

  echo -e "\n${CYAN}━━━ $name ━━━${NC}"
  if eval "$cmd"; then
    echo -e "${GREEN}  ✓ $name passed${NC}"
    RESULTS+=("✓ $name")
    ((PASS++))
  else
    if [[ "$required" == "true" ]]; then
      echo -e "${RED}  ✗ $name FAILED${NC}"
      RESULTS+=("✗ $name")
      ((FAIL++))
    else
      echo -e "${YELLOW}  ⚠ $name skipped/warning${NC}"
      RESULTS+=("⚠ $name")
      ((SKIP++))
    fi
  fi
}

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Reckons.AI — Local Test & Bench Suite                     ║"
echo "║  Zero API credits required                                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Pre-flight checks ────────────────────────────────────────────────────────

echo -e "${CYAN}Pre-flight checks:${NC}"

# Check Ollama
if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  MODEL_COUNT=$(curl -s http://localhost:11434/api/tags | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('models',[])))" 2>/dev/null || echo "?")
  echo -e "  ${GREEN}✓${NC} Ollama running ($MODEL_COUNT models)"
else
  echo -e "  ${RED}✗${NC} Ollama not running — start with: ollama serve"
  echo -e "  Skipping Ollama benchmarks."
  BENCH_ONLY=false  # can't bench without Ollama
fi

# Check Node
NODE_VER=$(node --version 2>/dev/null || echo "none")
echo -e "  ${GREEN}✓${NC} Node.js $NODE_VER"

# Check pnpm/npm
if command -v pnpm &>/dev/null; then
  PKG_MGR="pnpm"
elif command -v npm &>/dev/null; then
  PKG_MGR="npm"
else
  echo -e "  ${RED}✗${NC} No package manager found"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} $PKG_MGR available"

echo ""

# ── Phase 1: Unit Tests ──────────────────────────────────────────────────────

if [[ "$BENCH_ONLY" == "false" ]]; then
  run_step "Unit Tests (Vitest)" "npx vitest run --reporter=verbose 2>&1 | tail -20"

  # ── Phase 2: Type Check ───────────────────────────────────────────────────
  if [[ "$QUICK" == "false" ]]; then
    run_step "Type Check (svelte-check)" "npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5" "false"
  fi

  # ── Phase 3: E2E Tests (mock backend, no API credits) ────────────────────
  if [[ "$QUICK" == "false" ]]; then
    run_step "E2E Tests (Playwright, mock backend)" "npx playwright test --project=desktop-chrome 2>&1 | tail -15" "false"
  fi
fi

# ── Phase 4: Ollama LLM Bench ────────────────────────────────────────────────

if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  OLLAMA_ARGS=""
  if [[ -n "$OLLAMA_MODEL" ]]; then
    OLLAMA_ARGS="--model $OLLAMA_MODEL"
  fi
  if [[ "$SAVE_RESULTS" == "true" ]]; then
    OLLAMA_ARGS="$OLLAMA_ARGS --save"
  fi

  if [[ "$QUICK" == "true" ]]; then
    # Quick mode: only ingest bench with first available model
    if [[ -z "$OLLAMA_MODEL" ]]; then
      # Pick the smallest chat model
      FIRST_MODEL=$(curl -s http://localhost:11434/api/tags | python3 -c "
import sys,json
models = json.load(sys.stdin).get('models',[])
chat = [m for m in models if 'embed' not in m['name'].lower() and 'nomic' not in m['name'].lower()]
chat.sort(key=lambda m: m['size'])
print(chat[0]['name'] if chat else '')
" 2>/dev/null || echo "")
      if [[ -n "$FIRST_MODEL" ]]; then
        OLLAMA_ARGS="--model $FIRST_MODEL --tasks ingest"
      fi
    else
      OLLAMA_ARGS="$OLLAMA_ARGS --tasks ingest"
    fi
    run_step "Ollama Bench (quick — ingest only)" "npx tsx tests/bench/run-ollama-bench.ts $OLLAMA_ARGS"
  else
    run_step "Ollama Bench (full — ingest + chat)" "npx tsx tests/bench/run-ollama-bench.ts $OLLAMA_ARGS"
  fi
fi

# ── Phase 5: Embedding Bench (always local, no API) ──────────────────────────

if [[ "$QUICK" == "false" && "$BENCH_ONLY" == "false" ]]; then
  run_step "Embedding Bench" "npx tsx tests/visual/run-embed-bench.ts 2>&1 | tail -30" "false"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo -e "\n${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  SUMMARY${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"

for r in "${RESULTS[@]}"; do
  if [[ "$r" == ✓* ]]; then
    echo -e "  ${GREEN}$r${NC}"
  elif [[ "$r" == ✗* ]]; then
    echo -e "  ${RED}$r${NC}"
  else
    echo -e "  ${YELLOW}$r${NC}"
  fi
done

echo ""
echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}  ${YELLOW}Skipped: $SKIP${NC}"

if [[ "$SAVE_RESULTS" == "true" ]]; then
  echo -e "  Results saved to ${CYAN}tests/bench/results/${NC}"
fi

echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
