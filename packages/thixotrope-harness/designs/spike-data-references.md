# Spike: references to data a vat does not read

Research spike, lane `claude/thix-dataref`, synthesis unit. Not product code. Written 2026-11-18
against lane commit `5e63e5847f`. Source material, all in `designs/spike-dataref/`: four surveys
(`survey-harness-flows.md` S1, `survey-ocapn-hub.md` S2, `survey-engine.md` S3,
`survey-prior-art.md` S4), three designs (`design-harness.md` T1, `design-ocapn.md` T2,
`design-engine.md` T3), and `critique.md`. Journal: J-9800..J-9843 (tracks), J-9845..J-9859 (this
document).

Merge note (PM, 2026-11-18): only the documents and the journal and CORE-CHANGES entries of the
spike are merged into `claude/thixotrope-harness`. The prototypes (`test/spikes/dataref-*` and the
core changes CC-083..CC-087) stay on the local lane branch `claude/thix-dataref` (tip
`d9a7fcd7d8`), which is not pushed; nothing here is adopted until the owner decides.

The owner's request (2026-11-18): find a way for a vat to reference data it does not need to read,
without the bytes being copied into or through the vat; secrets are the example; the answer may sit
at several layers; changing our OCapN protocol is allowed.

Evidence labels: **[measured]** a figure from a track's or the critique's benchmark run (source
file named); **[code]** read from the named file and function, by me in this unit unless said
otherwise; **[fetched]** a public source fetched during the spike; **[inference]** reasoning, not
executed. I ran no benchmark in this unit; where the critique and a design disagree I checked the
code (section 3.4) and say who is right.

Paths: `H/` = `packages/thixotrope-harness/`, `pkg/` = `packages/thixotrope/`, `ocapn/` =
`packages/ocapn/`, `AH/` = `H/resources/agent-host/impl/`.

Terms this spike invented (the rest is Endo, OCapN and Thixotrope as usual):

- **data path**: where the bytes go. **identity**: the object a vat holds that designates them.
- **O handle** (T1): a methodless `Datum`/`Secret` remotable minted by a registry vat (today's
  agent-host manager), the D-15 `Blob` pattern generalised. **S ticket**: a store key sealed with
  AES-GCM and carried as a string. **L handle**: a remotable exported by the producing adapter.
- **amplifier** (T1 `DataUnsealer`): `resolve(handles) -> keys`, given only to adapters in their
  binding specs.
- **`hub:data` row** (T2): a reference row whose origin is a pseudo-session the hub serves itself,
  never attached and never retired. **writer / reader / unsealer powers**: `hub:data` rows that
  create data, read it, and read sealed data. **`locate(ref) -> { file, length }`**: a reader
  method that tells a co-located adapter which file to open. **`thix:data` envelope**: a Tagged
  value `{ length, ref, sha256 }` the hub checks on every `op:deliver`.
- **adopt-by-file** (proposed by T2, not built): a writer method that takes a file an adapter wrote
  into a staging directory and renames it into the store, so no byte crosses the hub.
- **holder-applied use**: the process that holds a secret applies it (signs, sends the request) for
  a caller, and answers only the result. Today's D-6 rule is the special case "the holder is the
  agent-host process".
- **D-1..D-4** (T3): engine-native data handle, collector-reported death, hub-side ingest of large
  inline atoms, rare read as an asynchronous call. **D-1a**: D-1's API built in JavaScript in the
  in-vat OCapN client.

---

## 1. The answer

**What to build.** One mechanism with two halves that belong to different layers:

1. **The data path stays outside the object system, and adapters read files themselves.** All three
   designs converged on this, and it is what gives the property the owner asked for: the bytes never
   enter a vat frame, journal, heap or snapshot, nor the hub's state, queue or log. A consumer
   adapter is told which file to open by an authority it was given, and reads it. This is a harness
   change first (no core work) and becomes the hub's `locate` later.
