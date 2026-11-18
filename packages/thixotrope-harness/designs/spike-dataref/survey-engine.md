# Spike dataref, survey S3: the Ironhorse engine and worker

Research spike, not product code. Question: can an Ironhorse vat hold, pass on, store and hand out
a reference to data whose bytes never enter its heap, frames, snapshot or journal, with reading as
the rare and dearer case? This survey covers the engine (`rust/engine`), the worker
(`rust/thixotrope-ironhorse-worker`), the boot files the worker evaluates, and the Node side of the
worker duct where it decides what the engine sees (`packages/thixotrope/src/ironhorse`,
`src/core/worker-peer*.js`, `src/core/durable-worker-transport.js`). It does not cover the hub or
OCapN protocol design (other surveys).

Legend for every claim:

- **[code]** read from the named file and function at the lane base `36b3035e92`.
- **[measured]** a number from `designs/m0-results.md` or `JOURNAL.md` (entry given). Nothing was
  measured for this survey; no cargo, no supervisor runs.
- **[inference]** my reasoning from the code; not executed.
- **[not checked]** a question I did not settle.

No web source was fetched for this survey. Where I compare with other systems I say "from memory".

Paths are relative to the repository root; `H` is `packages/thixotrope-harness`, `pkg` is
`packages/thixotrope`.

---

## 1. Findings in brief

1. **A delivery is JavaScript source text.** The adapter turns every inbound OCapN frame into
   base64, wraps it in a JSON envelope, embeds that JSON as a string literal in a one-line script
   `thixotropeDispatch("...")`, and sends the script over a newline-delimited JSON pipe. The worker
   compiles and runs the script. Every frame byte is therefore lexed, compiled into bytecode,
   copied into a UTF-16 string, JSON-parsed, base64-decoded, hardened and Syrup-decoded inside the
   vat [code, section 2]. By my count a frame byte becomes about 6.3 bytes of chunk allocation and
   1.3 bytes of bytecode, plus one descriptor object per byte (C-5), before the OCapN layer even
   looks at it [inference, 2.3].
2. **The worker has no binary channel, no shared memory, no file-descriptor passing and no host
   callables in use.** Stdin and stdout carry NDJSON; every value crossing is a JSON string
   [code, section 6]. The engine has a host-callable seam (`HostCallable`, `HostCallContext`) that
   the worker does not register, and that can return only strings, numbers and booleans today.
3. **The engine checkpoint is incremental, the host image is not.** `checkpoint_to_store` writes
   only dirty 256-slot pages and dirty 64 KiB chunk extents [code]. But the adapter's `snapshot`
   closes the worker, hashes the whole SQLite file and copies it; a wake hashes and copies it back
   [code, `pkg/src/ironhorse/ironhorse-engine.js` `snapshot`, `start`]. Bytes a vat holds cost on
   every sleep and every wake, about 3.3 bytes of image per stored character [measured, J-0006].
4. **Everything a vat receives is journaled verbatim until the next image.** The worker journal
   entry is the whole frame in base64 [code, `durable-worker-transport.js` `journalEntryOf`].
   Keeping bytes out of the heap does not keep them out of the journal unless they are kept out of
   the frame.
5. **Replay determinism is already strong and pins the collection schedule.** GC timing is a pure
   function of the image and the journal (C-7 policy), finalizer callbacks run at fixed points,
   and the runtime manifest refuses a changed schedule [code, worker `GcPolicy`,
   `ironhorse-runtime.js` `checkSavedManifest`]. So a handle-death report produced by the collector
   is deterministic across replay, which is what a host-side free needs.
6. **The opaque handle (candidate 1) needs no engine change to work.** A frozen, property-less
   object minted by the trusted bootstrap, branded by a bootstrap WeakMap and watched by a
   `FinalizationRegistry`, gives everything the owner asked for inside the vat: unreadable,
   unforgeable by guests, passable once marshal knows it, persists as a few slots and a number,
   death reported deterministically [inference, section 8.1]. An engine-native handle only lowers
   the per-handle slot cost and replaces finalization callbacks with a collector list. The zero-copy
   saving comes from the bytes never being sent to the worker, which is a protocol and hub decision,
   not an engine one.
7. **Host-backed bytes (candidate 2) are feasible only for immutable, content-addressed data**,
   because a replay must read the same bytes. The engine already has the shape needed (lazy
   `PageSource` faults that unwind as typed host faults) but every ArrayBuffer view path assumes a
   chunk offset; the change is large. A rare read can be done today, with no engine change, as an
   ordinary async call to the holder; the bytes then enter heap and journal once, which is what
   "reading is the rare case and may cost more" allows.
8. **Frame segments (candidate 3) and lazy decoding (candidate 4) do not reach the goal alone.**
   Segments carried to the worker still land in the journal and, if retained, in the image; lazy
   decoding happens after every copy listed in finding 1. Both reduce CPU, not storage.
9. **Independent of the handle question, the delivery path itself is the cheapest large win**: a
   binary delivery operation that hands the vat one `Uint8Array` built from the frame bytes would
   remove the lexer, the bytecode literal, two UTF-16 strings, the JSON parse and the base64 decode
   (section 10).

