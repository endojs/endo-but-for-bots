# OCapN, DIDs, and UCANs: overlap analysis and alignment options

Research notes on how OCapN relates to W3C Decentralized Identifiers (DIDs)
and UCANs (User Controlled Authorization Networks), and how OCapN could be
changed — in tiers of increasing invasiveness — to better support those
primitives.
Grounded in the OCapN draft specifications (CapTP, Netlayers, Locators),
the UCAN 1.0 specification family (Delegation, Invocation, Promise,
Revocation), W3C DID Core 1.0/1.1, and this repository's implementation
(`packages/ocapn`, `packages/captp`).
Related community discussion: [kriskowal/garden#34][garden-34] (CAS and DID).

Status: research notes, 2026-07-13.
Both OCapN and this implementation are pre-standardization and likely to
change; every OCapN-side claim below is time-sensitive to the draft state.

[garden-34]: https://github.com/kriskowal/garden/issues/34

## TL;DR

OCapN and UCAN sit on opposite sides of a split the UCAN spec itself
articulates: reference capabilities versus certificate capabilities.
OCapN exercises authority over live, ordered, session-bound connections;
UCAN adopts an SPKI-lineage certificate model precisely because offline
operation and self-verifiability are hard requirements, and its identity
layer is mandatorily DIDs (`did:key` support is required).

The two natural bridge points are:

1. **The locator layer.**
   OCapN designators are conventionally self-authenticating public keys —
   structurally the same content as a `did:key`.
2. **Third-party handoffs.**
   OCapN's handoff give/receive descriptors are already signed
   certificates — the closest structural analogue to a UCAN delegation —
   but single-hop, session-bound, online-redeemed, and unattenuated.

A `did:key` bijection and UCAN-as-payload gateways need no protocol change
at all (Tier 0).
DID designators, a stable-identity session attestation, and caveats on
handoff certificates are backward-compatible additions (Tier 1).
Chainable offline delegation certificates and protocol-level revocation
are feasible only as deep changes to OCapN's possession-based,
connection-oriented semantics (Tier 2).

## The three systems in brief

### OCapN: live reference capabilities

- CapTP object references are per-session positive integers in
  import/export tables — positions, not portable cryptographic
  identifiers.
  ("Any object which is exported over CapTP is described with a positive
  integer. This positive integer MUST be unique to this CapTP session.")
- Peer identity at the CapTP layer is **ephemeral**: each side generates a
  fresh Ed25519 key pair per session, and the public identifier is a
  double-SHA-256 of the serialized public-key descriptor.
  This implementation confirms it: `makeSelfIdentity` runs per connection
  (`src/client/index.js`), keys are never persisted
  (`src/cryptography.js`), and session IDs are derived from the sorted
  pair of per-session key hashes.
- Netlayers must deliver messages in order while a session is active.
  Authority is exercised over live connections, not standalone artifacts.
- Locators (`ocapn://<designator>.<transport>[?hints]`, plus sturdyref
  forms) address nodes and objects.
  The designator is *conventionally* a self-authenticating public key
  (the websocket netlayer here uses the base32-encoded Ed25519 public
  key), and the Netlayers draft requires that designator + transport alone
  uniquely distinguish two locations — hints must not be load-bearing for
  identity.
- Sturdyrefs are pure bearer capabilities: `(location, swissnum)`, no
  subject binding, redeemed online via `fetch` on the peer's bootstrap.
- Third-party handoffs are OCapN's only certificate-like mechanism: the
  gifter signs a `desc:handoff-give` naming the receiver's session key,
  the exporter's location, the gifter–exporter session, and a gift ID;
  the receiver counter-signs a `desc:handoff-receive` with a
  replay-preventing handoff count; both ride in `desc:sig-envelope`s and
  the exporter verifies both.
  There is no attenuation or caveat field anywhere in the handoff path,
  and redemption requires a live connection to the exporter.
- The CapTP draft contains no revocation or attenuation language at all;
  both are behavioral patterns (caretakers, membranes, read-only
  attenuators — as used in the Endo daemon).

### UCAN: offline certificate capabilities

- UCAN 1.0 deliberately adopts a certificate-capability model in the SPKI
  lineage: "Since offline operation and self-verifiability are two
  requirements, UCAN adopts a certificate capability model related to
  SPKI."
- Every principal (`iss`, `aud`, `sub`) MUST be a DID; the `did:key`
  cryptosuite MUST be supported.
  There is no authorization server; delegation chains are self-certifying
  (the resource defaults to the subject).
- Chains validate offline: `aud` of each proof must equal `iss` of the
  next link, signatures must verify against the issuer DIDs, and `nbf`/
  `exp` time bounds apply; validation MUST occur upon receipt of an
  invocation, before execution.
- Attenuation is monotonic and mandatory ("Each direct delegation MUST
  either directly restate or attenuate its capabilities") and expressed in
  a syntactic policy language (predicate logic with jq-inspired selectors)
  constraining the eventual invocation's `args`.
- The spec family is modular: Delegation and Invocation are REQUIRED;
  Promise and Revocation are RECOMMENDED.
  Revocation is by delegation CID, eventually consistent, and described as
  a "last line of defense" — strictly weaker than severing a live
  reference.
- The lineage is acknowledged in both directions: the UCAN Invocation spec
  names CapTP "one of the most influential object-capability systems" and
  describes OCapN as extending CapTP with a generalized networking layer;
  UCAN Promise mirrors CapTP promise pipelining.

### DIDs: portable cryptographic identifiers

- A DID resolves to a DID document containing verification methods (keys)
  and service endpoints.
- `did:key` is purely generative — the identifier *is* the public key, no
  registry, no mutation — and is the method UCAN requires.
- Most other methods (`did:web`, ledger-based methods) resolve through a
  mutable external authority, which imports an availability and trust
  dependency that self-authenticating designators do not have.
  DID 1.1 refines but does not change this basic architecture.

## Where the models overlap — and where they don't

| Concern | OCapN today | UCAN/DID | Fit |
|---|---|---|---|
| Node identity | Self-authenticating public-key designator (locators) | `did:key` is the same content in different clothes | **Good** |
| Session identity | Fresh Ed25519 pair per session, unlinkable by default | Long-lived DIDs, linkable by design | Tension: opt-in bridging only |
| Delegation | Signed handoff certificates, single-hop, session-bound, online | Signed chains, multi-hop, offline | **Structurally adjacent** |
| Attenuation | Behavioral (caretakers/membranes), unbounded expressiveness | Syntactic policy language over invocation args | Different philosophies |
| Revocation | Sever the connection / drop the reference / revoke the caretaker — immediate | By-CID revocation lists, eventually consistent | OCapN's is stronger |
| Offline authority | None (sturdyref secrets aside) | The entire point | **The real gap** |
| Invocation & promises | CapTP op:deliver + pipelining | UCAN Invocation + Promise (cites CapTP as prior art) | Already convergent |

What fits well:

- **`did:key` ↔ designator.**
  Both are self-authenticating public keys; the mapping is mechanical.
- **DID documents as structured connection hints.**
  A DID document's service endpoints are exactly the "peer identifier plus
  connection hints" shape that OCapN locator hints gesture at — and that
  [garden#34][garden-34] asks for when it seeks a portable locator for
  content-addressed blobs naming multiple retrieval sources.
- **UCAN delegation shape ↔ handoff certificates.**
  A handoff-give is already an issuer-signed statement naming an audience
  key and a subject (the gift at the exporter); UCAN generalizes exactly
  the dimensions handoffs deliberately restrict.

What fits poorly:

- **Registry- and ledger-resolved DID methods as designators.**
  Mutable resolution reintroduces an external authority and an
  availability dependency, and undermines the self-authentication the
  Netlayers draft leans on.
  `did:key` (and arguably `did:peer`) are the ocap-safe subset.
- **Identity-bound authority as the default.**
  UCAN authority is attached to identities; ocap discipline attaches it to
  references precisely to avoid ambient authority and confused deputies,
  and to preserve least linkability (per-session keys are a privacy
  feature, not an accident).
  Any bridging should be opt-in per capability, not a global identity
  layer.
- **UCAN's syntactic policy caveats over CapTP invocations.**
  Constraining Syrup/OCapN-encoded `op:deliver` arguments with jq-style
  selectors is an awkward match for arbitrary method invocation, and the
  exporter would bear enforcement cost at redemption time.
  Behavioral attenuators remain more expressive; caveats earn their keep
  only in the offline gap where no live attenuator can run.
- **UCAN revocation as a replacement for anything.**
  It is eventually consistent and best-effort; adopting offline
  certificates means accepting a weaker revocation story for exactly the
  authority conveyed offline.

## Recommendations

### Tier 0 — no protocol change (layered on top)

1. **Publish a `did:key` rendering of OCapN node identity.**
   Define the mechanical bijection between a locator designator's public
   key and `did:key`, so any OCapN node has a DID (and a derivable DID
   document whose service endpoints carry the netlayer address and hints)
   for free.
   *Unlocks:* participation in DID-consuming ecosystems (verifiable
   credentials, DIDComm-adjacent tooling, UCAN principals) without
   touching the wire protocol.
2. **Carry UCANs as CapTP payloads; build gateway objects.**
   UCAN delegations and invocations are just bytes/structs; CapTP can
   carry them today.
   A *UCAN gateway* exo can redeem a valid UCAN chain for a live reference
   (certificate → reference exchange), and mint UCANs scoped to
   capabilities it holds (reference → certificate), entirely at the
   application layer.
   *Unlocks:* offline delegation for OCapN-hosted services, interop with
   UCAN-native clients, zero spec risk; deployable now.
3. **Keep attenuation and revocation as caretakers/membranes.**
   This is the established ocap pattern and already how the Endo daemon
   attenuates (e.g. read-only wrappers, invitation attenuators).
   Document the pattern as the OCapN answer to UCAN policies for the
   online case.
4. **For [garden#34][garden-34] (CAS locators):**
   a content locator can be a plain structure of
   `(content hash, [retrieval sources])` where each source is either an
   OCapN sturdyref or an out-of-band fetch hint; rendering the *peer*
   halves of those sources as DIDs (per item 1) gives the "DID-shaped"
   portability without requiring a DID method registration or resolver
   infrastructure.
   A bespoke `did:ocapn` method is possible but adds process cost for
   little beyond what `did:key` + service hints already provide.

### Tier 1 — additive protocol extensions (backward-compatible)

1. **Admit DIDs as locator designators.**
   Extend the Locators draft so a designator may be a DID, with `did:key`
   as the mandatory baseline.
   `did:key` trivially satisfies the existing "designator + transport MUST
   uniquely distinguish locations" constraint; registry-resolved methods
   would need an explicit resolution profile (when to resolve, how to pin,
   what rotation means) and should be optional if admitted at all.
   *Unlocks:* DID-addressable peers at the protocol level; key rotation
   becomes possible for methods that support it, which raw-key designators
   can never offer.
2. **Optional stable-identity attestation at session start.**
   Add an optional descriptor to `op:start-session` binding the ephemeral
   session key to a long-lived DID: a signature by the DID's verification
   key over the session public key (and channel binding where available,
   as the Noise netlayer already does for locations).
   Per-session keys and default unlinkability are preserved; linkage is
   opt-in per session.
   *Unlocks:* DID-attributable sessions (needed for any UCAN whose
   audience is a stable principal), persistent peer identity across
   reconnects, and an anchor for gifting to a *party* rather than to a
   session.
3. **Optional caveat field on `desc:handoff-give`.**
   The certificate already exists; adding an optional attenuation/caveat
   slot lets a gifter grant *less* than the full live reference, making
   the handoff a single-hop, session-scoped analogue of an attenuated UCAN
   delegation, enforced by the exporter at redemption.
   *Unlocks:* attenuated gifting without wrapper-object round-trips
   through the gifter; a concrete convergence point with UCAN Delegation
   semantics.
4. **Standardize locator hints ↔ DID document service mapping.**
   Define how a peer's hints table round-trips through DID document
   service entries, so either artifact can be derived from the other.
   *Unlocks:* multi-transport reachability described in a widely-understood
   format; directly serves the [garden#34][garden-34] multi-source-locator
   use case.

### Tier 2 — deeper protocol changes

1. **Generalize handoffs into chainable, offline-verifiable, cross-session
   delegation certificates.**
   Adopt UCAN Delegation (or an isomorphic OCapN-native encoding over the
   OCapN data model) as a first-class way to convey attenuated authority
   over an object identified by locator/sturdyref: mintable while the
   exporter is offline, re-delegatable in chains, redeemable later in any
   session, validated by principal alignment + signatures + time bounds
   instead of per-session handoff counts.
   *Unlocks:* partition-tolerant delegation (grant while offline — the one
   thing the live-reference model cannot do), auditable delegation chains,
   and wire-level interop with UCAN's REQUIRED subset (Delegation +
   Invocation), whose invocation/promise semantics already mirror CapTP.
   *Costs:* changes OCapN's core semantics — authority is no longer purely
   session-scoped possession; exporters take on chain-validation and
   replay-protection duties; and the revocation story for offline-conveyed
   authority degrades to UCAN's eventually-consistent model.
   Expect principled resistance from the certificate-vs-reference debate
   (Horton and the cap-talk lineage); notably, early OCapN URI sketches on
   cap-talk *did* include Certificate and CertBear types alongside
   sturdyrefs, so the idea has precedent inside the group.
2. **Protocol-level revocation operation.**
   If Tier 2.1 lands, add an operation (and/or a revocation-list fetch
   convention) for invalidating a previously issued delegation by content
   identifier.
   *Unlocks:* the minimum hygiene required to make offline certificates
   tolerable; without it, Tier 2.1 should not ship.

Tier 2 is procedurally feasible only because OCapN is explicitly
pre-specification ("will change, likely significantly").
Whether it is *desirable* is a genuine design question for the group, not
a foregone conclusion; Tiers 0–1 capture most of the interop value at a
small fraction of the semantic risk.

## Open questions

- Can a UCAN-style syntactic caveat meaningfully constrain an
  `op:deliver` (method selector plus encoded args), and is the exporter
  willing to pay that enforcement cost at redemption time?
- Which DID methods beyond `did:key` (e.g. `did:peer`) meet the locator
  layer's self-authentication expectations, and what resolution profile
  would make a mutable method safe in an ocap setting?
- Would the OCapN group accept identity-bound certificate delegation at
  all, or is Tier 0/1 the political ceiling?
- For [garden#34][garden-34]: is a locator *document* (hash + sources +
  hints) enough, or is there value in registering a DID method so
  third-party DID resolvers can dereference Endo content locators?

## Sources

- OCapN draft specs: [CapTP][ocapn-captp], [Netlayers][ocapn-netlayers],
  [Locators][ocapn-locators]; [ocapn.org](https://ocapn.org/).
- UCAN: [spec][ucan-spec], [delegation][ucan-delegation],
  [invocation][ucan-invocation], [revocation][ucan-revocation].
- DIDs: [DID Core 1.1](https://www.w3.org/TR/did-1.1/),
  [did:key](https://w3c-ccg.github.io/did-key-spec/),
  [DID primer](https://w3c-ccg.github.io/did-primer/).
- Related: [zcap-spec](https://w3c-ccg.github.io/zcap-spec/),
  [Horton](https://erights.org/elib/capability/horton/),
  [web-keys](https://waterken.sourceforge.net/web-key/),
  [Spritely forum: UCAN and ocap model][spritely-ucan],
  [cap-talk OCapN URI proposal][cap-talk-uri],
  [kriskowal/garden#34][garden-34].
- This repo: `packages/ocapn/src/cryptography.js`,
  `packages/ocapn/src/client/{handshake,sturdyrefs,grant-tracker}.js`,
  `packages/ocapn/src/codecs/{components,descriptors}.js`,
  `packages/ocapn/src/netlayers/websocket.js`, `packages/captp/src/captp.js`.

[ocapn-captp]: https://github.com/ocapn/ocapn/blob/main/draft-specifications/CapTP%20Specification.md
[ocapn-netlayers]: https://github.com/ocapn/ocapn/blob/main/draft-specifications/Netlayers.md
[ocapn-locators]: https://github.com/ocapn/ocapn/blob/main/draft-specifications/Locators.md
[ucan-spec]: https://github.com/ucan-wg/spec
[ucan-delegation]: https://github.com/ucan-wg/delegation
[ucan-invocation]: https://github.com/ucan-wg/invocation
[ucan-revocation]: https://github.com/ucan-wg/revocation
[spritely-ucan]: https://community.spritely.institute/t/ucan-and-ocap-model/787
[cap-talk-uri]: https://groups.google.com/g/cap-talk/c/VjrzBgMmXiI