2. **Identity and lifetime move into the hub** (T2's `hub:data` rows), for bulk data, once four
   corrections and three prerequisites are in (section 4). A data reference is then an ordinary
   OCapN import to every vat and adapter; it survives restarts with no resolution crank and can be
   collected when the last holder lets go.

**Secrets stay where they are** in the harness: identities (`Secret`, `ReadGrant`) in the manager
vat, values only in the process that holds them, used by holder-applied use. No design improved on
that, and T2's sealed rows, as specified, widen who can read a secret and cannot be revoked
(section 2.1).

**The engine needs no change now.** T3 did not build an engine handle and the one number that would
justify it (the in-vat cost of one held reference) was measured by nobody. What the engine side
should do next is the per-byte inbound cost (C-5, deliver-v2), which governs the rare read.

**The protocol needs no wire change.** The envelope is a standard Tagged value; the hub serves the
rows as it serves its bootstrap. A negotiated descriptor for remote peers is specified by T2 but
no owner case needs it; I recommend not building it.

**Order.**

| step | layer | what | what it buys |
|---|---|---|---|
| 1 | harness | give the workspace and containers adapters (and the export CLI path) the blob store directory and an amplifier in their binding specs; binary blobs; random keys; an adapter-side function shaped like `locate` | `runCommand` stdin, `viewImage`, export without 20 KiB paging through the hub; no core change |
| 2 | core (hub) | C-1 and C-2 (needed anyway), then `hub:data` rows with the corrections in section 4: refusing envelope walk, powers given at launch, revocation flag, adopt-by-file, quotas, GC proven with live adapters | references that survive restarts without a crank, collection of bulk data, no per-byte work on the hub thread |
| 3 | harness | move `Blob`/`StagedText` onto `hub:data` rows; step 1's adapters switch their backing from the amplifier to `locate` without changing callers | collectable blobs; no manager crank per 64 handles; no owner ACL |
| 4 | engine | C-5 / deliver-v2 (cheaper inbound bytes); D-1a or D-1/D-2 only after a measurement of one held handle shows it matters | cheaper rare reads; cheaper holding, if needed |

**The numbers that justify it.**

- **Passing costs the same at 1 KiB and 64 MiB.** T2: about 230 bytes from the hub into V1 per hop
  at every size, vat journals +0.7-0.9 KB over three hops [measured, `design-ocapn.md` 7.2]; T1:
  inbound frames per vat 380-580 bytes at every size [measured, `design-harness.md` 7.1].
- **Inline does not work and paging is expensive.** A 1 MiB value passed inline halts the receiving
  vat in all three tracks and in the critique's reruns (0.8-4.5 s to retirement). Paging 1 MiB
  between two adapters through the hub in 20,480-byte pages takes 0.74-1.5 s and grows the hub log
  by +2.9-3.0 MB per MiB; one 1 MiB answer in a frame adds +1.72 MB to the hub log [measured, T1,
  T2, T3, critique 2.4, 3.3, 4.4].
- **The consumer's read is a file read.** B read 64 MiB from the store in 30 ms (T1) and
  112-172 ms (T2, `locate`, including the hop) [measured].
- **Secrets never appeared in persisted state.** 0 hits of the 64 B and 1 MiB secret values (raw,
  hex, UTF-16, base64 at three alignments) over the whole state directory in every track and in the
  critique's own searches with the actual values; the inline positive control was found every time
  [measured, critique 2.2, 3.1, 4.2].

---

## 2. The owner's cases

### 2.1 A secret that is used but never read by a vat

- **Layer:** harness. **A vat holds:** a `Secret` or `ReadGrant` identity (a manager-vat exo), or a
  `Backend` built with one; never a value, a key string or a ticket.
- **Today** this already holds (D-6): values live in `secrets.enc`, keys `k<n>` travel only manager
  -> adapter, and only `AH/secrets/manager.js` reads values [code, S1 2.3]. The spike confirmed the
  shape: T1's holder-applied use (`hmacVia`) and a consumer's direct store read cost the same
  (74 / 68 ms against 62 / 71 ms for 64 B / 1 MiB) [measured, T1 7, critique 2.4].
- **What is missing** is a secret consumer outside the agent-host process (a workspace or containers
  adapter needing a credential). The answer is holder-applied use: that adapter calls the
  agent-host's provider object, which was bound at mint to its destination, and gets a result. The
  alternative, giving every consumer adapter the data key (T1 direct read) or the unsealer and key
  file (T2 sealed rows), lets every such adapter read every secret [code, critique 3.1].
- **Why not T2 sealed rows now:** no revocation (M4's P-58 needs revoke and delete-after-revoke),
  `locate` hands out a file name that stays valid while the file exists, and every unsealer holder
  holds the same AES key [code: `hub.js` `handleDataDeliver`; critique 3.1]. Secret generations
  also need a mutable pointer that `hub:data` rows do not have (T2 10).
- **Holder-applied use is a use oracle** for whoever can call the provider; that is the intended
  meaning of "use without reveal", and the destination must be bound at mint, never chosen by the
  caller [critique 2.2, S4 4.7].
- **The CLI's large sealed-box write** (about 1.4 MB through the hub, queued as hex until
  compaction, C-1) is not a reference problem; it is fixed by an adopt-by-file path (section 5).

### 2.2 Bulk data forwarded through vats

- **Layer:** the data path in adapters (step 1), identity in the hub (steps 2-3). **A vat holds:**
  in step 1 a `StagedText`-like record `{ blob, bytes, ... }` with a manager-minted handle (an O
  handle); after step 3 a `thix:data` envelope whose `ref` is a `hub:data` import.
- Per hop the vat pays one crank and a frame of a few hundred bytes. T2's prototype measured 48-185
  ms per hop (run 1) with the test's round trip, T1 300-444 ms per three-hop pass [measured]; those
  are crank and hub costs, independent of size. The hub log still grows 10-12 KB per hop (T2) or
  53-125 KB per pass (T1) from whole-row rewrites (C-2), not payload [measured].
- Creation through frames is per byte on the supervisor's hub thread (64 MiB took 422-950 ms in T2,
  521 ms in the critique's rerun, blocking other sessions meanwhile) [measured]. Adopt-by-file
  removes that; until it exists, step 1's adapter-written files are the cheaper path.

### 2.3 The rare read by a vat

- **Layer:** an asynchronous reader call answered in frames. All three designs agree.
- **A vat holds:** the reference plus a reader it was given on purpose (today `Content`; the exec vat
  pattern, D-11). It receives one bounded page per answered call; the bytes enter its journal once
  and its heap until collected.
- Measured: 1,024 bytes in 53-112 ms, about 1,170-1,220 frame bytes in, journal +1.6 KB per read
  [measured, T1 7, T2 7.3, T3 J-9837]. ByteArray answers are passable into Ironhorse vats in this
  build [measured, T2 7.3]; J-0023's "not passable" no longer holds for answers.
- The cost is per inbound byte (C-5: about 10 us per byte, S1 1). The fix is deliver-v2 and the
  harden change, not a reference design. A synchronous host read (T3 D-4, external buffer) is
  specified only for immutable content-addressed data and is not recommended.

### 2.4 Data produced by a vat

- **Not solved by any design.** A vat has no I/O; whatever it produces leaves in outbound frames.
- Outbound frames are cheap for the producing vat (4 MiB in one answer passes, S1 1, J-0142); the
  cost lands on whoever receives them and on the hub. The critique proposed, and nobody measured,
  giving the vat an attenuated T2 builder: the vat `append`s pieces, the hub decodes them once and
  writes them to a part file without queueing them (builder calls are served locally in
  `handleDataDeliver` [code]), and `close()` answers a data reference. The bytes then cross the vat's
  outbound frames and one hub decode, and never another vat or the hub state. Builders do not
  survive a restart, so the vat must handle a break and start again.
- Today's harness does the equivalent with `BlobWriter`s owned by the agent-host adapter (pieces of
  at most 12,288 bytes, outbound from the exec vat) [S1 3.1]. That stays.
