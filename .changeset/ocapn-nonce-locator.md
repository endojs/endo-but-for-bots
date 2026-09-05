---
'@endo/daemon': minor
'@endo/ocapn': minor
---

`@endo/daemon` now exports `makeFormulaNonceLocator` (from
`@endo/daemon/formula-nonce-locator.js`): an OCapN nonce locator that resolves a
presented canonical formula identifier to that formula's capability, collapsing
every failure to one indistinguishable miss and severing a session that crosses
a configurable per-session miss bound.

`@endo/ocapn`'s `makeOcapn` gains an optional `makeLocatorForSession` hook, so an
embedder can build a fresh per-session `NonceLocator` for incoming
`bootstrap.fetch` calls (scoping miss counters and rate limits to one
authenticated peer) instead of sharing the single injected `locator`. The
factory receives the peer's claimed `remoteDesignator`, the handshake-verified
`peerPublicKey` (prefer it for durable per-peer accounting), and an
`abortSession` callback.

The two members of `makeFormulaNonceLocator`'s result must both be wired for
incoming peer traffic to be safe: its shared `get` is **unbounded** (no miss
counter, no abort) and is safe as `makeOcapn`'s `locator` only for the daemon's
own outgoing self-local `enlivenSturdyRef`; the miss bound and abort live in
`makeLocatorForSession`, which supplies `makeOcapn`'s hook. Passing only the
shared `get` as `locator` leaves incoming peer fetches unbounded. The mechanism
also refuses every well-known swissnum *word* (e.g. `endo-peer-entry`) by
construction, so a deployment retaining a live well-known swissnum must compose
rather than replace its locator wholesale (see the docstring and
`designs/daemon-ocapn-external-connectivity.md` §2).
