---
'ses': major
---

Support the `@endo/parcel` shim when it is installed before `lockdown`.
The start compartment keeps the shim's `Parcel`, including the privileged `Parcel.locate`, while child compartments receive a `Parcel` with only `open` and `isParcel`.
`lockdown` recognizes the shim by shape, not provenance: it accepts an own data property `globalThis.Parcel` holding a constructor with a locked `prototype` and distinct `open`, `locate`, and `isParcel` functions, and trusts it as it trusts any other pre-lockdown code.
Breaking: `lockdown` now throws a `TypeError` for any other own `globalThis.Parcel` binding, including an accessor or a constructor without that shape.
To upgrade, remove or rename any other `globalThis.Parcel` binding before calling `lockdown`, or install `@endo/parcel/shim.js` in its place.
