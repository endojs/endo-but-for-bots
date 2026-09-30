---
'@endo/marshal': patch
---

Rank-ordering a pass style that has no rank, such as the new `'sturdyRef'` of `@endo/pass-style`, now throws a clear error instead of a `TypeError` from reading a missing table entry.
`@endo/marshal` cannot yet encode or rank-order a SturdyRef.