---

## 2. How a delivery frame becomes JavaScript values

### 2.1 Inbound, step by step

| # | where | file and function | what happens to the frame's N bytes | copy / decode / intern |
|---|---|---|---|---|
| 1 | supervisor, transport | `pkg/src/core/durable-worker-transport.js` `journalEntryOf` (about line 738), `appendJournal` | frame bytes encoded `encodeBase64(bytes)`; entry `{ b64, hubSequence?, gc? }` appended durably before delivery | copy to 4N/3 ASCII; durable write |
| 2 | supervisor, transport | same file, delivery of a crank (about lines 543-561) | `running.deliver(harden({ t: 'f', b64 }))` | object wrap |
| 3 | adapter | `pkg/src/ironhorse/ironhorse-engine.js` `dispatchSource` (line 434) | `` `thixotropeDispatch(${JSON.stringify(JSON.stringify(message))});` `` | two JSON encodings: the envelope, then a string literal of it |
| 4 | adapter | same file, `crank` (line 407) and `request` | `{ op: 'deliver', source, budget, drainBudget }` written as one JSON line to the child's stdin | third JSON encoding; pipe write |
| 5 | worker | `rust/thixotrope-ironhorse-worker/src/main.rs` `run` (line 782) | `stdin.lock().lines()`, `serde_json::from_str` into a `Value`; `parse_request` borrows `source` | Rust `String` line, then `serde_json` unescapes into a second `String` |
| 6 | worker | `main.rs` `run_source` (line 126) | `ironhorse_compile::compile_atoms_goal_with_meter(source, Goal::Script, ...)`, metered through `charge_compilation` | lexer and coder copy the literal into bytecode as CESU-8 (`XS_CODE_STRING_4` operand) |
| 7 | worker | `main.rs` `run_source`: `link_intrinsics` or `relink_crank`, then `m.run(&code)` | the bytecode is held as `top_level_code` (`rust/engine/ironhorse-vm/src/interp/code.rs`) | bytecode buffer retained while the crank runs |
| 8 | engine | `ironhorse-vm/src/interp/dispatch.rs` `exec_string` (about line 3169) | `cesu8_to_units` to `Vec<u16>`, `units_to_be16` to `Vec<u8>`, `self.chunks.alloc(...)`; `meter.tick_string(units)` | two transient Rust copies, then a chunk of 2 bytes per code unit plus a 4-byte header |
| 9 | vat, bootstrap | `pkg/src/core/worker-peer-xs.js` `dispatch` (line 105) | `JSON.parse(json)`: new object, keys `t` and `b64` (already interned), the base64 text as a new string | another chunk string of 2 bytes per base64 character |
| 10 | vat, bootstrap | same, `decodeBase64(message.b64)` | native `Uint8Array.fromBase64` since `b10254b252` (`ironhorse-vm/src/interp/natives/base64.rs` `from_base64`) | N-byte ArrayBuffer chunk |
| 11 | vat, OCapN pipe | `pkg/src/net/pipe-network.js` `deliver` (line 158) | `inbound.put(harden({ done: false, value: bytes }))` | C-5: `harden` takes `getOwnPropertyDescriptors` of the `Uint8Array`, one descriptor object per byte [measured, J-0190] |
| 12 | vat, OCapN | `packages/ocapn/src/syrup/decode.js` (atoms, about lines 110-150) | strings through the native UTF-8 decoder; bytestrings `frozenBytes(valueBytes)`; integers via `textDecoder` and `BigInt` | each bytestring copied again into an emulated immutable ArrayBuffer; each string a new UTF-16 chunk; record labels and keys interned as property names (C-6) |
| 13 | vat, OCapN and marshal | `@endo/ocapn` captp and pass-style | passable values hardened, presences created or looked up | per value |

Intermediate strings and the bytecode die at the next collection; whether they reach a snapshot
depends on whether a collection runs before `close` (it does under the allocation policy,
`GcSchedule::before_close`) [code].

### 2.2 Outbound

`thixotropeSend` (installed by `pkg/scripts/bundle-ironhorse-worker.mjs` into `boot.js`) receives
`JSON.stringify({ t: 'f', b64: encodeBase64(frame) })` from `worker-peer-xs.js` and does
`outbound.push(JSON.parse(json))` [code]. At the end of the crank the worker runs the source
`JSON.stringify(thixotropeTakeOutbound())` (`main.rs` `crank_deliver`), returns the engine's string
rendering as `result`, which `reply` serializes into one JSON line; the adapter does
`JSON.parse(reply.result)` and the transport `decodeBase64(envelope.b64)` [code]. So an outbound
frame byte is Syrup-encoded, base64-encoded, stringified, parsed, stringified again inside the vat,
rendered to UTF-8, JSON-escaped, parsed twice and base64-decoded. Outbound was measured cheap
relative to inbound (8 x 16 KiB in one crank 191-202 ms) [measured, m0 section 1, J-0142].

### 2.3 What one inbound frame byte costs in the heap [inference]