- **Recommended next measurement** before deciding: a vat appending 1 MiB through a builder, with
  hub log growth and hub-thread time recorded.

### 2.5 Long-lived stored references

- **Layer:** the hub, and it needs C-2.
- **What a vat holds:** today a `Blob` presence in records it keeps; after sealing, the archive
  turns references into `b<n>` names in segment files, because each held handle costs a c-list entry
  in every holder's hub row, rewritten whole at every commit. Before the archive, 2 handles per turn
  grew one session row to 10,012 entries and each commit to 888 KB (J-9386, S1 4.1).
- **What a held reference costs** (measured figures are batch averages of slot-page capacity, good
  for ratios only, critique 2.4): T1's O handle about 444-503 persisted hub characters per held
  reference, S tickets 0 [measured, T1 J-9806, critique 2.4]; T2 about 51 bytes per holder entry
  plus about 110-130 characters per datum [code and S2 estimate, not measured per reference]. Every
  hub commit stringifies every row (C-2) in both designs.
- **So** neither design makes holding free. Until C-2's per-row dirty tracking lands, the archive
  keeps writing `b<n>` names into segment files. That is allowed by the owner's principle: the
  reference has left the object system into an adapter's file. With C-2 and T2 rows, sealed records
  could keep references (pass them on, collect them).
- **Restart:** T2 rows need no crank (first use after restart 129-212 ms) [measured, T2 7.4]; T1's
  O handles cost one registry crank per fresh datum per consumer incarnation (first use 188-481 ms,
  then about 51-59 ms cached) [measured, T1, critique]. L handles are tombstones after an adapter
  restart and must not be stored.

---

## 3. The three designs compared

### 3.1 On the shared benchmark

Times are wall milliseconds under load (load average 6-10); byte counts are exact. "rerun" is the
critique's exclusive rerun. Sources: T1 `design-harness.md` 7 and `test/spikes/dataref-harness/`;
T2 `design-ocapn.md` 7-8 and `test/spikes/dataref-ocapn/bench.mjs`; T3 `design-engine.md` 7 and
`test/spikes/dataref-engine/bench.mjs`; reruns `critique.md` 2.4, 3.3, 4.4.

