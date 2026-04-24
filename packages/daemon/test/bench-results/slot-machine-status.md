# Slot-machine status — JS client landed, bus splice follow-up

## What this PR adds

- **`packages/slots`** — `@endo/slots`, a JavaScript client that
  speaks the slot-machine wire protocol byte-for-byte with the Rust
  crate.
  - Canonical CBOR encoder/decoder (minimal-head integers; no
    indefinite lengths; RFC 8949 §4.2).
  - `Descriptor` 2-element array `[kindByte, position]` with the
    reference fixture `Descriptor(Local, Object, 0)` → `82 00 00`.
  - Four payload codecs: `deliver`, `resolve`, `drop`, `abort`.
  - Per-session c-list (`makeCList`) with monotonic counters matching
    the Rust `Session`.
  - `SessionId` derived as SHA-256 of `"slots/session/" + label`.
  - `makeSlotCodec` on top of `@endo/marshal`, encoding method
    calls and resolutions into wire payloads with c-list-backed slot
    translation.  All capabilities share a flat `targets` array on
    the wire (kind byte disambiguates); `promises` stays empty since
    the Rust supervisor's `translate_slice` handles both arrays
    identically.
  - `makeSlotClient` composing the c-list and codec with a transport
    callback: produces `HandledPromise` presences whose `E()` calls
    emit `deliver` envelopes, routes inbound `deliver` envelopes to
    `HandledPromise.applyMethod` on the local target, and resolves
    pending reply promises when matching `resolve` envelopes arrive.
    Rejections rehydrate as `Error` instances.
- **Pinned wire fixtures on both sides** — an empty-label SessionId
  and `worker-1` SessionId hex digests appear in both
  `packages/slots/test/session.test.js` and
  `rust/endo/slots/src/session.rs`.  Any divergence will fail either
  `yarn test` in `packages/slots` or `cargo test -p slots`.
- **CapTP baseline** captured in `captp-baseline.md`; 57 JS unit
  tests (descriptor / cbor / payload / session / clist / codec /
  client) plus 39 Rust unit tests (previously 37) are green.

## What's explicitly not in this PR

### The daemon splice

Integrating `@endo/slots` into `bus-daemon-rust-xs.js` and
`bus-worker-node-raw.js` so worker-to-worker traffic uses
`deliver`/`resolve`/`drop`/`abort` envelopes instead of CapTP is
substantially more work than the client itself.  Library stages
now in place; remaining work is the bus integration:

1. ~~A slot-machine-aware codec on each worker~~ — **done**
   via `makeSlotCodec`.
2. ~~Presence-factory wiring so `E(presence).method()` queues a
   `deliver` against the descriptor of `presence` without awaiting
   resolution~~ — **done** via `makeSlotClient` (`HandledPromise`
   presences + reply-promise table keyed by descriptor).
3. ~~Error marshalling (`resolve` with `is_reject=1`)~~ — **done**;
   `makeSlotClient`'s `onResolve` rehydrates rejections as `Error`.
4. **Still open**: splicing the client into `bus-worker-node-raw.js`
   and `bus-daemon-rust-xs.js` behind an opt-in env flag.  This
   needs a bootstrap handshake that lets both ends agree on the
   initial root descriptor, plus drop-refcount management at the
   JS boundary (the JS client doesn't yet track pillar decrements
   for finalized presences — a `WeakRef`-backed finaliser will do).

The Rust supervisor already attempts `translate_deliver` /
`translate_resolve` on every `deliver`/`resolve` envelope it routes
(see `supervisor.rs:362`), and falls through silently when the
payload does not decode as canonical CBOR with the slot-machine
shape.  That means CapTP-over-`deliver` traffic continues to work
unchanged — the splice is non-regressive in the sense that a JS
client emitting slot-machine CBOR on the same verb will be handled
correctly, but nothing today emits that shape.

### The benchmark comparison

`captp-baseline.md` stands.  The comparison run belongs to the PR
that ships the splice, since slot-machine traffic requires a
marshaller swap to exist on the wire at all.

## Next step

A follow-up PR that:

1. Replaces worker↔daemon and worker↔worker CapTP with
   `makeSlotClient`, starting with a feature-flagged
   (`ENDO_USE_SLOT_MACHINE=1`) opt-in.  Adds a minimal bootstrap
   handshake so both peers agree on the root descriptor.
2. Adds `WeakRef`-backed drop routing so presence GC emits a
   `drop` envelope with the appropriate pillar decrements.
3. Measures the Rust+XS `worker_to_worker_ping` /
   `worker_to_worker_echo_1kib` deltas versus the baseline in
   `captp-baseline.md`.
4. Writes the delta to `slot-machine-result.md` alongside the
   baseline.
