---
'@endo/captp': minor
'@endo/ocapn': major
---

CapTP now carries Parcels inline through the marshal callbacks supplied by its
transport.
Parcels do not consume CapTP slots, and their opaque locations remain under the
authority of the transport that binds them.

`@endo/ocapn` now carries a realm Parcel instead of a
`makeTagged('ocapn-sturdyref', undefined)` record.
`passStyleOf` reports `'parcel'`, not `'tagged'`, and stringification produces
`'[object Parcel]'`.
Each Parcel minted by a client binds its location to that client's open hook,
so `Parcel.open(parcel)` opens it the same way as
`client.openParcel(parcel)`.
The wire form remains the OCapN specification's `ocapn-sturdyref` record.
Trusted OCapN code locates any realm Parcel and accepts it when its location
uses the OCapN scheme.

For compatibility, the exported value was previously typed as
`CopyTagged<'ocapn-sturdyref', undefined>` and is now the realm `Parcel` from
`@endo/pass-style`.
Code that branched on `passStyleOf(ref) === 'tagged'` or
`getTag(ref) === 'ocapn-sturdyref'` must test for `'parcel'` instead, or use
`Parcel.isParcel`.
Code typed against `CopyTagged` must accept `Parcel`.
A Parcel from `@endo/ocapn`'s top-level `makeParcel` has no client bound, so
`Parcel.open(parcel)` rejects.
Mint with a client's `makeParcel` to get a Parcel that opens through that
client.

Opening previously required holding the client and calling
`client.enlivenSturdyRef(ref)`.
A Parcel that a client mints, including one it receives from a peer, now carries
that ability itself, so anyone who holds the Parcel can make the client open a
session to the Parcel's location.
This is the Parcel contract, and it is limited to the Parcel's own opaque
location.
