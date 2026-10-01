---
'@endo/sturdyref': patch
---

`@endo/pass-style` now recognizes a SturdyRef as passable, with the pass style `'sturdyRef'`, so `passStyleOf` no longer rejects one.
The `SturdyRef` type now carries its `Symbol.toStringTag` of `'SturdyRef'`, matching the `SturdyRefObject` type of `@endo/pass-style`.
