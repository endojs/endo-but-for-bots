# OCapN Structural Protocol Core and Point-to-Point Profile

| | |
|---|---|
| **Created** | 2026-07-20 |
| **Author** | Aaron Davis (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Two related problems with `@endo/ocapn` as it stands.

### 1. The protocol cannot be spoken without materializing references

A comms-vat-style consumer — a kernel, a message router, a c-list
translator — wants to move OCapN messages between a wire and its own
reference table.
It needs `bytes → structural message with slot descriptors` on the way in,
and `slot descriptors → bytes` on the way out.
It does not want a `Remotable` presence, a `HandledPromise`, or an `E()`
proxy for every reference that crosses the wire, because it never invokes
those references locally; it forwards them.

The current implementation makes materialization unavoidable, because the
wire codecs are constructed *around* the live-reference machinery:

- `makeDescCodecs(referenceKit)` (`packages/ocapn/src/codecs/descriptors.js`)
  bakes the reference kit into every descriptor codec.
  Decoding a `desc:import-object` calls
  `referenceKit.provideRemoteObjectValue(position)`, which mints a
  `Remotable` presence backed by a `HandledPromise` handler
  (`makeRemoteObject` in `packages/ocapn/src/client/ref-kit.js`).
  Every reference that appears in any message becomes a live proxy as a
  side effect of *parsing*.
- Decode performs I/O.
  Reading a `desc:handoff-give` in an argument position calls
  `referenceKit.provideHandoff(signedEnvelope)`, whose implementation
  (`makeHandoff` in `packages/ocapn/src/client/ocapn.js`) dials the
  exporter's session and performs a `withdraw-gift` exchange — network
  activity launched from inside a codec `read` function.
- Encode performs I/O.
  `HandOffUnionCodec.write` calls `referenceKit.sendHandoff(...)`, which
  signs a `HandoffGive` and deposits a gift over a *different* session,
  during serialization of the current message.
- Encode consults live-value identity.
  `makeValueInfoRecordUnionCodec` (`packages/ocapn/src/codecs/util.js`)
  selects a wire branch by calling `referenceKit.getInfoForVal(value)`,
  which walks the grant tracker and pairwise table keyed by JS object
  identity.
- Dispatch invokes live values.
  The `op:deliver` handler (`ocapnSystemMessageHandler` in
  `packages/ocapn/src/client/ocapn.js`) resolves the target and calls
  `HandledPromise.applyMethod` / `applyFunction` on it directly.
  There is no seam at which a consumer can say "give me the delivery, I
  will route it myself".

Notably, the wire format is already designed for the consumer we cannot
serve: `docs/cbor-encoding.md` (Design Goal 5, and the "Passable Data and
Slots" section, per [ocapn/ocapn#172]) specifies in-band reference markers
with parallel slot arrays precisely so that "kernels, comms vats" can
remap slots and forward bodies without re-serialization.
The encoding anticipates a structural tier; the JavaScript stack does not
expose one.

### 2. Every session pays for third-party handoffs

The three-party handoff (3PHO) machinery is unconditionally wired into
every client and every session:

- `makeOcapn` (`packages/ocapn/src/client/index.js`) always constructs a
  `grantTracker`, a `giftTable`, and handoff cryptography.
- The bootstrap object always exposes `deposit-gift` and `withdraw-gift`
  alongside `fetch`.
- `ReferenceCodec` always includes the `third-party:handoff` branch, so
  the classification of *every outgoing reference* consults the grant
  tracker to decide whether it is third-party.
- The session core (`makeOcapn` in `packages/ocapn/src/client/ocapn.js`)
  receives `provideSession`, `getActiveSession`, and
  `getPeerPublicKeyForSessionId` — powers over the whole session graph —
  whose only consumers are `makeHandoff`, `sendHandoff`, and
  `withdraw-gift`.

Many deployments are strictly pairwise: a client talking to one service, a
vat talking to its kernel, two peers bridged by a comms layer that does
its own proxying.
For them 3PHO is dead code, extra attack surface (gift tables, signature
verification paths, the ambient ability of a session to dial arbitrary
third parties), and a conceptual tax.
There is currently no configuration to build an OCapN endpoint without it.

## Current State (coupling inventory)

The layering today, annotated with the couplings that block both goals:

```
client/index.js      sessions, networks, handshake
  └─ client/ocapn.js session core: op-handlers, comms kit, handoff logic
       ├─ invokes targets via HandledPromise          [blocks goal 1]
       ├─ closes over provideSession/getActiveSession [3PHO-only power]
       └─ client/ref-kit.js  slot allocation + presence minting, fused
            └─ captp/ocapn-tables.js  pairwise table, refcounts, GC
codecs/{descriptors,passable,operations}.js
  └─ parameterized over the full ReferenceKit         [blocks goal 1]
       ├─ decode mints presences, registers slots
       ├─ decode/encode of handoffs performs network I/O
       └─ branch selection via getInfoForVal (live identity)
```

The exact codec-facing surface (from `codecs/descriptors.js` and
`codecs/util.js`) is fifteen methods:
`provideRemoteObjectValue`, `provideRemotePromiseValue`,
`provideLocalExportValue`, `getLocalAnswerValue`,
`provideRemoteResolverValue`, `provideLocalObjectPosition`,
`provideLocalPromisePosition`, `provideRemoteExportPosition`,
`provideRemoteAnswerPosition`, `getInfoForVal`, `makeSturdyRef`,
`provideHandoff`, `sendHandoff` — plus the union-branch dispatch keyed on
`getInfoForVal`.
This surface is the seam the refactor formalizes.

## Description of the Design

Split the stack into three tiers with explicit interfaces, such that the
current API is the composition of all three, and a comms-vat consumer can
stop at tier 2.

```
Tier 1  Wire codecs (pure)         bytes ⇄ structural messages
Tier 2  Session core (sans-invoke) slots, refcounts, answers, GC, abort
Tier 3  Presence layer (optional)  Remotable/HandledPromise/E(), handoffs
```

### Tier 1: codecs become pure over a narrow `ReferenceIO`

Formalize the fifteen-method surface above as a `ReferenceIO` interface
and make `makeDescCodecs` (and `makeValueInfoRecordUnionCodec`) depend on
it rather than on `ReferenceKit`.
This is initially a type-level change: the presence layer's
`ReferenceKit` is one implementation.

Then add a second, *structural* implementation whose `provide*` functions
return inert descriptor records instead of live values:

```js
// Read side: no table mutation, no presence, no I/O.
harden({ kind: 'import-object', position: 5n });
harden({ kind: 'import-promise', position: 2n });
harden({ kind: 'export', position: 7n });
harden({ kind: 'answer', position: 3n });
harden({ kind: 'handoff-give', signedGive });   // data, not a promise
harden({ kind: 'sturdy-ref', location, secret });
```

On the write side, the structural `getInfoForVal` recognizes exactly these
records (by brand, not duck-typing) and maps them back to wire branches,
so a structural message round-trips: `decode(encode(m))` is deep-equal,
and `encode(decode(bytes))` is byte-identical.
Snapshot tests already exist for the codecs
(`test/codecs/snapshots/*.md`); the structural implementation is testable
against the same corpus without standing up sessions.

Handoff side effects move out of the codecs entirely (next section), so
tier-1 decode/encode is pure for both implementations.

### Handoffs become a message-boundary transform, not a codec side effect

Today `HandOffUnionCodec.read` redeems a gift (dialing the exporter) and
`HandOffUnionCodec.write` issues one (signing and depositing over another
session), in the middle of (de)serialization.
Instead, the session core applies a descriptor-transform pass at the
message boundary:

- **Inbound**: after decode, walk the message's reference descriptors;
  for each `handoff-give`, hand the signed envelope to the handoff module,
  which returns the redemption promise (presence tier) or forwards the
  envelope untouched (structural tier, which by definition forwards).
- **Outbound**: before encode, references classified as third-party are
  replaced by `handoff-give` descriptors produced by the handoff module.

This relocation is behavior-preserving for the presence tier (the same
work happens, one layer up), it is what lets tier 1 be pure, and it gives
the point-to-point profile a single module to omit.

### Tier 2: `makeOcapnSessionCore` — the protocol without invocation

Extract the protocol state machine from `client/ocapn.js` into a session
core that owns everything *except* invocation and presence identity:

- the pairwise table, refcount commit points
  (`clearPendingRefCounts` / `commitSentRefCounts` /
  `commitReceivedRefCounts` around each encode/decode, exactly as
  `dispatchMessageData` and the comms kit do today),
- answer-position and export-position allocation,
- GC emission (`op:gc-exports` / `op:gc-answers`) and handling,
- `op:abort` and session teardown,
- message stats and observers.

Operation handling is delegated to an injected handler interface instead
of `HandledPromise`:

```js
const core = makeOcapnSessionCore({
  codec,
  connection,
  handlers: {
    // target/resolveMe/args contain descriptors, not live refs.
    deliver({ target, args, answerPosition, resolveMe }) { ... },
    listen({ target, resolveMe, wantsPartial }) { ... },
    get({ target, fieldName, answerPosition }) { ... },
    index({ target, index, answerPosition }) { ... },
    untag({ target, tag, answerPosition }) { ... },
  },
});

core.dispatchMessageData(bytes);          // decode → refcount commit → handler
core.send({ type: 'op:deliver',           // descriptors in, bytes out
  to: { kind: 'export', position: 1n },
  args: [...],
  answerPosition: core.allocateAnswer(),
  resolveMeDesc: { kind: 'import-object', position: 9n },
});
core.dropImport(position, delta);         // explicit GC for c-list consumers
```

A comms vat implements the handlers by translating descriptors through its
c-list and forwarding into its kernel; positions map to c-list refs
(strings), and no JS object is ever minted per reference.
Import lifetime is driven explicitly by `dropImport` (emitting
`op:gc-exports`) rather than by WeakRef finalization —
`enableImportCollection` becomes a tier-3 concern, since only tier 3 has
collectible proxies.

### Tier 3: the presence layer as one client of the core

The current behavior — `ref-kit.js` presences, `makeRemoteKit` handlers,
`invokeDeliver` via `HandledPromise`, eager `op:listen` subscription on
imported promises, WeakRef-driven GC, handoff redemption — becomes the
default handler set plus the materializing `ReferenceIO`.
`makeOcapn` keeps its existing public API by composing tier 2 with tier 3;
existing users and the interop test suites see no change.

Public surface additions:

- `@endo/ocapn/protocol`: `makeOcapnSessionCore`, descriptor constructors
  and brand checks (`makeExportDescriptor`, `isRefDescriptor`, ...).
- The existing entrypoint re-exports are unchanged.

### Point-to-point profile (no 3PHO)

Add a profile switch to `makeOcapn` (working name):

```js
const ocapn = await makeOcapn({ codec, network, locator, handoffs: false });
```

`handoffs: false` produces an endpoint that is a spec-conforming subset:

1. **Codec**: `ReferenceCodec` is built without the `HandOffUnionCodec`
   branch.
   Receiving a `desc:sig-envelope` in a reference position is a decode
   error, which already aborts the session with a diagnostic
   (`dispatchMessageData`'s decode-error path) — a clean, loud refusal
   rather than a silent capability leak.
2. **Bootstrap**: trimmed to `fetch` only; no `deposit-gift`, no
   `withdraw-gift`, no gift table, no `usedGiftHandoffs`, no handoff
   counts.
3. **Classification**: sending a reference that was imported from a
   *different* session throws at serialization with an actionable error
   ("reference belongs to another session; enable handoffs, or pass a
   sturdy ref").
   Today this is the `third-party:handoff` branch; without it, the error
   is the correct behavior, and the check is a cheap
   session-of-origin comparison instead of grant-tracker bookkeeping.
4. **Least authority**: the session core is constructed *without*
   `provideSession`, `getActiveSession`, and
   `getPeerPublicKeyForSessionId`.
   Those powers exist only for 3PHO, so a point-to-point session closes
   over nothing that can dial or enumerate other peers.
   This is a real containment improvement, not just dead-code removal.
5. **Sturdy refs are kept**: they are pairwise-compatible data
   (`makeSturdyRef` / `enlivenSturdyRef` involve only the naming session),
   and they are the recommended fallback for moving a capability between
   two point-to-point meshes.

A later, optional `relay: true` extension could transparently re-export
third-party references through a local pass-through proxy (classic CapTP
proxying, every hop paying a round trip through the relay); it is
explicitly out of scope for the first cut, since erroring is the safe
default and relaying has its own GC and partition-failure semantics.

The profile also composes with tier 2: `makeOcapnSessionCore` with
`handoffs: false` is the minimal kernel-facing endpoint — pure codecs, no
presence machinery, no session-graph powers.

## Implementation Plan

Each phase is a separately landable PR with the interop suites green
(`test/python-test-suite`, codec snapshots, three-party handoff tests).

1. **refactor(ocapn): extract `ReferenceIO`.**
   Define the interface; make `makeDescCodecs` and
   `makeValueInfoRecordUnionCodec` accept it; `ReferenceKit` implements
   it.
   No behavior change; snapshots and API surface updated only where types
   surface.
2. **refactor(ocapn): hoist handoff side effects to the message
   boundary.**
   Move `provideHandoff` / `sendHandoff` out of `HandOffUnionCodec` into
   inbound/outbound descriptor transforms in the session layer.
   The existing three-party tests are the regression net; this is the
   riskiest phase and deliberately carries no other change.
3. **feat(ocapn): structural tier.**
   Structural `ReferenceIO`; `makeOcapnSessionCore` with injected
   handlers; presence layer re-expressed as the default handlers.
   New tests: structural echo and pipelining round-trips, and a
   cross-test of a structural peer against a presence peer over the
   in-memory netlayer.
4. **feat(ocapn): `handoffs: false` profile.**
   Codec branch omission, trimmed bootstrap, session-of-origin check,
   core constructed without session-graph powers.
   Tests: peer-attempts-handoff aborts with the diagnostic; third-party
   send throws locally; API-surface snapshot records the trimmed
   bootstrap.
5. **Follow-ups (separate designs if pursued):** body-bytes forwarding
   fast path per `docs/cbor-encoding.md` § "Passable Data and Slots"
   (remap parallel slot arrays, forward the embedded body unparsed);
   `relay: true` proxying for point-to-point meshes.

## Testing Plan

- Codec purity: structural decode/encode round-trips over the existing
  snapshot corpus; `encode(decode(bytes))` byte-identity.
- Interop: python test suite and Goblins-shaped fixtures unchanged in
  phases 1–3; three-party handoff tests unchanged through phase 3 and
  asserted *absent* (refused) under the phase-4 profile.
- Cross-tier: structural peer ↔ presence peer conversations, including
  pipelined answers (`op:deliver` to an answer position) and GC
  (`dropImport` emitting `op:gc-exports` that the presence peer honors).
- Least authority: a unit test that the point-to-point session core's
  construction inputs contain no session-graph capabilities.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [cbor-codec](cbor-codec.md) | Shared CBOR primitives; the structural descriptor vocabulary should stay aligned with the `rust/endo/slots` representation it standardizes golden vectors against. |
| [ocapn-network-transport-separation](ocapn-network-transport-separation.md) | Orthogonal layer (network/transport sits below the session core), but both refactors touch `packages/ocapn/src/client/index.js`; sequence phase 3 with awareness of its in-flight changes. |
| [ocapn-noise-key-only-session-boundary](ocapn-noise-key-only-session-boundary.md) | Independent; the point-to-point profile pairs naturally with relay-terminated pairwise deployments. |
| `docs/cbor-encoding.md` § "Passable Data and Slots" | The wire-format commitment (out-of-band slot arrays for forwarding) that the structural tier finally exposes to JavaScript consumers; the phase-5 fast path implements it. |

## Open Questions

1. Should `op:get` / `op:index` / `op:untag` be handler-interface
   operations (as sketched) or core-internal with a data-access callback?
   A comms vat forwards them like deliveries, which argues for the
   handler interface; a presence-only consumer never sees them.
2. Naming of the profile switch: `handoffs: false` (capability-shaped,
   composable with future `relay`) versus `profile: 'point-to-point'`
   (bundles future restrictions).
   Current lean: `handoffs: false`.
3. Whether the structural tier should represent `resolveMeDesc` as a bare
   descriptor (sketched) or as a core-provided `resolve/break` callback
   pair.
   The descriptor keeps tier 2 free of callback state; the callback is
   friendlier.
   Current lean: descriptor, with a helper in `@endo/ocapn/protocol`.
4. Coordination with the `@endo/cbor` extraction
   ([cbor-codec](cbor-codec.md)) and the Rust `slots` work: the
   structural message shape should be reviewed against the
   `rust/endo/slots` representation so the two ends of a future
   JS-kernel/Rust-comms boundary agree on descriptor vocabulary.

## Prompt

> propose a refactor of the ocapn implementation that achieve:
> 1) easier commsvat implementations (working with the protocol without
>    materializing references)
> 2) configuration to optimize for point-to-point modes that don't need
>    3pho
