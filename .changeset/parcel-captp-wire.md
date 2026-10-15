---
'@endo/captp': minor
'@endo/ocapn': major
---

CapTP now carries Parcels inline through the marshal callbacks supplied by
its transport. Parcels no longer consume CapTP slots, and their opaque
locations remain under the authority of the transport that binds them.

`@endo/ocapn`'s Parcel is now a realm Parcel instead of a
`makeTagged('ocapn-sturdyref', undefined)` record. `passStyleOf` reports
`'parcel'`, not `'tagged'`, and `String(ref)` is `'[object Parcel]'`.
Each ref's handler closes over its `(location, secret)` pair and the minting
client, so `Parcel.open(ref)` revives it the same way
`client.openParcel(ref)` does. The wire form is unchanged: the spec's
`ocapn-sturdyref` record. The OCapN codec refuses to write a Parcel that
OCapN did not mint.

Compatibility for `@endo/ocapn` callers: the exported `Parcel` type was
`CopyTagged<'ocapn-sturdyref', undefined>` and is now the realm `Parcel`
from `@endo/pass-style`. Code that branched on `passStyleOf(ref) === 'tagged'`
or `getTag(ref) === 'ocapn-sturdyref'` must test for `'parcel'` instead
(or use `Parcel.isParcel`), and code typed against `CopyTagged` must take
`Parcel`. A Parcel from `@endo/ocapn`'s top-level `makeParcel` has
no client bound, so `Parcel.enliven` rejects for it; mint with a client's
`makeParcel` to get one that enlivens.

Authority note: enlivening used to require holding the client
(`client.enlivenParcel(ref)`). A Parcel that a client mints, including
one it receives from a peer, now carries that ability itself, so anyone who
holds the ref can make the client open a session to the ref's location. This
is the Parcel contract, and it is limited to the ref's own
`(location, secret)` pair.
