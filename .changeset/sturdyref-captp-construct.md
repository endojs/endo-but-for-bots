---
'@endo/captp': minor
'@endo/ocapn': minor
---

Each CapTP can now construct a SturdyRef from its data: a peer id, an object
id, a network designator, and connection hints. This is the dual of minting a
SturdyRef for a live object, and it is how a persistence layer re-issues a ref
it recorded.

- `makeCapTP` returns `makeSturdyRefFromData(data)` and `getSturdyRefData(ref)`.
  A ref constructed from data enlivens by asking the peer to `locate` its object
  id over this connection; the peer answers through the new `locateSturdyRef`
  option, and rejects when that option is absent. The new `peerId` option makes
  construction refuse data that names a different peer.
- The `@endo/ocapn` client gains `makeSturdyRefFromData(data)` and
  `getSturdyRefData(ref)`, which map the same field names onto an OCapN
  `(location, secret)` pair. The result is an ordinary OCapN SturdyRef, and a
  client reveals the data only of refs it minted itself.

Both capabilities are closely held by whoever made the CapTP or client; neither
is reachable from a peer, a SturdyRef, or the realm.
