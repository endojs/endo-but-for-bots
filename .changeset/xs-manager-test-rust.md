---
'@endo/daemon': patch
---

The XS manager that the Rust `endor` supervisor runs now honors `setTimeout`
delays instead of firing every timer on the microtask queue, so a timer
formula's tick loop no longer starves the manager and hangs every later
request.
