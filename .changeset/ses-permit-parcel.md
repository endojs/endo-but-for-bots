---
'ses': major
---

Support the `@endo/parcel` shim when it is installed before `lockdown`.
The start compartment keeps the shim's `Parcel`, including the privileged `Parcel.locate`, while child compartments receive a `Parcel` with only `open` and `isParcel`.
Breaking: `lockdown` now throws a `TypeError` if `globalThis.Parcel` exists and is not the `@endo/parcel` constructor, including an accessor or an unrelated constructor.
To upgrade, remove or rename any other `globalThis.Parcel` binding before calling `lockdown`, or install `@endo/parcel/shim.js` in its place.
