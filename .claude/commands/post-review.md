Compare current KB state against the pre-review snapshot to show what changed.

1. Check that `/tmp/kb-pre-review.json` exists. If not, tell the user to run `/pre-review` first.
2. Run `npx tsx scripts/kb-snapshot.ts --compare /tmp/kb-pre-review.json --work "$ARGUMENTS"` to generate the diff report
3. Call `kb_alignment_score` to get the updated alignment score
4. Report to the user:
   - Before/after alignment scores with delta
   - New or changed KB entities
   - New test coverage links
   - New file links in the codebase KB
   - Status changes (features advancing through lifecycle)
   - Any drift warnings
5. If the alignment score improved, note it. If it degraded, propose `kb_add_note` entries with type `drift-warning`.
6. Suggest specific TTL updates if the KB needs to reflect the new code changes (e.g., updating `has-status` from "planned" to "functional").
