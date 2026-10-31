---
'@endo/gateway': minor
---

Add the local bootstrap registration protocol for per-user daemons.
The gateway now challenges Ed25519 identities, tracks registered public keys
and weblets, and removes registrations when their CapTP connection closes.
Add the daemon-side publisher that proves key possession and exposes only the
weblets published through its registration.