| | T1 harness (O handle) | T2 hub rows | T3 stand-in (bearer integer) |
|---|---|---|---|
| what was measured | the real design, adapters as native-resource processes | the real hub change, adapters as in-process transient clients (no Node IPC) | T1's data path with a guest-visible integer; **not** the engine design |
| bulk 1 KiB / 1 MiB / 64 MiB, A -> V1 -> V2 -> B | 300 / 385 / 444 per pass; rerun 1 MiB 311 | per hop 74-179 / 48-165 / 112-185 (run 1); rerun 1 MiB 108 + 145 + 51 | 83 / 83 / 180 per pass; rerun 78 / 114 / 130 |
| bytes into a vat per hop | 380-580 per vat per pass | about 230 | 200-370 |
| vat journal growth | not reported per hop | 0.7-0.9 KB over three hops | 370-570 B per vat per pass |
| hub log growth | 53-125 KB per pass | 30-36 KB over three hops | not reported per pass |
| rare read 1 KiB | 75 (rerun 62), 1,224 B in | 112-217, 1,164 B in, journal +1,616 B | 53, 1,177 B in, journal +1,632 B |
| secret use 64 B / 1 MiB | holder-applied 74 / 68 (rerun 68 / 58) | 146-243 / 155-195 (rerun 188 / 133) | 53 / 47 (rerun 41 / 43) |
| secret search | 0 hits; controls found | 0 hits; control found in snapshot and hub log (hex) | 0 hits; controls found |
| clean restart, first use | 188 (rerun 481), registry crank; then 59 | 129-212, no crank | 182 |
| SIGKILL mid-pass | no duplicate (one effect line, per-pass id) | 2 of 3 committed, "no duplicate" by a count check the critique showed cannot tell a duplicate plus a loss | in-flight call broke; exactly one delivery after |
| death (bytes freed on last drop) | O: never. L: 412 ms if only a vat held it; never once another adapter received it | 3 rounds, 622-1,093 ms, **only after both adapter sessions were closed**; not freed in 60 rounds with adapters open (critique) | never |
| baseline (a) inline 1 MiB | vat halted, 3.5 s (rerun 2.0 s) | vat halted, 0.8-1.0 s | vat retired, 4.5 s (rerun 3.8 s) |
| baseline (b) 1 MiB in 20 KiB pages | 1,480 (rerun 1,278), +2.93 MB hub log | 759-1,238 (rerun 788) | 886 (rerun 744) |
| per-page time in (b) | 28.5 (rerun 24.6): the outlier, see 3.3 | 14.6-23.8 [inference: 759-1,238 / 52] | 16.4 (rerun 12.8) |

Not measured by anyone: the in-vat cost of one held handle in isolation (all slot figures are
256-slot page capacity divided by a batch); the T2 path over Node IPC; concurrency on the hub
thread; the envelope walk's cost per `op:deliver`; T1's 64 MiB pass in the critique's rerun.

### 3.2 Properties

| | T1 harness | T2 hub rows | T3 engine (D-1/D-2 over T2) |
|---|---|---|---|
| copies of N bytes, end to end [code, critique 6] | 2 kernel copies (A writes, B reads); only A and B touch the bytes | prototype: 4 user-space + 1 kernel to create, 1 to read; production over IPC about 4 more; the supervisor touches every created byte; with adopt-by-file as T1 | as T2 (stand-in: as T1); transport ingest put the bytes in the hub image in clear |
| what a held reference costs the vat | a presence (several times an S ticket; absolute not isolated) | a presence | one slot plus a side row [inference, not built] |
| what it costs the hub | a RefRow plus a c-list entry per holder, about 444-503 persisted chars [measured] | the same rows plus a data entry of about 110-130 chars per datum [code] | as T2 |
| vat can read what it holds | no by design; **the prototype let a holder of the consumer endpoint read any datum and any secret's ciphertext by guessed sequential key** [measured, critique 2.1; code checked, 3.4] | no; envelope metadata forgeable by adapters or peers past nesting depth 64 [measured, critique 3.1; code checked] | no by design; the stand-in's check was bypassed by a string or float payload, and a string id escaped the store directory [measured, critique 4.1; code checked] |
| revocation | per datum, durable tombstone [measured]; prototype let any holder revoke for everyone | none | none |
| restart | O and S survive; L does not | rows survive, no crank | as T2 |
| collection | none for durable references | by OCapN GC, proven only with adapters closed | D-2 reports death from the collector; not built |
| size of change | no core; T1 says about 2 weeks, critique about 3 [inference] | prototype +634 core lines; T2 says 4-6 days core + 1.5-2 weeks harness, critique 3-4 weeks plus C-1, C-2 [inference] | 1,500-1,900 lines, golden re-pins, state migration, 2-3 weeks [inference, T3 3.2] |
| cannot do | free durable data; resolve without a registry crank at a new consumer; references beyond this daemon | mutable secrets (generations); per-grant revocation; a growing (readable before close) datum; remote reads over 61,440 bytes per call | anything not also in T2; the benefit is unmeasured |

### 3.3 Where the critique and a design disagree, and who is right