From the table: base64 text in the bytecode literal (4/3 byte in `top_level_code`, an
`Rc<[u8]>` outside the chunk arena, plus transient Rust copies), the literal string chunk (8/3
bytes), the `JSON.parse` copy (8/3), the `Uint8Array` (1), a Syrup bytestring copy when the byte is
inside a bytestring (1): about 6.3 chunk bytes and 1.3 bytecode bytes per frame byte, plus C-5's
descriptor object per byte (an instance slot and its property slots, 24 bytes each
resident). All of it is garbage after the crank except what the vat keeps, but a crank must fit all
of it under the ceilings, because the engine never collects inside a crank (C-21). This is
consistent with the measured halt of one inbound message above about 94 KB at a 50 M budget
(`HeapExhausted`) and the measured 10 us per byte [measured, m0 section 2 item 4]. I did not
separate the shares; J-0190 attributes the dominant part to C-5.

### 2.4 Interning

Property keys are 16-bit ids in one monotone table per machine; about 57,000 remain after boot and
none is ever released (`ARCHITECTURE.md` "Halts, resource admission and determinism"; m0
`vatKeyNames`) [code, measured]. String values are not interned; each string is its own chunk.
Envelope keys are fixed, so the duct itself consumes no names; Syrup record labels and
`copyRecord` keys do (C-6). A reference mechanism whose descriptor has fixed keys consumes no
names per datum.

---

## 3. How values are stored in the heap

### 3.1 Slots and chunks [code, `ironhorse-vm/src/value.rs`]

| store | unit | identity | notes |
|---|---|---|---|
| slot arena (`SlotArena`) | `Slot { next: SlotIndex, id: u16, flag: u8, kind: Kind, value: Payload }`, 24 bytes resident on 64-bit | `SlotIndex(u32)`; `u32::MAX` null | objects are an `Instance` slot plus one `Property` slot per named own property in a linked list; ceiling `slotCeiling` (harness 4,000,000) |
| chunk arena (`ChunkArena`) | `[u32 length][payload]` blocks in one byte vector | `ChunkOffset(u32)`; 4 GiB address limit | strings (UTF-16 big-endian code units), BigInt digits, ArrayBuffer bytes, bytecode; ceiling `chunkCeiling` (256 MiB, at most 512 MiB per J-0006) |
| side tables (`Interp` fields, `interp/state.rs`) | `Tracked<HashMap<SlotIndex, ...>>` per internal kind | keyed by the owning instance slot | arrays, collections, ArrayBuffers, typed arrays, dates, promises, weak refs, finalization registries and so on; growable ones are charged against the chunk ceiling by capacity class (`side_storage.rs`) |

`Kind` has 15 values (`Undefined` .. `BigInt`); there is no external, foreign or host kind
[code, `value.rs` `Kind`, line 459]. Integrity is by index validation, not by pointers; the
snapshot codec encodes fields explicitly (`ironhorse-snapshot/src/slot_codec.rs`).

### 3.2 Strings

A string value is `Kind::String` with `Payload::String(ChunkOffset)`; its chunk holds UTF-16BE code
units [code]. Cost: one slot wherever the value is stored, plus `4 + 2 x units` chunk bytes per
distinct allocation, plus metering `string_chunk_cost(units)` (`meter.rs` `tick_string`). ASCII
text therefore costs twice its UTF-8 size in the heap; the measured snapshot growth is about 3.3
bytes per character [measured, J-0006].

### 3.3 ArrayBuffers

`ArrayBufferData { data: ChunkOffset, length: u32, max_length: Option<u32> }` in the
`array_buffers` side table, keyed by the buffer's instance slot; the bytes are one chunk;
`detached_buffers` and `shared_buffers` are separate sets [code, `ironhorse-vm/src/interp.rs` line
992, `interp/state.rs` lines 1977-2016]. Views (`typed_arrays`, `data_views`) are their own side
tables pointing at the buffer slot. A resize allocates a new chunk; a detach keeps the chunk with
length 0. Every element read or write goes through the chunk arena
(`interp/natives/buffer.rs`, 2,520 lines) [code].

### 3.4 Immutable ArrayBuffers

The engine has no native immutable ArrayBuffer (`transferToImmutable` and `sliceToImmutable` do not
occur in `ironhorse-vm/src`) [code, grep]. `boot.js` carries `@endo/immutable-arraybuffer`'s shim:
an emulated immutable buffer is an ordinary object with `__proto__: ArrayBuffer.prototype` and an
own `Symbol.toStringTag`, mapped by a module WeakMap `buffers` to a genuine ArrayBuffer that holds
the bytes [code, `pkg/dist-ironhorse/boot.js` about lines 3200-3465, `makeImmutableArrayBufferInternal`].
Cost of one: the bytes' chunk, the genuine buffer's slot and side-table row, the wrapper instance
and its tag property, and two WeakMap entries (`buffers`, `reverseBuffers`). `sliceToImmutable`
copies. Syrup's `frozenBytes` makes one per bytestring.

### 3.5 What persistence charges for each, in short

