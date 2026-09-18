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

mkdir -p "$KBS"/{production,roadmap,features,docs,quickstart,codebase,architecture,vocabulary,generation,terminology,standards}

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
# The controlled vocabularies (SKOS + SHACL). Linked so an agent can ASK what a valid altitude or
# task state is, rather than inferring it from examples — which is the whole reason for defining
# them in the graph instead of in TypeScript.
ln -sf ../../../static/reckons-vocabulary.ttl "$KBS/vocabulary/vocabulary.ttl"
# Terminology (F203) and coding standards (F204). Linked because the failure they exist to prevent
# is an agent GUESSING a convention it could have looked up: which of four things "node" means
# here, or whether a constant is UPPER_SNAKE. A graph nothing can search is a graph nobody reads,
# and silence from kb_search reads as "no such rule exists" rather than "not linked".
mkdir -p "$KBS/terminology" "$KBS/standards"
ln -sf ../../../static/reckons-terminology.ttl "$KBS/terminology/terminology.ttl"
ln -sf ../../../static/reckons-standards.ttl   "$KBS/standards/standards.ttl"
# The local-generation catalogue, so an agent can ask what is available and what its licence
# permits rather than guessing from a model name.
ln -sf ../../../static/reckons-generation-tools.ttl "$KBS/generation/generation.ttl"
# The offline jobs, as entities (F87: a task is a triple). Linked so an agent can ask what runs,
# at which tier, and whether it is enabled — instead of reading scripts/offline/jobs.json, which is
# the same facts in a format nothing else in the system can query.
mkdir -p "$KBS/jobs"
ln -sf ../../../static/reckons-jobs.ttl "$KBS/jobs/jobs.ttl"
# The positioning graph (F200). Linked as its own KB rather than only folded into docs-all.ttl so
# that "why this instead of Palantir / OntoBricks / Logseq" is ANSWERABLE by kb_search. It is the
# one graph in the workspace that is openly persuasion, and it carries its own sources and dates
# so an agent quoting it can quote the evidence too.
mkdir -p "$KBS/why"
ln -sf ../../../static/docs-why-reckons.ttl "$KBS/why/why.ttl"

# Docs KB: merge all sub-graphs into one file, then symlink
cat static/starter-guide.ttl \
    static/docs-triples-rdf.ttl \
    static/docs-llm.ttl \
    static/docs-use-cases.ttl \
    static/docs-integrations-tech.ttl \
    static/docs-tips-security.ttl \
    static/docs-timeline-ecosystem.ttl \
    static/docs-why-reckons.ttl \
    > static/docs-all.ttl
ln -sf ../../../static/docs-all.ttl "$KBS/docs/docs.ttl"

echo "Workspace ready: $WORKSPACE/ (8 KBs, symlinked to static/*.ttl)"

# ── mcp-workspace: the graphs Claude Code's `reckons` MCP server reads ─────────
#
# .mcp.json (committed) points the server at mcp-workspace/, but that directory is
# GITIGNORED — so without this block a fresh clone gets a configured MCP server with
# nothing to read. It was also hand-made once and then drifted: on 2026-07-18 the
# `architecture` and `testing` folders existed but were EMPTY and `codebase` was absent,
# so the server silently served 3 graphs while CLAUDE.md described 6. Building it from a
# script instead of by hand is what stops that recurring.

MCP_WS="mcp-workspace"
MCP_KBS="$MCP_WS/kbs"

echo "Setting up MCP workspace..."

mkdir -p "$MCP_KBS"/{production,roadmap,features,architecture,testing,codebase,terminology,standards}
find "$MCP_KBS" -name meta.json -delete 2>/dev/null || true
find "$MCP_KBS" -name kb.ttl -delete 2>/dev/null || true

ln -sf ../../../static/reckons-production.ttl "$MCP_KBS/production/production.ttl"
ln -sf ../../../static/reckons-roadmap.ttl    "$MCP_KBS/roadmap/roadmap.ttl"
ln -sf ../../../static/docs-features.ttl      "$MCP_KBS/features/features.ttl"
ln -sf ../../../static/docs-architecture.ttl  "$MCP_KBS/architecture/architecture.ttl"
ln -sf ../../../static/docs-testing.ttl       "$MCP_KBS/testing/testing.ttl"
ln -sf ../../../static/reckons-codebase.ttl   "$MCP_KBS/codebase/codebase.ttl"
# Same two graphs for the Claude Code workspace: a coding agent is the reader these were written
# for, so leaving them out of the workspace it actually queries would defeat the point entirely.
mkdir -p "$MCP_KBS/terminology" "$MCP_KBS/standards"
ln -sf ../../../static/reckons-terminology.ttl "$MCP_KBS/terminology/terminology.ttl"
ln -sf ../../../static/reckons-standards.ttl   "$MCP_KBS/standards/standards.ttl"
mkdir -p "$MCP_KBS/user-paths"
ln -sf ../../../static/docs-user-paths.ttl   "$MCP_KBS/user-paths/user-paths.ttl"
# Positioning graph (F200) — see the note in the reckons-workspace block above.
mkdir -p "$MCP_KBS/why"
ln -sf ../../../static/docs-why-reckons.ttl  "$MCP_KBS/why/why.ttl"

# ── Starter graphs ────────────────────────────────────────────────────────────
# These were linked by hand once and never added here, so a FRESH CLONE got a
# different graph-lint result from this machine — the same silent-drift class the
# dangling-link check below exists to catch. Listed explicitly now.
for starter in guide everyday turtles; do
  mkdir -p "$MCP_KBS/starter-$starter"
  ln -sf "../../../static/starter-$starter.ttl" "$MCP_KBS/starter-$starter/starter-$starter.ttl"
done

# Sourced application example plus its portable opportunity and seeker inputs.
# Keep these separate from the user's own humanity-ai-call draft.
for example in humanity-pdc humanity-opportunity reckons-seeker; do
  mkdir -p "$MCP_KBS/example-$example"
  ln -sf "../../../static/example-$example.ttl" "$MCP_KBS/example-$example/example-$example.ttl"
done

# Fail loudly if a link is dangling — a silently-empty graph is how the drift above
# went unnoticed for weeks.
missing=0
for f in "$MCP_KBS"/*/*.ttl; do
  [ -e "$f" ] || { echo "  BROKEN LINK: $f"; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "MCP workspace has dangling symlinks — fix static/*.ttl paths above."; exit 1; }

echo "MCP workspace ready: $MCP_WS/ (documentation, starters and 3 grant example graphs) — restart Claude Code to pick up .mcp.json"
