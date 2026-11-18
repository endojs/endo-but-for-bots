# Spike dataref, design T3: data handles in the Ironhorse engine and worker

Research spike, lane `claude/thix-dataref`, track T3. Not product code. Base `36b3035e92`; the
prototype commits are `a86340a6a1` (core seam, CC-087), `8e0c458da3` and `f2fa1a877b` (stand-in and
benchmark). Written 2026-11-18.

Evidence labels: **[measured]** by this track's benchmark (section 7; JSON lines from commit
`f2fa1a877b`); **[code]** read from the named file and function; **[S1]..[S4]** the four surveys in
this directory; **[T2]** `design-ocapn.md` and journal entries J-9815..J-9821 of the hub track;
**[J-xxxx]** an earlier journal measurement, not re-run; **[inferred]** my reasoning, not executed.
No web source was fetched for this track; where I compare with other systems I rely on [S4], which
cites its sources.

Paths: `pkg/` = `packages/thixotrope/`, `H/` = `packages/thixotrope-harness/`, `ocapn/` =
`packages/ocapn/`.

**Said early, as asked: a real engine prototype was not built.** The engine-native handle (section
1) touches the value model, a new side table with persistence and collector hooks, two native
statics, the boot fingerprint, the row schema and the snapshot goldens [S3 8.1, code]. That is
weeks, not hours, and its numbers would not differ from the stand-in's in what the benchmark
measures (bytes in frames, journals, snapshots and the hub), because those depend on what crosses
the worker duct, not on how the vat represents a handle. So I prototyped the cheapest faithful
stand-in: the worker transport (supervisor side, Node) moves large atoms out of inbound frames
before they are journaled, records which references each worker received, and refuses outbound
references a worker never received, around the unmodified engine and worker. Section 7.5 states
exactly what the stand-in does not prove. No cargo build was run; `target-spike` was never
created (0 bytes).

---

## 1. The design in one page

**The engine's job is the vat-side half of a data reference, not the reference itself.** The
measurements and [T2] agree: the zero-copy property comes from the bytes never entering a vat
frame, and the identity, persistence, rights amplification and collection of a data reference
are best held by the hub as a `hub:data` row [T2 1]. What only the engine and worker can do is
(a) make *holding* a reference cheap inside a vat, (b) report a dropped reference without running
guest code, and (c) keep bytes that do arrive in a vat-bound frame out of the vat's journal and
heap. The design below gives each of those a place, and says which are worth building now.

**D-1. A data handle is an engine-native, methodless remotable.** When the in-vat OCapN client
decodes a reference it knows to be data (the [T2] envelope Tagged `thix:data`, extended to sealed
data, section 2.3), it does not build a presence. It asks a trusted native, captured by the
bootstrap and deleted from the global object before guest code runs (the pattern of
`thixotropeDispatch` and the CORE-1 UTF-8 statics [S3 8.1]), for the canonical handle of that
import position. The handle is one instance slot branded by a new engine side table
`data_handles: SlotIndex -> { position: u32, mentions: u32 }`, with a non-rooting reverse index
`position -> SlotIndex`. It is frozen, has no own properties, and its prototype is a frozen
intrinsic carrying only the pass-style marks of a remotable with interface `Alleged: DataHandle`.
So `passStyleOf` says `remotable`, marshal and the OCapN codec pass it like any reference (no new
pass style, no codec change outside the in-vat client), `===` is identity per position, it can be a
`WeakMap` key, and nothing on it reads anything. `E(handle).anything()` is refused locally: a
handle answers no messages; length and hash come from the envelope the vat received it in.

**D-2. Death is reported by the collector, not by guest finalizers.** The sweep's `swept` hook
(`ironhorse-vm/src/gc.rs` `GcHooks::swept`) appends each dead handle's `(position, mentions)` to a
released list. At the end of a crank the trusted bootstrap drains that list through a second
captured native and emits one ordinary `op:gc-exports` frame (positions, wire deltas). The hub
then does what it does today: decrement, and at zero `maybeReleaseRef`, which for a `hub:data`
row unlinks the file after the release commits [T2 1, code `hub.js`]. The sweep runs at
schedule-fixed points (the GC schedule is part of the replay contract, C-7, C-17), so the frame is
a pure function of image plus journal and replays identically.

**D-3. Inline bytes are ingested at the edge, before any journal.** A bytestring (or string) above
a bound in a frame toward a worker is turned into a data row and the frame carries its reference
instead. The stand-in does this in the worker transport and measured it working (1 MiB arrives as a
reference, the vat never sees the bytes, its journal grows 2.5 KB) [measured, J-9836]; but the hub
had already persisted the bytes in clear (`hub-image.json`, C-1) [measured, J-9834]. **So the edge
must be the hub, not the transport**: the hub decodes every frame anyway, and turning a large atom
into a `hub:data` row before it queues the re-encoded frame keeps it out of the hub state too. This
is a T2 change (hub `forwardToRow`), proposed here, not built.

**D-4. The rare read stays an asynchronous call.** `E(reader).read(handle, offset, count)`
answers a ByteArray; the bytes are journaled once and are garbage afterwards [measured: 1,024 bytes
read in 53 ms median, journal +1,632 bytes per read, J-9837]. A synchronous read of host-held bytes
(an external ArrayBuffer, [S3] candidate 2) is specified only as a later option for immutable,
content-addressed data that a vat must read repeatedly (section 4.5), and is not recommended now.