| value | slots | chunk bytes | side rows | names |
|---|---|---|---|---|
| string of n UTF-16 units | 1 per holder | 4 + 2n | 0 | 0 |
| ArrayBuffer of n bytes | 1 + properties | 4 + n | 1 | 0 |
| emulated immutable of n bytes | about 3 + the genuine buffer | 4 + n | 1 + 2 WeakMap entries | 0 |
| record with k fixed keys | 1 + k | per value | 0 | 0 new |
| record with k data-dependent keys | 1 + k | per value | 0 | up to k, forever |

[code for the representation; the per-row byte widths of side tables are in `side_storage.rs`.]

---

## 4. Snapshots

### 4.1 The engine checkpoint [code, `ironhorse-snapshot/src/machine.rs` `checkpoint_to_store_core`, line 1046]

- Gate: `is_quiescent()`, no pending unpersistable row, epoch and lineage token equal to the
  store's.
- Ships only `slots().dirty_pages()` (256 slots per page, `SLOTS_PER_PAGE`), encoded per slot, and
  `chunks().dirty_extents()` (64 KiB per extent, `CHUNK_EXTENT_BYTES`), copied by `extent_bytes`.
  Small state goes by section, and a section is written only when its digest changed. Free-list
  segments from the low-water mark. One `store.commit(&batch)`.
- `Interp::collect_garbage` (`interp/gc.rs` line 110) marks every small section dirty
  (`snapshot_dirt.mark_all()`), and chunk reclamation is `compact_local` (`gc.rs` line 233), which
  packs within an extent only, so a collection dirties the extents it touches rather than every
  extent after the first hole.
- The SQLite store (`rust/endo/ironhorse-store-sqlite/src/lib.rs`, schema near line 404) has
  tables `slot_pages`, `chunk_exts`, `small_state`/`small_sections`, `side_tables (name, key,
  bytes)`, `free_segs`, `page_edges`, `edge_pairs`, `meta`.

So inside one incarnation a checkpoint is O(dirty), not O(heap), and a retained large string
costs its extents once, when written.

### 4.2 The host image [code, `pkg/src/ironhorse/ironhorse-engine.js`]

- The worker checkpoints only at `close` (`main.rs` `close_heap`; the comment at the end of `run`
  explains why not per crank).
- `snapshot` = `close()` (worker exits after the checkpoint and WAL fold), `hashFile(heap)`,
  `copyFile` to a temporary, `syncPath`, `rename` to `images/<sha>`, `launch()` again (line 466).
- `start` with a snapshot = `hashFile(image)`, compare, `copyFile(image, heap)` (line 188).
- The worker then resumes eagerly: `open_heap` calls `resume_from_store` (reads and decodes every
  page and extent), not `resume_from_store_lazy` [code, `main.rs` line 708].

Consequence: every sleep and every wake costs a full-file hash and copy, and a wake decodes the whole
heap. Measured: images of 13.7 MB for a provisioned template (J-0181); snapshot operations
117-153 ms in perf runs (J-0145, J-0193); wake 46-63 ms on small vats; 20 M characters of strings
added 84.5 MB of snapshot and roughly doubled the state directory while running, with ping latency
almost unchanged (64.3 -> 66.1 ms) [measured, J-0006]. Bytes in the heap are cheap per crank and
expensive per sleep.

### 4.3 Could a region be excluded or file-backed?

- **Excluded from the chunk arena:** no mechanism exists. Everything a chunk offset names is in the
  arena and is written when dirty. Excluding bytes means not putting them in chunks at all, which
  needs a backing other than `ChunkOffset` (candidate 2).
- **Backed by a file:** the arena already has a lazily backed form, `ChunkBytes::Lazy` with a
  `PageSource` that faults an extent in on first touch, and faults that fail unwind as typed store
  faults which the persistent machine reports as host errors (`value.rs` `PageSource`, near line
  190; `machine.rs` `resume_from_store_lazy`, `catch_store_fault`) [code]. That is the right
  precedent for a host-backed region: faults are invisible to the guest and their failure is a
  host failure. But the lazy form backs the whole arena from the heap store, it is not a
  per-object external backing, and the worker does not use it.
- **Kept out of the image file:** only by keeping the bytes outside the SQLite file. A side table
  row that names an external content hash would be a few dozen bytes in `side_tables` [inference].

---

## 5. The journal and what replay requires

### 5.1 What is recorded [code, `pkg/src/core/durable-worker-transport.js`]

- Host-to-worker frames are journaled before they reach the duct, as `{ b64, hubSequence?, gc? }`
  (typedef `JournalEntry`, line 35). The journal is truncated when a snapshot commits.
- Outbound frames are not journaled by the transport; replay regenerates them and the transport
  re-emits them under their original sequence numbers.
- Crank boundaries are `journalCranks(entries, base)`, a pure function of the entries: a run of GC
  frames joins the next ordinary frame, or forms a crank alone at `GC_FRAMES_PER_CRANK` (64). C-17
  made this part of the replay contract.

### 5.2 What replay depends on [code]

- The same worker binary and bootstrap files: `acquireIronhorseRuntime` pins their SHA-256 in
  `runtime.json` and copies them to a private directory; a heap's signature includes the profile
  digest (`ironhorse-runtime.js`).
