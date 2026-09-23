# Endo Locator Reference

| | |
|---|---|
| **Created** | 2026-03-18 |
| **Updated** | 2026-09-23 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Current |

## Overview

An **endo locator** is a URL that identifies a formula on the Endo network.
Locators are the external representation of formula identifiers, suitable for
sharing between agents and across network boundaries.
Internally, the daemon stores **formula identifiers** (compact
`{number}:{node}` strings); locators are produced on demand by combining
identifiers with type information and optional connection hints.

## Locator Format

### Standard Locator

```
endo://{peerKey}/{formulaAddress}?type={formulaType}
```

| Component | Description |
|-----------|-------------|
| `peerKey` | 64-char hex Ed25519 public key of the peer that hosts the formula |
| `formulaAddress` | 64-char hex formula number (SHA-256 content address or random capability address) |
| `formulaType` | Formula type string (e.g., `host`, `guest`, `handle`, `worker`, `directory`, `remote`) |

### Locator with Connection Hints

```
endo://{peerKey}/{formulaAddress}@{hint1}@{hint2}?type={formulaType}
```

The URL path is a sequence of `@`-delimited components.
The first component is the formula address; subsequent components are
**connection hints** of the form `<transport-prefix>:<transport-payload>`
(e.g., `ws-relay+captp0://example.com:8920`,
`tcp+netstring+json+captp0://127.0.0.1:54321`,
`libp2p+captp0:///peer1`, `tor:abc123def456.onion:443`).

Each path component is **URL-encoded** with `encodeURIComponent` so that
`@`, `/`, and `?` inside a hint round-trip cleanly.
For example, a hint `tcp:user@example.com:8920` is encoded as
`tcp%3Auser%40example.com%3A8920`.

> **Tor hints carry the port separately from the address.** A Tor v3
> `.onion` address is host-only — a 56-character base32 service identifier
> followed by `.onion`, with no port embedded in the address. The `:443` in
> a `tor:` hint is the hidden service's *virtual port*, which the Tor client
> requests over its SOCKS connection; it lives in the hint's transport
> payload, never in the `.onion` address itself.

Hints are ephemeral: they reflect the peer's current network configuration
and may change over time.

### Invitation Locator

```
endo://{peerKey}/{invitationAddress}@{hint1}@{hint2}?type=invitation&from={hostHandleAddress}&fromNode={hostHandleNode}
```

Invitation locators extend the standard format with two query parameters:

| Parameter | Description |
|-----------|-------------|
| `type` | Always `invitation` |
| `from` | The host's handle formula number (used by the accepting peer to identify the inviting host) |
| `fromNode` | Optional: the host handle's node, present only when the handle uses an agent key distinct from the daemon node |

The `from` and `fromNode` parameters are specific to invitation locators.
Connection hints live in the path, not in query parameters.

### Handle Locator

```
endo://{peerKey}/{handleAddress}@{hint1}@{hint2}?type=handle&handleNode={handleNode}
```

Handle locators are emitted by the accepting peer in response to an
invitation.
The `handleNode` query parameter is optional and present only when the
handle uses an agent key distinct from the daemon node.

## Formula Identifiers

Internally, the daemon represents formulas as **formula identifiers**:

```
{formulaNumber}:{nodeNumber}
```

The `formulaNumber` and `nodeNumber` are both 64-character hex strings.
Local formulas use `LOCAL_NODE` (`'0'.repeat(64)`) as the node number: a
sentinel that is never a valid Ed25519 public key.

## Externalization and Internalization

The daemon maintains a duality between internal identifiers and external
locators:

### `externalizeId(id, formulaType, agentNodeNumber, addresses?)`

Converts an internal formula identifier to a locator for agent consumption.
Replaces `LOCAL_NODE` with the agent's own public key so that recipients know
which peer to contact.

```
internal id:  {number}:{LOCAL_NODE}
    → locator: endo://{agentKey}/{number}?type={type}
```

If `addresses` are provided, they become additional `@`-delimited path
components.

Remote identifiers (where node is not `LOCAL_NODE`) pass through with the
node number unchanged.

### `internalizeLocator(locator)`

Converts a locator from an agent back to an internal formula identifier.

