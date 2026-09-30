# Protecting `main`

`main` deploys to production on every push, so an unreviewed push is an unreviewed deploy.
`ruleset-main.json` is the live configuration, exported from GitHub, checked in so it is
reviewable and diffable rather than living only in a settings page.

It is a **ruleset**, not classic branch protection. The two are different features with
different APIs, and an earlier version of this file documented the classic one — which was
never what got applied.

## What it enforces (verified 2026-09-24)

| Rule | Effect |
|---|---|
| `pull_request` | No direct pushes. 0 approvals required — a sole maintainer cannot approve their own PR, and requiring one would lock the only person who can merge out of merging. Review threads must be resolved. |
| `required_status_checks` | All 8 CI gates, including `Promotion gate (staging → main)`. A check that is not *required* is only a red mark somebody can merge past. |
| `non_fast_forward` | No force-pushing. History on a deploying branch is evidence. |
| `deletion` | `main` cannot be deleted. |
| bypass | Repository admin + `matt-roe`, mode `always`. A genuine emergency has a path, and taking it is recorded — a better property than a rule strict enough that someone eventually switches the whole thing off. |

## Changing it

Edit in **Settings → Rules → Main merge protection**, then re-export and commit the JSON so
this file keeps matching reality. GitHub does not push changes back here.

## Reading it back, and a trap worth knowing

```bash
gh api repos/Data-Insight-Solutions/Reckons.AI/rulesets --jq '.[] | {id, name, enforcement}'
gh api repos/Data-Insight-Solutions/Reckons.AI/rulesets/<id> --jq '{enforcement, rules: [.rules[].type]}'
```

**A non-admin token cannot see the whole ruleset, and the API does not say so.**
`bypass_actors` is OMITTED entirely rather than returned empty, and classic-protection
endpoints answer `404` — which reads as "does not exist" and is in fact "you may not look".
Both misled a session on 2026-09-24 into reporting that protection was absent and that there
was no emergency bypass, when both were configured correctly.

Ask whether the field is PRESENT, not whether it is empty:

```bash
gh api repos/.../rulesets/<id> --jq 'has("bypass_actors")'   # false ⇒ redacted, not empty
gh api repos/.../rulesets/<id> --jq '.current_user_can_bypass'
```

`current_user_can_bypass` is readable without admin and answers the question that actually
matters at 2am.

## The promotion path this exists to enforce

```
feature → dev → staging → main
```

`scripts/offline/promotion-gate.ts` fails any PR into `main` whose head is not `staging`.
Add it to the required list only AFTER the workflow exists on `main` — requiring a check that
has never reported on a branch blocks every merge into it, including the one that would fix it.