- The same collection schedule: `gcPolicy`, `gcSlotAllowance`, `gcChunkAllowance`,
  `gcCrankInterval` may not change (`checkSavedManifest`). The worker's `GcSchedule::due` reads
  only slot and chunk growth and the crank count, never time or memory pressure (comment on
  `GcPolicy` in `main.rs`).
- Heap ceilings may only rise.
- The same meter release (`ironhorse-meter-9`) and the same boot fingerprint (`ARCHITECTURE.md`).
- A halted crank is fatal and never checkpointed; `HostAllocationFailed` is a host failure the host
  must re-drive, not record (`crank_halted`).

### 5.3 What a vat may observe [code, partly]

The vat sees only the frames it is dispatched and the results of its own computation. No clock
or entropy source is present in the engine natives I searched (`getRandomValues` and `Math.random`
do not occur in `ironhorse-vm/src`; the SES whitelist in `boot.js` is the "without Math.random"
profile); `worker-peer-xs.js` reads `globalThis.crypto` for its `randomBytes` power, which I did
not trace further [not checked: whether that path is reachable on Ironhorse]. Metering is a
consensus value: a crank that fits under one budget must fit on replay, so any new operation's
charge must depend only on vat-visible inputs (`side_storage.rs` states the same rule for side
storage).

### 5.4 Consequences for any data reference

- If the vat can read the referenced bytes synchronously, replay must produce the same bytes:
  the referent must be immutable and named by content (hash), and must stay available while any
  retained image or unsnapshotted journal suffix can reach the read.
- If the vat can observe a handle's metadata (length, a content hash, a media type), that metadata
  must be in the heap or in the frame that minted it, never fetched live.
- Absence of the referent at read time cannot be a guest-visible outcome (it would differ between
  live and replay); it must be a host failure that leaves the crank uncommitted, like a store fault.
- A handle-death report is deterministic only if it comes from the collector at the points the
  schedule fixes (sweep, then `notify_finalizations`), which is how OCapN import collection already
  works.

---

## 6. How the worker talks to the supervisor [code]

| channel | carrier | content |
|---|---|---|
| ownership helper (`--lock-state`) | inherited fd 1 is the supervisor's lock file (flock); stdin `prepare`; stderr JSON lines `locked`, `ready` | kernel leases only |
| worker process | argv: heap path, profile digest, lease path, limits JSON, boot files | |
| requests | stdin, one JSON object per line: `eval` (`source`, `budget`), `deliver` (`source`, `budget`, `drainBudget`, `timing`), `close` | JavaScript source text |
| replies | stdout, one JSON object per line: `ready` with `features: ["deliver-v1"]`, `result` (string, optional `timing`), `error`, `fatal` | the engine's string rendering of the result |
| heap | the worker's own SQLite file; the adapter copies it as the image after a successful `close` | |

There is no shared memory, no second pipe, no binary framing, and no file-descriptor passing.
The engine's host-call seam (`Machine::register_host_callable`, `Machine::host_function`,
`ironhorse-vm/src/interp/host.rs`) is not used by the worker. `HostCallContext` offers
`argument`, `receiver`, `capture`, `integer`, `number`, `boolean`, `string_units`, `string`,
`charge` and `call`; it cannot create objects or byte arrays, and persisted host functions require
an explicit `MachineRestorePolicy::host_callables` entry on restore [code]. A host function would
therefore need both a worker change (register and reattach it) and an API extension to carry bytes.

---

## 7. The measured baseline and where each cost sits

| id | cost (measured) | where it sits in the path | status |
|---|---|---|---|
| C-5 | `harden` of each inbound frame allocates a descriptor object per byte; about 10 us per byte; one message above about 94 KB halts at 50 M; 24 KiB inbound 312 ms median | step 11 (vat, JS) | open |
| C-6 | about 57,000 names per vat, never released; exhaustion is a catchable `RangeError` | step 12 (Syrup record keys, `copyRecord` keys) | open; harness rule forbids data-dependent keys |
| C-7 | per-delivery engine cost; a collection marks the whole live heap, so per-turn time grows with what the vat keeps (0.75 -> 2.71 s per turn from 300 to 4,000 turns, J-9388) | worker `GcSchedule`, engine `collect_full` | closed per crank, open for O(live) |
| C-16 | an engine fault in element attributes (`GET_LOCAL` carried binding flags) | engine | closed; relevant as precedent: an engine fix changed the worker digest and old state directories are refused |
| C-17 | GC frames cost a full crank each; idle vats woken | transport crank boundaries | closed; boundary rule is part of replay |
| C-21 | the slot ceiling bounds live heap plus everything one crank allocates | engine (no in-crank collection) | open |
| J-0006 | 3.3 snapshot bytes per stored character; snapshot and state directory are the limit, not crank latency | host image copy, section 4.2 | design rule: large text in blobs |

---

## 8. Candidate mechanisms

### 8.1 Candidate 1: an opaque host handle value

**Shape.** A heap value that names a host-side resource by a small integer, cannot be read by
JavaScript, survives a snapshot as the integer plus a host table entry, and can be put in an
outbound message as a reference.

