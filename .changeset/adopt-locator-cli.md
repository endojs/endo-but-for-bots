---
'@endo/daemon': minor
'@endo/cli': minor
---

`endo adopt-locator <name>` adopts the value an `endo://` locator names,
reading the bearer locator from standard input or `--file` so it stays out of
shell history. It is distinct from message-attachment `adopt` and invitation
`accept`. The host's `adoptFromLocator` now connects over a hint that an
installed network supports, authenticates the peer, and resolves the value
before storing the pet name; a locator with no hints, no mutually supported
route, a peer identity mismatch, or a value the peer does not provide rejects
without storing a name or redirecting a peer the daemon already knows, and its
errors do not echo the locator.

The OCapN network (`@nets/ocapn`) now also redeems bearer formula identifiers
presented directly to `bootstrap.fetch`, through the per-session bounded formula
nonce locator composed behind the existing `endo-peer-entry`
(`makeWellKnownLocatorForSession`). `makeFormulaNonceLocator` accepts an
`isLocalNode` predicate so it can serve formulas held under agent keys.
