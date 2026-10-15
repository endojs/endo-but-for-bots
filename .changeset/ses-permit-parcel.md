---
'ses': major
---

Support the `@endo/parcel` shim when it is installed before `lockdown`: the start compartment keeps the shim's `Parcel`, including `Parcel.locate`, while child compartments receive a `Parcel` without `locate`.
Breaking: `lockdown` now throws a `TypeError` for any other own `globalThis.Parcel` binding, which earlier versions left alone.
To upgrade, remove or rename any other `globalThis.Parcel` binding before calling `lockdown`, or install `@endo/parcel/shim.js` in its place.
