Run KB alignment to compare test results and code changes against the knowledge base.

1. Run `npx tsx scripts/kb-align.ts --skip-e2e` to capture unit tests, type-check, and MCP build results
2. Review the discrepancies — stale entries mean the KB needs updating, drift means regressions
3. Check `kb_pending` to see the generated proposals
4. For stale test counts, update `static/reckons-production.ttl` directly (the `kpred:expected-result` values)
5. For missing entities (e.g., test-e2e, test-typecheck), add them to the Production TTL
6. For roadmap drift, update `static/reckons-roadmap.ttl` feature statuses
7. After updating TTL files, re-run `kb_alignment_score` to verify the score improved
8. Use `kb_add_note` with type `status-update` for any additional observations
