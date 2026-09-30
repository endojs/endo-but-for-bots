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
