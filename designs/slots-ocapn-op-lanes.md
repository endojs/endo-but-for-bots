# Slot-Machine OCapN Operation Lanes

| | |
|---|---|
| **Created** | 2026-09-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | In Progress |
| **Source** | [Review of endojs/endo-but-for-bots#990](https://github.com/endojs/endo-but-for-bots/pull/990#discussion_r3799060578) |

## Status

The first slot-machine implementation began with four envelope verbs:
`deliver`, `resolve`, `drop`, and `abort`. Property reads used a private
`__get__` method delivery, while indexing and tag removal had no
eventual-send expression.

The review direction is now settled: `get`, `index`, and `untag` are distinct
operations, and Eventual Send gains `E.index` and `E.untag`. Draft PR
[endojs/endo-but-for-bots#990](https://github.com/endojs/endo-but-for-bots/pull/990)
contains a candidate implementation. This document specifies the boundary the
implementation must preserve, including dedicated payload schemas and strict
JavaScript/Rust parity.

## What is the Problem Being Solved?

An eventual delivery invokes behavior selected by the receiver. A field read,
list index, or tag removal instead observes the shape of data. Encoding
`E.get(target).field` as a delivery to a method named `__get__` lets a method
intercept an operation that is not a method call. It also makes a supervisor
unable to distinguish data operations from deliveries without decoding the
opaque marshalled argument vector.

OCapN avoids that ambiguity with separate `op:get`, `op:index`, and
`op:untag` operations. Slot-machine should preserve the same operation
separation even though its envelope and payload encoding are not OCapN's wire
format. No operation may overshadow, intercept, or be interpreted as another
operation.

## Design

### Seven envelope verbs

Promote property access immediately and add all three data lanes as peers of
delivery. The slot-machine envelope vocabulary becomes:

| Verb | Meaning | Eventual-send source |
|---|---|---|
| `deliver` | Function or method invocation | `E(target)(...)`, `E(target).method(...)` |
| `get` | String-named field access | `E.get(target).field` |
| `index` | Positional list access | `E.index(target, index)` |
| `untag` | Tag-checked payload access | `E.untag(target, tag)` |
| `resolve` | Fulfil or reject an operation result | internal |
| `drop` | Release references | internal |
| `abort` | End the session | internal |

`get` must not retain a `__get__` delivery fallback. Such a fallback would
restore the ambiguity the lane is intended to remove. A method literally named
`__get__`, `index`, or `untag` remains an ordinary method and is reachable only
through `deliver`.

The receiving JavaScript client dispatches the lanes independently:

- `deliver` uses `HandledPromise.applyFunction` or
  `HandledPromise.applyMethod`.
- `get` uses `HandledPromise.get` and rejects an array target.
- `index` uses `HandledPromise.index`, rejects a non-array target, and rejects
  an invalid or out-of-bounds array index.
- `untag` uses `HandledPromise.untag`, rejects a non-tagged target, and rejects
  a tag mismatch before returning the payload.

These checks also apply to local Eventual Send, so local and remote routing do
not give the same expression different meanings. OCapN adapters may impose
their stricter Struct/List pass-style checks at their own protocol boundary;
slot-machine's invariant here is separation of operation identity.

### Eventual Send extension

`HandledPromise.get` already expresses the `get` lane. Extend the handler
protocol and static methods with:

```js
handler.index(target, index, returnedP);
handler.untag(target, tag, returnedP);

HandledPromise.index(target, index);
HandledPromise.untag(target, tag);

E.index(target, index);
E.untag(target, tag);
```

`E.index` is explicit because a JavaScript Proxy receives both `array[0]` and
`record['0']` as the string property key `"0"`; `E.get` cannot recover the
caller's intent after that coercion. `E.untag` is explicit because JavaScript
has no corresponding access syntax. Both return promises, like one property
selection from `E.get`.

An index is a JavaScript array index represented as a `number`: an integer in
the range `0 <= index < 2**32 - 1`. This is an array-domain bound rather than a
safe-integer approximation of OCapN's integer domain. A tag is a string.
Symbol field names and tags are not serializable through these lanes.

There are no `indexSendOnly` or `untagSendOnly` operations. Data access exists
to obtain a result, so discarding that result is not a useful protocol
operation. Existing `getSendOnly` remains an Eventual Send compatibility
surface but must not create a reply-less slot-machine data operation; a
slot-machine presence rejects it until a result-bearing meaning is specified.

### Wire format

The envelope verb identifies the operation. Each data lane has a dedicated
canonical-CBOR payload instead of reusing `DeliverPayload` with a differently
named envelope:

```text
get    = [target: Descriptor, fieldName: UTF-8 bytes, reply: Descriptor]
index  = [target: Descriptor, index: uint, reply: Descriptor]
untag  = [target: Descriptor, tag: UTF-8 bytes, reply: Descriptor]
```

The UTF-8 byte strings are required to decode strictly and canonically to
JavaScript strings. `index` is bounded to the valid array-index range at both
encoders and decoders. `reply` is required because every data operation
produces an eventual result and must have descriptor kind `Promise`. A target
may have kind `Object`, `Promise`, or `Answer`, preserving pipelining; `Device`
is rejected for these data operations. The result travels through the existing
`resolve` lane.

Unlike `deliver`, these payloads need no opaque marshalled body and no parallel
target/promise descriptor arrays: their operand is a scalar and cannot carry
capabilities. The supervisor can therefore validate the complete operation and
translate its `target` and `reply` descriptors without interpreting guest data.

This is operation-level parity with OCapN, not byte-level interoperability.
OCapN continues to encode `op:get`, `op:index`, and `op:untag` records according
to `packages/ocapn/src/codecs/operations.js`; slot-machine continues to use its
own envelope plus compact positional payloads.

### Rust supervisor

`rust/endo/slots/src/wire` mirrors the JavaScript vocabulary and schemas:

- add `VERB_GET`, `VERB_INDEX`, and `VERB_UNTAG` to `wire/mod.rs` and to
  `is_slot_verb`;
- add `GetPayload`, `IndexPayload`, and `UntagPayload` encode/decode types in
  `wire/payload.rs` with the same canonicality and bounds as JavaScript;
- add operation-specific translation functions in `wire/translate.rs` that
  translate both the target and reply descriptors; and
- route each verb through its matching decoder and translator in the Rust
  supervisor.

A malformed payload for a claimed slot verb is a protocol error. It must not
fall through to opaque byte forwarding, because that would let one supervisor
validate a different protocol from another. The session aborts without
dispatching the operation.

### Cross-supervisor parity and rollout

JavaScript-to-JavaScript, JavaScript-to-Rust, and Rust-to-JavaScript paths use
the same seven-verb vocabulary and payload fixtures. Each new payload gets:

- a pinned hexadecimal fixture duplicated in the JavaScript and Rust suites;
- round-trip and malformed-input tests on both sides;
- descriptor-translation tests for both `target` and `reply`; and
- end-to-end tests proving that a same-named method cannot intercept a data
  operation, plus the required wrong-shape and tag-mismatch failures.

The protocol currently has no version negotiation. Consequently this is an
atomic protocol revision: deploy only peers and supervisors that understand
all seven verbs. An older four-verb peer encountering a new verb fails closed;
it must not reinterpret the message as `deliver`. If compatibility with an
already deployed four-verb peer becomes necessary, add explicit session-level
version negotiation before sending any capability traffic. Do not add
per-operation fallback.

## Alternatives Considered

- **Keep get-as-call until indexing and untagging exist.** Rejected because
  `get` is already distinguishable in Eventual Send, and carrying it as a call
  violates the operation non-interception invariant now.
- **Infer index from numeric-looking `E.get` keys.** Rejected because Proxy key
  coercion erases whether the caller wrote a number or a string.
- **Reuse the opaque `deliver` payload for all four result-bearing verbs.**
  Rejected because it hides scalar operands from supervisor validation, carries
  irrelevant descriptor vectors, and makes the Rust type model say that a data
  operation is a delivery with a different label.
- **Add a generic `operate(kind, ...)` Eventual Send method.** Rejected because
  named handler methods preserve auditability, local semantics, and direct
  correspondence with protocol lanes.

## Test Plan

- Eventual Send: local and handled-promise tests for `get`, `index`, and
  `untag`, including promise pipelining and handler forwarding.
- Semantic separation: `get` on an array, `index` on a non-array, out-of-range
  index, `untag` on a non-tagged value, and tag mismatch all reject; methods
  with colliding names are never invoked.
- Wire codecs: JavaScript and Rust round trips, canonical hex fixtures, invalid
  UTF-8, invalid array indices, missing/extra fields, trailing bytes, and wrong
  descriptor kinds.
- Supervisor: descriptor translation for every result-bearing verb and
  fail-closed behavior for malformed claimed verbs.
- Cross-supervisor: the same operation transcript in JavaScript/JavaScript,
  JavaScript/Rust, and Rust/JavaScript configurations yields equivalent values
  and rejections.

## Dependencies

| Dependency | Relationship |
|---|---|
| [cbor-codec](cbor-codec.md) | Supplies canonical primitive CBOR encoding used by both supervisors. |
| [daemon-capability-bus](daemon-capability-bus.md) | Carries the slot-machine envelopes between workers and supervisors. |
| `@endo/eventual-send` | Defines the handler and `E` surfaces that select each operation. |
| `@endo/ocapn` operation codecs | Semantic reference for keeping data operations separate from delivery. |

## Prompt

> Design how `@endo/slots` should emulate OCapN's separate `op:get`,
> `op:index`, and `op:untag` lanes as verbs distinct from message delivery,
> including the Eventual Send surface, matching Rust supervisor verb-set
> changes, wire format, and cross-supervisor parity implications.
