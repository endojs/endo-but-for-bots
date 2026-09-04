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
`abortSession` callback. The two pair directly:
`makeFormulaNonceLocator`'s own `makeLocatorForSession` supplies this hook.