| claim | design | critique | checked | verdict |
|---|---|---|---|---|
| a vat reads only through a Reader it was given | T1 | the prototype's Reader is the producer endpoint; any holder of `epB` reads any key by `setPeer` + `resolveLocal` | `fixture/ephemeral.js` line 223: `key = await E(peer).resolveLocal(handle)`, keys sequential (`fixture/durable.js` `mint`) [code] | **critique**. The L-form fallback is a confused deputy by construction; production must drop it, use random keys and separate Reader and admin facets |
| a holder can trust envelope metadata without a round trip | T2 | forged envelope nested 64+ deep was delivered between Node sessions | `hub.js` `checkDataEnvelopes`: `if (depth > 64) return;` (silently accepts) [code] | **critique**. Vats cannot exploit it (they overflow encoding at depth 63); adapters and remote peers can. Fix: break the message past the bound |
| lifetime is OCapN GC | T2 | freed only after both adapters closed | `bench.mjs` case 5 closes A and B (lines 693-694) before the death check [code]. The hub's release code is sound on reading (`maybeReleaseRef`, `op:gc-answers` handler); a row is also pinned by an answer route `{ local }` (`isPinned`) until the asker sends `op:gc-answers`, which A's `close()` answer creates [code] | **critique**: unproven for live adapters. Not diagnosed; consistent with a pin on A's side (its answer route for `close()` or its import), since closing B alone did not free it [inference] |
| forgery refused (measured) | T3 | only for an integer payload | `dataref-store.mjs` `refAt`: `if (tk.kind !== 'int' ...) return undefined`; `fileOf = id => path.join(segDir, id.toString(16))` [code] | **critique**. The stand-in proves nothing about unforgeability; D-1 as designed has no readable id |
| inline 1 KiB is 29 % slower | T3 | 79.0 vs 77.6 ms in rerun | no code question | **critique** on this evidence; the difference is within spread |
| "blob-like fails after restart" | T3 | compares against an adapter object without the manager vat, which D-15 already abandoned | D-15 `resolveBlobs` [S1 3.1] | **critique**: the harness's real blobs survive restart |
| per-reference holding costs | T1, T3 | slot-page capacity divided by N; moves 50-80 % with N; T1 and T3 disagree 3x | method, not code | **critique**: ratios only |
| 64 MiB through baseline (b) takes 42-93 s | T1, T3 | adapter-to-adapter calls are not bound by the vat's frame limit; one 1 MiB answer moves in 210-304 ms, so 13-19 s; the real cost is hub-log growth | T2 measured the 1 MiB answer | **critique**; T1's 28.5 ms per page is an outlier and should not be quoted |
| D-1a needs `FinalizationRegistry` in the bootstrap (unchecked by the critique) | T3 | open | `ocapn/src/captp/finalize.js` captures `globalThis.FinalizationRegistry` at module load and `pairwise.js` builds the import table with it; T2's case 5 measured vats releasing a dropped import at their next collection. Guest code lacks it (T1 probe) [code, measured] | the in-vat client has it; D-1a is feasible on that point |

---

## 4. The proposed hub and OCapN change, as specification

This is T2's specification (`design-ocapn.md` 4) with the critique's corrections and mine. It is
not built in this form. "Must" marks what the prototype lacks.

### 4.1 Objects

- **Data origin.** The hub reserves one session key for itself (`hub:data`). It is never attached,
  retired or forgotten. Rows whose origin is the data origin are **data rows**. A data row's entry is
  one of: a power (`writer`, `reader`, `unsealer`), a builder, a datum `{ file, length, sha256?,
  sealed, revoked }`, or a datum admin.
- **Powers are introduced into an adapter's session at launch** by the embedder, as an ordinary
  reference in the adapter's binding (the way binding specs carry objects today). They **must not**
  be publications reachable by a swissnum; the prototype's constant swissnums are bearer names
  against the owner's principle.
- **Methods.**

| target | method | answer |
|---|---|---|
| writer | `create({ sealed?, digest? })` | builder |
| writer | `put(bytes, { sealed?, digest? })` | `{ datum, admin }` |
| writer | `adopt(stagedName, { sealed?, digest? })` | `{ datum, admin }` |
| builder | `append(bytes)` | length so far |
| builder | `close()` | `{ datum, admin }` |
| datum | `describe()` | `{ length, sha256? }`, or `{ sealed: true }` |
| datum admin | `revoke()` | undefined |
| reader | `read(datumOrEnvelope, offset, count)` | ByteArray, at most 1 MiB toward a local session, 61,440 bytes toward a remote one |
| reader | `locate(datumOrEnvelope)` | `{ file, length }` |
| unsealer | as reader, also on sealed data | |

  Changes from T2: `close`/`put` answer a separate **admin** facet (revocation per datum; the datum
  itself conveys no admin authority); **`sha256` is present only when the writer asks for it**
  (`digest: true`), because a hash in vat journals and model context is a guess oracle for
  low-entropy data (critique 3.1), and the harness needs it only for duplicate detection of staged
  submissions; **`adopt`** takes a file name inside a staging directory that the writer's adapter
  was given at launch, and renames it into the store.
- **Amplification is by row identity.** An argument naming data must decode to a data row whose
  entry is a datum; otherwise break "not a data reference". Sealed data opens only by an unsealer.
  A revoked datum breaks every method except `describe` with "revoked", before any file access.
- **Break texts are fixed** and never carry a path, a file name or content (`respondLocal`
  currently breaks with `String(error.message)`, which can carry a store path; critique 3.1).

### 4.2 Wire encoding

- A datum toward a session is the ordinary `desc:import-object` (25 bytes in Syrup).
- **Envelope** (level 1): a `desc:tagged` with a reserved, namespaced tag (T2's `thix:data` is a
  placeholder; the production name is the owner's decision, 6.3) and a record payload with exactly
  the keys `length` (integer), `ref` (a reference), and, when the writer asked for a digest,
  `sha256` (64 lowercase hex). For sealed data the payload is exactly `{ ref, sealed: true }`
  (T3's request: it reveals nothing a bare reference does not, and lets a vat-side representation
  recognise data imports). A 1 MiB datum's envelope with a digest is 150 bytes [measured by
  encoding, T2 4.5].
- `read` answers a Syrup bytestring; `locate` answers `{ file, length }`.

