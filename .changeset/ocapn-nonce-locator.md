---
'@endo/daemon': minor
'@endo/ocapn': minor
---

Add the reusable mechanism for the OCapN nonce locator: an OCapN endpoint whose
protocol bootstrap resolves a presented daemon formula identifier — carried on
the wire as the canonical ASCII bytes of the `FormulaIdentifier`, which is the
Swiss number — to exactly that formula's capability, and turns every failure
into one indistinguishable miss so the endpoint cannot become an oracle for
probing valid identifiers.

`@endo/daemon` gains `@endo/daemon/formula-nonce-locator.js`, exporting
`makeFormulaNonceLocator({ provideLocalFormula, localNodeNumber, missBound })`.
It is the adapter between `@endo/ocapn`'s injected-locator seam and the daemon's
`provide` path: it accepts only canonical ASCII formula identifiers for the
local node, incarnates the formula through the injected `provideLocalFormula`,
and returns the resulting OCapN-exportable target. Malformed ASCII, noncanonical
form, an identifier for another node, an absent / collected / corrupt formula, a
value that does not incarnate to a remotable, and an incarnation that throws all
collapse to the same miss: the adapter never throws and returns `undefined`,
which the bootstrap turns into one fixed `secret not found` rejection, echoing no
identifier, node, formula type, or lookup stage. The old fixed `endo-bootstrap`
and `endo-peer-entry` names are not canonical formula identifiers and are
therefore never accepted. The returned `makeLocatorForSession` factory scopes a
miss counter to one authenticated peer/connection and tears that session down
once it crosses `missBound`, without affecting any other peer's session.

`@endo/ocapn`'s `makeOcapn` gains an optional `makeLocatorForSession` hook: when
supplied, each established session builds its own `NonceLocator` for incoming
`bootstrap.fetch` calls from the authenticated remote designator, instead of
sharing the single injected `locator`. This is the seam an embedder uses to
scope miss counters and rate limits per authenticated peer; outgoing self-local
`SturdyRef` resolution still uses `locator`.