**End to end it is one thing.** On the wire: the [T2] envelope `thix:data { length, ref, sha256 }`
whose `ref` is an ordinary `desc:import-object` position of a `hub:data` row. In the hub: that row.
In a vat: a D-1 handle bound to the same position. In an adapter with a reader power: the same row,
read by `read` or `locate` [T2 2.1]. The engine adds no wire form of its own; the stand-in's integer
Tagged (section 7) was a measurement device, not a proposal.

**Recommendation for this layer.** Build D-3 in the hub (with T2) and the T2 hub rows first;
those give every number in section 7. Then fix the delivery path (deliver-v2 and the C-5 harden,
[S3] 10), which makes the rare read and every other inbound frame cheaper. Build D-1/D-2 only when
a vat must hold more than roughly 10^4 data references at once (long sessions keeping references
after sealing, [S1] 4.1): the measured in-vat cost of a presence is about 136 slots and 4.5 KB of
snapshot per reference, of a small Tagged value about 71 slots and 1 KB, upper bounds
[measured, J-9839]; a native handle should be one slot and a side row [inferred]. Before D-1/D-2,
an interim D-1a in JavaScript (section 3.3) gives most of the API at no engine cost.

---

## 2. What a vat and an adapter see

### 2.1 In a vat

| question | answer (D-1) | stand-in (section 7) |
|---|---|---|
| how it arrives | as the `ref` of a `thix:data` envelope (or a sealed envelope, 2.3) | a Tagged `thix-dataref` whose payload is a 63-bit integer |
| `typeof` | `'object'` | `'object'` (measured `kind`: `object:true`, frozen) |
| `passStyleOf` | `'remotable'`, interface `Alleged: DataHandle` | `'tagged'` |
| frozen | yes, no own properties, frozen intrinsic prototype | yes |
| readable state | none; the position is in the engine side table, reachable only by the captured native | the integer is readable (that is why the stand-in needs a possession check) |
| equality | `===` per import position within the vat (canonical through the reverse index) | structural only (two Tagged values with one number are not `===`) |
| `WeakMap` key | yes | no (copy data) |
| eventual send | refused locally ("a data handle answers no messages") | not applicable (data) |
| store in durable state | yes: the heap is persistent; a handle costs one slot plus a side row | yes: measured about 71 slots and 975 bytes of snapshot per reference, upper bound |
| pass on | as any remotable; the in-vat client writes the hub's position | the Tagged value passes verbatim |
| read | only through a reader it was given on purpose (2.2) | same |
| names used | none (no property per handle, no record key per datum: C-6) | none |

A short example, the secret case (V is a session vat; `secrets` and `provider` are adapter objects
the vat was given; under D-1 the code is identical, only the representation differs):

```js
// In V: hold a secret reference in durable state, later hand it to the provider.
const slots = new Map(); // the heap persists
const vat = Far('Session', {
  adopt: async () => {
    slots.set('apiKey', await E(secrets).issue('provider key')); // a handle, no bytes
  },
  ask: request => E(provider).call(request, slots.get('apiKey')), // forwards the handle
});
```

The bulk-forward case, V1 to V2 to B:

```js
// In V1
relay: (v2, key, b) => E(v2).putAndGive(key, slots.get(key), b),
// In V2
putAndGive: (key, ref, b) => { slots.set(key, ref); return E(b).take(ref); },
```

### 2.2 In an adapter

Adapters are Node processes; they see the [T2] surface unchanged: a writer power (`put`, `create`,
`append`, `close`), a reader power (`read`, `locate`) and, for sealed data, an unsealer power. The
engine design adds nothing an adapter calls. In the stand-in, the test's two control clients played
the adapters and read and wrote the store directly (stub of the writer and reader powers).

```js
// Provider adapter (holds the unsealer power, given at launch).
call: async (request, keyRef) => {
  const { file } = await E(unsealer).locate(keyRef); // no bytes through the hub
  const key = await readFile(path.join(dataDir, file));
  return send(request, key); // destination bound at mint time, never from the caller
},
```

### 2.3 One change asked of T2

[T2] sends sealed data (secrets) bare, without an envelope, so that nothing reveals length or hash.
A vat cannot then tell a sealed data import from any other import, and would have to build a full
presence for it. Proposal: a sealed envelope `thix:data { ref, sealed: true }`, no length, no hash.
It reveals nothing a bare reference does not, the hub checks it like the other envelope, and it
lets a vat represent every data import by a D-1 handle.

---

## 3. Every change, by layer and file

### 3.1 What the stand-in changed (built, measured)

| layer | file | change | size |
|---|---|---|---|
| core, worker transport | `pkg/src/core/durable-worker-transport.js` | optional frame filter under `Symbol.for('thixotrope.spike.dataref.frameFilter')` on `globalThis`: `inbound` before `journalEntryOf` builds the entry, `outbound` before `onFrame`/`onFrames` (CC-087) | +30, -4 lines |
| spike | `H/test/spikes/dataref-engine/dataref-store.mjs` | Syrup frame scanner (no copy; skips atom contents), splice, the segment store (write once: part file, fsync, rename, directory fsync; random 63-bit ids), per-worker possession logs (append, fsync), the filter | 340 lines |
| spike | `H/test/spikes/dataref-engine/frame-filter.mjs` | `node --import` preload that installs the filter in the supervisor child and removes its variables from the environment (the child refuses unknown variables) | 35 lines |
| spike | `H/test/spikes/dataref-engine/bench.mjs` | the benchmark (section 7) | 960 lines |
| spike | `H/test/spikes/dataref-engine/scan.test.js` | scanner unit test (3 tests) | 60 lines |

The core change is additive and inert unless a process installs the symbol. It overlaps no other
track's file.