**Two implementations.**

| | 1a: bootstrap object (no engine change) | 1b: engine-native handle |
|---|---|---|
| representation | frozen object with null or shared frozen prototype, no own properties; bootstrap `WeakMap(handle -> id)`; `FinalizationRegistry` with `id` as held value | ordinary `Instance` slot branded by a new side table `host_handles: HashMap<SlotIndex, HostHandleRow>`, as `dates` or `array_buffers` are |
| minting | trusted bootstrap function closed over in `worker-peer-xs.js`, never on a guest global (the pattern `thixotropeDispatch` and the deleted `Uint8Array.decodeUtf8` already use) | a native static captured and deleted by the bootstrap before guests run, as the UTF-8 statics are (`codec-polyfill`, `1d44da02d0`) |
| vat API | none for guests: identity (`===`), use as a WeakMap key, pass in messages; the OCapN layer asks the bootstrap `idOf(handle)` when encoding and `handleOf(id)` when decoding | same |
| persistence | the object, its WeakMap entry and its FR cell: about 3-6 slots and a few side-table bytes [inference] | one slot and one side-table row (id and optional length or hash), new ledger row in `ironhorse-snapshot/src/sidetable.rs` (`Coverage::Serialized`) and codec in `interp/persist.rs` |
| death report | `FinalizationRegistry` callback after the sweep, inside `sweep_and_notify`'s rounds; the bootstrap queues `dead(id)` into the outbox, which leaves with that crank's outbound | the sweep's `swept` hook (`ironhorse-vm/src/gc.rs` `GcHooks::swept`, `interp/gc_tables.rs`) appends ids to a dead list; the worker returns it in the reply (for example `{ op: 'result', ..., released: [...] }`) without running guest code |
| determinism | FR callbacks already run at schedule-fixed points (C-7 comment, `sweep_and_notify`) | the sweep is at schedule-fixed points; the list is a pure function of image plus journal |
| metering | ordinary object allocation | a fixed charge per mint; nothing per byte |
| key space | none (no named properties) | none |
| snapshot goldens | unchanged | boot fingerprint moves if a native static is added to `INTRINSIC_KEY_ORDER` (as `1d44da02d0` did; re-pinned in `0a4bdb3826`); `ROW_SCHEMA_VERSION` (now 6) and the side-table ledger change; worker digest changes, so existing state directories are refused (as after C-16) |
| size of change | bootstrap: tens of lines; OCapN and marshal: a descriptor (other surveys) | engine: a side table with GC hook, persist codec, ledger row, brand check, tests (my estimate 500-1,500 lines with tests) [inference]; worker: reply field; bootstrap and OCapN as in 1a |

**What it saves.** Measured against today's "vat holds a Blob presence" design (D-15, an OCapN
import of an object exported elsewhere):

- 1a and 1b remove nothing per byte by themselves: the saving is that the data never crosses into
  the worker at all. That requires the protocol to carry a handle id in place of the bytes and the
  holder (hub or adapter) to keep the bytes. Then the frame, the journal entry, the C-5 harden, the
  compile, the strings and the snapshot all carry only the id. That removes C-5 and the J-0006
  snapshot cost for the referenced data entirely, and C-6 for it (no keys).
- Against a Blob presence, a handle avoids the OCapN import machinery per datum: c-list entry in the
  vat's captp tables, a presence object, a WeakRef and FR registration for import collection, hub
  rows, and the GC frames of C-17/C-20 when it dies [inference: I did not count the slots of an
  import; worth one measurement].
- 1b over 1a saves a few slots per handle and replaces guest-code finalization (bounded by
  `FINALIZATION_ROUNDS = 64` and the crank budget) with a collector list. That matters only for
  vats holding very many handles.

**What it cannot remove.** C-7's O(live heap) marking (a handle is still a live object); the slot
ceiling share per handle (C-21); the cost of the rare read.

**What breaks or must be designed.**

- Reclamation timing: a handle dead in the live incarnation can be resurrected by a replay from an
  older image (the image holds it, the journal suffix re-mints it). The holder may free the
  referent only when (a) a death report has been committed into an image and (b) every older
  image and journal suffix that could re-mint or hold it has been released. This is the same
  "delay a release is always safe" rule the transport states for GC frames [code comment,
  `durable-worker-transport.js`].
- Unforgeability: ids must not be guessable by a guest that cannot already reach the handle. With
  1a and 1b guests never see the id; only trusted bootstrap code maps between handle and id. An id
  carried in a frame is authority only on that duct, like an OCapN import position.
- Passability: `@endo/pass-style` would classify a property-less frozen object as an empty
  `copyRecord`. The handle needs its own pass style (or to be a Remotable with a reserved tag) so
  that marshal never flattens it [inference; marshal is outside this survey].
- Equality across vats: if two vats receive the same datum, are their handles "the same"? Within a
  vat, identity is per id; across vats only the holder can say. Hash-named ids would make equality
  checkable but turn the id into a content name (no forgery risk if the holder checks the session).

### 8.2 Candidate 2: host-owned external buffers

