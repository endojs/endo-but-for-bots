# S1 survey: where data passes a vat without being read, today

Research spike "zero-copy data references" (lane `claude/thix-dataref`), survey S1. Nothing here is
product code. The question it answers for the designers: in the Thixotrope harness as built (M1a,
M1b, M2) and as specified (M3, M4, M5 contracts, later milestones in `milestones.md`), where are bytes
produced in one place and consumed in another with a vat between them or holding the reference;
what does each path cost; what mechanisms already give "reference without reading"; and how each
falls short of the owner's wish that a vat can hold, pass, store and hand out a reference to data
without the bytes ever entering its heap, frames, snapshot or journal.

Paths: `H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`, `pkg/` =
`packages/thixotrope/`. Journal ids (J-xxxx) are entries of `H/JOURNAL.md`.

**Evidence tags.** [M] measured, with the journal entry; [C] read from code, with file and
function; [D] stated by a design or contract document (section given), not re-checked in code;
[I] my inference. Nothing in this document was measured by this spike; every [M] number is the
journal's.

---

## 1. What a byte costs when it crosses or rests in a vat

The reason the harness keeps data out of vats, in one table. These are the costs a zero-copy
reference must avoid; they also bound what a reference itself may cost.

| cost | value | source |
|---|---|---|
| inbound decode into a vat | about 10 us per byte at steady state (24 KiB in 312 ms with a 57 ms floor; 64 KiB 829 ms); cause: SES `harden` of each inbound frame allocates one descriptor object per byte (`pkg/src/net/pipe-network.js` `deliver`) | [M] J-0190, J-0193, J-0194; candidate C-5 |
| one inbound message halts the vat for good | above 94,208 bytes at 50 M computrons (`HeapExhausted`) | [M] J-0141, J-0194 |
| harness frame bound | `frameBytes` 24,576 bytes per message into or out of a vat; `inlineBytes` 8,192 per text field, larger fields are staged | [D] architecture 9; `H/guest/lib/limits.js` |
| outbound from a vat | cheap: 4 MiB in one answer passes; 8 x 64 KiB `sendOnly` in one crank 553-576 ms; but every outbound message is some other vat's inbound frame | [M] J-0142 |
| marshalling records out of a vat | about 2-4.5 ms per record (page cranks): 1 s per about 450 records | [M] J-0322, J-9387, J-0461 |
| name table | about 57,000 property names per vat for life; every fresh record key takes one; exhaustion is a catchable `RangeError` | [M] J-0191, J-0333 |
| heap and snapshot | a vat's live heap is marked whole at each collection (about 0.4 ms per 1,000 live slots); 20 M characters of strings grow the snapshot about 3.3 bytes per character | [M] J-9383, J-9388; tooling survey 4.4 |
| journal | every inbound frame is journaled; on the worker duct a frame is base64 inside JSON (survey `core.md` 3.8, from `pkg/src/core/durable-worker-transport.js` at survey time) | [D] survey; [I] the ratio 4/3 |
| hub commit | the hub commits its state before every frame it sends, about 1.25 times per inbound delivery, 21-28 per turn, 5.5-6.6 ms each (fsync) | [M] J-9333, J-9216 |
| hub transcoding | every message is decoded with the wire codecs and re-encoded toward the destination, rewriting every embedded reference through the c-lists (`pkg/src/net/hub.js`, header comment of `makeOcapnHub`); bytes in a message are therefore copied by the hub process | [C] |
| hub holds frames in clear | frames toward a durable session queue in the hub state as hex (`hub.js` `dispatchBytes`); frames toward transient adapter sessions are persisted while queued (C-1) | [C]; [M] J-0164 |
| a reference held across sessions | one hub `RefRow` per exported object (`refs` map, typedef `RefRow`: `facing`, `refcounts` per other session) plus one c-list entry (`ourExports`) in every holder's session row; the log store rewrites a changed row whole | [C] `hub.js` typedefs `RefRow`, `SessionState`; [M] J-9386 |
| per hub row entry | about 51 bytes of row text | [D] m2-interfaces 4.13 (estimate from J-9383..J-9388) |
| hop between two adapters through the hub | 25 ms; about 82 events/s adapter to adapter (whole-file store; not re-measured after CC-025) | [M] J-0163 |
| vat -> adapter -> vat answered call | 70-76 ms (before CC-022; a trivial worker delivery is now 0.5 ms, the rest is host work) | [M] J-0161, J-9303 |

Consequence already adopted (architecture section 0 closing rule): "vats are the system of record
and the decision makers; Node adapters are the data path". Everything below is how that rule is
implemented flow by flow, and where it leaks.

---

## 2. Flow inventory

Twenty flows. Status: **built** (M1a, M1b or M2, code exists in this tree), **contract** (M3, M4, M5
contracts, not built in this tree), **planned** (a later milestone's text in `milestones.md` or the
architecture, not contracted).

### 2.1 Who produces, who consumes, what the vat holds

"Vats on the path" = vats the bytes or the reference pass through or rest in. "Holds" = what the
vat keeps: H = a `Blob` handle (manager-minted exo), ST = a `StagedText` record `{ blob, preview,
bytes, digest? }` (preview up to 1,024 units for messages, 256 for tool text, `''` for native
context), I = an inline copy of the bytes, K = a string key or digest, O = another object.