```
locator: endo://{agentKey}/{number}@{addr}?type={type}
    → id: {number}:{agentKey}
    → formulaType: {type}
    → addresses: [{addr}]
```

### Round-trip Invariant

For local formulas:
```
internalId → externalizeId → internalizeLocator → internalId  ✓
```

For remote formulas, the node number is preserved through both operations.

## Method Taxonomy

### Name Resolution

| Method | Signature | Description |
|--------|-----------|-------------|
| `identify(...path)` | `name → identifier` | Resolve a pet name path to an internal formula identifier |
| `locate(...path)` | `name → locator` | Resolve a pet name path to a locator (calls through `externalizeId`) |
| `lookup(...path)` | `name → value` | Resolve a pet name path to the formula's value |

### Reverse Resolution

| Method | Signature | Description |
|--------|-----------|-------------|
| `reverseIdentify(id)` | `identifier → name[]` | Find all pet names for a formula identifier |
| `reverseLocate(locator)` | `locator → name[]` | Find all pet names for a locator (calls through `internalizeLocator`) |
| `reverseLookup(presence)` | `value → name[]` | Find all pet names for a live value |

### Enumeration

| Method | Signature | Description |
|--------|-----------|-------------|
| `list(...path)` | `name → name[]` | List pet names in a directory |
| `listIdentifiers(...path)` | `name → identifier[]` | List unique identifiers in a directory |
| `listLocators(...path)` | `name → Record<name, locator>` | Map pet names to locators in a directory |

### Writing

| Method | Signature | Description |
|--------|-----------|-------------|
| `write(path, id)` | `(name, identifier) → void` | Bind a pet name to a formula identifier (internal) |
| `writeLocator(path, locatorOrId)` | `(name, locator\|id) → void` | Bind a pet name; accepts locator or identifier |

`writeLocator` is the canonical write method exposed through exos.
It accepts either a locator string (starting with `endo://`) or a raw
formula identifier.
When given a locator, it calls `internalizeLocator` to extract the
identifier before delegating to `write`.
This method is defined once in `directory.js` and carried up through
`host.js` and `guest.js` via destructuring; it is not re-implemented at
each layer.

### Subscription

| Method | Signature | Description |
|--------|-----------|-------------|
| `followNameChanges(...path)` | `name → AsyncIterator<NameChange>` | Subscribe to pet name changes |
| `followLocatorNameChanges(locator)` | `locator → AsyncIterator<LocatorNameChange>` | Subscribe to name changes for a locator |

## LOCAL_NODE Sentinel

```js
const LOCAL_NODE = '0'.repeat(64);
```

All-zeros is never a valid Ed25519 public key, making it a safe sentinel for
"this daemon".
The daemon maintains a `localKeys` set containing all known local agent
public keys.
The predicate `isLocalKey(node)` returns `true` for any key in this set,
enabling `internalizeLocator` to normalize locators from sibling agents on
the same daemon.

## Locator Validation

`parseLocator(locator)` validates locators:

- Protocol must be `endo://`
- Node (hostname) must be a valid 64-char hex string
- The first `@`-delimited path component (URL-decoded) must be a valid
  64-char hex formula number
- Query parameter `type` is required and must be a valid formula type
- Allowed query parameters: `type`, `from`, `fromNode`
- Any other query parameter causes validation failure

Invitation and handle locators include `from`/`fromNode` and `handleNode`
query parameters.
The invitation acceptance code paths in `daemon.js` and `host.js` parse
these locators directly so they can extract those parameters.

## Connection Hints and Peer Info

Connection hints are ephemeral transport addresses encoded as additional
`@`-delimited path components after the formula address.
When a locator with hints is received:

1. The formula identifier is extracted and stored durably.
2. The hints are forwarded to the peer info system via `addPeerInfo`.
3. Hints are not stored with the formula: they are looked up fresh when
   producing a locator for sharing.

When producing a locator for sharing (`locate`), the current hints for the
peer are fetched from the network layer and appended as `@`-delimited path
components.

## Files

