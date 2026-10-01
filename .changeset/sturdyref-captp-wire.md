---
'@endo/captp': minor
'@endo/ocapn': minor
---

CapTP layers mint realm SturdyRefs (`@endo/sturdyref`) and carry them over the
wire.

`@endo/captp` exports a SturdyRef under a new `s+N` slot kind. The peer mints
a SturdyRef of its own for the slot. Enlivening it with `SturdyRef.enliven`
asks the exporter, which enlivens the original SturdyRef and returns the live
result. Passing the imported SturdyRef back yields the original, and
enlivening fails once the connection is aborted.

`@endo/ocapn`'s SturdyRef is now a realm SturdyRef instead of a
`makeTagged('ocapn-sturdyref', undefined)` record. `passStyleOf` reports
`'sturdyRef'`, not `'tagged'`, and `String(ref)` is `'[object SturdyRef]'`.
Each ref's handler closes over its `(location, secret)` pair and the minting
client, so `SturdyRef.enliven(ref)` revives it the same way
`client.enlivenSturdyRef(ref)` does. The wire form is unchanged: the spec's
`ocapn-sturdyref` record. The OCapN codec refuses to write a SturdyRef that
OCapN did not mint.

Compatibility for `@endo/ocapn` callers: the exported `SturdyRef` type was
`CopyTagged<'ocapn-sturdyref', undefined>` and is now the realm `SturdyRef`
from `@endo/pass-style`. Code that branched on `passStyleOf(ref) === 'tagged'`
or `getTag(ref) === 'ocapn-sturdyref'` must test for `'sturdyRef'` instead
(or use `SturdyRef.isSturdyRef`), and code typed against `CopyTagged` must take
`SturdyRef`. A SturdyRef from `@endo/ocapn`'s top-level `makeSturdyRef` has
no client bound, so `SturdyRef.enliven` rejects for it; mint with a client's
`makeSturdyRef` to get one that enlivens.

Authority note: enlivening used to require holding the client
(`client.enlivenSturdyRef(ref)`). A SturdyRef that a client mints, including
one it receives from a peer, now carries that ability itself, so anyone who
holds the ref can make the client open a session to the ref's location. This
is the SturdyRef contract, and it is limited to the ref's own
`(location, secret)` pair.