### 3.2 What production D-1, D-2 would change (not built; sizes are estimates [inferred])

| layer | file or area | change | size |
|---|---|---|---|
| engine | `rust/engine/ironhorse-vm/src/interp/state.rs`, `side_storage.rs` | `data_handles` side table and its non-rooting reverse index; capacity-class charge like the other growable tables | 120 |
| engine | `ironhorse-vm/src/gc.rs`, `interp/gc_tables.rs` | sweep hook: a dead branded slot appends `(position, mentions)` to a released list; the reverse index is pruned, never marked | 80 |
| engine | `ironhorse-vm/src/interp/natives/` (new `data_handle.rs`) | `%DataHandle%` statics: `import(position)` returns the canonical handle (mint or reuse, `mentions += 1`), `positionOf(handle)`, `takeReleased()`; a frozen prototype intrinsic with the remotable marks | 250 |
| engine | `ironhorse-snapshot/src/sidetable.rs`, `interp/persist.rs`, `snapshot_api.rs` | ledger row `Coverage::Serialized` `{ slot, position, mentions }`; reverse index rebuilt on restore; `ROW_SCHEMA_VERSION` 6 -> 7 | 200 |
| engine | `INTRINSIC_KEY_ORDER`, boot | the new statics and prototype move the boot fingerprint; goldens re-pinned by the three-run procedure (`0a4bdb3826`) | small, plus re-pin |
| worker | `rust/thixotrope-ironhorse-worker/src/main.rs` | none required: the bootstrap drains the released list inside the crank; optional `timing` field for the count | 0-20 |
| boot | `rust/endo/xsnap/src/polyfills.js` or the boot bundle | capture and delete `%DataHandle%` statics before guests run | 20 |
| vat bootstrap | `pkg/src/core/worker-peer-xs.js`, `pkg/src/core/worker-peer.js` | pass the captured natives to the in-vat OCapN client; at the end of each crank drain released positions into one `op:gc-exports` frame | 60 |
| in-vat OCapN | `ocapn/src/captp` import table and `codecs/passable.js` (vat build only) | decode the `ref` of a `thix:data` envelope through `import(position)` instead of `makeRemoteKit`; encode a handle through `positionOf`; refuse `E()` on a handle | 150 |
| hub | `pkg/src/net/hub.js` (with T2) | D-3 ingest: during re-encode toward a worker session, a bytestring or string above a bound becomes a `hub:data` row before the frame is queued | 120 |
| tests | engine unit tests, persistence round trip, GC replay test, worker integration, hub ingest | | 500-800 |

Total about 1,500-1,900 lines with tests, plus golden re-pins, plus a state-directory migration
(an engine change moves the worker digest and existing state directories are refused, as after
C-16 [S3 5.2]).

### 3.3 D-1a: the same API without an engine change

The in-vat client mints, for a data import, a frozen methodless `Far('DataHandle', {})` kept in a
bootstrap `Map(position -> WeakRef)` and `WeakMap(handle -> position)`, with a
`FinalizationRegistry` whose callback queues `(position, mentions)` for the crank-end
`op:gc-exports`. Cost per handle: an instance, its WeakMap entry, a WeakRef and a registry cell, so
several slots instead of one, and death runs guest-code finalization (bounded by
`FINALIZATION_ROUNDS = 64` and the crank budget) [S3 8.1]. No digest, fingerprint or golden moves.
About 150-250 lines in the in-vat client. This is the step to take before D-1/D-2.

---

## 4. Determinism, restart and collection

### 4.1 What is journaled

Only frames toward the worker, as today. With D-1/D-3 a data reference costs its envelope in the
frame (the stand-in's reference is about 50 bytes of Syrup; [T2]'s envelope is about 230 bytes per hop
with length and hash [T2, J-9817]). The bytes are never journaled, unless the vat reads them (4.5).

### 4.2 What a mint and a forward do

`import(position)` runs inside the decode of a journaled frame, so on replay it runs again with
the same position and returns a handle at the same point of the heap's history: deterministic.
`positionOf` reads the side table. Neither reads the host.

### 4.3 Metering and the key table

`import` charges a fixed amount (one object allocation plus a side row), `positionOf` and
`takeReleased` a fixed amount plus one unit per released entry. Nothing depends on length, I/O,
cache state or time, so a crank that fits under one budget fits on replay [S3 5.3]. The handle has
no named properties and the envelope has fixed keys (`length`, `ref`, `sha256`, `sealed`), all
already interned after the first envelope: no name per datum (C-6).

### 4.4 Snapshot format

One side-table row per live handle, persisted in `side_tables` with the other ledger rows; the
reverse index is rebuilt at resume. The handle's instance slot is an ordinary slot. Snapshots do
not grow with the referenced data, only with the number of handles.

### 4.5 A read, and replay

`E(reader).read(handle, 0, 1024)` answers a ByteArray in a frame; that frame is journaled like any
other, so replay delivers the same bytes without asking anyone. Measured: 53 ms median, journal
+1,632 bytes per 1,024-byte read [measured, J-9837]; [T2] measured ByteArray answers passable into
Ironhorse vats (J-9818). A synchronous host read (an external buffer) would need: immutable,
content-addressed data; the hash checked on every fault; a missing or mismatching referent treated
as an uncommitted host failure (the `PageSource`/`catch_store_fault` precedent), never a guest
error; metering by length only; and the bytes kept available while any retained image or journal
suffix can reach the read [S3 5.4, 8.2]. Not recommended now.

### 4.6 Restart

