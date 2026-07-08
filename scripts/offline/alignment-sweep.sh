#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# Offline Alignment Sweep  —  runs WITHOUT Opus / any cloud orchestrator.
# ══════════════════════════════════════════════════════════════════════════════
# A STATIC batch procedure for off-time (Opus session maxed). Deterministic
# checks across all code and graphs; every finding is surfaced as a pending
# QUESTION in the Reckons.AI review UI for you to triage, and analyzed by Opus
# next session. Safe by construction: read-only + pending entries only — it
# never edits source, commits, or pushes.
#
# The checks encode bugs this project actually hit (a local model with MCP
# access still hallucinated these): broken TTL, /static/ asset paths, the
# urn:kabase: namespace typo, and stale LEAP mentions.
#
#   Usage:  bash scripts/offline/alignment-sweep.sh
#   Review: open Reckons.AI → Review tab → drain (↻); or read the report file.
#   Next online session: hand the report to Opus for analysis.
# ══════════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

REPORT="offline-sweep-$(date +%Y%m%d-%H%M%S).log"
PENDING="reckons-workspace/knowledge.pending.jsonl"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINDINGS=0

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }

# Append a pending QUESTION (partial fact) to the Reckons.AI graph for review.
question() { # $1=subject-slug $2=predicate-slug $3=question text
  printf '{"subject":"urn:sweep:%s","predicate":"urn:sweep:pred/%s","question":%s,"type":"question","agent":"offline:alignment-sweep","priority":"high","addedAt":"%s","addedByMcp":true}\n' \
    "$1" "$2" "$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" "$NOW" >> "$PENDING"
  FINDINGS=$((FINDINGS + 1))
}

log "══ Offline Alignment Sweep — $NOW ══"
log ""

# ── 1. Every graph must parse (catches unusable TTL before it spreads) ────────
log "[1] TTL parse check…"
for f in static/*.ttl reckons-workspace/kbs/*/*.ttl; do
  [ -f "$f" ] || continue
  if ! node --input-type=module -e "import{readFileSync}from'fs';import N3 from'n3';new N3.Parser().parse(readFileSync('$f','utf8'))" 2>>"$REPORT"; then
    log "  ✗ PARSE ERROR: $f"
    question "graph/$(basename "$f" .ttl)" "parse-error" "$f does not parse as TTL — fix before use."
  fi
done

# ── 2. Asset paths: /static/ is wrong (files serve from root: /glb/, /assets/) ─
log "[2] asset-path check (/static/ prefix)…"
if grep -rnE '"/static/[^"]*"' static/*.ttl 2>/dev/null | tee -a "$REPORT" | grep -q .; then
  question "assets" "wrong-path" "TTL references /static/… — static files are served from root (e.g. /glb/, /assets/)."
fi

# ── 3. Namespace typo: urn:kabase: should be urn:kbase: ───────────────────────
log "[3] namespace-typo check (urn:kabase:)…"
if grep -rn "urn:kabase:" static/*.ttl reckons-workspace 2>/dev/null | tee -a "$REPORT" | grep -q .; then
  question "namespace" "typo" "Found urn:kabase: — should be urn:kbase:."
fi

# ── 4. Stale LEAP mentions in graphs / code ───────────────────────────────────
log "[4] stale-LEAP-mention check…"
if grep -rniE "\bleap\b" static/*.ttl src 2>/dev/null | grep -viE "leaflet|leapfrog" | tee -a "$REPORT" | grep -q .; then
  question "leap" "stale-mention" "Stale LEAP mentions found — confirm intended usage vs rename."
fi

# ── 5. Release-pipeline alignment (deterministic; no LLM) ──────────────────────
log ""
log "[5] branch-align (graph pipeline vs git)…"
npm run --silent branch-align 2>&1 | tee -a "$REPORT" || log "  (branch-align reported drift — see above)"

# ── 6. Code ↔ KB alignment (F26) ──────────────────────────────────────────────
log ""
log "[6] kb-align (tests / files vs KB)…"
npx tsx scripts/kb-align.ts --skip-e2e 2>&1 | tee -a "$REPORT" || log "  (kb-align reported discrepancies — see above)"

log ""
log "══ done: $FINDINGS finding(s) queued as pending questions in $PENDING ══"
log "Review in Reckons.AI (Review tab → drain ↻), or hand $REPORT to Opus next session."
echo "Report: $REPORT"
