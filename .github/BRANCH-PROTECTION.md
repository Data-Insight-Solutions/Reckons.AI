# Protecting `main`

`main` deploys to production on every push, so an unreviewed push is an unreviewed deploy.
This file is the settings it should carry, checked in so the configuration is reviewable
rather than living only in a settings page nobody can diff.

**Applying it needs repository ADMIN rights.** Agents working in this repo generally do not
have them — `PUT /branches/main/protection` returns 404 with a push-only token, which reads as
"not found" rather than "not permitted" and is easy to misread as a broken command.

```bash
gh api -X PUT repos/Data-Insight-Solutions/Reckons.AI/branches/main/protection \
  --input .github/branch-protection-main.json
```

## Why each setting

| Setting | Value | Why |
|---|---|---|
| `contexts` | the 8 CI gates | A check that is not *required* is only a red mark somebody can merge past. |
| `Promotion gate` | required | Enforces `dev → staging → main`. **Add only after the gate workflow exists on `main`** — requiring a check that has never reported on a branch blocks every merge into it, including the one that would fix it. |
| `strict` | `false` | Requiring every PR to be rebased onto the latest `main` serialises merges for one maintainer and buys little when CI already runs on the merge result. |
| `enforce_admins` | `false` | Keeps a genuine emergency path open. The audit trail records an admin override, which is a better property than a rule so rigid people switch the whole thing off. |
| `required_pull_request_reviews` | `null` | Sole maintainer. Requiring an approving review from someone else would lock the only person who can merge out of merging. Revisit the day a second maintainer exists. |
| `allow_force_pushes` | `false` | History on a deploying branch is evidence. |
| `allow_deletions` | `false` | — |
| `required_conversation_resolution` | `true` | Review comments get answered rather than merged past. |

## Verify afterwards

```bash
gh api repos/Data-Insight-Solutions/Reckons.AI/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, admins: .enforce_admins.enabled}'
```

A 404 here means protection is **not** applied — the same response as a permissions failure,
so check the output rather than assuming the command worked.