### 4.3 The envelope check

On every `op:deliver` (calls and resolver settlements), before routing, the hub walks the decoded
arguments through copyArray, copyRecord and Tagged payloads. Every envelope it finds must name a
non-revoked datum row with that `length` (and `sha256`, if present) and the matching `sealed` flag,
or the message breaks: "envelope does not match its reference". **A value nested deeper than the
walk's bound (64) breaks the message** ("too deeply nested"); it is never delivered unchecked. The
walk's cost per message was not measured.

### 4.4 Local answers

The hub answers data-row methods itself, as it answers its bootstrap. A reference answer records an
answer route `{ local: refId }` (and pins the row until `op:gc-answers`, as today). A non-reference
answer **must** be recorded so that `op:listen` on the answer position fulfils with the value, or
must break the listen with a fixed text; T2's `{ done: true }` route fulfils without a value, which
is a conformance bug for a non-Endo peer [code, critique 3.4]. `read` answers should take the
second option, so bytes never sit in an answer route in hub state.

### 4.5 Persistence, collection and revocation

1. A datum row is minted only after its file is durable (part file, fsync, rename, directory
   fsync). Rows persist in hub state (a `data` table and a `dataNext` counter; `STATE_VERSION` 3).
   Positions are never reused within a session epoch (`provideFacingPosition` [code, critique 3.2]).
2. Release is the ordinary rule (`maybeReleaseRef`: no facing session, not pinned). Releasing the
   last row naming a file queues it; the unlink runs after the next successful commit. Startup
   recounts and sweeps every file no row names and every part file.
3. **Acceptance condition before adoption:** a test with long-lived adapter sessions in which a
   datum created by A, passed through vats to B, and dropped everywhere, is unlinked while A and B
   stay connected. The spike's only passing case closed both adapters first.
