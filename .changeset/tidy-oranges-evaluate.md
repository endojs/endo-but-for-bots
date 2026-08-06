---
'@endo/agentry': minor
'@endo/daemon': patch
---

Add a directly loadable Pi extension and thin `endo-pi` launcher for
daemon-backed code-mode sessions with durable, non-secret authority policy.
Host-side retained state lives under `code-mode/pi/...` in the daemon pet store.
Route the daemon-start readiness diagnostic to stderr so Pi print and JSON
output remain machine-readable during autostart.
