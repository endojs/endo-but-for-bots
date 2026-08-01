---
'@endo/agentry': minor
'@endo/daemon': patch
---

Add a directly loadable Pi extension and thin `endo-pi` launcher for
daemon-backed code-mode sessions with durable, non-secret authority policy.
Route the daemon-start readiness diagnostic to stderr so Pi print and JSON
output remain machine-readable during autostart.
