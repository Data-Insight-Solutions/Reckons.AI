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

# Reports live beside the other run evidence (reckons-workspace/runs/, runner.log.jsonl),
# not in the repo root. 71 of these had accumulated there — invisible to `git status` because
# .gitignore matches `*.log` anywhere, so nothing ever prompted a cleanup.
SWEEP_DIR="reckons-workspace/sweeps"
mkdir -p "$SWEEP_DIR"
REPORT="$SWEEP_DIR/offline-sweep-$(date +%Y%m%d-%H%M%S).log"
PENDING="reckons-workspace/knowledge.pending.jsonl"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINDINGS=0

log() { printf '%s\n' "$*" | tee -a "$REPORT"; }

# Report a FINDING this script has already proved.
#
# These used to be queued as `type: "question"` with no object — a partial fact asking a human
# "is this a typo?" about a grep the script had just run and answered. That is precisely the work
# the script tier exists to remove: a deterministic check that ends in a human decision has moved
# the cost rather than removed it, and it asks a question whose answer it is holding.
#
# Now they are OBSERVATIONS carrying the answer, and only ever emitted when the check actually
# fails. A passing check queues nothing at all.
#
# NOTE — still a raw append, and that is a known gap: it bypasses transactPendingQueue, so this
# script neither dedupes nor takes the lock, and every run re-queues findings that are already
# there. That is why the same namespace row appears four times. Routing this through the shared
# writer needs a small TS entry point; until then do not run this concurrently with other queue
# writers, and expect repeats.
finding() { # $1=subject-slug $2=predicate-slug $3=object/answer $4=note
  printf '{"subject":"urn:sweep:%s","predicate":"urn:sweep:pred/%s","object":%s,"note":%s,"kb":"roadmap","type":"observation","agent":"offline:alignment-sweep","priority":"high","addedAt":"%s","addedByMcp":true}\n' \
    "$1" "$2" \
    "$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$(printf '%s' "$4" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$NOW" >> "$PENDING"
  FINDINGS=$((FINDINGS + 1))
}

# Drop comment lines before matching. The namespace check used to match the WORD "urn:kabase:"
# inside a comment in example-design-principles.ttl that documents the typo as an example — so it
# reported a typo that did not exist, every run, since 2026-07-12.
#
# Matches the comment marker AFTER grep's `file:line:` prefix as well as at the start of a bare
# line — anchoring on `^` alone silently strips nothing from `grep -rn` output, which is the only
# thing this is ever fed.
strip_comments() { grep -vE '(^|:[0-9]+:)[[:space:]]*#'; }

log "══ Offline Alignment Sweep — $NOW ══"
log ""

# ── 1. Every graph must parse (catches unusable TTL before it spreads) ────────
log "[1] TTL parse check…"
for f in static/*.ttl reckons-workspace/kbs/*/*.ttl; do
  [ -f "$f" ] || continue
  if ! node --input-type=module -e "import{readFileSync}from'fs';import N3 from'n3';new N3.Parser().parse(readFileSync('$f','utf8'))" 2>>"$REPORT"; then
    log "  ✗ PARSE ERROR: $f"
    finding "graph/$(basename "$f" .ttl)" "parse-error" "$f" "$f does not parse as TTL — fix before use."
  fi
done

# ── 2. Asset paths: /static/ is wrong (files serve from root: /glb/, /assets/) ─
log "[2] asset-path check (/static/ prefix)…"
HITS="$(grep -rnE '"/static/[^"]*"' static/*.ttl 2>/dev/null | strip_comments || true)"
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" >> "$REPORT"
  finding "assets" "wrong-path" "$(printf '%s\n' "$HITS" | wc -l) reference(s)" \
    "TTL references /static/… — static files are served from root (e.g. /glb/, /assets/)."
else
  log "  ✓ none"
fi

# ── 3. Namespace typo: urn:kabase: should be urn:kbase: ───────────────────────
log "[3] namespace-typo check (urn:kabase:)…"
HITS="$(grep -rn "urn:kabase:" static/*.ttl reckons-workspace/kbs 2>/dev/null | strip_comments || true)"
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" >> "$REPORT"
  finding "namespace" "typo" "$(printf '%s\n' "$HITS" | wc -l) occurrence(s)" \
    "Found urn:kabase: — should be urn:kbase:."
else
  log "  ✓ none"
fi

# ── 4. Stale LEAP mentions in graphs / code ───────────────────────────────────
log "[4] stale-LEAP-mention check…"
HITS="$(grep -rniE "\bleap\b" static/*.ttl src 2>/dev/null | grep -viE "leaflet|leapfrog" | strip_comments || true)"
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" >> "$REPORT"
  finding "leap" "stale-mention" "$(printf '%s\n' "$HITS" | wc -l) mention(s)" \
    "Stale LEAP mentions found — confirm intended usage vs rename."
else
  log "  ✓ none"
fi

# ── 5. Release-pipeline alignment (deterministic; no LLM) ──────────────────────
log ""
log "[5] branch-align (graph pipeline vs git)…"
npx tsx scripts/branch-align.ts --suggest 2>&1 | tee -a "$REPORT" || log "  (branch-align reported drift — see above)"

# ── 6. Code ↔ KB alignment (F26) ──────────────────────────────────────────────
log ""
log "[6] kb-align (tests / files vs KB)…"
npx tsx scripts/kb-align.ts --skip-e2e 2>&1 | tee -a "$REPORT" || log "  (kb-align reported discrepancies — see above)"

log ""
log "══ done: $FINDINGS finding(s) queued as pending questions in $PENDING ══"
log "Review in Reckons.AI (Review tab → drain ↻), or hand $REPORT to Opus next session."
echo "Report: $REPORT"
