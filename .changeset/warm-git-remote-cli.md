---
"@endo/cli": minor
---

Add `endo git-remote provision` and `endo git-remote inspect`.
`provision` binds an existing `Git` capability, a named credential, and a fixed HTTPS endpoint into a `fetch-only` or `agent` remote profile, previewing the grant and asking for approval unless `--yes` is given.
The `agent` profile grants push only to `refs/heads/agent/*` or to the narrower branch namespaces given with repeatable `--branch` options, and rejects selectors that would reach tags, other ref namespaces, or every branch.
`inspect` reports the remote's policy and credential health as text or, with `--json`, as JSON.
