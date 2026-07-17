Check current work against the Reckons.AI knowledge base.

1. Call `kb_alignment_score` to get a quantitative alignment score with per-dimension breakdown
2. Call `kb_git_status` to get current branch, staged files, and recent commits
3. Call `kb_check_plan` with a summary of recent changes to find matching KB entities and their statuses
4. Call `kb_git_diff_triples` to find KB entities affected by changed files
5. Call `kb_pending` to see any queued proposals
6. Report: alignment score, per-entity verdicts, what matches the plan, what diverges, what KB entities need updating
7. If alignment score < 0.5 or drift is detected, propose `kb_add_note` entries with type `drift-warning` and priority `high`