The handle's position is the hub's position toward this vat session, which the hub persists in its
c-lists; the row's origin is `hub:data`, which is never retired [T2]. So a stored handle works after
a supervisor restart, a worker wake and an adapter restart, with no re-resolution crank.
Measured with the stand-in: after a graceful restart the stored 1 MiB reference relayed V1 -> V2 ->
B with the right digest (182 ms); the blob-like baseline, an adapter-held object, failed after the
same restart ("unknown blob", the adapter's object did not survive its session) [measured,
J-9840]. After a SIGKILL during a 64 MiB pass: the in-flight call broke ("Session disconnected"),
B received the reference 0 times before the kill and 0 times after the restart, then exactly once
for one new pass; V2 still held the reference [measured, J-9841]. Nothing was delivered twice; the
transport's existing exactly-once machinery (journal before duct, hub watermark) is unchanged by
the filter, which runs before the journal append and on regenerated outbound frames alike.

### 4.7 Collection, and when the bytes may be freed

The chain is: collector (D-2) -> crank-end `op:gc-exports` from the vat -> hub refcount -> T2
`maybeReleaseRef` -> file unlinked after the release commits. Two timing rules:

1. **A delayed release is always safe** [S3 8.1, code comment in `durable-worker-transport.js`]. A
   handle dead in the live incarnation is still alive in the last image and the unsnapshotted
   journal. That is harmless here because the vat's `op:gc-exports` is an outbound frame: on replay
   it is regenerated with the same sequence number and dropped by the hub's watermark, and the hub
   acts on it only once, after it committed. The hub, not the worker, owns the bytes, so no image
   can re-mint a handle whose row the hub has released: a replayed import of a released position is
   impossible because the hub will never send that position again (positions are not reused within
   a session epoch) [inferred from `hub.js` `provideFacingPosition`; not tested].
2. **GC lag.** The sweep runs on the allocation schedule, so a dead handle is reported up to the
   schedule's interval later (C-7, CC-022: up to 32 cranks), and never while the vat sleeps (C-17).
   Bytes held only by a sleeping vat stay. Revocation and secret deletion therefore stay explicit
   store operations ([S4] 4.9); GC only reclaims.

The stand-in has no death signal at all: dropping every reference and restarting left all 1,008
segment files in place [measured, J-9842].

---

## 5. Security argument

**Who can dereference.** Only a holder of a reader (or, for sealed data, the unsealer) power,
presenting the handle; the hub amplifies by the argument's row identity [T2]. Vats are given no
reader unless a designer means them to read (the exec vat pattern, D-11).

**Why a vat that holds a handle cannot read it.**

1. The handle exposes nothing: no own properties, a frozen intrinsic prototype with no methods, and
   `E()` on it is refused locally. Its position lives in an engine side table, reachable only
   through a native the bootstrap captured and deleted from the global object before guest code
   ran.
2. Bytes never enter the vat's frames, journal, heap or snapshot unless it reads through a reader,
   so there is nothing to find by reflection, by a heap walk or by reading its own journal.
   Measured with the stand-in: a 64-byte and a 1 MiB secret held in V1's durable state and used by
   the provider: 0 hits of the value (raw, base64 at three alignments, hex in both cases) in 119
   files of the state directory while live and in 111 after the snapshot (journals, snapshots,
   hub log and image); the negative control, the same kind of value passed inline, was found in
   the vat's journal while live and in its snapshot afterwards [measured, J-9831].
3. A vat cannot forge a handle: the only constructor is the captured `import`, called only by the
   decoder on a frame it received. Even if guest code learned a position number it could do
   nothing with it: the hub resolves positions through the vat session's own c-list. The stand-in,
   whose integer *is* guest-visible, enforces the same rule in the transport: V8 built a Tagged
   value with the number of a datum it never received; the transport replaced it with a refused tag
   and B received `refused:thix-dataref-refused`, while V1, which holds the datum, passed it
   correctly [measured, J-9832].
4. Length and hash, where present, come from the envelope the hub checked [T2 CC-085]; sealed data
   carries neither (2.3), so a secret's handle is not a guess oracle ([S4] 4.4).

**What the engine layer does not protect.** A frame toward a worker that carries bytes has
already passed the hub: the stand-in's transport ingest kept a 1 MiB secret out of the vat's
journal and snapshot, but the hub image held it as hex [measured, J-9834]. Only hub-side ingest
(D-3 in the hub) or producers that never put bytes in frames ([T2] `put`/`locate`) keep secrets out
of the hub.

---

## 6. What "zero copy" honestly means here

Counted from the code path for N payload bytes of the bulk-forward case (A -> V1 -> V2 -> B).

| path | copies of the N bytes, and where | in a vat frame, journal, heap or snapshot | in the hub state |
|---|---|---|---|
| stand-in data reference (measured) | 1: A writes the store file (`write`: one `writeSync` into the page cache, fsync). 1: B reads it (`readFileSync`). Total **2**, both outside the object system | 0 bytes; about 50 bytes of reference per frame | 0 |
| [T2] `put` + `locate` (adapter writes through the hub, reader reads the file) | about 2 in the producer (Syrup writer), about 4 in IPC (base64, JSON), 3 in the hub (decode copy, two encode copies), 1 store write; then 1 read by B | 0 | 0 (the hub serves `hub:data` locally, no queue) [T2] |
| D-3 transport ingest (stand-in, measured) | producer 2 + IPC about 4 + hub 3 + **hex into the hub queue (durable until compaction)** + hub-to-transport + 1 store write + 1 read | 0 | **yes** (C-1), measured 2.2 MB of hub growth for 1 MiB |
| D-3 hub ingest (proposed) | producer 2 + IPC about 4 + hub decode 1 + 1 store write + 1 read | 0 | 0 |
| inline into a vat (baseline a) | producer 2 + IPC 4 + hub 3 per hop + hex per hop + journal base64 + engine request JSON-in-JSON + compiled literal + two UTF-16 strings + JSON.parse + base64 decode + harden per byte + Syrup copy [S2 3.5, S3 2.1] | yes, every hop | yes, every hop |