**Shape.** An ArrayBuffer (or an immutable one) whose bytes live outside the heap, read lazily,
never written into the snapshot.

**Engine change.** `ArrayBufferData.data` becomes an enum `Chunk(ChunkOffset) | External { handle,
length }`; every view operation in `interp/natives/buffer.rs`, typed-array element access,
`DataView` get/set, `slice`, `transfer`, the base64 and UTF-8 natives, structured iteration and the
side-storage ledger must branch on it [code: all of these read `data` as a chunk offset]. The read
path faults the bytes from a host source into a transient buffer (or into a chunk on first touch,
as `ChunkBytes::Lazy` does for extents). The worker needs a content source (a read-only
content-addressed directory or a request to the adapter) and must treat a missing or mismatching
referent as a host failure that aborts the crank uncommitted (the `PageSource` and
`catch_store_fault` pattern).

**Determinism.** Only immutable content works: the buffer must be non-resizable, non-detachable and
non-writable, and the read must check the content hash, so replay sees the same bytes. Mutable
external buffers would make the heap image depend on host state: not feasible. Metering must charge
by length, not by I/O time or cache state.

**Snapshot.** The row persists `handle, length, hash`; bytes stay out of `chunk_exts`. If the
engine caches faulted bytes in chunks, the cache must be marked non-persistent (a new extent
class), or the snapshot copies them back in; the simplest rule is "never cache, re-read per
operation" [inference].

**GC.** As 1b: the side-table row's owner is swept, the id joins the dead list.

**What breaks.** Views over immutable buffers are not native today: immutability is emulated in JS
(section 3.4), so a native external buffer would also need a native immutable brand or must sit
behind the shim's wrapper. Every golden that covers ArrayBuffer costs and representations, the row
schema, the boot fingerprint if a constructor or static is added. The fuzz and differential
harnesses (`ironhorse-fuzz`, `stack-lanes`) compare with XS, which has no such buffer.

**Size.** The largest of the four: dozens of native call sites plus persistence and GC [inference].

**Saving.** Removes snapshot and chunk-ceiling cost for bytes a vat reads but does not modify,
and journal cost for bytes that would otherwise have been fetched into the vat. A read still
decodes into heap values (a `TextDecoder` result is a chunk string), so it does not help data the
vat reads as text and keeps.

**Cheaper alternative with the same semantics for the rare read.** An asynchronous read through
the holder (`E(holder).read(handle)` or a gateway method) needs no engine change; the bytes enter
the vat once, through one journaled frame, and are garbage afterwards. Under the owner's framing
("reading is the rare case and may cost more") this is adequate unless a vat must read the same
large datum repeatedly within its life [inference].

### 8.3 Candidate 3: pass-through frame segments

**Shape.** A delivery carries an out-of-band segment the worker never decodes; the vat can only
forward it.

**Where the bytes would live.** Today the worker receives only JavaScript source, so a segment
needs a new request field (for example `segments`, base64 in the NDJSON line, or length-prefixed
binary after it) [code, section 6]. The worker must keep each segment until the vat forwards it or
drops it, across sleeps; that means persisting it in the worker's SQLite file (a new table) or
outside. If it is in the SQLite file, the host image copy (section 4.2) carries it at every sleep and
wake. And the transport journals the whole frame (section 5.1), segment included, unless the
journal stores segments by reference.

**Vat API.** A segment would surface as a handle (candidate 1) whose referent is held by the worker
instead of the hub; forwarding writes the segment back into the outbound frame.

**Determinism.** Fine: the segment is part of the journaled input.

**GC.** As candidate 1; the worker frees a segment when the handle dies and no image holds it.

**Saving.** Removes the per-byte compile, string, JSON, base64, harden (C-5) and Syrup costs for
the segment, and the chunk-ceiling share. Does not remove the journal copy, the network hop
through the supervisor, or (if stored in the heap file) the image cost. So it is strictly weaker
than candidate 1 with the bytes kept by the holder, and it adds a second place that owns bytes
(the worker) to the reclamation protocol [inference].

**When it is worth it.** Only as a transport optimisation for bytes the vat will forward
promptly, within a crank or two, and only if candidate 1 is ruled out at the protocol level.

### 8.4 Candidate 4: lazily decoded arguments

**Shape.** The vat receives a placeholder; the bytes are decoded only if touched.

**Where it would live.** Decoding is JavaScript in the vat (`@endo/ocapn` Syrup decode, captp,
pass-style), so laziness is a JS change there, not an engine change; an engine-level lazy value
would need an exotic object (a Proxy-like kind) that every built-in honours, which the engine
avoids [inference].

**Saving.** Only Syrup decode, pass-style checks and the record-key interning (C-6) of untouched
arguments. Every copy of section 2.1 steps 1-11 has already happened, C-5 included, and the
journal holds the bytes. It does not meet the owner's goal.

**Determinism and snapshot.** Neutral if decoding is pure. A placeholder kept across a snapshot keeps
its raw bytes in the heap, the opposite of the goal.

---

## 9. Comparison

