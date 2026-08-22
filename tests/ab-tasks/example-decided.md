# A/B task spec — DECIDED kind

Add a way for a user to collapse a group of related nodes in the graph view into a
single summarised node, and expand it again. Include tests.

<!--
WHY THIS IS 'DECIDED': the graph already holds rulings on node summarisation
(F65, F96, kb:graph-legibility) — the 2026-07-19 avoided-rework ledger entry records a
session where exactly this request was resolved onto existing features by ~2k tokens of
kb_search instead of building a parallel feature. The control arm cannot see any of that.
The question under test is whether the graph arm FINDS the existing feature and extends
it, while the control arm builds a second one under a different name.

Keep the wording above neutral and free of this project's vocabulary — naming
'kb:graph-legibility' in the task would hand the graph arm the answer.
-->
