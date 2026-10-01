---
'@endo/marshal': patch
---

Rank-ordering a pass style that has no rank, such as the new `'sturdyRef'` of `@endo/pass-style`, now throws a clear error instead of a `TypeError` from reading a missing table entry.
`@endo/marshal` cannot yet encode or rank-order a SturdyRef.
Marshalling one with `toCapData` or `serialize`, in either body format, throws an error naming the `'sturdyRef'` pass style rather than an internal error.
Passing one through a dot-membrane does the same.
`compareRank` still answers 0 when both operands are the same SturdyRef, as it does for any identical operands.