| | 1a bootstrap handle | 1b native handle | 2 external buffer | 3 frame segment | 4 lazy decode |
|---|---|---|---|---|---|
| bytes enter the worker | no | no | only when read | yes | yes |
| bytes in the journal | no (id only) | no | only when read through a frame | yes | yes |
| bytes in heap or image | no | no | no, if never cached | in worker store, maybe image | yes |
| removes C-5 for the datum | yes | yes | yes | yes | no |
| removes C-6 for the datum | yes | yes | yes | yes | partly |
| removes J-0006 image cost | yes | yes | yes | only if stored outside the image | no |
| removes O(live) GC share | no | no | no | no | no |
| engine change | none | medium | large | small (worker) | none |
| boot fingerprint / goldens | unchanged | moves | moves | unchanged | unchanged |
| replay rule needed | delayed free | delayed free | immutable, content-addressed, host failure on miss | delayed free | none |
| needs OCapN change | yes (descriptor) | yes | yes | yes | no |

---

## 10. Opportunities that do not depend on the handle decision

1. **A binary delivery operation (`deliver-v2`).** Pass the frame bytes beside the request and
   have the worker allocate one `Uint8Array` in the chunk arena and call the bootstrap's dispatch
   with it, instead of compiling `thixotropeDispatch("<json>")`. Removes steps 3-10 of section 2.1:
   the triple JSON encoding, the lexer and bytecode literal, two UTF-16 string copies, the JSON
   parse and the base64 decode: about 5.3 of the 6.3 chunk bytes and all 1.3 bytecode bytes per
   frame byte [inference]. It
   needs a way for the worker to construct a byte array and call a rooted function: today
   `HostCallContext` cannot build byte arrays, and `RootedValue` handles exist for host roots
   (`ARCHITECTURE.md`, "Execution and ownership"). The binary frame still crosses the pipe; length-
   prefixed binary after the JSON line avoids base64 on the pipe as well. A matching outbound path
   would drop the in-vat `JSON.stringify` of base64 strings. Replay is unaffected (the same bytes,
   the same dispatch); the worker digest changes, so it is offered as a feature flag the way
   `deliver-v1` is.
2. **C-5 itself.** The pipe hardens `{ done, value: bytes }`; the bytes are owned by the duct.
   Not hardening them, or a native `harden` fast path for TypedArrays, removes the per-byte
   descriptor objects (m0 section 6 already names both fixes).
3. **Lazy resume in the worker.** `resume_from_store_lazy` exists and is tested; the worker uses
   the eager form. A wake of a large vat would read only what the next crank touches [code; not
   measured for the worker].
4. **Incremental images.** The engine checkpoint is O(dirty), the host image is O(file). A
   content-addressed page store shared by images, or a copy-on-write file clone where the platform
   offers one, would make sleeps O(dirty) [inference; this is the hub and transport surveys' ground
   too].
5. **A collector-reported release list.** Whatever the handle form, a list of released host ids
   returned in the worker's reply would also suit OCapN import collection (C-17, C-20) without
   running finalization callbacks as guest code [inference].

---

## 11. Hard constraints for the designers

1. A vat's only input is the journaled frame stream and its image. Anything a vat can observe about
   a referenced datum (length, hash, kind, content) must come from a frame or the heap, never from
   a live host query inside a crank.
2. Synchronous reads of host-held bytes are admissible only for immutable, content-addressed data,
   with absence or mismatch treated as an uncommitted host failure, never as a guest exception.
3. The collection schedule is part of the replay contract. A death report must come from the
   collector (sweep or finalization) at the schedule's points; the host may free a referent only
   after the death is in a committed image and no retained image or journal suffix can re-mint the
   handle.
4. Engine changes move the worker digest, and most move the boot fingerprint or the row schema;
   existing state directories are then refused (`runtime.json` check). Snapshot goldens must be
   re-pinned with the three-run procedure (`0a4bdb3826`).
5. No per-datum property names: descriptors must use fixed keys (C-6).
6. Metering of any new operation must depend only on vat-visible inputs.
7. The worker channel is text only today; any binary or out-of-band payload is a protocol change to
   the worker, the adapter and the transport journal together.
8. Immutable ArrayBuffers are a JS emulation in Ironhorse vats; a design that relies on a native
   immutable brand must add one.
9. A handle must not pass `@endo/pass-style` as a `copyRecord`; it needs a pass style or tag of its
   own that marshal and the OCapN codec recognise.

---

## 12. Not checked

- The slot and side-table cost of one OCapN import presence in a vat (the baseline for "a handle is
  cheaper than a Blob presence"). One small measurement would settle it.
- Whether `globalThis.crypto` is reachable for `worker-peer-xs.js`'s `randomBytes` on Ironhorse,
  and whether any OCapN path in the vat calls it.
- The exact share of the 10 us per byte between C-5 and the other copies of section 2.1.
- Whether `compact_local` plus `mark_all` makes a collection-heavy crank's checkpoint large in
  practice (no measurement here).
- The XS worker (`rust/thixotrope-xs-worker`) duct, which is similar (`globalThis.thixotropeDispatch`
  with a literal) but was not surveyed.
- Behaviour of the lazy resume path under the worker's GC schedule.
