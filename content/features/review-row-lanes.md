---
title: "Where a machine's row goes in Review: claim, question or finding"
slug: "review-row-lanes"
order: 1062
section: "Features"
parent: "review-system"
template: doc
status: published
nav: sidebar
excerpt: "Every row a local job writes for you to review is stamped when it is written with the collection it belongs to, the run that made it, the job's name and a lane."
generated: "docs-kb"
---

# Where a machine's row goes in Review: claim, question or finding

Every row a local job writes for you to review is stamped when it is written with the collection it belongs to, the run that made it, the job's name and a lane. The lane says what accepting it would do: a CLAIM writes a fact when accepted; a QUESTION wants an answer; a FINDING is a machine's note that something needs doing (a file, a page, a commit), so accepting writes nothing, which is why a finding can be rejected or put off but never settled. Findings are kept out of your review queue. A row missing its collection, run or lane is refused at write time with the missing field named. If a person runs a job by hand there is no run to name, so the row is stamped with a made-up run id of the form hand:&lt;job&gt;:&lt;time&gt; and a line says so. Rows your own notes make need only a collection. If the app has to keep back a row that names no collection, it now says how many and why.

## Why it is this way

**Honest Note**

PARTLY BUILT. The model that made a row is stamped only when a job reports it, and almost none do, so it is often missing and not enforced. Older rows get their lane from their job's declaration plus a guess whose accuracy was not measured, and the declarations are a first reading, not an audit. Nothing yet fails a queue row whose lane its job did not declare. Some producers still write findings as rows; those are hidden from review but still written.
