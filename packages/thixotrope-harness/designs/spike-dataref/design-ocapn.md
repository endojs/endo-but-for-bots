# Spike dataref, design T2: data references in the hub and the OCapN protocol

Research spike, lane `claude/thix-dataref`, track T2. Not product code; the prototype commits are
marked "spike prototype, not merged". Base `36b3035e92`. Written 2026-11-18.

Evidence labels: **[measured]** by this track's benchmark (section 8, JSON lines with the commit);
**[code]** read from the named file and function; **[S1]..[S4]** the four surveys in this
directory; **[J-xxxx]** an earlier journal measurement, not re-run; **[spec]** a fetched public
specification (cited by the surveys; nothing new was fetched for this track); **[inferred]** my
reasoning, not executed.

Paths: `pkg/` = `packages/thixotrope/`, `H/` = `packages/thixotrope-harness/`, `ocapn/` =
`packages/ocapn/`.

---

## 1. The design in one page

**A data reference is an ordinary OCapN object reference whose origin is the hub.** The hub gets a
second piece of endpoint behaviour beside its bootstrap: a pseudo-origin `hub:data` that is never
attached, never retired and served by the hub itself. Its rows are normal `RefRow`s, so they are
exported toward every session as `desc:import-object`, passed on by c-list rewriting, pipelined on,
gifted and collected exactly like any other reference. No vat, no adapter and no remote peer needs
new code to *hold or pass* one.

**The bytes live beside the hub, not in it.** A content-addressed directory (`<state>/hub-data/`,
files named by SHA-256) holds them, written with write, fsync, rename, directory fsync before the
row exists. The hub state holds only `{ kind, hash, length, sealed }` per row in a new `data` table
(about 130 characters of JSON per row). Bytes are never in the hub state, its queues (C-1), a vat
frame, a journal or a snapshot.

**Metadata travels with the reference, checked by the hub.** A data reference may travel wrapped
in a reserved Tagged value, `thix:data` `{ length, ref, sha256 }` (the Model draft's own extension
point [spec]). The hub checks every such envelope in every `op:deliver` (calls and resolver
settlements alike) against its table before routing and breaks the message if it lies (level 1).
So a vat sees the length and hash deterministically, as frame content, and can trust them without a
round trip. A peer that does not know the tag still decodes an ordinary Tagged value holding a
presence.

**Reading is rights amplification by row identity.** A data row has one method, `describe()`. To
read, a holder presents the reference to a *reader*, itself a `hub:data` row (a power) that the
embedder gives to chosen adapters. The hub looks up the argument's row (identity, never a name) and
answers. A *sealed* datum (a secret) is opened only by the *unsealer* power, travels bare (no
envelope, no hash) and describes itself only as `{ sealed: true }`. Vats are given no reader unless
someone means them to read (the exec vat pattern, D-11).

**Two read paths.** `read(ref, offset, count)` answers a ByteArray in a frame (for remote peers and
for the rare vat read; the bytes then cross the hub like any argument). `locate(ref)` answers
`{ file, length }`: the content file's name in the directory the adapter was given at launch, so a
co-located adapter reads the file itself and no byte passes through the hub or the supervisor.

**Lifetime is OCapN GC.** When the last holder releases the row (`op:gc-exports`, or the adapter
session is forgotten), `maybeReleaseRef` drops the data entry and its per-hash count; the file is
unlinked only after that release has committed. A startup sweep removes every file no row names and
every part file. Rows survive restarts because the origin is the hub: no manager-vat minting (D-15),
no re-resolution crank after a restart, no C-19 tombstones.

**No wire change between our own sessions.** Workers, adapters and the endpoint all run our hub and
our `@endo/ocapn`; the envelope is standard OCapN. A negotiated level-2 descriptor `desc:data` is
specified in section 4.8 for peers beyond this daemon only, and not prototyped.

### Decisions and why

| question | decision | rejected, and why |
|---|---|---|
| where the bytes live | a content-addressed store beside the hub log, owned by the hub | **producer adapter**: its rows die with the incarnation (C-19, [S2] 7.2), which is why D-15 moved Blob identity into the manager vat at a crank per batch; **a shared store addressed by hash alone**: the hash becomes a bearer name and, for secrets, an offline guess oracle ([S4] 2.8, 4.4) |
| reference kind | ordinary exported object (hub-origin row) with a hub fast path, plus the reserved `thix:data` Tagged envelope for metadata | **new pass style in `@endo/pass-style` and marshal**: needs every vat bundle, the template key and every peer's marshal to change, and buys nothing a Tagged value does not; **new descriptor**: breaks every peer that does not know the label (our hub aborts a remote session on an undecodable frame, [S2] 10(c)); kept only as negotiated level 2 |
| who may dereference | holders of a reader power, amplified by row identity; sealed data only with the unsealer | **session-class policy** ("workers may not read"): ambient authority and naming-based ([S2] 10(d)); **bearer tokens** (sturdyref, swiss number): leak through logs, the hub log (C-1) and model text ([S4] 2.9) |
| how a consumer reads without a copy | `locate` + the adapter reads the content file directly; `read` in frames otherwise | **fd passing over Node IPC**: Node's `child.send` passes only sockets and servers, not arbitrary descriptors [inferred from the Node API, not tested]; a native SCM_RIGHTS module is possible later ([S4] 2.3) |
| negotiation | none for local sessions; a remote peer sees an object and a Tagged value | **new label without negotiation**: aborts unknown peers |