So "zero copy" means: **zero copies through vats, journals, snapshots and (with hub ingest or
direct writes) the hub**; the bytes are written once into a store and read once by each consumer.
They are not zero-copy in the operating-system sense (there is a kernel copy into and out of the
page cache, and the stand-in reads whole files into memory).

---

## 7. Measurements

### 7.1 Method

`H/test/spikes/dataref-engine/bench.mjs`, commit `f2fa1a877b`, under
`node scripts/run-lock.mjs --exclusive` with `THIX_AGENT=T3`, one run of 132 s (2026-11-18
03:51-03:53 UTC); two earlier runs gave the same shape (scratch, not cited). Release worker
`367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, allocation GC policy, hub log store. The
machine's load average was 7-10 throughout (other work outside the slot lock), so absolute times
are inflated; ratios and byte counts are not affected. The supervisor is the harness's
`serve.mjs` child with `frame-filter.mjs` preloaded. Nine holder vats (`v0`..`v8`), each a
`Map`-in-the-heap program. **Stubs:** adapters A and B are two control-socket clients in the
benchmark process (two hub sessions; no Node IPC leg, no adapter child process); they write and read
the store directly (stand-ins for writer and reader powers); the blob-like baseline is an
A-exported methodless `Blob` object with an A-exported `Content.read(blob, offset, 20480)`, the
structural equivalent of the harness path (`AH/blobs.js`, `AH/content.js`) without the manager vat
and its minting. Frame bytes are counted by the filter on the worker duct (Syrup bytes, before
base64). Hub growth is the size change of the hub's files (log plus image), which compaction can
make negative; read it as an order of magnitude. Images are taken after a graceful restart; "slots"
is the slot-page count times 256 (capacity, an upper bound on live slots).

### 7.2 Table against the shared benchmark and both baselines

Per pass = A has already handed the datum to V1; one pass is V1 -> V2 -> B, B reads all of it and
answers a SHA-256, compared with the expected digest (all `ok: true` unless stated).

| case | path | wall per pass, median (ms) | vat frame bytes per pass (V1 in/out, V2 in/out) | journal growth per pass (V1, V2) | hub growth | heap and snapshot |
|---|---|---|---|---|---|---|
| (2) 1 KiB | data reference | 83.3 (82-101) | 198 / 250, 250 / 233 | 368, 396 | noise (+151 KB for 5 passes, commits) | no slot page added |
| (2) 1 MiB | data reference | 83.0 (78-183) | 233 / 317, 278 / 297 | 464, 472 | +177 KB for 5 passes | no slot page added |
| (2) 64 MiB | data reference | 179.8 (148-385; B's 64 MiB read and hash included) | 203 / 374, 310 / 236 | 401, 572 | +69 KB for 3 passes | no slot page added |
| (2) 1 KiB | baseline (b), blob-like | 84.0 | 198 / 219, 226 / 202 | 361, 364 | +168 KB | |
| (2) 1 MiB | baseline (b), blob-like | 885.7 (52 pages through the hub) | 282 / 223, 281 / 265 | 605, 590 | +218 KB | |
| (2) 64 MiB | baseline (b), pass only | 85.9 | 148 / 272, 222 / 145 | 415, 495 | +90 KB | |
| (2) 64 MiB | baseline (b), full read | inferred 53.6 s (16.35 ms per 20 KiB page through the hub, 3,277 pages; 0.03 ms per page in process) | | | | |
| (2) 1 KiB | baseline (a), inline string | 107.2 | 220 / 1,277, 1,248 / 1,255 | 690, 1,762 | +135 KB | |
| (2) 1 MiB | baseline (a), inline string into a vat | **vat retired** after 4,510 ms ("the target session has been retired"; ping afterwards: retired) | | | | |
| (2) 64 MiB | baseline (a) | not attempted: above the 8 MiB control-socket frame [code `local-control.js`] and far above the 94 KB vat halt (C-5) | | | | |
| (2) 1 MiB | D-3 transport ingest of an inline string, then data reference | hand-over 1,053; pass 83.8 | hand-over: 1,048,658 raw, 124 after ingest | 496, 392 (hand-over included) | **+2.2 MB** (the string as hex in the hub image) | |
| (1) 64 B secret | data reference, held in V1, used by the provider | use 53.1 | | | | |
| (1) 1 MiB secret | same | use 47.0 | | | | |
| (1) search | 64 B and 1 MiB data-reference secrets | **0 hits** in 119 files live, 111 after snapshot | | | | |
| (1) search | negative control, 64 B inline | found: V7 journal (base64) live; V7 snapshot (raw) after | | | | |
| (1) search | 1 MiB secret by transport ingest | found only in `hub-image.json` (hex); 0 in journals and snapshots | | | | |
| (3) rare read, 1,024 bytes of the 1 MiB datum by V1 | reader call | 53.0 (51-171) | 1,177 in / 268 out | +1,632 per read | | the 1,024-character string is garbage after the crank (not kept) |
| (4) restart | graceful; stored reference relayed | 182 (pass) | | | | stop 3.0 s, serve 3.6 s |
| (4) restart | blob-like baseline after restart | fails: "unknown blob" | | | | |
| (4) SIGKILL | during a 64 MiB pass | in flight broke; takes 0 before, 0 after restart, 1 after a new pass; stored reference works | | | | serve 4.1 s |
| (5) death | drop every reference, restart | **not freed**: 1,008 segment files before and after | | | | |
| hold 1,000 | data references (Tagged, batches of 100) | 1,744 ms for 10 puts | | | +159 KB (commits only, no rows) | **+71,168 slots capacity, +975 KB snapshot** (V5) |
| hold 1,000 | blob-like presences | 2,751 ms | | | **+1,170 KB** (rows and c-list entries) | **+136,192 slots, +4,530 KB** (V6) |
| forgery | V8 forges a reference it never received | B got `refused:thix-dataref-refused`; V1's honest pass correct | V8 out: 1 reference refused | | | |

### 7.3 Reading

- **Size no longer matters on the vat path.** 1 KiB, 1 MiB and 64 MiB data references cost the same
  frames (200-370 bytes per vat per direction per pass) and the same journal growth (370-570 bytes
  per vat per pass). The 64 MiB pass is slower only because B reads and hashes 64 MiB.
- **Against baseline (b)**, a datum B must read moves from 52 hub round trips (1 MiB, 886 ms) or
  about 3,300 (64 MiB, 54 s inferred) to one local file read. Passing alone costs the same in both,
  as [S2] and [S4] predicted: a reference is a descriptor either way.
- **Against baseline (a)**, the 1 KiB inline pass is 29 % slower and journals 1.9-4.4x more; the 1 MiB
  inline value kills the vat.
- **Restart** is where the reference's origin matters: an adapter-origin object dies with its
  session (the reason for D-15), a store- or hub-origin reference does not.
- **Per held reference**, a presence costs about twice the slots and 4.6x the snapshot bytes of a
  small Tagged value, and grows the hub by about 1 KB per reference (both upper bounds, capacity
  measure). A native handle should be about one slot and a 12-16-byte side row [inferred, not
  built]. This is the only number in the table an engine change would improve.

### 7.4 Measured lines

Copied from the run (commit `f2fa1a877b`); `loadAvg`, `at` and the constant `spike` field dropped,
and frame counts of unrelated vats removed from `passFrames`. The first line carries the run's
identity.

```json
{"commit":"f2fa1a877b","workerSha256":"367e78ad1db3c096ff0d9d35c1cb3d1539ed14d8016471c296d9c2f8ceca2e25","slotCeiling":4000000,"gcPolicy":"allocation","hubStore":"log","metric":"setup","startMs":14012.2,"vats":9}
{"metric":"bulk.dataref","size":1024,"ok":true,"storeWriteMs":12,"holdMs":30.2,"passMs":83.3,"passMsAll":[100.5,82,82,83.3,83.7],"passes":5,"holdFrames":{"v1":{"in":126,"out":56,"inRaw":126,"frames":2,"stripped":0,"refused":0}},"passFrames":{"v1":{"in":990,"out":1250,"inRaw":990,"frames":20,"stripped":0,"refused":0},"v2":{"in":1250,"out":1165,"inRaw":1250,"frames":20,"stripped":0,"refused":0}},"journalGrowth":{"v1":1838,"v2":1980},"hubGrowth":150559}
{"metric":"bulk.blobLike","size":1024,"ok":true,"readAll":true,"passMs":84,"passMsAll":[86.6,89.3,83.9,84,82.9],"passFrames":{"v3":{"in":990,"out":1095,"frames":20},"v4":{"in":1130,"out":1010,"frames":20}},"journalGrowth":{"v3":1806,"v4":1820},"hubGrowth":167917}
{"metric":"bulk.dataref","size":1048576,"ok":true,"storeWriteMs":9.9,"holdMs":28.3,"passMs":83,"passMsAll":[182.9,178.2,78,83,83],"passes":5,"passFrames":{"v1":{"in":1164,"out":1584,"frames":37},"v2":{"in":1388,"out":1486,"frames":37}},"journalGrowth":{"v1":2322,"v2":2360},"hubGrowth":176963}
{"metric":"bulk.blobLike","size":1048576,"ok":true,"readAll":true,"passMs":885.7,"passMsAll":[821.7,885.7,834.1,911.3,1130.6],"passFrames":{"v3":{"in":1409,"out":1113,"frames":36},"v4":{"in":1403,"out":1326,"frames":42}},"journalGrowth":{"v3":3026,"v4":2952},"hubGrowth":217738}
{"metric":"bulk.dataref","size":67108864,"ok":true,"storeWriteMs":134.8,"holdMs":42.5,"passMs":179.8,"passMsAll":[179.8,148.4,384.8],"passes":3,"passFrames":{"v1":{"in":609,"out":1121,"frames":26},"v2":{"in":929,"out":708,"frames":19}},"journalGrowth":{"v1":1202,"v2":1716},"hubGrowth":69384}
{"metric":"bulk.blobLike.pageRate","size":67108864,"pageBytes":20480,"pageMsThroughHub":16.351,"localPageMs":0.03,"inferredFullReadS":53.6}
{"metric":"bulk.blobLike","size":67108864,"ok":true,"readAll":false,"passMs":85.9,"passMsAll":[200.4,85.9,74.1],"passFrames":{"v3":{"in":444,"out":815,"frames":24},"v4":{"in":666,"out":435,"frames":18}},"journalGrowth":{"v3":1244,"v4":1484},"hubGrowth":90403}
{"metric":"bulk.inline","size":1024,"ok":true,"passMs":107.2,"passMsAll":[107.2,108.4,89.2,91.7,276.3],"passFrames":{"v7":{"in":1099,"out":6385,"frames":32},"v8":{"in":6242,"out":6275,"frames":32}},"journalGrowth":{"v7":3450,"v8":8808},"hubGrowth":134761}
{"metric":"bulk.inline","size":1048576,"ok":false,"error":"ocapn hub: the target session has been retired","ms":4509.8,"afterPing":"ocapn hub: the target session has been retired"}
{"metric":"bulk.inlineIngest","size":1048576,"ok":true,"holdMs":1052.8,"kindInVat":"object:true","passMs":83.8,"passMsAll":[196.5,83.2,83.8,79.9,88.1],"holdFrames":{"v1":{"in":124,"out":56,"inRaw":1048658,"frames":2,"stripped":1048576,"refused":0}},"passFrames":{"v1":{"in":1248,"out":1311,"frames":29},"v2":{"in":1245,"out":1521,"frames":34}},"journalGrowth":{"v1":2480,"v2":1960},"hubGrowth":2199530}
{"metric":"rareRead.dataref","readBytes":1024,"ms":53,"msAll":[170.7,55.9,51.1,52,53],"frames":{"v1":{"in":5885,"out":1340,"frames":34}},"journalGrowthV1PerRead":1632}
{"metric":"secret.dataref","size":64,"useMs":53.1,"keyedDigestOk":true}
{"metric":"secret.dataref","size":1048576,"useMs":47,"keyedDigestOk":true}
{"metric":"secret.inlineControl","size":64,"keyedDigestOk":true}
{"metric":"secret.ingestInline","size":1048576,"holdMs":1025.9,"kindInVat":"object:true","frames":{"v8":{"in":405,"out":350,"inRaw":1048938,"frames":8,"stripped":1048576,"refused":0}},"keyedDigestOk":true}
{"metric":"security.forge","forgedAnswer":"refused:thix-dataref-refused","honestOk":true,"frames":{"v8":{"in":173,"out":188,"inRaw":173,"frames":4,"stripped":0,"refused":1},"v1":{"in":197,"out":236,"inRaw":197,"frames":4,"stripped":0,"refused":0}}}
{"metric":"secret.search.live","results":{"s64":{"files":119,"hits":{}},"s1m":{"files":119,"hits":{}},"inlineControl":{"files":119,"hits":{"workers/<v7>/journal.jsonl":["b64@0"]}},"ingest1m":{"files":119,"hits":{"hub-image.json":["hex"]}}}}
{"metric":"holdMany","n":1000,"dataref":{"ms":1743.6,"hubGrowth":158645},"blobLike":{"ms":2750.6,"hubGrowth":1170162}}
{"metric":"restart.graceful.held","stopMs":3071.7,"serveMs":3594.8,"images":{"v1":{"slots":173568,"snapshotBytes":14180352},"v2":{"slots":173568,"snapshotBytes":14188544},"v5":{"slots":244736,"snapshotBytes":15106048},"v6":{"slots":309760,"snapshotBytes":18661376},"v8":{"slots":180736,"snapshotBytes":14348288}},"imagesBefore":{"v1":{"slots":173568,"snapshotBytes":14131200},"v2":{"slots":173568,"snapshotBytes":14135296},"v5":{"slots":173568,"snapshotBytes":14131200},"v6":{"slots":173568,"snapshotBytes":14131200},"v8":{"slots":173568,"snapshotBytes":14131200}}}
{"metric":"secret.search.afterSnapshot","results":{"s64":{"files":111,"hits":{}},"s1m":{"files":111,"hits":{}},"inlineControl":{"files":111,"hits":{"heaps/snapshots/<v7 image>.sqlite":["raw"]}},"ingest1m":{"files":111,"hits":{"hub-image.json":["hex"]}}}}
{"metric":"restart.graceful.use","datarefOk":true,"ms":182,"blobLikeAfterRestart":{"ok":false,"error":"unknown blob"}}
{"metric":"restart.sigkill","killMs":11.1,"serveMs":4118.5,"inFlight":{"ok":false,"error":"Session disconnected"},"takesBeforeKillSeen":0,"takesAfterRestart":0,"takesAfterNewPass":1,"storedRefWorks":true,"v2HoldsK":true}
{"metric":"death","segFilesBefore":1008,"segFilesAfterDropAndRestart":1008,"restart":{"stopMs":3004.1,"serveMs":3868.1}}
{"metric":"total","ms":131783}
```

### 7.5 What the stand-in does not prove

- **Nothing about an engine-native handle's cost.** The vat held a Tagged value with a readable
  integer, not a D-1 handle; the per-handle slot and snapshot numbers are for that value (and for
  presences), and the D-1 numbers are inferences.
- **Opacity and unforgeability by construction.** The stand-in's integer is guest-visible; it gets
  unforgeability from a per-worker possession check in the transport, not from the engine.
  Adapters (the control clients) are not checked at all: any adapter can name any datum (stub).
- **Death.** A Tagged value has no identity and no finalization; nothing reports its death, and no
  byte was ever freed (J-9842). D-2 is not exercised.
- **The hub path of T2.** The stand-in kept bytes out of the hub only because the producer wrote the
  store directly; the hub never saw a data row. The end-to-end composition (envelope, hub row,
  engine handle) is designed (section 1, 2.3), not run. [T2]'s own benchmark measures the hub half.
- **Possession under a crash.** The filter records possession and writes ingested segments before
  the journal append; a crash between the two over-grants a reference the vat never received and
  orphans a segment (both harmless here; a production design keeps possession in the hub c-list).
- **Adapters as processes.** No Node IPC leg was exercised; adapter-to-hub costs of real adapter
  processes are not in these numbers.
- **The filter's own CPU cost** (a byte scan of every worker frame) was not timed separately; it is
  inside the pass times.

---

## 8. Costs that remain

1. **A crank per hop.** A pass of two vats costs about 80 ms of which none is size-dependent; that is
   crank, hub commit and duct cost (architecture 0.1), the same for any descriptor.
2. **A hub row and c-list entries per holder** [T2, S2 4.2], rewritten on every commit until C-2's
   per-row dirty tracking is done. The engine design cannot remove these.
3. **In-vat cost per held reference**: today a presence (about 136 slots, 4.5 KB snapshot, upper
   bound); with D-1, about one slot and a side row; with D-1a, several slots plus a WeakRef and a
   registry cell.
4. **GC lag** of up to the schedule interval, and none while a vat sleeps.
5. **The rare read** journals the bytes once and pays the inbound frame cost (C-5) until deliver-v2
   and the harden fix land.
6. **The producer's copy into the store**: once through the hub for a remote or IPC producer
   ([T2] `put`), or zero hub copies with a staged-file adoption (not built).

## 9. What it cannot do

- Let a vat read referenced bytes synchronously (by design; 4.5).
- Keep bytes out of the hub when a producer puts them inline in a frame, unless the hub ingests
  them (D-3 in the hub).
- Give mutable values under a stable reference: a data row is immutable; secrets with generations
  need the [T2]/M4 store's own versioning, and the engine is not involved.
- Free bytes held only by a sleeping vat, or revoke: revocation and deletion are explicit store
  operations.
- Help peers beyond this daemon: they see [T2]'s envelope and a presence.
- Change anything for existing state directories without a migration (the worker digest moves).

## 10. How the harness would adopt it

The engine part changes no harness interface; it changes what a held reference costs. Order:

1. **[T2] hub rows and envelope, plus D-3 hub ingest** (hub track). Replaces: manager-minted `Blob`
   handles and `sink.mintBlobs`/`resolveBlobs` (D-15), the per-incarnation `known` maps in
   `AH/blobs.js`, the 17.3 owner ACL (the reader is the authority), `Content` (a reader power), and
   the `Secret`/`ReadGrant` key amplification through the manager vat (sealed rows with the
   unsealer). `StagedText` keeps its preview (a deliberate copy) and holds the envelope instead of
   a `Blob`.
2. **deliver-v2 and the C-5 harden fast path** (engine and worker, [S3] 10). Makes the rare read and
   the exec vat's source pages cheap; independent of references.
3. **D-1a in the in-vat client** (JavaScript). Data imports become methodless handles with
   bootstrap finalization; measure the slot cost against presences.
4. **Archive references kept as references.** With cheap holding (step 3) and C-2's per-row
   diffs, sealed records can keep handles instead of `{"$staged":{"key":"b<n>"}}` names ([S1] 3.3
   item 5), so delete and export follow references.
5. **D-1/D-2 engine-native handles**, only if step 4 makes vats hold more than about 10^4 references
   and step 3's numbers are the limit.

## 11. Risks and open questions

- **Envelope dependence.** D-1 needs the vat to know an import is data; that rests on [T2]'s
  envelope and on the sealed envelope proposed in 2.3. A data row arriving bare is a full presence.
- **Mention counting.** D-2's `mentions` must match what the hub counts as `mentionsIn` toward the
  vat; an engine-side counter and the in-vat client's existing import accounting must not both
  answer for the same position. Not checked against `ocapn/src/captp/finalize.js`.
- **Position reuse.** The safety argument of 4.7 assumes the hub never reuses an export position
  within a session epoch; not verified in `hub.js`.
- **Crank-end drain.** If the worker collects after the bootstrap takes the outbound queue, released
  positions leave one crank later; safe, but the drain point must be fixed in the replay contract
  like C-17's GC frame rule.
- **Golden and migration cost.** Every engine change refuses existing state directories; the
  harness's templates and the deployment must be rebuilt.
- **Interaction with `E()`.** Refusing eventual sends on a handle may surprise code that treats every
  remotable as callable; T2 gives data rows a `describe()` method answered by the hub. If that is
  wanted from vats, D-1 must route `E(handle).describe()` through the in-vat client (more code,
  a presence-like handler).
- **The stand-in's frame filter scans every worker frame in JavaScript**; acceptable for a spike,
  not as a production seam (CC-087 is not to be merged).

## 12. Work estimate for production quality

| item | estimate [inferred] |
|---|---|
| D-3 hub ingest (with T2's rows) | 3-5 days with tests |
| D-1a in the in-vat OCapN client, with finalization-driven `op:gc-exports` and a slot measurement | 3-5 days |
| sealed envelope (2.3) in the hub check and codecs | 1-2 days |
| deliver-v2 and C-5 (separate, [S3] 10) | 1-2 weeks |
| D-1/D-2 engine-native handle: side table, GC hook, natives, persistence, schema 7, boot fingerprint, golden re-pins, replay tests, worker and bootstrap drain | 2-3 weeks |
| migration of state directories and templates after the engine change | 2-4 days |

---

## Appendix: time and resources

- Benchmark runs (all under the slot lock, label `dataref-t3`): one exited at once (missing module),
  one failed after 69 s (a test bug), two complete runs of 284 s and 142 s of wall time (scratch),
  and the final exclusive run, 137 s of wall time, 132 s inside the script. The first attempt waited
  9 minutes for the lock behind another unit's exclusive run.
- No cargo build. No snapshot golden touched.
