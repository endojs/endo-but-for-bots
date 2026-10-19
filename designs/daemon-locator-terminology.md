# Daemon Locator Terminology

| | |
|---|---|
| **Created** | 2026-02-24 |
| **Updated** | 2026-10-19 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Complete |

## Implementation Status

Implemented on `llm`:

- Types: `PeerKey`, `FormulaAddress`, `FormulaKey`, `ConnectionHint`,
  `PeerLocator`, and `FormulaLocator` in `packages/daemon/src/types.d.ts`.
- Locator format: `@`-delimited, URL-encoded path components
  (5bd2f09d69, closes #34); `parseLocator` returns `hints`;
  `formatLocatorWithHints` and `hintsFromLocator` exist, with the earlier
  names `formatLocatorForSharing` and `addressesFromLocator` kept as
  deprecated aliases (24b8dcb688).
- `locate` hydrates the agent's current connection hints from its
  network addresses; `EndoHost.locateWithHints` is the explicit name for
  the same operation.
  `adoptFromLocator` dehydrates hints into the peer's `PeerInfo`.
- Documentation and diagnostics: `formula-identifier.js`, `locator.js`,
  the `locate`/`identify` help text, and the `endo locate` CLI description
  use the new terms; locator parse errors name the peer key and formula
  address.

The method and field names that predate the terminology (`parseId`,
`formatId`, the `number`/`node` fields of `IdRecord`, `FormulaNumber`,
`NodeNumber`, `FormulaIdentifier`) keep their names, per the invariant
below that no existing signature changes.

Two questions other designs defer to this one are settled:

- The user-facing locator keeps the `endo://` scheme, including for OCapN
  peers ([daemon-ocapn-external-connectivity](daemon-ocapn-external-connectivity.md)
  § Resolved Decisions).
- The invitation methods `invite`, `accept`, and `correspondentName` keep
  their names (see [Invitation Methods](#invitation-methods-endohost));
  [guest-native-invitations](guest-native-invitations.md) can treat those
  spellings as final.

The LOCAL_NODE normalization this design originally specified was
superseded by the SQLite migration (d0ce26b327); see
[Formula Keys Carry Real Peer Keys](#formula-keys-carry-real-peer-keys).

## Starting State

The rest of this section records the state this design started from.

This document describes terminology and format changes for the daemon's
identifier and locator system, building on the 256-bit identifier migration
from `designs/daemon-256-bit-identifiers.md`.

### Starting Terminology

| Term | Definition |
|------|------------|
| Node Number | 64-char hex string (Ed25519 public key after 256-bit migration) |
| Formula Number | 64-char hex string (SHA-256 or random 256-bit) |
| Formula Identifier | `{formulaNumber}:{nodeNumber}` |
| Locator | `endo://{peerKey}/{formulaAddress}?type={type}` |

### Starting Types (types.d.ts)

```typescript
/** A 64-character hex string identifying a formula within a node */
export type FormulaNumber = string & { [FormulaNumberBrand]: true };

/** A 64-character hex string identifying a node */
export type NodeNumber = string & { [NodeNumberBrand]: true };

/** A full formula identifier in the format {FormulaNumber}:{NodeNumber} */
export type FormulaIdentifier = string & { [FormulaIdentifierBrand]: true };
```

Connection hints are stored in `PeerFormula.addresses: Array<string>`
(types.d.ts:233).

### Starting Methods

The daemon already had parallel identifier and locator methods:

| Method | Location | Purpose |
|--------|----------|---------|
| `parseId(id)` | formula-identifier.js | Parse identifier -> `{number, node}` |
| `formatId({number, node})` | formula-identifier.js | Format `{number, node}` -> identifier |
| `parseLocator(locator)` | locator.js | Parse locator -> `{formulaType, node, number}` |
| `formatLocator(id, type)` | locator.js | Format identifier + type -> locator |
| `idFromLocator(locator)` | locator.js | Extract identifier from locator |
| `identify(...path)` | NameHub | Resolve pet name path -> identifier |
| `locate(...path)` | NameHub | Resolve pet name path -> locator |
| `reverseIdentify(id)` | EndoAgent | Identifier -> pet names |
| `reverseLocate(locator)` | NameHub | Locator -> pet names |
| `listIdentifiers(...path)` | NameHub | List identifiers in directory |
| `lookupById(id)` | EndoAgent | Identifier -> value |

---

## Target State

### New Terminology

| Current Term | New Term | Definition |
|--------------|----------|------------|
| Node Number | **Peer Key** | Ed25519 public key (64-char hex) |
| Formula Number | **Formula Address** | Content address (SHA-256) or capability address (random 256-bit) |
| Formula Identifier | **Formula Key** | `{formulaAddress}:{peerKey}` |
| (new concept) | **Connection Hint** | Transport-prefixed address string (e.g., `ws:example.com:8920`) |
| (new concept) | **Peer Locator** | Peer key + connection hints |
| (new concept) | **Formula Locator** | Formula key + connection hints + type |

### New Locator Format

Standard locator:
```
endo://{peerKey}/{formulaAddress}?type={formulaType}
```

Locator with connection hints:
```
endo://{peerKey}/{formulaAddress}@{hint1}@{hint2}?type={formulaType}
```

Invitation locator:
```
endo://{peerKey}/{invitationAddress}@{hint1}@{hint2}?type=invitation&from={handleAddress}
```

The URL path is a sequence of `@`-delimited components.
The first component is the formula address; subsequent components are
connection hints of the form `<transport-prefix>:<transport-payload>`
(for example, `ws-relay+captp0://example.com:8920` or
`tor:abc123def456.onion:443`).
Each component is URL-encoded with `encodeURIComponent` so that `@`, `/`,
and `?` inside a hint do not collide with the path syntax.

The `from` parameter on an invitation contains only the handle's formula
address (peer key is the same as the hostname).

### New Types (types.d.ts)

```typescript
// Semantic aliases for existing types
export type PeerKey = NodeNumber;
export type FormulaAddress = FormulaNumber;
export type FormulaKey = FormulaIdentifier;

// Connection hint type
export type ConnectionHint = string;

// Locator structures
export type PeerLocator = {
  peerKey: PeerKey;
  hints: ConnectionHint[];
};

export type FormulaLocator = {
  formulaKey: FormulaKey;
  formulaType: string;
  hints: ConnectionHint[];
};
```

---

## Method Changes

**Invariant: No existing method signatures change.** Existing methods continue
to work with identifiers as they do today. New methods are added for
locator-with-hints operations.

### Low-Level Functions (locator.js, formula-identifier.js)

| Current Method | Signature | Change |
|----------------|-----------|--------|
| `parseId(id)` | `string -> {number, node}` | Unchanged |
| `formatId(record)` | `{number, node} -> string` | Unchanged |
| `parseLocator(locator)` | `string -> {formulaType, node, number}` | Returns additional `hints` field |
| `formatLocator(id, type)` | `(string, string) -> string` | Unchanged (no hints) |
| `idFromLocator(locator)` | `string -> string` | Unchanged |

| New Method | Signature | Purpose |
|------------|-----------|---------|
| `formatLocatorWithHints(id, type, hints)` | `(string, string, string[]) -> string` | Format locator with connection hints |

### High-Level Methods (NameHub, EndoAgent, EndoHost)

| Current Method | Signature | Change |
|----------------|-----------|--------|
| `identify(...path)` | `...string[] -> Promise<string?>` | Unchanged |
| `locate(...path)` | `...string[] -> Promise<string?>` | Internal format change only |
| `reverseIdentify(id)` | `string -> Name[]` | Unchanged |
| `reverseLocate(locator)` | `string -> Promise<Name[]>` | Unchanged |
| `listIdentifiers(...path)` | `...string[] -> Promise<string[]>` | Unchanged |
| `lookupById(id)` | `string -> Promise<unknown>` | Unchanged |

| New Method | Signature | Purpose |
|------------|-----------|---------|
| `locateWithHints(...path)` | `...string[] -> Promise<string?>` | Resolve path -> locator with current hints |

### Invitation Methods (EndoHost)

| Current Method | Signature | Change |
|----------------|-----------|--------|
| `invite(guestName)` | `string -> Promise<Invitation>` | Unchanged; `Invitation.locate()` returns new format |
| `accept(locator, guestName)` | `(string, string) -> Promise<void>` | Parses new format internally |

---

## Formula Keys Carry Real Peer Keys

This design originally specified a LOCAL_NODE sentinel (`0` x 64) that
replaced every local agent's public key inside stored formula keys, with
`internalizeLocator` normalizing local keys to the sentinel and
`externalizeId` stamping the presenting agent's key back on.
The SQLite migration (d0ce26b327) removed that normalization.
Stored formula keys now carry the real peer key of the agent or daemon
that owns the formula, so:

- `internalizeLocator(locator)` preserves the peer key as-is and returns
  `{ id, formulaType, hints }`.
- `externalizeId(id, formulaType, agentNodeNumber, hints)` formats the
  stored key directly; `agentNodeNumber` is unused and kept only for
  signature stability.
- The round-trip invariant holds trivially for local and remote formulas:
  `internalizeLocator(externalizeId(id, type, key)).id === id`.

`LOCAL_NODE` survives in `locator.js` only as an all-zeros peer key no
daemon can own, for tests.

---

## Dehydration and Hydration

Locators carry both stable data (formula key) and ephemeral data (connection
hints). These are separated at ingestion and recombined at presentation:

**Dehydration** (on ingestion): When a locator is received, extract the
formula key and store it. Separately, update the peer's connection hints in
`PeerFormula.addresses`. The formula key is the durable reference; hints are
transient.

```js
const { id: formulaKey, formulaType, hints } = internalizeLocator(locator);
const { node: peerKey } = parseId(formulaKey);

// Store the stable reference
await petStore.write(petName, formulaKey);

// Update peer hints separately
await addPeerInfo({ node: peerKey, addresses: hints });
```

**Hydration** (on presentation): When a locator is needed, look up the peer's
current connection hints and combine them with the stored formula key.

```js
const formulaKey = await petStore.read(petName);
const { node: peerKey } = parseId(formulaKey);
const { addresses: hints } = await getPeerInfo(peerKey);

const locator = formatLocatorWithHints(formulaKey, formulaType, hints);
```

**Round-trip invariant**: If a locator is dehydrated and then hydrated without
any intervening hint changes, the resulting locator is identical to the
original.

---

## Planned File Changes

As planned in 2026-02; `daemon.js` has since been renamed `manager.js`,
so the line numbers below are historical.

**`packages/daemon/src/types.d.ts`**
- Add `PeerKey`, `FormulaAddress`, `FormulaKey` type aliases
- Add `ConnectionHint`, `PeerLocator`, `FormulaLocator` types
- Add `locateWithHints` to `NameHub` interface

**`packages/daemon/src/formula-identifier.js`**
- Update function documentation to use new terminology (no signature changes)

**`packages/daemon/src/locator.js`**
- Update `parseLocator` to return `hints` (the URL-decoded `@`-delimited
  path components after the formula address)
- Update `formatLocator` and `formatLocatorForSharing` to emit
  `@`-delimited URL-encoded path components

**`packages/daemon/src/directory.js`**
- Add `locateWithHints` implementation
- Update `locate` to use new format internally

**`packages/daemon/src/daemon.js`**
- Lines 3162-3173: `makeInvitation.locate()` — use new format
- Lines 3179-3199: `makeInvitation.accept()` — parse new format
- Add `locateWithHints` to directory implementations

**`packages/daemon/src/host.js`**
- Lines 587-637: `accept()` — parse new invitation format, dehydrate hints

---

## Test Plan

- Parse/format round-trip for the locator format
- Parse with URL-encoded hints containing `@`, `/`, or `?`
- Multiple connection hints (`ws` + `libp2p` + `tor`)
- `locateWithHints` returns locator with current peer hints
- Dehydration/hydration round-trip invariant
- Integration: invitation creation and acceptance
- Peer-key preservation (replacing the superseded LOCAL_NODE items):
  - `internalizeLocator` preserves local and remote peer keys
  - `externalizeId` preserves local and remote peer keys
  - Round-trip: id -> externalize -> internalize = original id

These cases live in `packages/daemon/test/locator.test.js`; invitation
and `locateWithHints` integration coverage lives in
`packages/daemon/test/endo.test.js` and
`packages/daemon/test/channel-relay.test.js`.
