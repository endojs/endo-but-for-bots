---
"@endo/cli": minor
"@endo/daemon": minor
---

Add `endo git-remote provision` and `endo git-remote inspect`, and formula inspection for Git remotes and credentials.
`provision` binds an existing `Git` capability, a named credential, and a fixed HTTPS endpoint into a `fetch-only` or `agent` remote profile, previewing the grant on stderr and asking for approval unless `--yes` is given.
The `agent` profile grants push only to `refs/heads/agent/*` or to the narrower branch namespaces given with repeatable `--branch` options, and rejects selectors that would reach tags, other ref namespaces, or every branch, or that `git check-ref-format` would refuse.
`inspect` reports the remote's policy and credential health as text or, with `--json`, as JSON; a revoked remote reports its policy without credential health.
Inspecting a `git-remote` formula reports its fixed endpoint, allowed branches, the push refspecs the remote enforces (including those derived from allowed branches), fetch refspecs, revocation state, and force-push, tag, deletion, and local-file transport policy.
Inspecting a `git-credential` formula reports its kind and audience without revealing credential material.
