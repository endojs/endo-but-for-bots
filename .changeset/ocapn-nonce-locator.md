---
'@endo/daemon': minor
'@endo/ocapn': minor
---

Add the reusable mechanism for the OCapN nonce locator: a locator whose
`get` resolves a presented daemon formula identifier — carried on the wire as
the canonical ASCII bytes of the `FormulaIdentifier`, which is the Swiss number
— to exactly that formula's capability. Each *individual* presentation below
the session's miss bound is non-oracular: any failure collapses to one
indistinguishable miss, so a single below-bound presentation reveals only that
it yielded no capability, never which failure class it was. This is uniformity
*below the bound*, not an absolute guarantee: once a session crosses its miss
bound it is severed, and that severance is observable to the crossing peer
(which already knows it exceeded the bound, having made that many misses); the
property never rested on the crossing reply being byte-identical to a
below-bound miss.

`@endo/daemon` gains `@endo/daemon/formula-nonce-locator.js`, exporting
`makeFormulaNonceLocator({ provideLocalFormula, localNodeNumber, missBound,
logger })`. It is the adapter between `@endo/ocapn`'s injected-locator seam and
the daemon's `provide` path: it accepts only canonical ASCII formula
identifiers for the local node, incarnates the formula through the injected
`provideLocalFormula`, and returns the resulting capability. As a **policy** of
this locator (not a protocol limit — `bootstrap.fetch` can carry any
`OcapnPassable`), it serves only remotable capabilities: malformed ASCII,
noncanonical form, an identifier for another node, an absent / collected /
corrupt formula, a value that does not incarnate to a remotable, and an
incarnation that throws all collapse to the same miss — the adapter never
throws and returns `undefined`, which the bootstrap turns into one fixed
`secret not found` rejection, echoing no identifier, node, formula type, or
lookup stage. Well-known swissnum *words* like `endo-bootstrap` and
`endo-peer-entry` are not canonical *formula identifiers*, so this locator never
resolves them (that they name live well-known entries elsewhere is irrelevant
here). `missBound` must be a positive integer — a `NaN`, negative, or
non-integer bound throws at construction rather than silently disabling the
guard — and defaults to a small value; the optional `logger` names, locally
only, the *class* of each miss (never the presented secret), so a silent daemon
stays debuggable without leaking a bearer nonce into the log.

The returned `makeLocatorForSession` factory scopes a miss counter to one
authenticated peer/connection. It orders only *misses* against the bound (hits
run concurrently): a synchronous in-flight counter admits a presentation only
while `misses + inFlight < missBound`, so a peer cannot pipeline past the
counter and no single non-settling lookup can wedge the session. Once
`missBound` misses have settled the session latches closed — every further
presentation, including a valid identifier, is refused synchronously without
running the lookup, so nothing can be redeemed on that session again — and
`abortSession` is called to tear the session down (any throw from the
embedder's `abortSession` is caught and logged locally, never propagated to the
peer). One session crossing its bound never affects any other peer's session.

`@endo/ocapn`'s `makeOcapn` gains an optional `makeLocatorForSession` hook: when
supplied, each established session builds its own `NonceLocator` for incoming
`bootstrap.fetch` calls from the remote designator, instead of sharing the
single injected `locator`. The `remoteDesignator` in the session context is the
peer's *claimed* designator; it is transport-authenticated only when the
netlayer supplies `verifyPeerLocation`, and is otherwise self-asserted and
therefore spoofable — so durable per-peer accounting should key on the
session's verified public key (`getPeerPublicKeyForSessionId`) rather than on
`remoteDesignator`. This is the seam an embedder uses to scope miss counters and
rate limits per authenticated peer; outgoing self-local `SturdyRef` resolution
still uses `locator`.