---

## 2. What a vat and an adapter see

### 2.1 The surface

| object | who holds it | methods (all answered by the hub) |
|---|---|---|
| data reference (`hub:data` row, kind data) | anyone it is passed to | `describe()` -> `{ length, sha256 }`, or `{ sealed: true }` for sealed data |
| `thix:data` envelope | anyone; a Tagged value | none (a value); `payload.ref` is the reference |
| writer power | adapters that create data | `create(sealed?)` -> builder; `put(bytes, sealed?)` -> data reference |
| builder | its creator | `append(bytes)` -> length so far (bigint); `close()` -> data reference |
| reader power | adapters (and a vat, on purpose) | `read(dataOrEnvelope, offset, count)` -> ByteArray (at most 1 MiB toward a local session, 61,440 bytes toward a remote one); `locate(dataOrEnvelope)` -> `{ file, length }` |
| unsealer power | the provider adapter(s) that use secrets | as the reader, and also on sealed data |

Errors are breaks with fixed texts that never quote content: "not a data reference", "this reader
cannot open sealed data", "envelope does not match its reference", "this builder did not survive a
restart".

### 2.2 The secret case

```js
// Secrets holder adapter A: seal locally, store the ciphertext as sealed data.
const box = seal(value); // AES-256-GCM with the store key, a file outside the state dir
const builder = await E(writer).create(true);
await E(builder).append(frozenBytes(box));
const secretRef = await E(builder).close(); // a bare reference: no hash, no envelope
await E(sessionVat).keep('apiKey', secretRef);

// Session vat: holds and passes; it has no unsealer, so it cannot read.
use: (slot, provider) => E(provider).use(kept.get(slot)),

// Provider adapter B (was given the unsealer and the store key at launch):
use: async ref => {
  const { file } = await E(unsealer).locate(ref);
  const value = unseal(readFileSync(join(dataDir, file)));
  return sendRequestWith(value); // the value never goes back toward a vat
},
```

### 2.3 The bulk forward case

```js
// Adapter A
const builder = await E(writer).create();
for (const chunk of chunks) await E(builder).append(frozenBytes(chunk));
const ref = await E(builder).close();
const { length, sha256 } = await E(ref).describe();
const datum = makeTagged('thix:data', harden({ length, ref, sha256 }));
await E(v1).keep('report', datum);

// Vat V1, later
E(v2).keep('report', kept.get('report')); // about 150 bytes of frame, whatever the size

// Vat V2
E(consumer).consume(kept.get('report'));

// Adapter B
consume: async datum => {
  const { file } = await E(reader).locate(datum);
  return sha256OfFile(join(dataDir, file)); // B's own read; nothing passes the hub
},
```

---

## 3. Changes by layer and file

Prototype commits in this lane: `733deabd9b` (hub, hub state, data store, daemon wiring), `556596ab1a` (copy an emulated byteArray once on write; clearer break texts), `7db2a25516` (benchmark). Line counts are `git diff --stat`.

| layer | file | change | size |
|---|---|---|---|
| hub | `pkg/src/net/hub.js` | `DATA_ORIGIN`, `DATA_TAG`; `dataStore` option; tables `dataEntries`, `dataNext`, `dataBuilders`, `dataHashCounts`, `dataUnlinks`; `mintDataRow`, `releaseDataEntry`, `dataOfArgument`, `checkDataEnvelopes`, `respondLocal`, `handleDataDeliver`; hooks in `handleMessage` (`op:deliver` envelope check and local dispatch; `op:listen` on a data row settles at once), `maybeReleaseRef` (no GC frame, release the entry), `persist` (unlink after commit), restore (count and sweep), `retireSessionInternal` (refuses `hub:data`), `inspect` (data rows retain no vat); API `publishDataPower`, `dataStats`; per-session frame byte counters in `stats().frameBytes` (measurement only) | +422 |
| hub state | `pkg/src/net/hub-state.js` | optional `data` table and `dataNext` scalar in the serialized state; restored when present. A production change bumps `STATE_VERSION` to 3 | +30 |
| hub store | `pkg/src/net/hub-data-store.js` (new) | content-addressed directory: `begin` (part file, incremental SHA-256, fsync, rename, dir fsync), `read`, `has`, `unlink`, `sweep` | +173 |
| daemon | `pkg/src/core/daemon.js` | `hubDataStore` option passed to the hub; `publishDataPower`, `inspectHubData` (minimal and additive; the file is not a hub file, said here as the rules ask) | +9 |
| OCapN codecs | `ocapn/`, `captp`, `marshal`, `pass-style`, `syrup-frame` | **none**: level 0 and level 1 need no codec change | 0 |
| boot bundles, worker, engine | none: the in-vat code is unchanged, so the template key and snapshot goldens are unchanged | 0 |
| harness | none in this spike; adoption in section 11 | 0 |
| benchmark | `H/test/spikes/dataref-ocapn/bench.mjs` (new) | the shared benchmark, section 8 | 842 |

