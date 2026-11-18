# Spike dataref, track T1: data references with no core change

Research spike, lane `claude/thix-dataref`, track T1. Not product code. Written 2026-11-18.

The question (owner, 2026-11-18): a vat should hold, pass on, store and hand out a reference to
data without the bytes ever being copied into or through its heap, frames, snapshot or journal;
reading is the rare case. T1 is the best design that changes **no** core, hub, protocol or engine
code: harness objects and adapters only. It is the baseline the hub/OCapN track (T2) and the
engine track (T3) must beat.

Evidence tags: **[measured]** this track's runs (section 7, JSON lines in the appendix);
**[code]** read from the named file and function; **[survey]** from the four surveys in this
directory (`survey-*.md`), which carry their own sources; **[inference]** my reasoning.
Paths: `H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, `pkg/` =
`packages/thixotrope/`. The prototype is `H/test/spikes/dataref-harness/` (a throwaway native
resource `fixture/` and the measurement program `dataref.test.js`).

---

## 1. The design in one page

**One mechanism, three parts, all already present in the harness in special-case form.**

1. **The store** (adapter side). A datum is one write-once file `<store>/<key>` in a directory
   inside the state directory (so templates and copies carry it, as `findBlobDir` does today). It
   is written `.part`, fsynced, renamed, and the directory fsynced **before** its handle leaves
   the writing process (D-15's rule). Bytes are binary (a `Buffer`, not UTF-8 text). A secret is
   the same file encrypted with AES-256-GCM under a data key held **outside** the state directory
   (as `secrets.enc`'s key is today). Revocation is a durable tombstone `<key>.revoked` checked at
   every dereference; keys are never reused.
2. **The registry** (one vat; in production the agent-host manager vat). It mints handles:
   methodless remotables `Datum` and `Secret`, durable because the vat heap is, and keeps
   `handle -> key` in a WeakMap. Adapters keep a pre-minted stock (one registry crank per 64
   handles), so producing a datum costs no crank on the hot path. This is exactly D-15's
   `mintBlobs`/`resolveBlobs`, generalised to every kind of datum.
3. **The amplifier** (`DataUnsealer.resolve(handles) -> keys`). The registry hands it **only** to
   adapters, inside the spec of their binding, so every restore gives a restarted adapter its
   amplifier again with nobody's help. A consumer adapter that is given a handle amplifies it
   (one registry crank on a cache miss, cached per incarnation) and then opens the file itself.
   **The bytes cross no frame**: not the vat's, not the hub's, not another adapter's.

What a vat holds is a record with fixed keys, `{ datum, bytes }` (plus optional non-secret
`digest`, `kind`); for a secret, `{ secret }`. It can store it in durable state, pass it to another
vat or an adapter, and drop it. It cannot read it: the handle has no methods, the vat has no
filesystem and is never given the amplifier. Reading by a vat is the rare case and goes through a
separate **Reader** facet (today's `Content`) that the vat must be given, one ranged page per
answered call; those bytes then do enter that vat's heap and journal, once.

**Use without reveal** (secrets) has two forms, both measured: the consumer adapter amplifies and
decrypts in its own process (it must hold the data key), or the consumer asks the **holder** to
apply the value on its behalf (`hmacVia` in the prototype: the holder computes and answers only
the result; the consumer never sees the value or the key). The second keeps today's rule "only
the agent-host process reads secrets" and costs the same (section 7).

**Two measured variants** that T1 can also offer:

- **S, the sealed ticket**: the record carries `{ ticket, bytes }`, where `ticket` is the store
  key sealed (AES-256-GCM) with the shared data key. No handle, so no hub row and no registry
  crank; the reference is pass-by-copy, like an OCapN sturdyref (`pkg/src/net/hub.js`
  `makeSturdyRef`: "opaque pointers ... re-encoded verbatim" [code]). It is a bearer string inside
  vats, and I do not recommend it for vat-held state (section 5).
- **L, the adapter-origin datum**: the handle is a remotable of the producing adapter process. It
  is the only T1 form whose bytes can be freed when the last holder drops it (a
  `FinalizationRegistry` in the adapter sees the export go), but it is a tombstone after that
  process ends (C-19).

**Recommendation for T1**: O (registry handle) for every reference a vat holds; holder-applied
use for secrets; S only where a reference already leaves the object system (export files, archive
segment files written by the adapter, which hold `b<n>` names today); L only for references that
live within one turn. T1 removes every byte from vat frames, journals, heaps, snapshots and the
hub for data that vats do not read, and lets any configured adapter read a datum with 2 copies
end to end. It does **not** make holding free (one hub row per held handle), it does not collect
durable data, and it pays one registry crank per fresh datum at each consumer.

---

## 2. The API a vat and an adapter see

### 2.1 Vat side (no new powers; guest code only)

```js
// The record a vat stores, passes and drops. Fixed keys: no names per datum.
// { datum: Datum, bytes: number }            // data
// { secret: Secret }                          // a secret (value never reachable)

// Secret case: the session vat keeps the Secret and later has a provider use it.
const keep = rec => { held.set(SLOT, rec); };            // durable state
const callModel = (provider, request) =>
  E(provider).complete(request, held.get(SLOT));          // the provider uses the value
// (prototype: E(consumer).hmac(rec, challenge) answers only a keyed digest)

// Bulk forward: V1 receives from producer A, passes to V2, V2 hands to consumer B.
const ref = await E(producerA).produce(size, seed);      // { datum, bytes }
await E(v2).put(id, ref);                                 // V1 -> V2: one descriptor
const { digest } = await E(consumerB).digest(ref);       // V2 -> B: B reads the store