4. **Revocation** is a durable flag on the datum entry, written by `admin.revoke()` before it
   answers; it breaks every later dereference and unlinks the file after commit. It cannot stop an
   adapter that already opened the file (adapters share the daemon's user and filesystem; see 4.7).
5. **Files are named by a random identifier**, not by content hash, when the writer did not ask for
   a digest. This removes content deduplication (and the side channel "two writers learn their
   contents are equal", T2 12) and lets `adopt` be a rename with no read by the supervisor.
   Datums with a digest are hashed off the hub thread before their row is minted [inference; not
   built].

### 4.6 Quotas and bounds

A per-writer quota on bytes and live datums; a bound on ByteArrays in frames toward worker sessions
(refuse rather than deliver bytes a vat cannot take). Neither is built.

### 4.7 What is weaker than an ideal design, stated

`locate` relies on the consumer adapter's ambient filesystem access to the store directory; every
adapter runs as the daemon user and could list it. The reader power is therefore the in-system check
between vats and adapters, not a boundary between adapters. Closing that needs descriptor passing
(Node IPC passes sockets, not arbitrary descriptors [recalled by T2 from the Node API, not tested])
or per-adapter OS users. The boundary every design actually enforces is vat versus adapter.

### 4.8 Negotiation and remote peers

None for level 1. A peer without the extension decodes an ordinary Tagged value holding a presence
and can pass it on. T2's level 2 (`desc:data`, negotiated through an `ocapn-noise` encoding version
or a bootstrap probe) is **not recommended**: no owner case needs it, and OCapN has no negotiation
mechanism to build it on.

### 4.9 How far this departs from the public drafts

- **Tagged:** the OCapN Model draft defines Tagged as a pair of a tag and a value, with no reserved
  tags, no namespacing and nothing about unknown tags or intermediaries; it says the tag "must be a
  String" [fetched: OCapN Model draft,
  https://github.com/ocapn/ocapn/blob/main/draft-specifications/Model.md]. Endo writes the tag as a
  Syrup selector (`ocapn/src/codecs/passable.js` `OcapnTaggedCodec` [code, critique 3.4]). The CapTP
  draft I fetched does not define `desc:tagged` at all [fetched: OCapN CapTP draft,
  https://github.com/ocapn/ocapn/blob/main/draft-specifications/CapTP%20Specification.md]; so
  whether a non-Endo peer decodes our envelope is **not established**.
- **An intermediary that interprets an application value** (breaking a message because a Tagged
  value lies about its referent) has no counterpart in the drafts; our hub is already a
  non-standard structural transcoder (S2 9.3). The check is local policy of our hub.
- **Hub-served objects** are ordinary exports from the point of view of every peer; nothing on the
  wire distinguishes them.
- The CapTP draft I fetched defines version checks at session start and no extension negotiation
  [fetched, same URL].

### 4.10 Engine change

**Not recommended now.** If a measurement of one held handle (not slot-page capacity) shows that
vats holding more than about 10^4 data references pay enough to matter, the order is D-1a (the
in-vat OCapN client mints a frozen methodless `Far('DataHandle', {})` per data import and reports
death through its existing `FinalizationRegistry`; no engine, digest or golden change), then D-1/D-2
(T3 1). Determinism rules any engine version must keep (T3 4, S3 5):

1. A handle is minted only while decoding a journaled frame, from the import position in that frame;
   the native reads no host state. On replay the same frame mints the same handle.
2. Metering is fixed per operation (mint, position lookup, drain), never by data length, I/O or
   cache state.
3. Death is reported only at points fixed by the GC schedule (part of the replay contract, C-7,
   C-17), drained into an ordinary outbound `op:gc-exports` frame at crank end; replayed frames are
   dropped by the hub's inbound watermark. A delayed release is always safe; an early one never
   happens because the hub, not the worker, owns the bytes and never re-sends a released position.
4. The handle has no own properties and no readable id; its natives are captured by the bootstrap
   and deleted from the global object before guest code runs.
5. A synchronous host read, if ever built, only for immutable data with a digest, checked on every
   fault, with a miss treated as an uncommitted host failure, never a guest error.

---

## 5. How the harness adopts it

### 5.1 Special cases, in order

| step | replaces | how | stays |
|---|---|---|---|
| 1a | `Blob` reachable only by the agent-host process (S1 3.3 item 3) | the workspace and containers adapter binding specs (M6, M10) carry the blob store directory and a resolve amplifier from the manager vat; a consumer resolves a `Blob` it was handed and opens the file. One adapter-side function, shaped `locate(blob) -> { file, length }`, so step 3 changes its backing and not its callers | `mintBlobs` stock, `resolveBlobs`, `Content` for vats and the browser |
| 1b | security of 1a | random blob keys instead of `b<n>`; no name-returning fallback (`resolveLocal`); the amplifier only in adapter specs, never on a facet a vat can reach; separate read and admin facets | |
| 1c | text-only blobs (S1 3.3 item 7) | binary blobs (`Buffer`, not UTF-8) for F-14 images and F-18 stdin; `Content.read` pages for text stay as they are | |
| 1d | export's 1,900 `Content.read` pages through the hub (F-19) | the export script, run beside the daemon, reads blob files through the same amplifier path | import keeps `writersFor` until adopt-by-file |
| 2 | (core) | C-1, C-2, then `hub:data` rows per section 4 | |
| 3 | D-15 blobs: manager minting, `resolveBlobs` after restart, the owner ACL (`texts.blobNotOwned`), no collection (m1b 17.1) | new stagings write data rows; `StagedText.blob` becomes the envelope's `ref`, `bytes` and `digest` the hub-checked `length` and optional `sha256`; old `b<n>` blobs read through the old path until their session is deleted | `StagedText.preview` (a deliberate copy) |
| 4 | the CLI's 1.4 MB sealed box through the hub (F-3) | the CLI, running beside the daemon, writes the sealed box into a staging directory and the `SecretWriter` adopts the file (T1-style in step 1, `adopt` in step 2); only a short call crosses the hub [inference; how the CLI is given that directory is open] | the box's encryption; `secrets.enc` |
| 5 | secret consumers confined to the agent-host process (D-6 as a process rule) | holder-applied use: providers outside agent-host call an agent-host provider object bound to its destination | `Secret`, `ReadGrant`, `SecretsAdmin`, generations, revoke, delete-after-revoke, the audit |
| 6 | archive `b<n>` names in segment files | only after C-2 and step 3: sealed records may keep references | until then, names in files (a reference that has left the object system) |
| 7 | exec vat source pages (F-9) | none: the exec vat reads on purpose; it gets a reader per call instead of `Content` after step 3 | the rare read path |

### 5.2 What M3, M4 and M5 as now contracted would change

- **M3 (UI and gateway):** nothing required. The browser reads large replies through `Content.read`
  pages in the gateway, which is in-process with the agent-host adapter; that is not a hub crossing.
  After step 3 the browser's `Content` would accept data rows; the contract's methods stay.
- **M4 (secrets, credentials, pools):** nothing required. The browser large-secret path is already
  in-process through the gateway extension (`m4-interfaces.md` 9.1 item 3, `LargeCall` on
  `SecretWriter.replace`), so values typed in the browser never cross the hub. The CLI
  `--value-file` path (sealed box through the hub) is the one place step 4 would change, outside
  M4's contract. M4 should not add any path in which a secret value or a store key crosses a vat.
- **M5 (presets, prompts, tools):** nothing required. Two touch points for later: label-map values
  (`ExecPowersSource.store`, `{ json }` up to 8,192 bytes resting in the session heap, F-15) could
  hold data references instead of copies; `systemTextOf` reads staged prompt pieces in the adapter
  and keeps working when blobs become data rows.

### 5.3 What stays as it is

The rule "vats are the system of record, adapters are the data path"; inline bounds (`frameBytes`
24,576, `inlineBytes` 8,192); previews in `StagedText`; `BlobWriter` for vat-produced text; D-6
for secret values; the archive's segment design until C-2.

---

## 6. What the spike did not establish, risks, and the owner's decisions

### 6.1 Not established

- Why a `hub:data` datum (T2) or an adapter-origin datum (T1 L) is not freed while adapters that
  received it stay connected. Candidates: an answer-route pin on the creator's side, the consumer's
  OCapN import, the hub's mention accounting. Not diagnosed.
- The cost of one held reference in a vat, isolated (all figures are slot-page capacity over
  batches; T1 and T3 disagree by about 3x).
- T2 over Node IPC (adapters were in-process clients); concurrency on the hub thread during large
  creations; the envelope walk's cost per message.
- Crash consistency between file rename and row mint, and between release commit and unlink
  (swept by design, tested once).
- T1's mid-pass SIGKILL was not re-verified by the critique (its kill landed after the pass).
- Whether a non-Endo OCapN peer decodes the envelope (tag as Syrup selector versus string).
- Whether harness vats can reach the hub's publication `lookup` (which would expose the
  prototype's swissnum powers).
- Data produced inside a vat (2.4): no design, no measurement.
- Attenuation (ranges, read-once, expiry), quotas, secret generations on hub rows: designed at most.

### 6.2 Risks

- Step 1 widens the set of processes that can read blob files (all adapters already run as the
  daemon user, so this does not widen it against a hostile adapter; it does make an amplification
  bug in any consumer a read-everything bug, hence random keys).
- Synchronous file I/O and fsync on the supervisor's single hub thread until adopt-by-file and
  off-thread hashing exist.
- A reserved application tag can collide with other users of Tagged values; it must be namespaced.
- C-2 remains the cost of holding many references in every design; without it, step 3 reintroduces
  the hub-row growth the archive cured.
- The prototypes' security mistakes (name-based amplification over a flat store, a possession check
  keyed to one encoding, a depth-limited check that accepts past its bound) are easy to carry into
  production; each needs a test that tries the attack.

### 6.3 Decisions for the owner (recommended default first)

1. **Where identity of bulk data lives long-term.** Default: the hub (T2 rows), after step 1 and
   C-1/C-2. Alternative: keep T1's registry vat and accept no collection.
2. **Secrets on hub sealed rows or holder-applied use.** Default: holder-applied use; revisit only
   if a secret consumer must live outside the agent-host process and cannot call it.
3. **Expose a content digest to vats.** Default: only when the writer asks (`digest: true`), for
   duplicate detection of staged submissions; never for sealed data.
4. **The reserved tag's name** and whether to propose anything upstream to OCapN. Default: a local
   namespaced tag, nothing upstream until the Tagged encoding question (4.9) is answered.
5. **Build level 2 (`desc:data`) for remote peers.** Default: no.
6. **Engine handle.** Default: no engine change now; measure one held handle first; D-1a before
   D-1.
7. **Accept `locate`'s reliance on ambient filesystem access** instead of descriptor passing.
   Default: accept, and record it as the boundary between adapters that this design does not
   provide.
8. **Content deduplication in the store.** Default: no (random file names), which makes adopt a
   rename and removes an equality side channel.
9. **Vat-produced data through an attenuated builder.** Default: measure first (2.4), decide after.

---

## 7. Fit findings for the running journal

- **Thixotrope is a control plane with persistent identity, not a data plane.** Every byte a vat
  receives costs heap, snapshot, journal, interned names and hub bookkeeping; the spike's designs
  all succeed by keeping bytes out of the object system and keeping only identity in it. A
  data-heavy service on Thixotrope needs a byte store beside it from the start.
- **The hub is the natural home for identity of things no vat owns.** It already persists c-lists,
  survives every restart, and sees every release; serving `hub:data` rows needed about 630 lines of
  prototype and no change to vats, codecs or engine.
- **The protocol is not the obstacle.** Level 1 is a Tagged value and a hub-served object; no wire
  change. The obstacles are hub-state costs that exist without this feature: C-1 (frames in clear in
  the hub state) and C-2 (whole-row rewrites per commit).
- **"Zero copy" in Node means zero copies inside the object system.** With no mmap and no general
  descriptor passing, two processes sharing bytes cost a write and a read. The object system's own
  path (frames through the hub) costs about 19 copies per page and 2.8 bytes of hub log per byte.
- **The engine's leverage is the per-byte inbound cost (C-5), not handles.** The rare read and every
  vat-bound message pay it; no reference design changes that.
- **Security hygiene is where prototypes went wrong**, not the architecture: name-based amplification,
  one-encoding checks, a depth bound that accepts. The object-capability rule held wherever it was
  applied (amplification by row identity, methodless handles).
- **Collection across long-lived adapter sessions is unproven** for any reference whose last holder
  is an adapter; it matters beyond data references (any adapter-held import).

---

## Appendix: time and method

Synthesis unit, 2026-11-18, started 04:35:04Z. I read the critique and the three designs in full or
by section, S1 sections 1-4, the M4 contract's gateway section, and checked in code: `hub.js`
(`checkDataEnvelopes`, `maybeReleaseRef`, `isPinned`, the `op:gc-answers` handler, the retiree
answer-route pass), T2's `bench.mjs` case 5, T1's `fixture/ephemeral.js` `keyOf`, T3's
`dataref-store.mjs` `refAt` and `fileOf`, `ocapn/src/captp/finalize.js`, `pairwise.js` and
`client/ocapn.js` GC emission. I fetched the OCapN Model and CapTP drafts (URLs in 4.9). No
benchmark was run in this unit; no command took over 60 s.
