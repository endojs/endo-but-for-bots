---
'@endo/pass-style': minor
---

`passStyleOf` now recognizes a Parcel, as shimmed by `@endo/parcel`, and returns the new pass style `'parcel'`.
Like a remotable, a Parcel has object identity and no data.
Passing a Parcel hands the receiver the authority to enliven it with `Parcel.enliven`.
A child compartment recognizes Parcels only when the shim was installed before `lockdown`.
When no `Parcel` shim has run, nothing changes.
The `Passable` type admits the new `ParcelObject` type, alone or inside a container.