// Rare read (only a vat given a Reader): one ranged page per answered call.
const page = await E(reader).read(ref, 0, 1024);         // { text, next, done }
```

### 2.2 Adapter side

```js
// Given in the binding spec by the registry vat: sink (mint, attach), unsealer,
// store directory, key file path. Restored with the binding after every restart.
const { handle, key } = await stockOf('datum');           // pre-minted, 64 per crank
writeDurably(key, fill);                                   // .part, fsync, rename, fsync dir
return harden({ datum: handle, bytes });                   // only now may it leave

const keyOf = async ref => {                               // handles only, never names
  const handle = ref.datum ?? ref.secret;
  return known.get(handle) ??                              // per-incarnation cache
    (await E(spec.unsealer).resolve([handle]))[0];         // one registry crank on a miss
};
// then: refuse a tombstoned key, open <store>/<key>, read ranges, digest, decrypt...
```

Holder-applied use: the consumer holds the holder's endpoint (bound at wiring time, never chosen
per call) and calls `E(holder).hmac(ref, challenge)`; in production the provider would be built
with the grant and the destination bound at creation, as `makeBackend` binds `baseUrl` and
`keyGrant` today [survey S4 4.7].

---

## 3. Every change, by layer and file

T1 changes nothing in `packages/thixotrope`, `packages/ocapn*`, `packages/captp`,
`packages/marshal`, `packages/pass-style` or `rust/`.

| layer | file | prototype (this spike) | production change [inference: sizes are estimates] |
|---|---|---|---|
| registry (manager vat) | `H/resources/agent-host/durable.js` | `fixture/durable.js`, 117 lines | generalise `makeBlob`/`mintBlobs`/`resolveBlobs` to `Datum` and `Secret` kinds and a `DataUnsealer` facet given in adapter specs; about 150 lines changed |
| store (adapter) | `AH/blobs.js` | `fixture/ephemeral.js` (store, resolution, readers, secrets, tickets), 553 lines | binary data (`Buffer`, not `utf8`), kinds, tombstones, encrypted kind for secrets; about 300 lines changed |
| reader | `AH/content.js` | `read(ref, offset, count)` in the fixture | ranged binary pages; the owner check (17.3) kept as defence in depth; about 30 lines |
| secrets | `AH/secrets/{manager,store,writer}.js` | `adopt`, `hmac`, `hmacVia`, `revoke` in the fixture | holder-applied use API with destinations bound at mint; per-grant handles for per-holder revocation and audit [survey S4 4.5-4.6]; about 300 lines |
| other adapters | workspace, containers (M6, M10) binding specs | B's spec carries the unsealer, store path, key path | add `unsealer` and store path to their specs; about 20 lines each |
| interfaces | `H/guest/lib/interfaces.js` | none (records only) | `DataRef` shape `{ datum, bytes, digest? }` beside `StagedText`; about 40 lines |
| measurement | `H/test/spikes/dataref-harness/dataref.test.js` | 1,009 lines (after prettier) | none |

---

## 4. Who can dereference, and why a holding vat cannot

- **Dereference needs two authorities that no vat has**: the store (a filesystem path, which a
  vat cannot open: vats have no I/O) and either the amplifier (`DataUnsealer`, for O) or the data
  key file (for S, and for decrypting secrets). The registry gives the amplifier only in adapter
  binding specs. The handle itself has no methods (`Far('Datum', {})`), so holding it conveys
  designation only: the E sealer/unsealer pair, with the registry as the brand [survey S4 2.5].
- **A vat can have a datum used, but only by what it was given**: passing the record to a
  consumer adapter is the intended authority ("whoever holds the reference may have it used by
  a consumer it can reach"). Consumers must answer results (a digest, a model reply), never the
  bytes, unless the method is a Reader the vat was deliberately given.
- **No names cross the vat boundary**: adapter methods accept a handle or a sealed ticket, never a
  store key, path, label or digest (`keyOf` in the fixture; keys are checked against
  `^[ds][1-9][0-9]*$|^t[0-9a-f]{24}$|^l[0-9a-f]{24}$` before any path is built). Keys travel only
  registry -> adapter, as today's `b<n>`/`k<n>` do.
- **Proof for secrets** [measured]: after a full run, every file of the state directory except
  the store (80 files, 249 MB live; 74 files, 255 MB after a clean stop) was searched for the
  64-byte secret and a 64-byte window of the 1 MiB secret, in raw, UTF-16 (both orders), hex
  (both cases), base64 and base64url at all three alignments: **0 hits**. A positive control (a
  64-byte canary passed inline into V1 and kept) was found in V1's heap and snapshot
  (`raw`, `utf16be`); in the shorter smoke run it was found in V1's journal (`base64`). The
  secrets never crossed a frame, so the hub log, journals and snapshots cannot hold them.
- **Revocation** [measured]: `revoke` writes the tombstone and removes the bytes, durably, before
  it answers; the next use through any holder fails with `dataref: revoked` (83 ms).
- **What widens** [inference]: a consumer that reads secrets from the shared store must hold the
  data key; every such adapter can then read every secret in the store, which is weaker than
  today's rule (only the agent-host process reads secrets, D-6). Holder-applied use avoids it at
  the same measured cost, so it is the default for secrets; direct store reads are for non-secret
  data. All adapters run unconfined as the same user anyway (architecture section 6), so the
  shared store does not weaken anything against adapters for non-secret data; the boundary T1
  defends is the vat boundary.
- **Tickets (S) are bearer strings** inside vat heaps and journals. They cannot be forged
  (AES-GCM) or opened by a vat, and a vat can only present tickets it holds, but any party that
  learns the string (a log, a transcript, a model's context) can present it to a consumer. That
  is the sturdyref trade-off and goes against "pass objects, not names" for vat-held state.

---

## 5. Determinism, restart and collection

**Determinism.** A vat observes only the record it was given: `bytes` (and any digest) is minted
with the handle in the frame that delivers it; nothing about the datum is queried inside a crank.
The registry is a vat, so minting and resolution answers are journaled and replayed like any
other delivery. Adapter-side resolution and file reads are outside every vat.

**Restart** [measured]. What persists: the registry vat's heap (handles, WeakMap, serial counter);
the store files and tombstones; the data key outside the state directory; the records in the
holders' heaps. Adapters persist nothing else: their caches are per incarnation. After a clean
restart (serve 4.5 s), the stored O reference of a 1 MiB datum digests correctly at the first use
(188 ms, one registry crank, `by: registry`) and from the cache afterwards (59 ms); the S ticket
works with no crank (55 ms); the 1 MiB secret is used correctly (174 ms, registry). The L
reference is refused after restart (`not a reference this store knows`): the presence arrived at
the consumer as a tombstone. Nothing is woken by a restart for references: resolution is lazy,
on the first use, which fits the owner's dormant-after-restart rule.

**SIGKILL mid-pass** [measured]: killed 40 ms into a 64 MiB pass (V2 -> B digest with an fsynced
effect line per pass id): no effect line had been written; after the restart V2's pending call
was broken with the retired text (`outcomeK1`), the re-driven pass `k2` succeeded with the right
digest, and the effect log has exactly one line (`k2`): nothing delivered twice. The guarantee is
the harness's ordinary one (intent before effect; adapter calls break, never replay).

**Collection** [measured]:

- **O (registry handle): never collected.** The registry vat cannot observe the last holder
  going: `FinalizationRegistry` and `WeakRef` are `undefined` in guest code (probe in
  `t1.setup`), and a WeakMap cannot be enumerated. After the datum was dropped by V1, V2 and B
  and 40 churn cranks, the file stays. Bytes go only by explicit release (session delete, as
  today) or a tombstone (revoke).
- **L (adapter origin), held only by a vat**: freed 412 ms after the drop, after one churn crank
  (50,000 allocations; a ping allocates too little to reach the allocation-driven collection,
  C-7). The FinalizationRegistry in A unlinked the file.
- **L, once another adapter has received it**: not freed within 60 churn rounds (15.7 s and
  24.4 s), although both adapters forced a Node collection every 50 ms. Something on the adapter
  side keeps it: the consumer's OCapN import, or the hub's mention accounting after the consumer
  passed it back to its origin (`resolveLocal`). Not diagnosed further [not checked].
- So T1 cannot have both a reference that survives a restart and bytes freed when the last
  holder drops it. That needs a durable origin that learns of death: the hub (T2) or a
  collector-reported release list in the worker (T3).

---

## 6. What "zero copy" honestly means here

Counted from the code path of the prototype [code: `fixture/ephemeral.js` `writeDurably`,
`digestFile`; survey S2 3.5 for the hub side], for N bytes forwarded A -> V1 -> V2 -> B:

| path | copies of the N bytes | durable copies | bytes in vat frames, journals, heaps, snapshots | bytes through the hub |
|---|---|---|---|---|
| T1 O or S | 2: A's `writeSync` into the file (page cache, then disk at fsync), B's `readSync` into its buffer (hashed in place) | 1 (the store file) | 0 | 0 |
| baseline (b): B pulls `Content` pages from A through the hub | about 19 per page: A file read, string, Syrup encode (2), base64 and JSON for IPC, supervisor JSON and base64 decode, hub decode, hub re-encode (2), hex into the queue, hub log append, hex decode at flush, base64 and JSON toward B, B's JSON and base64 decode, B's Syrup decode | 1 (hub log, hex, about 2.8 N, until compaction: measured +2.93 MB per 1 MiB) | 0 | all of it |
| baseline (a): inline through two vats | per vat hop: the hub's (as above) plus the worker journal (base64, durable), the dispatch literal and its strings (about 6.3 chunk bytes and 1.3 bytecode bytes per byte [survey S3 2.3]), `harden` per byte (C-5), Syrup copy, and the retained string (2 bytes per unit in the heap, then the snapshot) | 3 per vat (journal, heap image, hub log) | all of it | all of it, three times |

"Zero copy" in T1 therefore means: **zero copies inside the object system** (vats, hub, journals,
snapshots, IPC), and the irreducible two for two processes that share no memory (one write, one
read). Node offers no `mmap`, so the read cannot be avoided. A producer whose bytes are already
in a file (a workspace image for `viewImage`) could hard-link or rename it into the store and
save the write [inference, not prototyped].

---

## 7. The shared benchmark, measured

Run: `dataref.test.js` (part `bench`) under the exclusive slot lock, 2026-11-18T03:54-03:57Z,
held 291 s; Ironhorse worker `367e78ad1db3c096`; crank budget 50 M; Node 22.23.4; hub log store.
Code measured: lane commit `33bc1a7095` (it contains T2's and T3's spike prototypes in
`packages/thixotrope`; both are inert unless used, and T1 uses neither) with the test of commit
`4424eff86c` plus a stderr capture added before the run (committed in `c62ab140ff`). Medians of 3
unless stated. Load average 6.3-7.8 (other lanes building), so milliseconds are indicative; frame
and byte counts are exact. The appendix has every JSON line.

### 7.1 Case (2), bulk forward A -> V1 -> V2 -> B, and the baselines

| form | size | total ms (acquire + pass + send) | B resolve / read ms | inbound frames into V1 / V2 (bytes) | hub log per pass | result |
|---|---|---|---|---|---|---|
| T1 O (registry handle) | 1 KiB | 300 (103 + 61 + 76) | 25-38 (registry crank) / 0.2 | 4 (382) / 3 (426) | +53 KB | digest ok |
| T1 O | 1 MiB | 385 (119 + 116 + 93) | 24-54 / 0.7 | 4 (388) / 3 (426) | +57 KB | ok |
| T1 O | 64 MiB | 444 (238 + 64 + 128) | 25-40 / 29.9 | 5 (416) / 3 (427) | +70 KB | ok |
| T1 S (sealed ticket) | 1 KiB | 361 | 0.1-0.5 (ticket) / 0.1 | 4 (442) / 7 (566) | +67 KB | ok |
| T1 S | 1 MiB | 199 | 0.1-0.2 / 0.6 | 9 (580) / 3 (474) | +77 KB | ok |
| T1 S | 64 MiB | 320 | 0.2-0.3 / 29.5 | 5 (473) / 3 (474) | +72 KB | ok |
| T1 L (adapter origin) | 1 KiB | 311 | 47-59 (a hop to A) / 0.1 | 4 (425) / 3 (423) | +94 KB | ok |
| T1 L | 1 MiB | 374 | 41-64 / 0.6 | 4 (428) / 7 (515) | +125 KB | ok |
| baseline (a) inline | 1 KiB | 339 | - | 4 (1,376) / 6 (1,425) | +105 KB | ok |
| baseline (a) inline | 1 MiB | V3 halted after 3,479 ms ("the target session has been retired") | - | V3: 7 frames, 1,048,879 bytes journaled (1.40 MB file) | +2.46 MB | **fails** |
| baseline (a) inline | 64 MiB | not attempted (1 MiB already halts) | | | | |
| baseline (b) Content pages A -> hub -> B | 1 KiB | 157 (1 page) | - | V2: 2 (308) | +66 KB | ok |
| baseline (b) | 1 MiB | 1,480 (52 pages, 28.5 ms each) | - | V2: 16 (749) | +2.93 MB | ok |
| baseline (b) | 64 MiB | 60 s window: 43.1 MB in 2,106 pages; **extrapolated 93.4 s** | - | V2: 3 (276) | (log compacted inside the window) | partial |

Readings. The inbound frame bytes into each vat do not change with the size (382-580 bytes for 1
KiB to 64 MiB). The time does not change with the size either, except the producer's write and
the consumer's read (64 MiB: about 30 ms to hash; the producer's 238 ms includes generating and
writing 64 MiB with fsync). The hub log grows 53-125 KB per three-hop pass whatever the size: this
is bookkeeping (whole session rows rewritten per commit, C-2), and the inline 1 KiB pass costs as
much. Against baseline (b), a 64 MiB datum reaches a second adapter in 444 ms instead of an
extrapolated 93 s, and leaves no data in the hub log.

**Vat heap and snapshot growth after all passes** [measured, `t1.snapshots`, clean stop]: V1
263,424 slots / 16.5 MB, V2 260,352 / 16.4 MB, against a control vat V0 with no references 173,568
/ 14.4 MB. The difference is the vats' whole history (about 30 forwards, the rare reads, the
death churn) and the slot count is capacity (high-water pages of 256 slots), so it is not a per
pass figure; the per-reference figures are in 7.5.

### 7.2 Case (1), secret use

| secret | adopt (mint + encrypted write) | consumer reads the store (`hmac`) | holder applies it (`hmacVia`) | MAC checked | hits in state (live / stopped) |
|---|---|---|---|---|---|
| 64 bytes | 209 ms (a registry mint crank) | 62 ms; first use `registry`, then `cache` | 74 ms (holder `cache`) | 3/3 | 0 / 0 |
| 1 MiB | 25 ms | 71 ms | 68 ms | 3/3 | 0 / 0 |

Revocation of the 64-byte secret: the next use fails with `dataref: revoked` (83 ms). The value
was written by the test into an inbox directory outside the state directory, adopted by A (file
removed), stored encrypted; the session vat V1 stored only `{ secret }` and later passed it to B.

### 7.3 Case (3), rare read

V1 reads bytes 0..1023 of its 1 MiB datum through A's Reader: **75 ms** median (70-89). What
entered V1: 2 inbound frames, 1,224 bytes (the 1,024-byte page plus framing) into its journal,
and the 1,024-character string into its heap (kept on purpose in the prototype, so it will be in
the next snapshot at 2 bytes per unit plus a 4-byte header [survey S3 3.2]).

### 7.4 Case (4), restart

| step | measured |
|---|---|
| clean stop | 3.5 s |
| serve again | 4.5 s; reopening endpoints 1.8 s |
| first use of the stored 1 MiB O reference | 188 ms, `registry` (one crank), digest ok |
| second use | 59 ms, `cache` |
| stored S reference | 55 ms, `ticket`, digest ok |
| stored 1 MiB secret | 174 ms, `registry`, MAC ok |
| stored L reference | refused: `dataref: not a reference this store knows` |
| SIGKILL 40 ms into a 64 MiB pass | 0 effect lines at the kill; serve 5.4 s; pending call broken with the retired text; re-drive ok; 1 effect line in all (`k2`); no duplicate |

### 7.5 Holding cost per reference (1,000 references, fixed-size batches of 20)

| per reference | O (registry handle) | S (sealed ticket) |
|---|---|---|
| hub: entries in the holder's session row (`ourExports`) | +1 (1,001 for 1,000) | 0 |
| hub: chars in the holder's session row | 47 | 0 |
| hub: persisted state chars, all tables | about 444 (443,594 for 1,000 O and 1,000 S together; S adds none to `refs` or rows) | 0 |
| vat slots (snapshot capacity, against a control vat that made the same 50 calls) | 121 | 23 |
| vat snapshot bytes | 4,166 | 578 |
| vat journal bytes (inbound frames, minus the control's) | about 52 | about 100 |
| property names (fill the table after holding) | 0 (57,027 left, as the control) | 0 |
| ms to produce, per reference, at A (2 fsyncs per file) | 21 | 17.5 |

The O slot cost includes the vat's OCapN import machinery per presence (a presence, a WeakRef and
FinalizationRegistry registration, c-list map entries) [inference from survey S3 8.1; the split
was not measured]. A pass (V1 -> V2) costs one crank of V1 and one of V2, 61-116 ms, 3-4 inbound
frames of 380-580 bytes per vat, and 53-125 KB of hub log (7.1).

### 7.6 Case (5), death

| form, holders | freed? | when |
|---|---|---|
| O, dropped by V1, V2 (B had used it) | **no**, file stays after 40 churn cranks | never by GC in T1 |
| L, held only by V1 | **yes** | 412 ms after the drop, 1 churn crank |
| L, V1 then B | no, within 60 churn rounds (15.7 s) | not diagnosed |
| L, V1, V2 and B | no, within 60 rounds (24.4 s) | not diagnosed |

---

## 8. Costs that remain in T1

1. **One hub row per held handle** and about 444 persisted chars per O reference, rewritten with
   the rows on every commit (C-2). This is exactly what made the archive convert references into
   `b<n>` names (J-9386, J-0461). T1 does not fix it; S removes it at the price of a bearer string.
2. **A registry crank per fresh datum at each consumer** (25-54 ms measured) and per stored
   datum after each restart, because the amplification table lives in a vat. Batching (64 per
   crank) helps only when a consumer meets many handles at once.
3. **Every pass is a vat crank** (61-116 ms per hop here) and 53-125 KB of hub log, as for any
   message. T1 removes the per-byte costs, not the per-message ones.
4. **No collection of durable data** (section 5).
5. **Every call between adapters goes through the hub.** The hub never emits a third-party
   handoff between its own sessions (`hub.js` `getInfoForVal` answers `isThirdParty: false`
   [code, lines 1400-1411]), so "the hub's handoff" does not exist today; T1's adapter-to-adapter
   data path is the shared store, and control calls (`resolveLocal`, `hmacVia`) pay a hub hop.
6. **Producing costs two fsyncs per datum** (file and directory): 17-21 ms per small datum at A.

## 9. What T1 cannot do

- Free a datum's bytes when the last holder of a durable reference drops it.
- Make holding a reference free in the hub (except by bearer tickets).
- Resolve a reference without a vat crank after a restart or at a new consumer (except tickets).
- Let a **vat** originate bulk bytes without frames: an exec vat that produces a large result
  still writes it through `BlobWriter` pieces of `frameBytes / 2` (architecture section 6).
- Give a vat a cheap synchronous read: a vat's read is an answered call and the page enters its
  heap and journal.
- Let a peer beyond this daemon resolve a reference (T1's store is local).

---

## 10. How the harness would adopt it

T1 is the generalisation of four special cases already in the tree:

| special case today | becomes | migration |
|---|---|---|
| `Blob` + `StagedText` (`AH/blobs.js`, D-15) | `Datum` + `{ datum, bytes, digest?, preview? }` | rename and widen: same registry, same files; add binary. The preview stays a deliberate copy |
| `Content` (`AH/content.js`) | Reader (ranged binary pages) | same object; owner check kept as defence in depth until delegation (M9) |
| `Secret` / `ReadGrant` (`AH/secrets/*`) | `Datum` of kind secret, with generations in the store and per-grant child handles | keep `secrets.enc` until the store has generations; move consumers to holder-applied use |
| archive segment keys `{"$staged":{"key":"b<n>"}}` | unchanged (adapter-written files; names are acceptable where a reference has left the object system), or sealed tickets if segments ever travel | none needed |
| staged native context, tool texts, submissions | `Datum` records | follow the Blob rename |

Order: (1) put the unsealer and the store path in the binding spec of every adapter that consumes
data (workspace, containers): this alone enables M6 `runCommand(stdin: Blob)`, M8 `viewImage` and
export without paging through the hub; (2) binary data in the store (M8 images); (3) holder-applied
secret use, so workspace and containers can use credentials without the hub ever carrying them;
(4) per-grant secret handles (revocation and audit per holder); (5) only after T2 or T3, durable
references with collection.

## 11. Risks and open questions

- **Why does an adapter that received an adapter-origin datum keep it alive?** (7.6). Until that is
  understood, any collection design that depends on OCapN GC through adapters is unproven.
- **Hub growth from held handles** stays the main cost for long sessions (J-9386). If T2 does not
  land, a long session must keep converting sealed references into names (the archive pattern).
- **Shared data key** widens who can read secrets if used for secrets; keep holder-applied use the
  default.
- **Quotas and sweeps**: the store needs per-owner quotas (17.1) and a sweep that treats every key
  an archive names as live (m2 4.10); not prototyped.
- **Identity comparison across holders** needs a registry method `same(a, b)` (one crank); not
  prototyped. Within one holder, presence identity works.
- **Attenuation** (range, read-once, expiry) as registry-minted child handles with the store
  checking `{ parent, range, flags }`; not prototyped; read-once must state its crash behaviour.
- **Two benchmark attempts failed before the measured run** for reasons outside T1 while other
  tracks were changing core files in this worktree: one with "journal cranks disagree with the
  frames written (0 != 1)" in `durable-worker-transport.js` during the first serve, one with the
  supervisor disconnecting during setup. The third attempt passed unchanged. Not diagnosed.

## 12. Estimate to production quality [inference]

About two weeks of one agent: registry generalisation and specs (2 days), store with binary data,
kinds, quotas, tombstones and sweep (3 days), holder-applied secret use and per-grant handles (3
days), migration of blobs and staged texts with their tests (2-3 days), perf checks for holding
and forwarding (1 day). No core lane work.

---

## Appendix: measured JSON lines

Commit `33bc1a7095` (bench part) and `5b2c7a405b` (death part, run at 03:59Z with the test of
`c62ab140ff`), worker `367e78ad1db3c096`, crank budget 50,000,000, gcPolicy allocation, hub
store log, slot ceiling 4,000,000. Identity fields, load averages and incarnation ids removed;
digests cut to 12 hex digits.

```jsonl
{"metric":"t1.setup","probe":{"finalizationRegistry":"undefined","weakRef":"undefined"},"at":"2026-11-18T03:54:25.074Z"}
{"metric":"t1.forward","form":"O","size":1024,"reps":3,"allOk":true,"acquireMs":103.3,"passMs":61.2,"sendMs":76.3,"totalMs":300.5,"by":["registry","registry","registry"],"resolveMs":[24.64,38,24.738],"readMs":0.2,"last":{"id":3,"ok":true,"acquireMs":103.28633400000399,"passMs":60.76199999999517,"sendMs":76.25299999999697,"totalMs":240.30133399999613,"by":"registry","resolveMs":24.738,"readMs":0.159,"v1":{"frames":4,"frameBytes":382,"fileBytes":636},"v2":{"frames":3,"frameBytes":426,"fileBytes":662},"hubBytes":53208,"hubRefs":14},"at":"2026-11-18T03:54:26.087Z"}
{"metric":"t1.forward","form":"O","size":1048576,"reps":3,"allOk":true,"acquireMs":118.7,"passMs":115.7,"sendMs":93.4,"totalMs":384.6,"by":["registry","registry","registry"],"resolveMs":[53.761,24.175,32.194],"readMs":0.7,"last":{"id":6,"ok":true,"acquireMs":118.73233400000026,"passMs":115.65266700000211,"sendMs":93.42441599999438,"totalMs":327.80941699999676,"by":"registry","resolveMs":32.194,"readMs":0.677,"v1":{"frames":4,"frameBytes":388,"fileBytes":640},"v2":{"frames":3,"frameBytes":426,"fileBytes":662},"hubBytes":56751,"hubRefs":14},"at":"2026-11-18T03:54:27.271Z"}
{"metric":"t1.forward","form":"O","size":67108864,"reps":3,"allOk":true,"acquireMs":238.3,"passMs":64.2,"sendMs":128.1,"totalMs":443.7,"by":["registry","registry","registry"],"resolveMs":[35.174,39.771,25.402],"readMs":29.9,"last":{"id":9,"ok":true,"acquireMs":222.34066599999642,"passMs":56.96966699999757,"sendMs":111.21808299999975,"totalMs":390.52841599999374,"by":"registry","resolveMs":25.402,"readMs":29.921,"v1":{"frames":5,"frameBytes":416,"fileBytes":720},"v2":{"frames":3,"frameBytes":427,"fileBytes":662},"hubBytes":70344,"hubRefs":13},"at":"2026-11-18T03:54:28.853Z"}
{"metric":"t1.forward","form":"S","size":1024,"reps":3,"allOk":true,"acquireMs":133.7,"passMs":100.9,"sendMs":59.4,"totalMs":361.4,"by":["ticket","ticket","ticket"],"resolveMs":[0.542,0.126,0.099],"readMs":0.1,"last":{"id":12,"ok":true,"acquireMs":201.10966599999665,"passMs":100.89424999999756,"sendMs":59.39312500000233,"totalMs":361.39704099999653,"by":"ticket","resolveMs":0.099,"readMs":0.094,"v1":{"frames":4,"frameBytes":442,"fileBytes":712},"v2":{"frames":7,"frameBytes":566,"fileBytes":1014},"hubBytes":67328,"hubRefs":-4},"at":"2026-11-18T03:54:29.813Z"}
{"metric":"t1.forward","form":"S","size":1048576,"reps":3,"allOk":true,"acquireMs":73.7,"passMs":72.9,"sendMs":51,"totalMs":199.4,"by":["ticket","ticket","ticket"],"resolveMs":[0.192,0.102,0.114],"readMs":0.6,"last":{"id":15,"ok":true,"acquireMs":85.68520899999567,"passMs":208.9763329999987,"sendMs":50.99629200000345,"totalMs":345.6578339999978,"by":"ticket","resolveMs":0.114,"readMs":0.618,"v1":{"frames":9,"frameBytes":580,"fileBytes":1096},"v2":{"frames":3,"frameBytes":474,"fileBytes":726},"hubBytes":77475,"hubRefs":-3},"at":"2026-11-18T03:54:30.570Z"}
{"metric":"t1.forward","form":"S","size":67108864,"reps":3,"allOk":true,"acquireMs":181.3,"passMs":74.9,"sendMs":85.1,"totalMs":320.4,"by":["ticket","ticket","ticket"],"resolveMs":[0.213,0.157,0.263],"readMs":29.5,"last":{"id":18,"ok":true,"acquireMs":181.25216699999874,"passMs":59.04904200000601,"sendMs":80.1241250000021,"totalMs":320.42533400000684,"by":"ticket","resolveMs":0.263,"readMs":29.532,"v1":{"frames":5,"frameBytes":473,"fileBytes":796},"v2":{"frames":3,"frameBytes":474,"fileBytes":726},"hubBytes":71683,"hubRefs":11},"at":"2026-11-18T03:54:32.017Z"}
{"metric":"t1.forward","form":"L","size":1024,"reps":3,"allOk":true,"acquireMs":99.7,"passMs":101.8,"sendMs":135.2,"totalMs":310.8,"by":["peer","peer","peer"],"resolveMs":[54.706,59.018,46.958],"readMs":0.1,"last":{"id":21,"ok":true,"acquireMs":99.66191699999763,"passMs":83.08120800000324,"sendMs":99.01091599999927,"totalMs":281.75404100000014,"by":"peer","resolveMs":46.958,"readMs":0.105,"v1":{"frames":4,"frameBytes":425,"fileBytes":696},"v2":{"frames":3,"frameBytes":423,"fileBytes":658},"hubBytes":94458,"hubRefs":17},"at":"2026-11-18T03:54:33.234Z"}
{"metric":"t1.forward","form":"L","size":1048576,"reps":3,"allOk":true,"acquireMs":168.4,"passMs":78.8,"sendMs":121.1,"totalMs":374.3,"by":["peer","peer","peer"],"resolveMs":[64.174,40.902,52.99],"readMs":0.6,"last":{"id":24,"ok":true,"acquireMs":240.55504199999996,"passMs":73.88654099999985,"sendMs":121.05979200000002,"totalMs":435.5013749999998,"by":"peer","resolveMs":52.99,"readMs":0.604,"v1":{"frames":4,"frameBytes":428,"fileBytes":700},"v2":{"frames":7,"frameBytes":515,"fileBytes":951},"hubBytes":124705,"hubRefs":3},"at":"2026-11-18T03:54:34.359Z"}
{"metric":"t1.forward","form":"inline","size":1024,"reps":3,"allOk":true,"acquireMs":87.2,"passMs":98.9,"sendMs":55.9,"totalMs":339,"by":[null,null,null],"resolveMs":[null,null,null],"readMs":0,"last":{"id":27,"ok":true,"acquireMs":191.83008300000074,"passMs":98.93362499999785,"sendMs":48.22095799999806,"totalMs":338.98466599999665,"v1":{"frames":4,"frameBytes":1376,"fileBytes":1964},"v2":{"frames":6,"frameBytes":1425,"fileBytes":2124},"hubBytes":105444,"hubRefs":-2},"at":"2026-11-18T03:54:35.324Z"}
{"metric":"t1.baselineA.inline1MiB","result":{"ok":false,"ms":3479.1,"error":"ocapn hub: the target session has been retired"},"vatAlive":false,"v3":{"frames":7,"frameBytes":1048879,"fileBytes":1398780},"hubBytes":2464531,"at":"2026-11-18T03:54:38.823Z"}
{"metric":"t1.baselineB.pages","size":1024,"pageBytes":20480,"bytes":1024,"digest":"0636eb58ba13...","done":true,"ms":157.022,"pages":1,"ok":true,"msPerPage":157,"extrapolatedMs":157.022,"wallMs":226.5,"v2":{"frames":2,"frameBytes":308,"fileBytes":474},"hubBytes":65990,"at":"2026-11-18T03:54:39.051Z"}
{"metric":"t1.baselineB.pages","size":1048576,"pageBytes":20480,"bytes":1048576,"digest":"a4bfe937726c...","done":true,"ms":1480.067,"pages":52,"ok":true,"msPerPage":28.5,"extrapolatedMs":1480.067,"wallMs":1689,"v2":{"frames":16,"frameBytes":749,"fileBytes":1648},"hubBytes":2934109,"at":"2026-11-18T03:54:40.744Z"}
{"metric":"t1.baselineB.pages","size":67108864,"pageBytes":20480,"bytes":43130880,"digest":null,"done":false,"ms":60019.276,"pages":2106,"ok":null,"msPerPage":28.5,"extrapolatedMs":93386.1,"wallMs":60078.7,"v2":{"frames":3,"frameBytes":276,"fileBytes":471},"hubBytes":-4955629,"at":"2026-11-18T03:55:40.825Z"}
{"metric":"t1.rareRead","bytes":1024,"ms":74.9,"rows":[{"ms":88.86804200000188,"n":1024,"v1":{"frames":2,"frameBytes":1224,"fileBytes":1698}},{"ms":74.86554099999194,"n":1024,"v1":{"frames":2,"frameBytes":1224,"fileBytes":1698}},{"ms":69.55395899999712,"n":1024,"v1":{"frames":2,"frameBytes":1224,"fileBytes":1698}}],"at":"2026-11-18T03:55:41.063Z"}
{"metric":"t1.secret.use","size":64,"adoptMs":208.5,"directMs":61.8,"viaMs":74.1,"allOk":true,"by":["registry/cache","cache/cache","cache/cache"],"at":"2026-11-18T03:55:41.833Z"}
{"metric":"t1.secret.use","size":1048576,"adoptMs":24.6,"directMs":71.4,"viaMs":68.1,"allOk":true,"by":["registry/cache","cache/cache","cache/cache"],"at":"2026-11-18T03:55:42.479Z"}
{"metric":"t1.secret.revoke","after":{"ok":false,"ms":83.2,"error":"dataref: revoked"},"at":"2026-11-18T03:55:42.579Z"}
{"metric":"t1.hold.hub","refs":1000,"msPerRefO":21.1,"msPerRefS":17.5,"hubRefsDelta":1227,"stateCharsDelta":443594,"vO":{"before":{"ourExports":1,"rowChars":307},"after":{"ourExports":1002,"rowChars":47463}},"vS":{"before":{"ourExports":1,"rowChars":307},"after":{"ourExports":0,"rowChars":252}},"v0":{"ourExports":9,"rowChars":1398},"journal":{"vO":{"lines":121,"frameBytes":65939,"fileBytes":91717},"vS":{"lines":122,"frameBytes":113881,"fileBytes":155802},"v0":{"lines":122,"frameBytes":13833,"fileBytes":22398}},"at":"2026-11-18T03:56:24.687Z"}
{"metric":"t1.death.local","usedBy":"peer","diedWhileIdle":false,"churnCranks":80,"churnObjects":50000,"msAfterDrop":18642.7,"deaths":[],"fileGone":false,"at":"2026-11-18T03:56:43.902Z"}
{"metric":"t1.death.registry","churnCranks":40,"fileStays":true,"lastForwardedOFileStays":true,"idO":6,"at":"2026-11-18T03:56:49.839Z"}
{"metric":"t1.secret.scan.live","s64":{"files":80,"bytes":249154570,"hits":[]},"s1M":{"files":80,"bytes":249154570,"hits":[]},"canary":{"files":80,"bytes":249154570,"hits":["heaps/incarnations/vat-app-v1-61c7884c-IyWyoN/heap.sqlite:raw","heaps/incarnations/vat-app-v1-61c7884c-IyWyoN/heap.sqlite:utf16be","heaps/snapshots/<id>.sqlite:raw","heaps/snapshots/<id>.sqlite:utf16be"]},"at":"2026-11-18T03:56:50.545Z"}
{"metric":"t1.snapshots","stopMs":3486,"snaps":{"v1":{"slots":263424,"snapshotBytes":16474112},"v2":{"slots":260352,"snapshotBytes":16392192},"v3":null,"v0":{"slots":173568,"snapshotBytes":14352384},"vO":{"slots":294400,"snapshotBytes":18518016},"vS":{"slots":196864,"snapshotBytes":14929920}},"holdSlotsPerRef":{"O":120.8,"S":23.3},"holdSnapshotBytesPerRef":{"O":4165.6,"S":577.5},"at":"2026-11-18T03:56:54.651Z"}
{"metric":"t1.secret.scan.stopped","s64":{"files":74,"bytes":254630404,"hits":[]},"s1M":{"files":74,"bytes":254630404,"hits":[]},"canary":{"files":74,"bytes":254630404,"hits":["heaps/snapshots/<id>.sqlite:raw","heaps/snapshots/<id>.sqlite:utf16be"]},"at":"2026-11-18T03:56:54.651Z"}
{"metric":"t1.restart.clean","served":{"servedMs":4492,"connectedMs":4691.5},"reopenMs":1830.8,"firstO":{"ms":187.5,"by":"registry","ok":true},"secondO":{"ms":58.5,"by":"cache"},"firstS":{"ms":55.1,"by":"ticket","ok":true},"secret":{"ms":174.1,"by":"registry","ok":true},"localAfter":{"ok":false,"ms":99.4,"error":"dataref: not a reference this store knows"},"registry":{"attaches":2,"minted":1088,"resolved":33,"serial":1088,"staleOpens":0},"at":"2026-11-18T03:57:01.786Z"}
{"metric":"t1.restart.sigkill","size":67108864,"killAfterMs":40,"effectsAtKill":0,"servedK":{"servedMs":5396.6,"connectedMs":5523},"outcomeK1":"broken:ocapn hub: the target session has been retired","outcomeK2":"ok:cef05d68580b...","k2Ok":true,"perPass":{"k2":1},"duplicates":false,"at":"2026-11-18T03:57:10.622Z"}
{"metric":"t1.names","afterHoldingO":57027,"control":57027,"at":"2026-11-18T03:57:26.163Z"}
```

```jsonl
{"metric":"t1.death.isolated","shape":"v1","churnRounds":1,"churnObjects":50000,"died":true,"msAfterDrop":351.3,"deaths":[{"atMs":411.986,"existed":true}],"fileGone":true,"at":"2026-11-18T04:00:19.099Z"}
{"metric":"t1.death.isolated","shape":"v1+B","churnRounds":60,"churnObjects":50000,"died":false,"msAfterDrop":15726.3,"deaths":[],"fileGone":false,"at":"2026-11-18T04:00:35.052Z"}
{"metric":"t1.death.isolated","shape":"v1+v2+B","churnRounds":60,"churnObjects":50000,"died":false,"msAfterDrop":24420.3,"deaths":[],"fileGone":false,"at":"2026-11-18T04:00:59.880Z"}
```