| File | Key Exports |
|------|------------|
| `locator.js` | `parseLocator`, `formatLocator`, `formatLocatorForSharing`, `externalizeId`, `internalizeLocator`, `idFromLocator`, `addressesFromLocator`, `LOCAL_NODE` |
| `formula-identifier.js` | `parseId`, `formatId`, `isValidNumber` |
| `formula-type.js` | `isValidFormulaType`, `assertValidFormulaType` |
| `directory.js` | `makeDirectoryMaker` (provides `locate`, `writeLocator`, etc.) |
| `host.js` | `makeHostMaker` (carries up directory methods) |
| `guest.js` | `makeGuestMaker` (carries up directory methods) |
| `mail.js` | `makeMailboxMaker` (externalizes message identifiers to locators) |
| `daemon.js` | `makeInvitation` (constructs invitation locators) |


## Minion Town guest federation integration plan (2026-09-23)

The maintainer's first target is a user who signs into minion.town, copies a
locator for their own guest, and adopts it with the Endo CLI on a local daemon.
An object already in that guest's grasp is the subsequent generalization.
The acceptance test must exercise a real account and the production service.
This section plans the integration; it does not claim that federation is deployed.

### Grounded state

Code inspected at Endo `f9cbcfc426` and minion.town `3062124`:

- `EndoHost.adoptFromLocator` already extracts identity and hints, calls
  `addPeerInfo`, and stores the identifier in the local directory.
  The CLI has no caller for it: `adopt` adopts a message attachment, while
  `accept` consumes an invitation.
  Neither is currently a general guest-locator import command.
- The installed OCapN network module uses CBOR over Noise/TCP and a signed
  binding between the daemon agent identity and the ephemeral session key.
  It still fetches `endo-peer-entry` and uses the greeter/gateway protocol.
  Direct formula redemption is a different application bootstrap path.
- Live GitHub checks on 2026-09-23 found #340 merged (2026-08-25), and
  #684 (WebSocket transport), #688 (forked-daemon tests), and #693 (cross-host
  demo) open and draft.
  Their heads were `efcc498729`, `884afffb79`, and `c25fe20a3d` respectively.
  #990 (operation lanes) was also open and draft, at `86d91b3762`.
- #1124 is open and draft at `96674df196`.
  Its `makeFormulaNonceLocator` and `makeLocatorForSession` implement bounded,
  local-only formula redemption through the OCapN bootstrap's `fetch`.
  They are absent from the inspected `llm` tree.
  `ocapn-nonce-locator.md`, cited in earlier planning, is absent too;
  the actual specification cited by #1124 is
  [daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md)
  section 2.
  Reuse this work rather than building a second nonce adapter.
- minion.town's `guest-self-endpoint.ts` and landing-page/shell copy fields
  already expose `/account/guest-formula-id`.
  The route derives the guest solely from authenticated `iss+sub`, applies
  account admission, and sends the raw identifier with `Cache-Control: no-store`.
  It does not supply the remote identity and usable route needed for adoption.
- The checked-in Caddy `/.well-known/ocapn-cbor-np` route targets port 8931,
  documented as the separate Pet-Daemon demo container.
  Account guests use the systemd daemon's Unix socket.
  This is a topology discrepancy to verify on the box, not evidence that the
  public endpoint can already fetch the account guest.
  The production script and client pins are both `f66505034aaa54ac46294347b2bf0e14655b088a`;
  minion.town #111 reverted a newer pin after a persisted-database startup failure.

### Integration contract

Retain the existing `endo://` user-facing locator as directed by the resolved
choices in the external-connectivity design.
The locator must carry the guest formula identity, authenticated hosting-peer
identity, and candidate connection hints sufficient for a fresh local daemon.
The server emits those hints from its actual public configuration; users must
not assemble JSON locations, infer a key from a port, or run custom JavaScript.
Formula identifiers and locators are bearer capabilities and must stay out of
logs, analytics, query strings sent to HTTP servers, and committed test evidence.

Select a mutually supported route using the existing network/codec machinery.
The first concrete target is CBOR over Noise over WSS on the public edge.
Only advertise Syrup or native CapTP alternatives when the corresponding
endpoint and client adapter actually work.
Codec choice is currently out of band; this plan does not invent an on-wire
negotiation protocol or require all M4 protocol redesigns to land first.
Reject incompatible routes and identity mismatches clearly, without accepting a
wrong identity as a fallback or reporting success merely because a name was stored.

