---
'@endo/agentry': patch
---

`@endo/agentry/edit-text` imports `harden` from `@endo/harden` explicitly
instead of relying on the post-lockdown global, so the shared edit algorithm
loads in pre-lockdown (shims-only) environments such as the genie tool suite.
