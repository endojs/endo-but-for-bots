---
'@endo/parcel': patch
---

The `Parcel` type now carries its `Symbol.toStringTag` of `'Parcel'`, matching the `ParcelObject` type of `@endo/pass-style`, instead of `Readonly<Record<never, never>>`.