Add a CLI surface for locator adoption without changing message-attachment
`adopt` semantics or invitation `accept` semantics.
Prefer a stdin/file input mode so the bearer need not enter shell history.
Reuse `adoptFromLocator` where its remote-resolution contract suffices; complete
the daemon bridge where formula-fetch endpoints do not offer `endo-peer-entry`.
Keep the imported capability in the daemon's durable formula/pet-name machinery,
including retention and re-acquisition after restart, rather than only in the CLI.
A localhost demonstration must prove a real method call through the imported guest.

Wire the public formula locator to the same formula store that provisions account
guests, preserving local-only redemption and per-session bounds from #1124.
Do not replace the current peer-entry locator wholesale: #1124's formula-only
adapter refuses that fixed name, so existing peer traffic needs deliberate
composition or a separate endpoint.
No host/root capability is disclosed by the browser reveal or by an empty fetch.
The reveal gate controls obtaining the bearer; it does not promise revocation of
an already-held capability when an OAuth session ends or an account is suspended.

## Ownership map

| Boundary | Mechanism | Policy | Durable state | Lifecycle / commit authority | Value crossing |
|---|---|---|---|---|---|
| Browser / account service | Authenticate and reveal own guest locator | Account service admits the verified identity | Account store owns identity; remote daemon owns guest formula | Account service provisions; browser only copies | Bearer locator |
| CLI / local daemon | Parse/import and name the remote capability | User selects name; daemon validates identity and compatible routes | Local daemon owns retained formula and pet name | Daemon commits binding and re-acquires after restart | Locator, then remote presence |
| Local / remote OCapN | Establish session and fetch formula | Netlayer authenticates peer; remote locator enforces locality and miss bounds | Remote daemon owns formula graph and agent keys | OCapN manages sessions; daemon manages formula revival | Canonical formula identifier, then guest capability |
| Deployment / daemon | Configure public routes and pinned artifacts | Reviewed release and operator deployment policy | Daemon owns account state; deployment owns configuration | Existing SSM scripts deploy/rollback; systemd restarts | Artifact revision and non-secret route configuration |

Each daemon owns its own persistent state and binding commits.
OCapN classifies session/delivery errors; the daemon decides reconnection and the
CLI decides its exit status, not whether remote application execution committed.
Deployment owns process rollback and must not replay arbitrary guest mutations.
The inner/outer naming check holds: session success is not called a durable
adoption or an application commit.

### Serial delivery and gates

The garden orchestration `endo-minion-town-guest-locator-federation` owns:

1. **Endo integration:** reconcile the existing #684/#1124 work, add the missing
   daemon/CLI adoption path, and prove it with real local daemons.
   Produce draft PRs against pinned bases, with exact dependency revisions.
2. **Minion Town wiring:** expose a complete self-scoped locator and connect its
   public endpoint to the account guest daemon through the reusable Endo code.
   Prepare idempotent SSM configuration and pin/client compatibility changes.
   Designs require PR review; keep production-affecting changes in review until
   the release gate, because a direct `main` push may trigger deployment.
3. **Release readiness:** require the plan and all implementation dependencies
   to pass their existing review gates and land before selecting deploy pins.
   Manual gauntlet triggers remain maintainer-controlled.
   A draft build's completion does not satisfy this gate.
   Block durably on the concrete missing PR; do not report readiness or deploy.
4. **Deployment:** use `deploy/aws/scripts/*`, prove persisted-state upgrade
   compatibility before touching production, preserve rollback, and attest the
   actual running revision, socket, public route, key binding, and dialect.
5. **Acceptance:** browse and authenticate as a real account, copy its locator,
   adopt using only the Endo CLI into a separate local daemon, then invoke the
   remote guest and demonstrate a benign capability round trip.
   Record redacted browser/CLI evidence, negotiated layers, both revisions,
   restart/re-acquisition behavior, and negative identity/invalid-locator cases.
   A mock guest, a bare WebSocket upgrade, or a demo-container capability fails
   this gate.

The whole M4 ledger remains open: broader per-agent transport configuration,
cryptographic review, transport separation, and operation-lane work are not
silently declared complete by this experiment.
A live test identity/browser login is an operational prerequisite for stage 5;
request maintainer participation through the liaison if existing access cannot
complete it, and leave acceptance unverified until it actually runs.
