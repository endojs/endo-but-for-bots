---
'@endo/pass-style': minor
---

`passStyleOf` now recognizes a SturdyRef, as shimmed by `@endo/sturdyref`,
and returns the new pass style `'sturdyRef'`. Like a remotable, a SturdyRef has
object identity and no data. Recognition uses only the realm's
`SturdyRef.isSturdyRef` brand check, so an object that merely inherits from
`SturdyRef.prototype`, or a ref from a constructor that lost the first-wins
race, is still rejected. When no `SturdyRef` shim has run, nothing changes.
`@endo/marshal` cannot yet encode a SturdyRef.
