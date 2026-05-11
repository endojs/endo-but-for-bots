---
"@endo/daemon": minor
---

Production default for `ENDO_GC` flipped from off to on. The
formula garbage collector now runs by default; set
`ENDO_GC=0` to opt out. Per
`endojs/endo-but-for-bots#207` step 6.
