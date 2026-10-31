---
"@endo/daemon": minor
---

Add formula inspection for `git-credential` and `git-remote` formulas.
Inspecting a Git remote reports its fixed endpoint, fetch and push refspecs, allowed branches, revocation state, and force-push, tag, deletion, and local-file transport policy.
Inspecting a Git credential reports its kind and audience without revealing credential material.
