---
'@endo/parcel': major
'@endo/eventual-send': minor
'@endo/init': minor
---

Add `@endo/parcel`, a first-wins shim and side-effect-free API for opaque,
passable locations.
`new Parcel(location, openHook)` captures both arguments, `Parcel.open(parcel)`
invokes the hook in a later turn, `Parcel.isParcel(value)` checks the selected
realm brand, and the initial constructor's privileged `Parcel.locate(parcel)`
reveals the captured location.
Add `E.open(parcel)` as the eventual-send convenience for `Parcel.open`.
Install the Parcel shim from `@endo/init` before lockdown.
