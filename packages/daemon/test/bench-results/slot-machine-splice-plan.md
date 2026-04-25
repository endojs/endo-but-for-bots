# Daemon-side splice plan — `bus-daemon-rust-xs.js`

The worker-side splice in `bus-worker-node-raw.js` is in place behind
`ENDO_USE_SLOT_MACHINE=1`.  This document specifies the matching
daemon-side change for the XS daemon, which is the larger half.

## Where the splice goes

`provideWorker` in `bus-daemon-rust-xs.js` (around line 467) currently
sets up CapTP per-worker connection:

```js
sendEnvelope(0, 'spawn', payloadBuf, nonce);
const response = await spawnResponse;
const workerHandle = decodeCborInt(response.payload);

const [captpReadFrom, captpWriteTo] = makePipe();
workerWriters.set(workerHandle, { writer: captpWriteTo });

const envelopeBytesWriter = harden({
  async next(chunk) {
    sendEnvelope(workerHandle, 'deliver', chunk);
    return harden({ done: false, value: undefined });
  },
  /* ... */
});
const messageWriter = mapWriter(envelopeBytesWriter, messageToBytes);
const messageReader = mapReader(captpReadFrom, bytesToMessage);

const { getBootstrap } = makeMessageCapTP(
  `Worker ${workerId}`,
  messageWriter,
  messageReader,
  cancelled,
  daemonWorkerFacet,
);
```

Under the flag this branches into a slot-machine setup:

```js
if (env.ENDO_USE_SLOT_MACHINE === '1') {
  // Slot envelopes carry the verb intact; the byte writer becomes
  // verb-aware.
  const [recvReadFrom, recvWriteTo] = makePipe();
  // Store an envelope writer so handleCommand can forward verb+payload.
  workerSlotWriters.set(workerHandle, { writer: recvWriteTo });

  const envelopeWriter = harden({
    async next(/** {{verb,payload}} */ env_) {
      sendEnvelope(workerHandle, env_.verb, env_.payload);
      return harden({ done: false, value: undefined });
    },
    /* ... */
  });

  ({ getBootstrap, closed } = makeMessageSlots(
    `Worker ${workerId}`,
    envelopeWriter,
    recvReadFrom, // an AsyncIterable<{verb, payload}>
    cancelled,
    daemonWorkerFacet,
  ));
} else {
  /* existing CapTP setup */
}
```

## `handleCommand` change

Today (line 756), inbound `deliver` envelopes from a worker go to
`workerEntry.writer` which feeds the CapTP byte reader.  Under
slot-machine the dispatcher must forward all four slot verbs as
envelope objects instead of bare bytes:

```js
const slotEntry = workerSlotWriters.get(env.handle);
if (slotEntry && isSlotVerb(env.verb)) {
  void slotEntry.writer.next({ verb: env.verb, payload: env.payload });
  return;
}
```

`isSlotVerb` is exported from `@endo/slots`.  Falls through to the
existing CapTP path when the worker is in the legacy mode.

## Bootstrap handshake

Both peers use the position-1 root convention from
`packages/slots/src/bootstrap.js`.  The XS daemon exports
`daemonWorkerFacet` at position 1 of its session for that worker; the
worker exports its `workerFacet` at position 1 of its session.  The
Rust supervisor's kref registry unifies them through `translate_one`.

No explicit handshake message is required — the first deliver from
either side primes the kref mapping.

## Bench validation

After the splice:

1. Build endor: `cargo build --release --bin endor`.
2. Run the bench: `ENDO_USE_SLOT_MACHINE=1 node packages/daemon/test/bench-daemon.js`.
3. Capture the `worker_to_worker_ping` and `worker_to_worker_echo_1kib`
   lines for the Rust+XS variant.
4. Write to `slot-machine-result.md` alongside `captp-baseline.md`.

Targets (from the design speculation): ping 1.4 → 0.6–0.9 ms
(1.5–2× win), echo 2.6 → 1.0–1.5 ms (~2× win, dominated by the
skipped JSON encode/decode of the body).

## Bundle drift blocker (discovered 2026-04-25)

The XS daemon runs a pre-bundled `rust/endo/xsnap/src/daemon_bootstrap.js`
embedded in the `endor` binary.  The committed bundle (1,260,776 bytes)
boots correctly — `bench-daemon.js` reproduces the captp baseline
numbers exactly.  Regenerating the bundle from the current source
tree (via `node packages/daemon/scripts/bundle-bus-daemon-rust-xs.mjs`)
yields a different binary (1,266,813 bytes without `@endo/slots`,
1,340,688 bytes with) that **fails to start**:

```
endor: [trace] daemon-xs: startup error: cannot coerce undefined to object
TypeError: cannot coerce undefined to object
 at makeFormulaPath ()
 at readFormula ()
 at seedFormulaGraphFromPersistence ()
```

The diff between committed and regenerated bundles shows source
drift unrelated to slot-machine: `makeRetentionAccumulator`,
`makeXsSqlitePowers`, `makeDebugSession`, `DebuggerInterface`, and
`makeDebugger` are present in the regenerated bundle but absent
from the committed one; conversely `makeSyncedStoreController`,
`SyncedPetStoreInterface`, and `makeSyncedPetStore` are in the
committed bundle but no longer compiled by current sources.  The
daemon source has evolved since `daemon_bootstrap.js` was last
checked in, and the persistence-seeding path now expects a record
shape that the older committed-bundle code didn't.

**This blocks the daemon-side splice.**  The slot-machine work
itself doesn't introduce the regression — adding `@endo/slots` to
the bundle without using it produces the same boot error — but
landing the splice requires a working regenerated bundle.

Concrete unblock steps for the next pass:

1. Identify the persistence record whose decode raises the
   `cannot coerce undefined to object` in
   `seedFormulaGraphFromPersistence`.  Likely candidates: the
   `synced-pet-store` formula type was removed but its on-disk
   records weren't migrated; or `makeRetentionAccumulator`
   replaced an inline behavior whose call-site still expects the
   inline value.
2. Either restore the missing modules to the source tree, add a
   migration step at boot, or check in a known-good
   `daemon_bootstrap.js` regenerated against a source tree that
   matches it.
3. Once the bundle regenerates cleanly, the splice in this
   document applies as written — `makeMessageSlots` plugs in at
   the `makeWorker` call site without further refactoring.

## Risks

- **`@endo/slots` in XS.**  The package uses `@noble/hashes`,
  `TextEncoder`, `Map`, `WeakMap`, `Promise` — all available in XS
  via the SES shim.  `FinalizationRegistry` is opt-in; the daemon
  side will pass `undefined` to disable auto-drop until XS's GC
  semantics are validated.
- **Pipe ordering.**  The supervisor's `route_message` may reorder
  envelopes if multiple verbs arrive in the same poll cycle.  Our
  `inboundFrames` generator processes them serially; verify the
  ordering invariants the existing `workerWriters.get(handle)` path
  relies on.
- **Spawn / debug-attach verbs.**  These remain CapTP-side concerns
  (they're worker lifecycle, not capability traffic).  The slot
  splice only intercepts `deliver`/`resolve`/`drop`/`abort`.
