Capture a KB snapshot before making code changes. This creates a baseline for comparing what changed.

1. Run `npx tsx scripts/kb-snapshot.ts --output /tmp/kb-pre-review.json --work "$ARGUMENTS"` to capture the current KB state
2. Call `kb_alignment_score` to report the current alignment score
3. Call `kb_check_plan` with the work description "$ARGUMENTS" to show which KB entities relate to the planned work
4. Report to the user:
   - Current alignment score and grade
   - Which KB features will be affected by this work
   - Any drift warnings or dependency concerns
   - Confirm the pre-review snapshot was saved
5. Tell the user: "Pre-review snapshot saved. After making changes, run `/post-review` to see the KB diff."