| id | flow | status | producer | consumer(s) | vats on the path | vat holds | a vat reads the bytes? |
|---|---|---|---|---|---|---|---|
| F-1 | API key read per round | built (M2) | operator (browser or CLI) via `SecretWriter` | provider code in the agent-host adapter | manager (Secret, ReadGrant identities); factory (Backend spec holds the ReadGrant); session holds the Backend | O: `Secret`, `ReadGrant` exos in the manager; the key `k<n>` only in a manager `WeakMap` | never (D-6) |
| F-2 | subscription credentials (OAuth access and refresh tokens), renewal write-back | contract (M4) | operator sign-in, then the adapter's renewal | pool provider in the adapter | manager (Secret, PoolMember, pool Backend); session holds the pool Backend | O; `PoolState` carries store keys `k<n>` (manager -> adapter) | never |
| F-3 | large secret write | built (CLI, M2) / contract (browser, M4) | browser Secrets panel or CLI `--value-file` | `SecretWriter` -> `secrets.enc` | none (the writer is adapter-local; the CLI's sealed box crosses the hub, not a vat) | - | never |
| F-4 | provider request body | built | adapter context cache (projection of records plus blob texts) | provider HTTP | session vat supplies records (`RoundRequest.append`, `ContextSource.page`) but not the body | records with ST for large fields | no (records yes, blob texts no) |
| F-5 | streamed reply text | built | provider SSE | browser viewers (in-process channel), session record | session receives `progress` checkpoints and `roundFinal` | ST of the latest checkpoint (outside the log), then ST in `RoundSettled` | no |
| F-6 | native context (signed thinking, encrypted reasoning) | built | provider | the same provider next round (replay) | session (record) | ST, preview `''` | no |
| F-7 | tool-call arguments | built | provider (model JSON) | the tool callee (adapter tool, exec vat, M5 object tools) | session (records `ToolIntents`, events); exec vat if the tool is `exec` | ST or I (<= 8,192) | session: never; exec vat: yes, on purpose (it parses or evaluates them) |
| F-8 | tool results | built | callee (echo in the adapter; exec vat through `BlobWriter`; M6 shell) | the model (next projection), viewers | session (record `ToolResult`, event); exec vat produces | ST or I | session: never |
| F-9 | exec source | built | model (through F-7) | exec vat's Compartment | session (routes ST), exec vat (reads pages) | exec: I, joined in one crank | yes (the one flow that must read: it evaluates) |
| F-10 | staged submission text | built | browser via `Composer` | provider projection, history, export | session (queue entry, `TurnStarted.input`, receipt fingerprint) | ST (digest compared for duplicates) | no |
| F-11 | system prompt | built (M2 staging) / contract (M5 composition) | factory composes from preset parts | provider each round | factory (composes: reads), session (stores, sends `RoundRequest.system`) | session: I (<= 8,192) or ST, or `[ST, note]` (M5) | factory yes (it builds it); session no |
| F-12 | transcript records of sealed turns (record archive, D-M2-1) | built (M2) | session vat (the records) | adapter `History`, context cache, export | session until sealed; afterwards none | the segment index (`SegmentEntry`, ~12 slots each) and `ArchiveState` digest (K) | the vat reads records (they are its own), never blob texts |
| F-13 | context projection after a restart | built | session vat pages (`ContextSource.page`) or `context.jsonl` | adapter cache | session (pages out up to 98,304 bytes) | records | the vat marshals records out; blob texts are resolved in Node |
| F-14 | images (`viewImage`) | planned (M8) | a workspace file, mount or capability | provider as native image input | session (a text receipt and "the image's handle") | H/ST [D], binary not text | no (M8: "bytes never enter a vat") |
| F-15 | M5 label-map values (`ExecPowersSource.store`) | contract (M5) | model code in the exec vat | model code later (`lookup`) | exec vat -> session vat | I: `{ json }` <= 8,192 bytes in the session heap | session: stores, does not parse; exec: parses |
| F-16 | mentions and packages (attachments) | contract (M5) / planned (M9 mail) | browser inventory, other agents | the model via `adopt` | session (queue entry, package table) | O (inventory objects), labels | no |
| F-17 | subagent answers, mail text | planned (M9) | child session's final reply (cap 16 Mi characters, staged) | parent session's model | child session, parent session | ST of the child's blob [D milestones M9] | no |
| F-18 | published workspace files, container I/O | planned (M6, M10) | workspace and containers adapters | asset HTTP clients; the model (via tool results) | session holds `Workspace`, `Route`, `Shell` objects; `runCommand(argv, { stdin?: Blob })` | O; ST for stdin [D arch 3.4] | no (assets: 0 vat deliveries per request, M10) |
| F-19 | export and import (data only) | built (M2) | `scripts/export.mjs` reads every text; import stages them again | an export file; a new session | session (`exportState`, `importState` pages of records), factory | records with ST; import: new ST | the vats page their records; texts are read through `Content` / `SealedText` by the CLI |
| F-20 | pass-through answers: model catalogue, secret catalogue | built (M2) / contract (M4) | adapter (`listModels`, `describeSecrets`) | factory, operator, browser | manager and factory vats forward the page | nothing kept (transient) | no, but both vats decode it: up to `frameBytes` inbound per vat [D m2 3.3, 3.5 "an answer passed through"] |

Not a vat flow today, listed so nobody looks for it: provider SSE deltas (published in process, 0
vat deliveries per token, architecture 4.2), audio (M11: "audio frames 0 vat deliveries"), account
readings and the secrets audit (adapter files only, M4 3.4), asset serving (M10).

### 2.2 Volumes, crossings, persistence, restart, freeing, measured cost

| id | bytes per instance | what crosses a vat frame | persisted where | how the reference survives restart | how the bytes are freed | measured cost |
|---|---|---|---|---|---|---|
| F-1 | API key: <= 8,192 read by the provider; store values <= 1 MiB | nothing secret; the `ReadGrant` presence once in `makeBackend` | `secrets.enc` (AES-256-GCM, key file outside the state dir); identities in the manager heap | `Secret`, `ReadGrant` are durable manager exos; the adapter re-resolves `k<n>` with `sink.resolveGrants` once per grant per incarnation | `Secret.revoke()` then `delete()` (`NOT_REVOKED` otherwise); grants die with the secret's key | [M] J-0441: read 0.018 ms median, first read 0.88 ms + one manager crank; replace 11.9 ms |
| F-2 | credential JSON <= 8,192 bytes | `PoolState` (~9 KB, manager -> adapter, keys not values) | `secrets.enc`; marks and served records in the manager heap | as F-1; `poolState` once per pool per incarnation | member or pool retire; secret delete | not built |
| F-3 | browser <= 1,040,384 bytes JSON-escaped; CLI <= 1,048,576 plaintext, sealed box "<= 1.4 MB" through the hub [D m2 3.4] | none into a vat; the CLI box crosses the hub (decoded, re-encoded, queued in hex) | `secrets.enc`; the hub log holds the ciphertext until compaction (C-1, J-0164) | the writer is per incarnation: reopen after restart | as F-1 | [M] replace with a sealed box 12.5 ms median (J-0441); hub crossing not measured for 1.4 MB |
| F-4 | the whole projected context each round (until M8 compaction); grows with the session [I: hundreds of KB for a large window] | records only (`append` per request, pages on a miss) | provider body is not persisted; `context.jsonl` (sealed part), `mirror.jsonl` (kept records) | the cache rebuilds from `context.jsonl`, the mirror and one page crank | not applicable (cache) | [M] in-step prepare 0-13 ms; 7.5 ms per prepare at 5,000 turns (J-0491 via J-0461); rebuild 0.13-0.54 s with the archive, 4-180 s without (J-0461, J-9383) |
| F-5 | reply text up to the output limit; 1 MiB tested | `progress({ partial: ST, tail })` (<= 6.2 KB, **answered** since M1b QC) every 16,384 new bytes or 10 s; `roundFinal` <= 18,432 | blob files; the session keeps the latest checkpoint outside the log | ST in records; handles durable | the adapter deletes a superseded checkpoint when the session answers `true` (`BlobStore.discard`); final blob freed only by session delete | [M] checkpoint writes bounded to about 3 x the text: 1 MiB reply 34 MB -> 3.6 MB written (J-0313, J-0393); one session crank per checkpoint |
| F-6 | opaque, per round; 2 per turn in the long-session script | ST in `roundFinal` | blob file; ST in `RoundSettled` | as F-5 | session delete (or sealed and then still only session delete) | [M] the two native-context handles per turn were the dominant hub row growth before the archive: about 2 entries per turn in the session's row and in the adapter's (J-9386) |
| F-7 | model JSON; staged above 8,192; at most 256 calls per message, 64 run per round | ST (~0.8 KB) or inline <= 8,192 in `roundFinal`; then `execute({ opId, args })` <= 8.4 KB to the callee | blob files; ST in `ToolIntents` | as F-5 | session delete | [M] a 256-call round is the measured heaviest session crank (passes at 4,000,000 slots, J-0392) |
| F-8 | <= 32,768 UTF-16 units (cut by the callee), staged above 8,192 | ST (~1 KB) or inline | blob files | as F-5 | session delete | [M] exec result over `inlineBytes`: one answered `append` per 12,288-byte piece, one exec crank each (contract 6.1); 32,768 ASCII units = 3 pieces |
| F-9 | <= 262,144 bytes (`execSourceBytes`) | the exec vat pulls `Content.read` pages of <= 20,480 bytes, one answered page per crank | blob file; the source then lives in the exec vat's heap for one crank, and in its journal (the pages are inbound frames) | the scope is in the exec vat; a source is per call | session delete | [M] 262 k staged in about 13 page cranks, 3.5-4 s, then a 175 ms evaluating crank (J-0195, contract 6.2) |
| F-10 | <= 200,000 units (about 600 KB worst case) | ST (<= 3.2 KB) in `enqueueOnce` | blob file; ST in the queue entry, `TurnStarted.input` | as F-5 | refused submissions: the Composer deletes the file (17.1); otherwise session delete | not separately measured |
| F-11 | preset instructions <= 4,096 units plus composed parts; staged above 8,192 | the factory appends pieces to `writersFor(session)` (<= 12,288 each, outbound); the session gets ST | blob file; ST in `SessionConfig` | as F-5 | creation rollback releases it (`releaseBlobs([prompt.blob])`, m2 7.2); session delete | not measured |
| F-12 | about 1.5 KB of segment + 0.5 KB of `context.jsonl` per archived turn; 5,000 turns: 7.36 MB + 2.42 MB, blobs 39 MB | `seal` request ~0.3 KB + kinds out, `SegmentEntry` ~0.2 KB back | `<state>/agent-host/archive/<h<n>>/seg-*.jsonl`; staged fields written as `{"$staged":{"key":"b<n>",...}}` | the vat's `ArchiveState.digest` chains the segments; the archive key `h<n>` lives in a manager `WeakMap` (host facet -> key) | session delete: `releaseArchive` unlinks every blob file the segments and the mirror name; sealed handles are dropped by the vat (GC frames to the manager), but the files stay named by key | [M] archive flatness 200 -> 5,000 turns: slots 409,088 both, snapshot 24.7 MB both, hub row 284 entries both (J-0461); without it 1.91 M slots, 114 MB, 10,012 entries (J-9383, J-9384) |
| F-13 | all records since the compaction boundary | pages out of the vat, <= 98,304 bytes, <= 512 records | `context.jsonl`, `mirror.jsonl` | rebuild | cache | [M] page crank about 1 s per 450 records (J-0322); 69 page cranks, 179.6 s at 5,000 turns pre-archive (J-9383) |
| F-14 | <= 2 MiB, binary (PNG, JPEG, WebP) | a text receipt and a handle [D M8] | not specified | not specified | not specified | target: "`viewImage` adds 0 vat deliveries beyond the tool result" [D M8] |
| F-15 | <= 8,192 bytes per value | `{ json }` text in `ExecPowersSource.store` (inbound to the session) | session heap, snapshot, journal | heap | `remove(label)` | not built |
| F-16 | object references, <= 32 per message | presences (~0.3 KB each in the frame) | session heap (queue entry, package table) | presences are durable if their origin is | released at the turn's settle (R3-8) | not built |
| F-17 | answer cap 16 Mi characters, staged | ST from the child [I: or a copy] | blob file | as F-5 | [I] unspecified for a blob staged for the child and read for the parent | not built |
| F-18 | container output 64 KiB per stream before the tool cut; published trees unbounded | tool results (F-8); `Route`, `Workspace` presences | workspace dir, container volumes | registrations restored at every start (D-16) | session delete releases the route (M10) | targets: 0 vat deliveries per asset request, >= 100 MB/s (M10) |
| F-19 | everything: a 5,000-turn session has 39 MB of blobs (J-9384) | export: `SessionInternal.exportState` pages (records); texts via `Content.read` and `SealedText.read` pages of 20,480 from the CLI through the hub; import: `importState` chunks <= frameBytes into the vat, texts appended through `writersFor(session)` from the CLI through the hub | the export file; new blob files | not applicable | not applicable | [M] import 13 ms per record in the vat (J-0481); text transfer not measured [I: 39 MB / 20,480 = about 1,900 pages, each a control-client -> adapter round trip of 20-25 ms (J-9043): about 40-50 s, plus the hub's hex queue of each page] |
| F-20 | `ModelPage` <= frameBytes; `SecretCatalogPage` up to ~30 KB before cutting | the whole page, inbound to the manager then to the factory | nothing | not applicable | not applicable | [I] up to two inbound decodes of 24 KB, about 250-300 ms each at 10 us per byte |

### 2.3 Notes the tables cannot carry

- **The session vat never reads a blob** (`H/guest/session/staging.js` header: "The vat never reads
  a blob; it copies StagedTexts where they arrive") [C]. It reasons about staged data with `bytes`
  (`fieldBytes`), `preview` (`previewOf`) and `digest` (`sameSubmission`). The only vat that reads
  blob bytes is the exec vat, for its own source (`H/guest/exec/main.js`, `E(content).read(...)`
  loop) [C].
- **Who reads secrets.** Only `AH/secrets/manager.js` `makeSecretsOps().readKey` (providers) and,
  in M4, `credentialFor(key)` (renewal) [C][D]. The manager vat's `Secret` methods forward a key
  string to the adapter (`withOps(current => E(current).secretDescribe(record.key))`,
  `H/resources/agent-host/durable.js` `makeSecret`) [C].
- **The preview is a copy.** Each ST carries up to 1,024 units of the text (256 for tool text),
  which lands in the session heap, its journal, its snapshot, its hub-crossing frames and the live
  events. For the long-session script that is the part of each staged field that does reach a vat
  [I: worst case about 3 KB per field in UTF-8].
- **`progress` is answered**, not `sendOnly` (M1b QC J-0393; architecture 4.1's sketch still says
  sendOnly): the answer is what lets the adapter delete the superseded checkpoint, so freeing a blob
  costs a vat round trip.
- **Archive sealing turns references into names.** A sealed record's staged fields are written into
  the segment as blob *keys* (`b<n>`), the vat drops its handles, the manager's `WeakMap` forgets
  the key, and from then on the file is reachable only by that key, from the segment files
  (m2-interfaces 4.10). The archive kept the hub row flat precisely by not keeping references.

---

## 3. Mechanisms the harness already has for "reference without reading"

### 3.1 Inventory, with file and function

| mechanism | what it is | where (file, function) |
|---|---|---|
| `Blob` handle | a methodless exo minted by the agent-host manager vat; designation only | `H/resources/agent-host/durable.js` `make`: `makeBlob = defineExoClass('Blob', ...)`, `sink.mintBlobs` (32 per crank, key `b<n>` from a durable counter into `blobKeys: WeakMap<Blob, key>`), `sink.resolveBlobs` (handle -> key, <= 64 per crank), `releaseBlobs` |
| adapter blob store | files `<state>/agent-host/blobs/b<n>`, a stock of minted handles, `WeakMap<presence, {key, bytes, owner}>` per incarnation | `AH/blobs.js` `makeBlobStore`: `stage`, `stagePending`/`commit`/`drop`, `read`, `readPage`, `resolveMany`, `claim`, `discard`, `release`, `readKey`, `readPageKey`, `keyOf`, `writersFor`, `sweep` |
| `StagedText` | the record a vat holds: `{ blob, preview, bytes, digest? }` | shape `m1bShapes.StagedText` (`H/guest/lib/interfaces.js`); built in `AH/blobs.js` `writePart` and `makeWriter().close`; used in `H/guest/session/staging.js` |
| `Content` | the read authority, one per incarnation (unowned) or per session ports (owned) | `AH/content.js` `makeContent().read(blob, { offset, maxBytes })` -> `store.readPage` |
| `BlobWriter(s)` | write-once append stream that ends in a ST | `AH/blobs.js` `makeWriter` (`append`, `close`, `abort`; idle abort 60 s), `writersFor(owner)` |
| `Secret`, `ReadGrant`, `SecretsAdmin` | durable identities; values never in the vat | `H/resources/agent-host/durable.js` `makeSecret`, `makeReadGrantExo`, `secretsAdmin`; `sink.resolveSecrets`, `sink.resolveGrants` |
| `SecretWriter` | adapter-local write-only object; resolves a passed `Secret` by amplification | `AH/secrets/writer.js` `makeSecretWriter().replace`; `AH/secrets/manager.js` `makeSecretsOps` (`keyOf` cache per incarnation, `readKey`) |
| sealed box | value encrypted to the adapter's X25519 key so the hub carries ciphertext | `AH/secrets/seal.js` (format `x25519-aes-256-gcm-1`) |
| archive segments | sealed turns in chained-digest files; the vat keeps an index and the head digest | `AH/archive/{store,segment,history,context-file,mirror}.js`; vat side `H/guest/session/archive.js`; contract m2-interfaces 4 |
| `SealedText` | adapter-local reader for a sealed field, minted per answer | `AH/archive/history.js` [D m2 4.9]; not re-read in code by this survey |
| archive key `h<n>` | per-session directory name, kept in a manager `WeakMap` (host facet -> key) | `durable.js` `archiveKeyOf`, `sink.resolveSessions`; passed in `ops.open` |
| adapter-local exports | objects the adapter owns resolve locally when they come back, so their traffic never leaves the process | `pkg/src/net/hub.js:804-812` per architecture 7 [D]; relied on by `Content`, `Composer`, `SecretWriter` in the gateway |
| OCapN sturdyrefs through the hub | "opaque pointers: they transit the hub as plain values, re-encoded verbatim" (no c-list row) | `pkg/src/net/hub.js`, reference kit `makeSturdyRef` (comment above it) [C]; not used by the harness |

### 3.2 How each falls short, property by property

Columns: **object?** does the reference travel as an object (not a name or digest); **pass on**
can a vat pass it to another vat or adapter that can then use it without a lookup; **resolve
elsewhere** can an adapter in a different process get the bytes without a copy through the hub;
**per-reference cost**; **restart**; then the general properties of section 5.

| mechanism | object? | pass on | resolve elsewhere | per-reference cost | restart | attenuate / revoke / compare / ranges / append / collect |
|---|---|---|---|---|---|---|
| `Blob` + `StagedText` | yes for the handle; the ST also carries `digest` (a content name) and a copied preview | the handle passes freely, but the reader must hold a `Content` too, and since 17.3 an owned `Content` or the context cache refuses a handle staged for another session (`texts.blobNotOwned`, `AH/blobs.js` `claim`) | no: only the agent-host adapter process maps handle -> file; any other process reads through `Content.read` pages over the hub (decode, re-encode, queue) | manager: one exo + one `WeakMap` entry; hub: one `RefRow` + a `facing` entry and a c-list entry per holding session (session vat and adapter both hold it: J-9386); holder vat: the presence plus the ST record; name table: none (fixed keys `blob`, `preview`, `bytes`, `digest`) [C][I] | handles are durable exos; the adapter's map is empty; first use costs `resolveBlobs`, one manager crank per 64 handles (`AH/blobs.js` `resolveMany`); owner is trust-on-first-use (17.3 item 4) | attenuate: no (no facet, no read-only or range-limited view; the authority is the separate `Content`); revoke: no; compare: by `digest` string and `bytes`, never by identity (`sameSubmission`); equal content staged twice is two files [C]; ranges: yes, UTF-8 byte offsets, whole code points, <= 20,480 per page; text only (`Buffer.from(text, 'utf8')` in `writePart`): no binary; append: write-once via `BlobWriter`, no append to a closed blob; collect: **no**: when the last holder drops the handle the manager's `WeakMap` entry goes but the file stays (vats have no `WeakRef`, the manager cannot list live keys, 17.1 "Not done"); files go only by `releaseBlobs` (session delete), `discard` (superseded checkpoints, refused submissions) or a future M13 sweep |
| `Content` | yes | it is an adapter-local object; a vat may hold the session's ports' `Content` (exec vat per call) | no: it reads only the agent-host blob directory | one adapter export per incarnation and per session ports | dies with the incarnation (tombstone); reopen ports | it is all-or-nothing read authority over every handle its owner may read |
| `BlobWriter` | yes | per incarnation; the exec vat holds one per call | no | one adapter export per writer | tombstone; a writer open at a crash leaves a `.part` that the next start deletes | write-once append, bounded per piece (12,288); a pending staging is not visible until `commit`; no way to hand out a reader while writing (no "growing blob") |
| `Secret` / `ReadGrant` | yes, and no lookup by name: `SecretWriter.replace(secret, ...)` resolves by amplification (`sink.resolveSecrets`) [C] | a ReadGrant passes to a Backend spec; a session never receives one (M4 11) | **no**: values must not cross the hub even between adapters (C-1, J-0164), so every reader of a secret must live in the agent-host process (D-6). A workspace or containers adapter that needs a credential cannot be given one without a copy through the hub [I: M6/M7 not contracted] | manager exo + `WeakMap` entry each; hub row entries for holders; key `k<n>` crosses manager -> adapter in `resolveGrants` answers and in the ops calls `secretDescribe(key)` etc. | durable identities; the adapter re-resolves keys once per incarnation (one manager crank per batch) | attenuate: `makeReadGrant()` is one attenuation (read-only, no admin path); revoke: whole-secret `revoke()` only, no per-grant revoke [C]; compare: by identity; ranges: no (values <= 8,192 read whole); collect: explicit delete after revoke; `secretList` holds every Secret strongly |
| `SecretWriter` / sealed box | yes | adapter-local per incarnation | the CLI path crosses the hub as ciphertext: up to about 1.4 MB in one frame, decoded and re-encoded by the hub and queued in hex until compaction (C-1) [D][C] | one adapter export | tombstone; reopen | write-only; generation-conditioned replace (`GENERATION_CONFLICT`) |
| archive segments | **no**: a segment is addressed by the vat's index entry plus the session's archive key `h<n>`; inside, staged fields are blob keys `b<n>` | the vat cannot hand a sealed turn's content to anyone as an object; readers go through the adapter's `History`, which mints adapter-local `SealedText`s per answer | no: files in the agent-host directory only | zero hub rows (by design: "No handle per segment", m2 4.6) and ~12 slots per index entry | survives (files plus the vat's chained digest); validation deletes orphans | compare: chain digest; ranges: yes through `SealedText.read`; append: new segments only; collect: only with the whole session (`releaseArchive`); a blob sweep must treat every key a segment names as live (`archiveKeys`, m2 4.10) |
| `SealedText` | yes, but adapter-local and transient | not storable by a vat (a tombstone after restart) | no | per answer, weakly cached | lost | read and describe only |
| archive key `h<n>`, blob key `b<n>`, store key `k<n>` | names | they never leave the manager-adapter pair (17.3 rule 1); they are how the adapter amplifies an object into bytes | the adapter's only cross-restart resolution path | strings in manager `WeakMap`s; files named by them | they are the persistence | - |
| sturdyref through the hub | a pass-by-copy capability (location + swissnum) | travels verbatim through the hub, no c-list rows | resolution needs a `fetch` to the exporter (one row then) [I] | none while in transit [C comment] | as durable as the exporter's publication table | not used by the harness; a swissnum is a bearer secret (owner principle: a name where a reference leaves the object system) |

### 3.3 The shortfalls in one list

1. **Designation and authority are split.** A `Blob` designates; `Content` (one per incarnation or per
   session ports) authorizes. Passing a Blob to another vat passes nothing usable unless that vat
   also holds a `Content` that will accept it, and since 17.3 the session-owned `Content` refuses
   another session's handle. This is an access-control list on top of a capability, adopted for
   defence in depth (J-9364); it is also what makes F-17 (a child's answer read for a parent) need
   either an unowned reader or a copy [I].
2. **Resolution is rights amplification through the manager vat by string key.** Handle -> `b<n>`
   (`resolveBlobs`), Secret -> `k<n>`, Session -> `h<n>`: one manager crank per 64 references per
   adapter incarnation. Keys never leave the manager-adapter pair, but inside it they are names,
   files are named by them, and the archive stores them in files for good.
3. **Only one process can turn a reference into bytes.** The blob directory, the secrets store and
   the archive belong to the agent-host adapter. Every other process (workspace and containers
   adapters, control clients, a second daemon) gets bytes only as messages through the hub, which
   decodes, re-encodes and queues them (in clear for transient sessions, C-1). For secrets this is
   forbidden outright, so the design concentrates every secret consumer in one process (blast
   radius noted in architecture 6).
4. **Every held reference is hub state.** A handle a vat or adapter holds is a c-list entry in that
   holder's hub session row, rewritten whole on every change of the row (J-9335 (a)), plus a
   `RefRow` with a `facing` entry. Measured: 2 handles per turn in two rows grew the session's row
   to 516 KB with 10,012 entries at 5,000 turns and the characters per hub commit from 86-93 KB to
   888 KB (2.9 GB written per 100 turns) (J-9386). The archive cured it by dropping the references
   (shortfall 5).
5. **References do not persist as references once they leave a vat's live state.** Sealed records,
   the adapter's `context.jsonl` and `mirror.jsonl` hold keys (`{"$staged":{"key":"b<n>"}}`,
   `{"$key":"b<n>"}`), not objects. A design that wants a sealed turn's attachment to stay an object
   (pass it on, revoke it, collect it) has nothing to hold.
6. **No collection of bytes.** Dropping the last reference never frees a file. Freed today: session
   delete (`releaseBlobs` pages + `releaseArchive`), superseded checkpoints (`discard`, after an
   answered `progress`), refused submissions, uncommitted `.part` files. Files of handles nobody
   holds any more stay until delete or M13 (m1b 17.1, "Not done"; J-9361).
7. **Text only, UTF-8, ranges by byte offset on code-point boundaries.** `stage(text)` and
   `BlobWriter.append(piece)` take strings; images (F-14, 2 MiB binary) and audio have no blob form
   today [C]. Whether a vat can now pass an OCapN bytestring is unverified: the codec maps
   `byteArray` to Syrup bytestrings (`packages/ocapn/src/codecs/passable.js`, `byteArray:
   BytestringCodec`) [C], while architecture fact 8 says "`Uint8Array` is not passable over OCapN in
   this build" and the survey's probe hung (`designs/survey/native.md`, general incompatibilities)
   [D]; not re-checked here.
8. **Per-incarnation objects are not storable.** `Content`, `BlobWriter`, `SecretWriter`,
   `SealedText`, `TurnPorts` die with the adapter; a vat that stores one holds a tombstone after a
   restart and must reopen. Only manager-minted handles are durable, and minting costs manager
   cranks (amortized by the stock of 32).
9. **No attenuation or revocation of data references.** A `Blob` has no methods; there is no
   read-only facet (it is already read-only), no range-limited facet, no expiring facet, no revoke
   short of deleting the file. Secrets have one attenuation (`ReadGrant`) and whole-secret revoke.
10. **Comparison is by content name.** Duplicate detection compares `digest` (SHA-256 hex) and
    `bytes`; identical texts staged twice are two handles and two files. A digest is a name for
    content, carried as a string inside a vat record.
11. **Pass-through still costs inbound decode.** F-20: a `ModelPage` or `SecretCatalogPage` that the
    manager and factory vats only forward is decoded by each (harden per byte, keys interned),
    because an answer cannot be routed past a vat to the final caller.
12. **The hub is not zero-copy even between two Node processes.** Structural transcoding means the
    hub decodes and re-encodes every frame; an adapter-to-adapter hop costs 25 ms and about 2.6
    store writes (J-0163, before CC-025).

---

## 4. The three flows where a true zero-copy reference would save the most

Ranked by measured or directly derivable cost; each with what it costs now and what a reference
that costs no hub row, no inbound bytes and no copy through the hub would remove.

### 4.1 References kept by long sessions (F-5, F-6, F-7, F-8, F-10, F-12)

- **Now.** Before the archive: 2 staged native contexts per turn made each of two hub rows grow by
  about 2 entries per turn; at 5,000 turns the session's row was 516 KB / 10,012 entries, each
  commit wrote 888 KB (from 86-93 KB at 300 turns), 2.9 GB per 100 turns, hub time per turn 0.29 ->
  0.72 s (J-9386); the vat's slot capacity 1.91 M (48 % of the ceiling), snapshot 114 MB, 1.29 s
  each (J-9383, J-9384). With the archive (M2): row flat at 284 entries / 14.6 KB, slots 409,088,
  snapshot 24.7 MB (J-0461), **but only because sealed turns hold no references**: 136 kept turns
  of handles still live in the vat and in the hub row, and the archived ones became `b<n>` keys in
  files.
- **What a zero-copy reference would change.** If holding a data reference cost no c-list entry
  (or a bounded, batched one), records could keep their references after sealing; the kept tail's
  284 entries (2 per kept turn plus fixed objects) would drop to the fixed ones; and the archive
  would not need to convert references into names to stay flat. The preview copy (up to 1,024
  units per field) is a separate, deliberate copy and is not removed by this.
- **Scale.** At the harness's 2 handles per turn, every 1,000 turns of history held by reference
  is about 2,000 row entries, about 100 KB of row text per holder row at 51 bytes per entry [D
  m2 4.13 estimate], rewritten whole at every commit of that row (21-28 commits per turn).

### 4.2 Bytes that must move between processes (F-3, F-14, F-18 stdin, F-19, F-17 [I])

- **Now.** Only the agent-host adapter can turn a handle into bytes. Any other consumer gets
  20,480-byte pages through the hub: each page is a control-client or adapter round trip of 20-25
  ms (J-9043, J-0163), decoded and re-encoded by the hub and queued in hex. Export of a 5,000-turn
  session moves 39 MB of blobs this way [I: about 1,900 pages, 40-50 s, and twice the hex bytes
  through the hub's log]; import moves them back as `BlobWriter.append` pieces of 12,288 [I: about
  3,200 appends]. M8's `viewImage` wants up to 2 MiB of binary from the workspace adapter's files
  to reach the agent-host's provider "with 0 vat deliveries" [D]: through the hub that is about 100
  pages [I] of a binary type the blob store cannot hold. M6's `runCommand(argv, { stdin?: Blob })`
  [D arch 3.4] needs the containers adapter to read an agent-host blob. The CLI's large secret
  write sends one 1.4 MB sealed box through the hub [D].
- **What a zero-copy reference would change.** A reference that any authorized process can resolve
  to the same bytes (a shared store, or a direct adapter-to-adapter channel the hub only
  introduces) would make these one hop of metadata plus a local read; for secrets it would let a
  credential reach the workspace or containers adapter without the hub ever seeing it, removing
  the reason all secret consumers must share one process [I].

### 4.3 Streamed replies and progress checkpoints (F-5)

- **Now.** A reply is re-staged whole at each checkpoint (every 16,384 new bytes or 10 s): before
  the M1b QC fix a 1 MiB reply wrote 34 MB; with the `progressWriteFactor` bound it writes about 3 x
  the text (3.6 MB) and pays one session crank per checkpoint plus one answered round trip to free
  the superseded file, and one more checkpoint before `roundFinal` (J-0313, J-0393, m1b 3.2).
- **What a zero-copy reference would change.** An append-only reference (one handle for the whole
  round, readable up to a length the vat records) would make every checkpoint a length update
  (no new file, no copy, no free), so a 1 MiB reply writes 1 MiB once, and the vat's record would
  name "this stream up to byte N". The session crank per checkpoint stays (the vat must record the
  length for recovery), but it carries no handle and frees nothing.

Other candidates, smaller or unmeasured: F-20 pass-through pages (up to about 2 x 250-300 ms of
inbound decode per catalogue page, [I]); F-9 exec source (13 page cranks, 3.5-4 s for 262 KB; but
the exec vat reads on purpose, so this is a read-cost problem (C-5), not a reference problem);
F-15 label-map values (8 KB copies resting in the session heap, M5, not built).

---

## 5. Properties a general mechanism must have to replace the special cases

Each property with the harness evidence that requires it. "Must" = a current special case depends
on it; "should" = the owner's wish implies it but no built flow needs it yet.

| property | must / should | why (evidence) |
|---|---|---|
| **pass by object** | must | owner principle (objects, not names); today's handles already pass as objects; the archive and adapter caches regress to `b<n>` keys (3.3 item 5) |
| **holding costs no per-reference hub row, or a bounded one** | must | J-9386: references held per turn grew hub rows to 516 KB; m2 4.6 forbids a handle per segment for this reason |
| **no bytes in vat frames, heap, snapshot or journal** | must | D-6 for secrets (heaps and journals are plaintext on disk); fact 2 / C-5 for everything else |
| **no bytes through the hub in clear** | must | C-1 / J-0164: queued frames toward adapter sessions are persisted in hex; secrets may not cross the hub even between adapters |
| **resolvable by more than one process** | must (M6-M8 as specified) | viewImage, runCommand stdin, export/import, CLI secret write (4.2) |
| **read on demand, in ranges** | must | `Content.read` pages (exec source, browser large replies, export); providers read whole texts in process; images need bytes, not code points |
| **binary as well as text** | must (M8) | 2 MiB images; the blob store is UTF-8 only |
| **write once; append with a visible length** | must (write once) / should (append) | `BlobWriter` is write-once; progress checkpoints (4.3) and archive segments both want append |
| **persist across restart without a per-incarnation re-resolution crank** | must (persist) / should (no crank) | handles are durable but the adapter re-resolves through the manager (1 crank per 64) and owner binding is trust-on-first-use (17.3) |
| **compare** | must | duplicate submissions compare `digest` + `bytes` (m1b 3.3, 17.2); an identity or content-equality test the vat can use without a digest string would do |
| **attenuate** | must for secrets, should for data | `ReadGrant` (read-only, no admin path, R7-26); a range- or session-limited facet would replace the 17.3 owner ACL |
| **revoke** | must for secrets | `Secret.revoke()` fails every grant's next read; M4 renewal writes are generation-conditioned |
| **mutable value under a stable reference (generations)** | must for secrets | a secret's value changes (replace, renewal) while grants stay valid (R4-82: read again every round); data blobs are immutable. One mechanism may need both kinds, or secrets stay a special case [I] |
| **collect the bytes when the last reference goes** | must | 17.1 "Not done": files of dropped handles stay until session delete; the archive keeps keys alive by file content; vats have no `WeakRef` |
| **audit and provenance** | must for secrets | every secret read audited (R7-24, `AH/secrets/store.js` `audited`); blob provenance (17.3) |
| **cheap to mint on a hot path** | must | D-15 pre-mints 32 handles per manager crank so staging costs no crank |
| **commit before the reference escapes** | must | D-15 / 17.1: a handle leaves the process only after its file is fsynced and named; intent-before-effect (architecture 4.3) |
| **quota per owner** | must | `blobLimits` 1 GiB per session, 16 GiB per daemon (17.1) |

### 5.1 Hard constraints for the designers (from the code and journal)

1. One inbound message above about 94 KB halts a vat; anything a vat receives costs about 10 us per
   byte; the harness bounds messages at 24,576 bytes (C-5 open). A reference must be small in the
   frame (today a ST is about 0.3-3 KB, most of it the preview).
2. Every fresh record key costs a vat a name for life (about 57,000). A reference's wire form must
   use fixed keys; a per-reference key (a map keyed by digest, a record keyed by id) is forbidden
   (rule 12.10).
3. The hub transcodes every message and persists before forwarding; it holds c-lists, not objects.
   Anything the hub must remember per reference is a row entry rewritten with the row (C-2's rest:
   no per-entry diffs yet; CC-051 proposed).
4. Vat-side finalization is deferred: a vat's GC frames leave at its next collection, up to 32
   cranks later (CORE-11), and a GC frame never wakes a sleeping vat (C-17). Collection of
   underlying bytes driven by OCapN GC therefore lags by up to 32 cranks or a vat's whole sleep.
5. Vats have no `WeakRef`, clock, randomness or bytes in the harness build (architecture fact 8);
   the manager cannot enumerate which handles are still held (17.1).
6. A retired break is the only restart signal and it is a string (C-18); adapter objects are
   tombstones after a restart with no notice to idle holders (C-19). A reference that is resolved
   by an adapter must survive the adapter's restart without the holder's cooperation.
7. Secrets: values must never be in a vat, a journal, a snapshot, the hub (even as frames between
   adapters, C-1), a log or a transcript (D-6, m4 11; acceptance greps the state directory).
8. Transcript content is never deleted by the harness (R4-64); session delete is the only freeing
   path for transcript blobs, and it must still find every byte (export must also find every byte).
9. Templates and state copies carry blobs because the blob directory is inside the state
   directory (fact 10, `findBlobDir`); the secrets key file is deliberately outside it.

### 5.2 Opportunities the survey found

- **The hub already forwards one reference form without rows**: sturdyrefs are "re-encoded
  verbatim" (`hub.js` comment above `makeSturdyRef`). A data reference as a pass-by-copy
  capability (a location plus an unguessable token, or a signed descriptor) would cost no c-list
  entry while held; the cost moves to resolution. It is a bearer token, so it must never reach a
  log, a transcript or a model (owner principle: a name is acceptable where a reference leaves the
  object system).
- **Rights amplification already exists and works** (`resolveBlobs`, `resolveSecrets`,
  `resolveGrants`): the adapter proves possession by passing the object. A general mechanism can
  keep this pattern and move the amplification table from a manager `WeakMap` (one crank per 64,
  per incarnation) to a store the resolving processes share.
- **The digest is already computed for every staging** (17.2): a content address is available
  for deduplication, integrity checks across processes and chained archives.
- **The archive is already the "append-only, ranged, persisted" structure** for transcripts; a
  general reference could address a range of an archive the way `Content.read` addresses a range
  of one blob (m2 4.6 states this analogy).
- **OCapN carries bytestrings** (`byteArray: BytestringCodec`), so binary data references could be
  first-class in the protocol if the vat side's byteArray path is fixed or avoided; to be verified
  (3.3 item 7).
- **Pass-through answers** (F-20) suggest a protocol feature independent of data: answering a
  caller past an intermediate vat (promise forwarding of a whole answer without decode), which
  OCapN's pipelining and third-party handoffs may already express [I; not checked].

---

## 6. Not checked by this survey

- No measurement was run. Every number is from the journal or a contract; [I] numbers are
  arithmetic on them.
- The live slot cost of one held `Blob` presence plus its ST in a session vat, and of one minted
  `Blob` exo in the manager vat, was not measured.
- Whether a vat can pass or receive an OCapN bytestring in the current build (architecture fact 8
  versus the codec).
- The hub cost of one 1.4 MB sealed-box frame (CLI secret write) and of exporting a large session
  through `Content.read` pages.
- `AH/archive/history.js` (`SealedText`) and `AH/context-cache.js` were described from the M2
  contract, not re-read line by line.
- M3, M4, M5 flows are as contracted; their implementations are in other lanes and were not read.
  M6-M13 flows (images, stdin blobs, mail, subagent answers, publishing) are from `milestones.md`
  and the architecture only; F-17's owner-check conflict is an inference.
- The harness specification was read for behaviour only (image envelope <= 2 MiB, packages <= 32
  attachments and 64,000 characters, published URLs with a 192-bit token, export of objects).
