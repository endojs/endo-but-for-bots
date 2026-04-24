# JS slot-machine client — design for integration

This document specifies the JavaScript `@endo/slots` client that, once
built, replaces CapTP on the worker ↔ daemon ↔ worker hot path when
the Rust supervisor is active.  The Rust supervisor already speaks
the `deliver`/`resolve`/`drop`/`abort` wire protocol and will
translate descriptors through its kref registry.  What's missing is
a JS peer that emits and consumes that wire.

## Package layout

```
packages/slots/
├── package.json               # @endo/slots, workspace:^
├── src/
│   ├── index.js               # pub API: makeSlotMachineClient, constants
│   ├── session.js             # SessionId computation (SHA-256 of label)
│   ├── descriptor.js          # Descriptor enc/dec (match Rust kind-byte)
│   ├── cbor/
│   │   ├── encode.js          # canonical CBOR, hand-rolled to match Rust
│   │   └── decode.js          # ciborium-style reader, strict canonicalness
│   ├── payload/
│   │   ├── deliver.js         # DeliverPayload encode/decode
│   │   ├── resolve.js
│   │   ├── drop.js
│   │   └── abort.js
│   └── clist.js               # per-session vref↔ref bimap, nextLocal counters
└── test/
    ├── descriptor.test.js
    ├── cbor-canonical.test.js # byte-level fixtures matching the Rust crate
    └── roundtrip.test.js      # JS encode → Rust decode → JS decode
```

## SessionId

Must match `slots::session::SessionId::from_label(label)` in the Rust
crate exactly: `SHA-256("slots/session/" || label.utf8()) → 32 bytes`.

```js
// src/session.js
export const sessionIdFromLabel = label => {
  const bytes = textEncoder.encode(`slots/session/${label}`);
  return sha256(bytes); // Uint8Array(32)
};
```

For worker-handle labels, use `worker-${handle}` exactly as the Rust
`supervisor.rs:session_for_handle` does.

## Descriptor encoding

A descriptor is a 2-element CBOR array `[kindByte, position]`.

`kindByte` layout (matches `rust/endo/slots/src/wire/descriptor.rs`):

| bit   | meaning                                              |
|-------|------------------------------------------------------|
| 0     | direction: 0=Local, 1=Remote                         |
| 1..=2 | kind: 0=Object, 1=Promise, 2=Answer, 3=Device        |
| 3..=7 | reserved (must be 0; decoder rejects)                |

`position` is a non-negative integer ≤ u64::MAX, encoded in the
smallest CBOR uint form (minimal head).

```js
// src/descriptor.js
export const Direction = { Local: 0, Remote: 1 };
export const Kind = { Object: 0, Promise: 1, Answer: 2, Device: 3 };

export const encodeDescriptor = (out, { dir, kind, position }) => {
  const b = (kind << 1) | dir;
  writeArrayHeader(out, 2);
  writeUint(out, b);
  writeUint(out, position);
};
```

## Canonical CBOR

Hand-roll to guarantee byte-identical output with the Rust crate
(same fixtures, same bytes).  The Rust crate's reference fixture
is `Descriptor(Local, Object, 0)` → `82 00 00`.  Pin the same fixture
in a JS test so regressions show up immediately.

Minimal-head rules (RFC 8949 §4.2):
- `u ≤ 23`: one byte.
- `u ≤ 0xff`: `[head+24, u8]`.
- `u ≤ 0xffff`: `[head+25, u16_be]`.
- `u ≤ 0xffff_ffff`: `[head+26, u32_be]`.
- otherwise: `[head+27, u64_be]`.

No indefinite lengths; no maps in slot-machine payloads, so map-key
sorting doesn't apply.

## Payload shapes

Mirror the Rust structs in `rust/endo/slots/src/wire/payload.rs`:

```
DeliverPayload = array(5) [
  target:   Descriptor,
  body:     bytes,
  targets:  array of Descriptor,
  promises: array of Descriptor,
  reply:    Descriptor | null,
]

ResolvePayload = array(5) [
  target:    Descriptor,
  is_reject: uint (0 | 1),
  body:      bytes,
  targets:   array of Descriptor,
  promises:  array of Descriptor,
]

DropPayload = array(N) of [
  array(4) [
    target: Descriptor,
    ram:    uint,
    clist:  uint,
    export: uint,
  ],
  ...
]

AbortPayload = bytes (utf-8 reason)
```

## C-list client surface

The client mirrors the Rust `Session`:

```js
// src/clist.js
export const makeSessionCList = ({ label }) => {
  const id = sessionIdFromLabel(label);
  const valToDesc = new WeakMap();
  const descToVal = new Map(); // key: kindByte<<64|position (stringified)
  const next = { object: 1, promise: 1, answer: 0, device: 1 };

  return harden({
    id,
    exportLocal(val, kind = Kind.Object) {
      const existing = valToDesc.get(val);
      if (existing) return existing;
      const position = next[kindNames[kind]]++;
      const desc = { dir: Direction.Local, kind, position };
      valToDesc.set(val, desc);
      descToVal.set(keyOf(desc), val);
      return desc;
    },
    importRemote(desc) {
      const existing = descToVal.get(keyOf(desc));
      if (existing) return existing;
      const presence = makePresence(desc); // see below
      descToVal.set(keyOf(desc), presence);
      return presence;
    },
    drop(desc) {
      const key = keyOf(desc);
      const val = descToVal.get(key);
      if (val) {
        descToVal.delete(key);
      }
      // refcounts live on the Rust side; we just report.
    },
  });
};
```