Another track's uncommitted edit to `pkg/src/core/durable-worker-transport.js` (CC-087, a frame
filter under a registered global symbol) was present in the worktree while this track measured; it
is inert unless that symbol is set, which this benchmark never does.

---

## 4. Specification text (implementable)

### 4.1 Terms

- *Hub*: an OCapN forwarding node as in `pkg/src/net/hub.js`.
- *Data origin*: a session key reserved by the hub (`hub:data`). It is never attached, never
  retired and never forgotten; `retireSession` on it is an error.
- *Data row*: a reference row whose origin is the data origin. Its *entry* is one of: `power`
  (`writer` | `reader` | `unsealer`), `builder` (`sealed`), `data` (`hash`, `length`, `sealed`).
- *Data store*: a directory of immutable files named by the lowercase hex SHA-256 of their content,
  plus part files named `.part-*`.

### 4.2 Minting

1. Data rows are minted only by the hub: power rows by the embedder (`publishDataPower` in the
   prototype; production: introduced into an adapter's session at launch), builder and data rows by
   `create`, `put` and `close`.
2. A data row's position is a counter (`dataNext`), never reused; its refId is
   `hub:data#0:<position>`.
3. A data entry is minted only after its file is durable (written, fsynced, renamed, directory
   fsynced). Equal content minted twice gives two rows naming one file; the hub counts rows per
   hash.

### 4.3 Messages to data rows

The hub handles `op:deliver` whose target resolves to a data row locally, as it handles its
bootstrap, without forwarding. It answers through the sender's resolver and records the answer
route: `{ local: refId }` when the answer is a reference, `{ done: true }` otherwise (a pipelined
message on such an answer breaks: "settled to a non-reference value"). `op:listen` on a data row
fulfils at once with the row. `op:get`, `op:index` and `op:untag` on a data row break. Methods,
by entry kind, are those of section 2.1; any other method breaks "no method <name>". A builder
entry is process-local: after a restart, a message to a builder breaks "did not survive a restart".

Arguments naming data are a data reference or a `thix:data` envelope. Amplification: the argument's
decoded token must name a row whose origin is the data origin and whose entry is `data`; else
"not a data reference". A sealed entry is opened only by an unsealer.

### 4.4 The envelope (level 1)

`thix:data` is reserved. A `desc:tagged` with that tag must carry a record with exactly the keys
`length` (integer), `ref` (a reference) and `sha256` (64 lowercase hex characters). On every
`op:deliver` the hub walks the decoded arguments (copyArray, copyRecord and Tagged payloads, to depth
64); every `thix:data` it finds must name a non-sealed data row with that length and hash, or the
message breaks before routing ("envelope does not match its reference"). Sealed data has no
envelope.

### 4.5 Wire encoding (Syrup, measured by encoding with `ocapn/` codecs)

A data reference toward a session is the ordinary descriptor, e.g. 25 bytes:

```
<18'desc:import-object5+>
```

The envelope of a 1 MiB datum is 150 bytes (keys in Syrup's canonical order):

```
<11'desc:tagged9'thix:data{6"length1048576+3"ref<18'desc:import-object5+>6"sha25664"<64 hex>}>
```

`read` answers a Syrup bytestring `<count>:<bytes>`; `locate` answers
`{4"file64"<hex>6"length<n>+}`.

### 4.6 Collection and persistence

1. A data row is released by the ordinary rule (`maybeReleaseRef`: no facing session, not pinned by
   a publication, gift or answer route). No GC frame is sent (the hub is the origin).
2. Releasing a `data` entry decrements its hash's count; at zero the hash is queued for unlink, and
   the unlink runs after the next successful commit, only if no row minted since names the hash.
   Releasing a builder aborts it and deletes its part file.
3. The `data` table and `dataNext` persist with the hub state (per-entry deltas in the log store).
   At startup the hub recounts rows per hash and sweeps every file no row names and every part file.
4. Revocation is not collection: a holder that must lose access (a secret revoked) needs a store-side
   flag checked at each dereference (section 7.4); GC only reclaims bytes.

### 4.7 Limits

`read` answers at most 1 MiB toward a local session and 61,440 bytes toward a `remote` session
(Noise allows 65,519 plaintext bytes per message, [S2] 6). Builders bound nothing in the prototype;
production needs a quota per writer (section 10).

### 4.8 Level 2 (not prototyped): `desc:data` for peers beyond this daemon

For a remote OCapN peer that wants to verify content without our hub (dedupe or fetch from another
holder by hash), a new descriptor `<desc:data ref length sha256>` with `ref` an import descriptor.
It must be negotiated: either a new `ocapn-noise` encoding version (our netlayer only, [S2] 9.3) or a
bootstrap probe `fetch("ocapn-ext:data")` answered with a marker object before first use; without
it the hub writes the level-0 envelope instead. A peer that never negotiates sees only level 0. This
is the only part of the design that changes the wire, and nothing the owner asked for needs it.

---

## 5. Security argument

1. **A vat holding a data reference cannot read it.** Its only method is `describe()` (length and
   hash, which the vat already has from the envelope). Every byte path needs a reader or unsealer
   row as the *target* of the call. A vat gets one only if some holder passes it one; powers are
   rows the embedder mints and gives to adapters. The hub decides by the target's row entry (an
   object identity), not by who the sender is.
2. **A vat cannot forge a reader** for the same reason it cannot forge any reference: positions are
   per session c-list entries ([S4] 3). It cannot forge metadata: the hub refuses an envelope whose
   length or hash differs from its table (measured refusal in section 8). It cannot name a datum by
   hash: no method takes a hash or a file name; `locate` gives a file name only to a reader holder,
   and that name is useless without filesystem access, which vats do not have.
3. **Sealed data.** The secrets holder adapter encrypts before writing; the hub stores and moves
   only ciphertext and never has the key (the key file stays outside the state directory, as
   `secrets.enc`'s does today, [S1] F-1). Sealed rows have no hash and no envelope (no guess oracle,
   [S4] 4.4). Only the unsealer opens them, and with `locate` the ciphertext does not pass through
   the hub either. Measured: no hit of the value, its hex or base64 in V1's journal, V1's snapshot,
   the hub log or the data directory (section 8, case 1).
4. **Confused deputy.** The provider is bound to its destination at creation, as `makeBackend`
   binds `baseUrl` and `keyGrant` today ([S4] 4.7); the data reference passed in designates only
   the value. The provider must never answer with the value or quote it in an error; the hub
   cannot enforce that (it does not read answers' content), so it is a rule for provider code.
5. **What is weaker than an ideal ocap design** (honest list):
   - `locate` relies on the adapter's ambient filesystem access to the data directory. Every adapter
     process runs as the daemon user and can read the state directory anyway (architecture 6), so
     the reader power is the in-system check, not an OS boundary. An fd-passing variant would close
     this.
   - Readers are all-or-nothing over every datum (like `Content` today). Range-limited, per-datum
     or expiring readers are a straightforward extension (a reader entry with a bound row set or
     range), not built.
   - A reader holder can copy bytes into a vat as a ByteArray argument. The hub could refuse frames
     toward worker sessions whose ByteArrays exceed a bound ([S2] 11 item 2); not built.

---

## 6. Determinism, restart and collection

- **What the vat observes** is only frame content: the reference (a position in its own c-list),
  and in the envelope the length and hash. Nothing is fetched live in a crank. A vat that reads
  (`read`) receives the bytes as an ordinary answer frame: journaled, deterministic on replay, and
  costed as any inbound frame ([S3] 5.4). This satisfies [S3] constraints 1-3 with no engine change.
- **Replay** regenerates the same outbound frames with the same sequence numbers; the hub drops
  duplicates by its inbound watermark (`processedUpTo`), so a replayed pass or GC frame is not
  applied twice [code: `deliverFrame`]. Section 8 case 4 measures this across a SIGKILL.
- **Restart**: the data rows, their entries and every holder's c-list entry are hub state; the files
  are in the data directory. After a restart the same positions resolve to the same rows. No vat or
  adapter crank is needed to re-resolve anything. Builders do not survive (their callers see a
  break and start again); a part file is swept.
- **Collection** is the existing OCapN chain: vat finalizers (at the vat's next collection, up to 32
  cranks later, CORE-11), GC frames held up to 64 per crank, and the hub's release. A transient
  adapter's holdings are released when its session is forgotten. Section 8 case 5 measures how long
  it takes. The file goes only after the release is durable, so a crash between commit and unlink
  leaves a file the next startup sweeps, never a row without its file.

---


## 7. Measured results against the shared benchmark

Two full runs, both under `--exclusive` with `THIX_AGENT=T2`, about 15 s and 23 s of benchmark each:
run 1 at commit `7db2a25516` (03:47 UTC), run 2 at `4424eff86c` (03:50 UTC; the only difference is
another track's inert transport seam, `a86340a6a1`). Values are "run 1 / run 2". Times are wall
milliseconds seen by the test process, each including the vat crank(s) on the path. Node v22.23.4,
release Ironhorse worker, fs store with the hub log store and fsync. Raw lines: section 8.

**Stubs, and what they do not change.** The two "adapters" are transient hub clients in the test
process (the native adapter's session kind: `transient:*`, discardOnRestart, coalesced inbound), so
Node IPC base64 is not on the path: it would add per-byte cost to creation and to `read`, nothing to
passing. The secrets store key is a run-time key shared by the test's A and B (standing for the key
file outside the state directory). The harness's agent-host blob path (manager-minted `Blob`,
`resolveBlobs`, `Content`) was not run; baseline (b) is the same shape without the manager vat (an
adapter-exported object read in 20,480-byte pages) and the D-15 costs are quoted from the journal.

### 7.1 Case 1: secret use

| value | proven by keyed digest | create (A, sealed) | keep (A -> V1) | use (V1 -> provider B, unseal via `locate`) | hits of raw / hex / base64 (3 alignments) in V1 journal, V1 snapshot, hub log, hub data dir |
|---|---|---|---|---|---|
| 64-byte string | yes / yes | 46 / 48 ms | 30 / 31 ms | 146 / 243 ms | 0 in all four (run 1 and run 2) |
| 1 MiB random | yes / yes | 55 / 67 ms | 80 / 156 ms | 155 / 195 ms | 0 in all four |

Frames of the use step: V1 sent 236 bytes and received 219 (64 B case); B's session 307 in, 337 out.
The value is in no frame. The hub data directory holds only AES-256-GCM ciphertext. V1 slept
(snapshot) between keep and use, so the reference was used from durable vat state.

### 7.2 Case 2: bulk forward A -> V1 -> V2 -> B

| datum | create (A, 1 MiB appends) | A -> V1 | V1 -> V2 | V2 -> B, B reads all (`locate`) and hashes | digest ok | bytes into V1 per hop (from the hub) | V1 / V2 journal growth over the three hops | V1 / V2 heap slot capacity growth | V1 / V2 snapshot growth | hub log growth over the three hops |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 KiB | 29 / 68 ms | 80 / 215 | 179 / 324 | 74 / 83 | yes | 226 (A -> V1) | 698 / 675 B | 0 / 0 | 4 / 28 KB (run 1) | 30.9 / 30.4 KB |
| 1 MiB | 30 / 69 ms | 114 / 437 | 165 / 321 | 48 / 81 | yes | 230 | 706-778 / 758 B | 0 / 0 | 4 / 8 KB | 35.7 / 34.6 KB |
| 64 MiB | 422 / 950 ms | 133 / 158 | 185 / 179 | 112 / 172 | yes | 232 | 858 / 762 B | 0 / 0 | 8 / 0 KB | 35.9 / 36.5 KB |

Reading: every hop costs the same at 1 KiB and 64 MiB; the vats see a 150-byte envelope (frames of
about 220-330 bytes per call). Slot capacity is counted in 256-slot pages from the snapshot's
`slot_pages`, so 0 means "less than one page". Snapshot growth is SQLite page noise of 0-28 KB, not
data. The hub log grows about 10-12 KB per hop whatever the size: that is the C-2 whole-row rewrite
of the sessions a hop touches, not the payload. The data directory holds the datum once
(`rowBytes` 69,207,160 with all five data rows live).

### 7.3 Case 3: rare read (V1 reads bytes 0..1023 of the 1 MiB datum)

V1 was given a reader on purpose. 112 / 217 ms; V1 received 1,164 bytes in frames (the 1,024 bytes as
a Syrup bytestring plus the answer), its journal grew 1,616 bytes (base64), heap slot capacity and
snapshot did not grow measurably (the bytes were garbage after the crank). The ByteArray *is*
passable into an Ironhorse vat in this build: `byteLength` 1024 and the first byte read back
(answering the question [S1], [S2] and [S3] left open; J-0023's "not passable" no longer holds for
answers). The read is one journaled delivery, deterministic on replay.

### 7.4 Case 4: restart

| event | result |
|---|---|
| shutdown, start, then V1 gives the 1 KiB reference to a new B | digest ok; shutdown 253 / 555 ms, start 84 / 101 ms, first use 129 / 212 ms; 4 data rows restored |
| SIGKILL of a child daemon running V1 -> V2 passes in a loop (killed after it reported 3 pass starts), restart in the parent | V2's keep count went 6 -> 8 for 3 started passes: 2 committed, the third lost before commit, none duplicated; restart 417 / 500 ms; V2's newly stored reference and V1's original both read back with the right digest |

What persists: the `data` table (`{ kind, hash, length, sealed }` per row), `dataNext`, every
holder's ordinary c-list entry, and the files. Nothing is re-resolved: no manager crank and no
`resolveBlobs` after the restart.

### 7.5 Case 5: death

V1 and V2 dropped their copy of the 1 MiB reference and the two adapters' sessions were closed
(forgotten, which releases their holdings). The file was gone after 3 rounds of one ping to each vat
(622 / 1,093 ms): the vats' finalizers ran at their next collections and the GC frames released the
row; the hub dropped the entry and unlinked the file after the commit. Data rows went 5 -> 4. The
other four datums, still held, stayed.

### 7.6 Baselines

| path | 1 KiB | 1 MiB | 64 MiB |
|---|---|---|---|
| (a) inline through the vats (a 1 KiB string) | ok; A -> V1 92 / 156, V1 -> V2 126 / 219, V2 -> B 46 / 76 ms; V1 sent 1,268 and received 1,303 bytes over the three hops (the string twice) | **fails**: the 1 MiB string halts the receiving vat (`guest crank halted: MeterAbort`), the hub retires it and the caller gets "the target session has been retired" after 809 / 1,008 ms | not attempted (fails a fortiori) |
| (b) an adapter-exported object handle passed V1 -> V2 -> B, B reads it in 20,480-byte pages through the hub | pass 26 + 72 ms, read 51 ms | pass 21 + 65 ms, read **759 / 1,238 ms** (52 page round trips; 1.05 MB through the hub twice) | not run [inferred: about 3,300 round trips, 48-80 s] |
| (b') the harness's agent-host `Blob` (D-15) | not run here: per handle one manager exo minted 32 per crank, `resolveBlobs` one manager crank per 64 handles per adapter incarnation; `Content.read` pages of 20,480 bytes, 20-25 ms each between processes (J-0163, J-9043); handles die with nothing but files remain (m1b 17.1) | | |
| this design, `read` in frames instead of `locate` (61,440-byte pages / one 1 MiB read) | | 398 / 545 ms for 18 reads; 228 / 304 ms for 1 read; **hub log +1.72 MB** for the single 1 MiB answer (the frame queued as hex, C-1) | |
| this design, `locate` | 74 / 83 ms (pass included) | 48 / 81 ms | 112 / 172 ms |

Authority checks (both runs): a `thix:data` envelope with a false length breaks "envelope does not
match its reference"; a reader on sealed data breaks "this reader cannot open sealed data"; the
unsealer opens it; `describe` of sealed data answers `{ sealed: true }`; a reader given an adapter
object breaks "not a data reference"; a data reference has no `read`.

---

## 8. Benchmark: method and raw lines

`H/test/spikes/dataref-ocapn/bench.mjs`, run from `H` as
`THIX_AGENT=T2 node scripts/run-lock.mjs --exclusive --label dref-ocapn -- node test/spikes/dataref-ocapn/bench.mjs`.
It makes a fresh state directory under the system temporary directory, starts a daemon with
`hubDataStore`, publishes the three powers, creates V1 and V2 (holder program in the file), opens A
(writer) and B (reader, unsealer), runs the cases in the order 1, 2, read-in-frames, checks, 3,
(a), (b), 5, 4, and removes the directory. The search in case 1 looks for a 48-byte slice from the
middle of the value as raw bytes, hex, and base64 at the three byte alignments, in V1's
`journal.jsonl` before the snapshot, the snapshot image after it, `hub-image.json`, `hub-log.jsonl`
and every file of the data directory. Frame bytes are the hub's per-session counters
(`stats().frameBytes`, toHub = frames the session sent, fromHub = frames the hub sent it).

Run 1, commit `7db2a25516` (frames fields abbreviated to the V1 entry; full lines are printed by the
script):

```
{"case":"1 secret use","size":"64 B","proven":true,"createMs":45.93,"keepMs":29.92,"useMs":146.19,"hits":{"journalV1":{},"snapshotV1":{},"hubStore":{},"hubDataDir":{}}}
{"case":"1 secret use","size":"1 MiB","proven":true,"createMs":55.16,"keepMs":80.13,"useMs":155.04,"hits":{"journalV1":{},"snapshotV1":{},"hubStore":{},"hubDataDir":{}}}
{"case":"2 bulk forward","size":"1 KiB","ok":true,"createMs":29.15,"passMs":{"A->V1":79.9,"V1->V2":179.33,"V2->B(read all)":74.09},"frames":{"A->V1":{"V1":{"toHub":110,"fromHub":226}}},"journalGrowth":{"V1":698,"V2":675},"slotsGrowth":{"V1":0,"V2":0},"snapshotGrowth":{"V1":4096,"V2":28672},"hubStoreGrowth":30906}
{"case":"2 bulk forward","size":"1 MiB","ok":true,"createMs":30.19,"passMs":{"A->V1":113.63,"V1->V2":164.9,"V2->B(read all)":48.18},"frames":{"A->V1":{"V1":{"toHub":115,"fromHub":230}}},"journalGrowth":{"V1":706,"V2":758},"slotsGrowth":{"V1":0,"V2":0},"snapshotGrowth":{"V1":4096,"V2":8192},"hubStoreGrowth":35654}
{"case":"2 bulk forward","size":"64 MiB","ok":true,"createMs":422.03,"passMs":{"A->V1":133.33,"V1->V2":184.8,"V2->B(read all)":111.89},"frames":{"A->V1":{"V1":{"toHub":115,"fromHub":232}}},"journalGrowth":{"V1":858,"V2":762},"slotsGrowth":{"V1":0,"V2":0},"snapshotGrowth":{"V1":8192,"V2":0},"hubStoreGrowth":35910,"hubData":{"rows":5,"hashes":5,"rowBytes":69207160}}
{"case":"read in frames","size":"1 MiB","page":61440,"ok":true,"reads":18,"ms":398.11,"hubStoreGrowth":109676}
{"case":"read in frames","size":"1 MiB","page":1048576,"ok":true,"reads":1,"ms":227.3,"hubStoreGrowth":1721007}
{"case":"3 rare read","ok":true,"ms":115.26,"value":{"byteLength":1024,"first":4},"frames":{"V1":{"toHub":443,"fromHub":1164}},"journalGrowthV1":1616,"slotsGrowthV1":0,"snapshotGrowthV1":0}
{"case":"baseline a inline","size":"1 KiB","ok":true,"passMs":{"A->V1":91.98,"V1->V2":125.88,"V2->B":46},"frames":{"V1":{"toHub":1268,"fromHub":1303}}}
{"case":"baseline a inline","size":"1 MiB","outcome":"ocapn hub: the target session has been retired","ms":809}
{"case":"baseline b adapter object handle","size":"1 MiB","ok":true,"passMs":{"A->V1":20.91,"V1->V2":64.91,"V2->B(read all, 20 KiB pages)":759.11},"journalGrowthV1":462}
{"case":"5 death","size":"1 MiB","freed":true,"pingRoundsUntilFreed":3,"ms":622,"hubDataBefore":{"rows":5},"hubDataAfter":{"rows":4}}
{"case":"4 restart (shutdown)","ok":true,"shutdownMs":253,"startMs":84,"firstUseMs":129.19}
{"case":"4 restart (SIGKILL mid-pass)","killedAfterPassesReported":3,"passesStarted":3,"keepsBeforeChild":6,"keepsAfterRestart":8,"noDuplicate":true,"restartMs":417,"v2RefWorks":true,"v1RefWorks":true}
```

Run 2, commit `4424eff86c`: the same cases with the values given second in section 7 (identical
outcomes; times 1.0-3.8 times run 1's, the machine being shared by other lanes between exclusive
runs). The baseline (b) 1 MiB line's `hubStoreGrowth` is negative in both runs because the hub log
compacted during it.

---

## 9. What "zero copy" honestly means here, counted from the code

Copies of the N payload bytes in the bulk-forward case (prototype, in-process adapters):

| step | copies | where |
|---|---|---|
| A encodes `append(bytes)` | 2 | `ocapn/src/syrup/encode.js` `writeBytestring` (fresh mutable buffer, then the writer) |
| (production only) Node IPC from the adapter process | about 4 encodings | base64, JSON, parse, decode ([S2] 3.1); not on this benchmark's path |
| hub decodes the frame | 1 | `ocapn/src/syrup/decode.js` `frozenBytes` |
| hub turns the emulated byteArray into a genuine view | 1 | `hub.js` `bytesOf` (`slice`) |
| hub writes the part file | 1 (into the kernel page cache) | `hub-data-store.js` `append` (`writeSync`); SHA-256 reads the same buffer, no copy |
| **A -> V1 -> V2 -> B passing** | **0** | only a 150-byte envelope moves; nothing in any vat heap, frame, journal or snapshot, nor in the hub state or queue |
| B reads via `locate` | 1 (page cache -> B's buffer) | `fs.createReadStream` in B |

So: **zero copies while the reference is held, stored, passed or handed out, however many hops**;
four user-space copies and one kernel copy to create it through frames (one kernel copy with an
adopt-by-file side channel, section 10); one kernel-to-user copy for the consumer to read it. Across
processes "zero copy" cannot mean shared pages without mmap (Node has none) or fd passing (Node IPC
cannot carry arbitrary descriptors [inferred from the Node API]); it means the bytes never pass
through the supervisor's hub, a vat or any persisted protocol state. With `read` in frames instead
of `locate`, a 1 MiB answer adds 6 copies plus 2 N characters of hex in the hub log (measured +1.72
MB), the C-1 cost.

---

## 10. Costs that remain, and what it cannot do

Costs that remain:

1. **A crank per hop.** Passing still costs each vat a crank (here 80-440 ms per hop including the
   test's round trip), the same as passing any small reference.
2. **Hub rows per holder.** Each holder of a data reference is one `facing` / `refcounts` /
   `ourExports` entry (about 51 bytes persisted each, [S2] 4.2), plus one `RefRow` and one data
   entry (about 110 characters, from the serializer) per datum. Every hub commit still stringifies
   every row (C-2). Thousands of references held for long sessions still need C-2's per-row dirty
   tracking or aggregation, exactly as [S1] 4.1 found; this design removes bytes, not rows.
3. **Hub log per hop**: 10-12 KB per hop measured, from whole-row rewrites (C-2), independent of
   size.
4. **Creation through frames is per byte in the supervisor** (64 MiB: 422 / 950 ms on the hub's
   single thread, blocking every other session meanwhile). An adopt-by-file side channel (the writer
   adopts a file the adapter wrote into a staging directory it was given; one rename) is the fix; not
   built.
5. **GC lag**: freeing follows vat collections (3 ping rounds here; up to 32 cranks or a vat's whole
   sleep in general, CORE-11, C-17).

What it cannot do (as built):

- **Mutable secrets under a stable reference** (generations, replace, renewal, R4-82). A data row is
  immutable. Secrets keep a `Secret` identity whose current value is a sealed data reference that
  `replace` swaps; the swap lives in whichever object holds the identity (today the manager vat).
  A "slot" entry kind (a mutable pointer row owned by the secrets writer) is the natural hub
  extension; not built.
- **Revocation per grant.** Readers are all-or-nothing; revoking a datum needs a store-side flag
  (unbuilt) checked at every dereference.
- **Append with a visible length** (streamed reply checkpoints, [S1] 4.3): a builder is not readable
  before `close`. A readable builder answering `{ length }` snapshots is a small extension.
- **Fd passing or shared memory.** `locate` depends on the adapter's filesystem access.
- **Direct adapter-to-adapter transfer between hosts.** A remote peer reads in 61,440-byte pages
  through calls; level 2 would let it fetch by hash elsewhere.
- **Quotas.** Nothing bounds a writer.

---

## 11. Adoption in the harness

Special cases it replaces, in migration order:

1. **Prerequisites that pay off anyway**: C-1 (no queued frames of discardOnRestart sessions in the
   persisted state) and C-2's per-row dirty tracking, so that holding many references is cheap.
2. **Core**: state version 3; powers introduced into adapter sessions at launch (not publications);
   adopt-by-file; quota per writer; the hub refusing large ByteArrays toward worker sessions.
3. **Blobs (D-15, F-5..F-10)**: new stagings write data references; `StagedText.blob` becomes the
   envelope (its `bytes` and `digest` are then the hub-checked `length` and `sha256`). This removes
   the manager vat's `mintBlobs` stock, `resolveBlobs` after each restart, the owner ACL
   (`texts.blobNotOwned`, replaced by giving a session a reader, or later a per-session reader), and
   it makes blobs collectable when the last reference goes (m1b 17.1 "Not done"). Old `b<n>` blobs
   keep reading through the existing path until a session is deleted.
4. **Content.read and the exec vat (F-9)**: the exec vat gets a reader per call instead of
   `Content`; pages are `read` ranges.
5. **Secrets (F-1..F-3)**: store values as sealed data written by the secrets holder (ciphertext
   only); `Secret` keeps its identity and generations and points at the current sealed reference;
   providers get the unsealer and the key file. Any adapter process can then use a credential
   without it crossing the hub (today every consumer must live in the agent-host process, D-6). The
   CLI's 1.4 MB sealed box would go through adopt-by-file instead of a hub frame.
6. **Binary data (F-14 images, F-18 stdin)**: data references are bytes, not UTF-8 text; a
   workspace adapter can hand the agent host a 2 MiB image as a reference.
7. **Export and import (F-19)**: the CLI reads with `locate` instead of 1,900 `Content.read` pages.
8. **Archive (F-12)**: segments could keep references instead of `b<n>` keys, but only after step 1
   (rows), so last.

---

## 12. Risks, open questions, estimate

Risks:

- Synchronous file I/O on the supervisor's hub thread (creation, `read`). Mitigation: adopt-by-file
  and capped reads; measure under concurrency.
- `locate` is an ambient-authority shortcut; it is no weaker than today (adapters can read the state
  directory), but it is not an OS boundary.
- The envelope walk runs on every `op:deliver` (O(argument size)); not measured separately here.
- The reserved tag `thix:data` could collide with an application tag; a production name should be
  namespaced and documented.
- Non-reference local answers (`describe`, `read`, `locate`) reach the caller only through the
  resolver; a peer that listens on the answer position instead would see a value-less fulfilment
  (`{ done }` route). All our clients use the resolver.
- A crash between a release commit and the unlink leaves a file the startup sweep removes; a crash
  between file rename and row mint leaves an unnamed file, also swept. Not crash-tested beyond the
  one SIGKILL above.

Open questions:

- Should data be content-deduplicated across writers (it is now, by file) given that two writers
  then learn that their contents are equal through `describe`? Not for sealed data, which has no hash.
- Per-datum or per-session readers (attenuation) versus one reader per adapter.
- Whether the data origin should also serve mutable slots (secrets generations, growing replies).
- Interaction with the dataref engine track (T3): a vat-side handle minted by the bootstrap could
  wrap this hub row, if per-import vat cost turns out to matter (not measured here).

Estimate to production quality (core only, [inferred]): 4-6 days: state version and migration,
powers at adapter launch, adopt-by-file, quotas and refusal of large ByteArrays toward workers,
crash-consistency tests around mint, release and sweep, unit tests in `pkg/test` next to
`hub.test.js`, and a measured concurrency run. Harness adoption (steps 3-7 above): about 1.5-2
weeks, dominated by migrating blobs and secrets and their tests. C-2's per-row dirty tracking is a
separate prerequisite.
