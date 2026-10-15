---
'@endo/pass-style': minor
---

`passStyleOf` now recognizes a Parcel, as shimmed by `@endo/parcel`, and returns the new pass style `'parcel'`.
Like a remotable, a Parcel has object identity and no data.
Passing a Parcel hands the receiver the authority to open it with `Parcel.open`.
A child compartment recognizes Parcels only when the shim was installed before `lockdown`.
At runtime, nothing changes when no `Parcel` shim has run.

This is a type-level change: the exported `PassStyle` union gains `'parcel'`, and `Passable` admits the new `ParcelObject` type, alone or inside a container.
A consumer with an exhaustive `switch` over `PassStyle`, or a `Record<PassStyle, …>` table, stops type-checking until it adds a `'parcel'` case or narrows with `Exclude<PassStyle, 'parcel'>`.