Presence factory: return a Far object that, when reached through `E(...)`,
queues a `deliver` envelope via the transport.  Promise resolution is
handled by `resolve`-verb inbound.

## Integration splice points

### Daemon side — `packages/daemon/src/bus-daemon-rust-xs.js`

Current (CapTP for client connections, line 708):
```js
const { dispatch, abort } = makeCapTP(
  `Client ${connectionHandle}`,
  send,
  bootstrap,
  { onReject: silentReject },
);
```

Keep this for **client** connections (the `bench-client` / user clients
stay on CapTP for now).  Add a parallel path for **worker** connections.

Worker connections are currently mediated entirely by the daemon's
`@endo/captp` over connection.js (`makeMessageCapTP`).  Add a
slot-machine connection mode keyed off `connection.kind === 'worker'`:

```js
import { makeSlotMachineClient, Verbs } from '@endo/slots';

const workerSession = makeSlotMachineClient({
  label: `worker-${workerHandle}`,
  sendFrame: (verb, payload, nonce = 0) =>
    sendEnvelope(workerHandle, verb, payload, nonce),
});

// In the envelope dispatch (handleCommand), around line 725:
if (env.verb === Verbs.DELIVER || env.verb === Verbs.RESOLVE) {
  workerSession.onInbound(env);
  return;
}
if (env.verb === Verbs.DROP) {
  workerSession.onDrop(env);
  return;
}
```

### Marshalling — `packages/daemon/src/daemon.js`

The daemon today creates a `@endo/marshal`-powered marshaller
(around line 1385) that emits `{ body, slots }` with FormulaIdentifier
strings.  For worker-bound traffic under slot-machine, replace this
with a slot-machine-aware codec:

```js
const slotsMarshaller = makeMarshal(
  // toRef: when a reference is encountered, export it into this
  // session and return the descriptor's stringified key as the slot.
  obj => session.exportLocal(obj),
  // fromRef: when a slot is encountered on the wire, look it up or
  // materialize a presence.
  desc => session.importRemote(desc),
  { serializeBodyFormat: 'smallcaps' },
);
```

The `body` produced by `toCapData` goes verbatim into
`DeliverPayload.body`.  The `slots` array becomes
`DeliverPayload.targets` (for objects) and `DeliverPayload.promises`
(for promises).  Keep them ordered by traversal index.

### Worker side — `packages/daemon/src/bus-worker-node-raw.js`

Node workers connect over pipes with CapTP today.  Swap CapTP for
`@endo/slots`:

```js
import { makeSlotMachineClient, Verbs } from '@endo/slots';

const session = makeSlotMachineClient({
  label: `worker-${selfHandle}`,
  sendFrame: writeEnvelopeToFd4,
});

onInboundEnvelope(env => {
  if (env.verb === Verbs.DELIVER) return session.onDeliver(env);
  if (env.verb === Verbs.RESOLVE) return session.onResolve(env);
  // else: legacy / host verbs pass through unchanged
});
```

## Testing plan

1. **Canonical-byte fixtures** matching the Rust crate's tests
   (e.g. `Descriptor(Local, Object, 0)` → `0x82 0x00 0x00`).  Any
   divergence means the Rust supervisor will reject the message.
2. **Round-trip through Rust**: spawn a Rust endor with `ENDO_TRACE=1`,
   emit a `deliver` envelope from the JS client, assert the
   supervisor logs the translate.  Use a tiny Node-only test harness
   that sidesteps the full daemon.
3. **End-to-end** with the existing daemon ava suite, after the
   splice lands.  Expect the makeBundle/makeUnconfined failures to
   persist (pre-existing XS gap); everything else should still pass.
4. **Bench**: rerun `test/bench-daemon.js` and compare against
   `captp-baseline.md`.

## Risks & open questions

- **Flow control.**  CapTP has an implicit back-pressure model (the
  writer stream).  Slot-machine envelopes go through the Rust
  supervisor's unbounded mailbox.  For a busy worker-to-worker
  stream we may need a `pause`/`resume` verb or a windowing model.
  Not in scope for the first cut; acceptable because the bench
  doesn't saturate.
- **Error marshalling.**  OCapN has a `desc:error`; we chose to omit
  it from the flattened verb set.  Method rejections need a home.
  Proposal: `resolve` with `is_reject=1` and an error body.  This
  matches the design document from the earlier exchange.
- **Promise pipelining.**  The JS client must expose the Presence
  factory so that `E(promise).foo()` before the promise resolves
  queues a `deliver` targeting the promise descriptor.  The Rust
  supervisor already handles forwarding; we just need to not await
  resolution in the JS layer.
- **Client (non-worker) connections.**  This design keeps CapTP for
  clients.  Later, the same slot-machine client can replace the
  CapTP stack on the client socket path too, reusing the same
  transport under a different session label.
