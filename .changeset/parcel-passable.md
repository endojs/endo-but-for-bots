---
'@endo/parcel': patch
---

`@endo/pass-style` now recognizes a Parcel as passable, with the pass style `'parcel'`, so `passStyleOf` no longer rejects one.
The `Parcel` type now carries its `Symbol.toStringTag` of `'Parcel'`, matching the `ParcelObject` type of `@endo/pass-style`.
