# Survey S2: the OCapN protocol and the hub, for zero-copy data references (spike)

Status: research spike, survey phase. Nothing here is product code. Base: lane base `36b3035e92`.

Question: can a vat hold, pass on, store and hand out a reference to data without the bytes being
copied into or through its heap, frames, snapshot or journal, and where in the protocol and the hub
would that fit?

Evidence labels used throughout:

- **[code]** read from the named file and function at `36b3035e92`;
- **[measured]** run in this spike (section 8 gives the method and the raw numbers);
- **[M0]** measured earlier by the harness and recorded in `designs/m0-results.md` or
  `designs/architecture.md` (journal ids given), not re-run here;
- **[spec]** from a public specification fetched during this spike (section 9 lists the sources);
- **[memory]** recalled, not fetched; treat as a pointer to check;
- **[inferred]** my reasoning from the above.

Paths: `pkg/` is `packages/thixotrope/`, `ocapn/` is `packages/ocapn/`, `H/` is
`packages/thixotrope-harness/`.

---

## 1. Summary for the designers

1. **The hub decodes and re-encodes every argument of every forwarded message.** It is a
   structural transcoder, not a byte router: each inbound frame is fully parsed with the ordinary
   OCapN codecs against table-backed tokens, then written anew toward the destination
   (`pkg/src/net/hub.js` `deliverFrame` -> `readOcapnMessage`, `handleMessage`, `forwardToRow` ->
   `writeOcapnMessage`) [code]. A ByteArray argument is therefore copied at least three times in the
   hub (slice into an immutable buffer on decode, slice again on encode, copy into the writer), then
   hex-encoded into the hub's durable state before it is sent (`dispatchBytes`) [code], [measured].
2. **Descriptors already are zero-copy references.** When vat V passes adapter A's object to
   adapter B, only a descriptor moves: a 61-byte frame in, a 68-byte frame out, no payload [measured].
   B can then call A's object, but only through the hub; the hub never emits a third-party handoff
   between its own sessions (`getInfoForVal` always answers `isThirdParty: false`) [code].
3. **A held reference is not free.** Each one is a hub row (`RefRow`) plus an export entry per
   holder, about 51 bytes of persisted state per row entry (H/designs/m2-interfaces.md 4.13,
   estimate from measured slopes) [M0], and every commit re-serializes **every** row
   (`serializeHubState`, then `imageOf` in `hub-log-store.js` stringifies each entry) [code]. Work
   per commit is O(rows held daemon-wide), and there are 21-27 commits per turn (architecture 0.9)
   [M0]. Releasing a row scans all publications, gifts and answer routes (`isPinned`) [code].
4. **Bytes that do reach a vat pay about 10 us per byte and halt the vat above about 94 KB per
   message** (C-5, J-0190, J-0194) [M0]. On the way in they are base64 in the worker journal,
   JSON-in-JSON in the engine request, compiled as a JS string literal, base64-decoded, hardened,
   Syrup-decoded and copied again into an emulated immutable buffer [code]. Outbound is cheap
   [M0].
5. **The public OCapN draft has nothing for bulk data, streams, chunking, flow control or
   extension negotiation** [spec]. `captp-version` MUST be `1.0`; unknown operations and labels are
   unspecified. The only data-model extension point is the Tagged value [spec]. Our implementation
   already departs from the draft in several places (section 7.3), and our Noise netlayer has its own
   encoding-version negotiation that could carry an extension bit [code].
6. **Smallest useful change** (section 10): make the hub able to *be the origin* of a small class of
   objects, data objects whose bytes live in a content-addressed store beside, not inside, the hub
   state; vats hold ordinary `desc:import-object` descriptors to them; reading is a rights
   amplification (a `DataReader` object given only to designated adapters), not a session-type
   check. No wire change is needed for that. A wire change is needed only for peers beyond this
   process and for range transfer without a hub crank, and the Tagged value is the
   interoperable carrier for length and hash.

---

## 2. Components and transports

| component | file, function | role in a message's journey |
|---|---|---|
| Hub | `pkg/src/net/hub.js` `makeOcapnHub` | forwarding OCapN node; per-session c-lists and answer routes as persistable tables; bootstrap `fetch` / `deposit-gift` / `withdraw-gift` is its only endpoint behaviour (`handleBootstrapDeliver`) |
| Hub state codec | `pkg/src/net/hub-state.js` `serializeHubState`, `restoreHubState` | whole hub state as one plain record (refs, sessions with queues, publications, gifts, giftWaiters) |
| Hub store | `pkg/src/store/hub-log-store.js` `makeHubLogStore` (`setState`, `deltaOf`, `imageOf`, `compact`) | write-ahead log of per-entry deltas over an image; one durable append per commit; compaction at max(1 MiB, 2 x image) |
| Worker session | `pkg/src/core/daemon.js` `provideWorkerSession` (attach at about line 272) | `durable`, `requireAcceptance`, `deferCleanup`, `sendBatch`: hub flushes go to the worker journal in one fsync |
| Worker transport | `pkg/src/core/durable-worker-transport.js` `journalEntryOf`, `journalCranks` | journals each frame as `{ b64, hubSequence, gc }` before delivery; GC frames held, up to 64 per crank |
| Engine bridge | `pkg/src/ironhorse/ironhorse-engine.js` `crank`, `dispatchSource` | each frame becomes JS source `thixotropeDispatch("<JSON of {t:'f', b64}>")`; outbound read with `JSON.stringify(thixotropeTakeOutbound())` |
| Worker binary | `rust/thixotrope-ironhorse-worker/src/main.rs` `crank_deliver` | evaluates the dispatch source, drains jobs, collects on schedule, returns outbound JSON |
| In-vat bootstrap | `pkg/src/core/worker-peer-xs.js` `dispatch` | `JSON.parse`, `decodeBase64`, `peer.deliver(frame)` |
| In-vat OCapN peer | `pkg/src/core/worker-peer.js` `makeWorkerPeer`, `pkg/src/net/pipe-network.js` `makePipeNetwork` (`deliver` hardens `{ done, value: bytes }`) | a full `@endo/ocapn` client inside the vat heap, session derived from the worker id (no handshake) |
| Native adapter | `pkg/src/native/adapters.js` `resource().create` (attach at about line 211), `pkg/src/platform/node/adapter-processes.js` | Node child process; session key `transient:native:<random>`, `discardOnRestart`, `coalesceInbound`, not durable, no wire identity; frames cross Node IPC as JSON `{ frame: <base64> }` |
| Endpoint | `pkg/src/net/in-process-session.js` | the daemon's own reifying OCapN client in the supervisor process |
| Remote peers | `pkg/src/net/peer-sessions.js` `bindConnectionToHub` | `remote: true`; durable for `peer:` and `handoff:` keys; carry wire identity for gift verification |
| Codecs | `ocapn/src/codecs/{operations,descriptors,passable}.js`, `ocapn/src/syrup/{decode,encode}.js` | Syrup operations, descriptors, passables |

---

## 3. One message, end to end: adapter A -> hub -> vat V -> hub -> adapter B

Scenario: adapter A calls `E(v).take(bytes, aObj)` on an object of V, where `bytes` is a ByteArray of
N bytes and `aObj` is one of A's own objects; V then calls `E(b).take(bytes, aObj)` on an object of
adapter B. Each hop says what is decoded, re-encoded and copied.

### 3.1 A to hub

1. A's OCapN client (Node) marshals `op:deliver` with Syrup. `aObj` becomes `desc:import-object
   <A's export position>`; `bytes` becomes Syrup `N:<N bytes>`. Syrup `writeBytestring`
   (`ocapn/src/syrup/encode.js:79-95`) first copies the view into a fresh mutable buffer, then
   into the writer [code]. Copies: 2.
2. Node IPC: `child.send({ frame: encodeBase64(bytes) })`, JSON-serialized by Node's IPC channel;
   the supervisor `decodeBase64`s it (`adapter-processes.js:92-110`) [code]. Wire size about
   1.33 N plus JSON; copies: about 4 (base64, JSON, parse, decode) [inferred from code].
3. `adapters.js`: `coalesceInbound` holds frames of one turn and delivers them as a batch [code].

### 3.2 In the hub (`attachSession` -> `sink.deliver` -> `deliverFrame`)

1. **Decode** with A's codec kit (`provideCodecKit('A')`): the table kit materializes every
   descriptor as an inert `Far('HubRef')` token with a WeakMap info (`makeToken`, `refTokenFor`).
   `desc:import-object` from A calls `provideRemoteObjectValue` -> `provideRef(A, pos, 'object',
   { mention: true })`: creates or finds the row `A#<epoch>:<pos>` and counts `mentionsIn` [code].
   The ByteArray is read by `readTypeAndMaybeValue` (`ocapn/src/syrup/decode.js:137-142`) as
   `frozenBytes(subarray)`: a copy into an immutable `ArrayBuffer`, then `harden` [code]. Copies: 1.
2. **Route** (`handleMessage`, `op:deliver`): `resolveTarget(message.to)` gives V's row;
   `forwardToRow` checks liveness (`unreachableReason`), allocates the answer route
   (`allocateAnswerRoute`: a fresh answer position at V and an answer-backed promise row) and notes
   the resolver as a listener (`noteListener`) [code].
3. **Re-encode** toward V (`provideCodecKit(V).writeOcapnMessage({ ...message, answerPosition })`):
   each token goes through `getInfoForVal` and `provideFacingPosition`, which allocates the hub's
   export position toward V on first mention and increments `refcounts[V]` [code]. The ByteArray is
   written again by `writeBytestring` (2 copies) [code]. All of decode, route and encode run under
   `withRollback`, so a failure leaves no rows behind [code].
4. **Queue and commit before the wire** (`dispatchBytes`): the encoded frame is pushed onto
   `session.queue` **as hex** (`encodeHex(bytes)`, 2 N characters), then `persist()` serializes the
   whole state, queue included, and the store appends the changed entries (`deltaOf`) [code]. Then
   `flushOutbox` decodes the hex back to bytes and sends. For a batching worker session the whole
   queue goes to `transport.writeBatch` with its sequences after one persist [code]. This is C-1
   (frames bound for any session, including transient adapters, sit in the hub log in clear until
   compaction, J-0164, J-9337) [M0], confirmed independently in section 8 [measured].
5. Commits: one after the inbound frame (with its watermark and the outgoing frames), and a later
   one that records the queue removal (piggybacked for `deferCleanup` sessions) [code]. The
   architecture records about 1.25 commits per inbound delivery and 21-27 per turn [M0].

### 3.3 Hub to V and inside V

1. `transport.writeBatch` -> `journalEntryOf`: `{ b64: encodeBase64(bytes) }` appended durably
   (fsync) to the worker journal [code]. The bytes are now in the journal until the next snapshot
   truncates it.
2. `ironhorse-engine.js` `dispatchSource`: `thixotropeDispatch(${JSON.stringify(JSON.stringify(message))})`,
   sent to the worker process as a JSON request [code]: the base64 text is escaped twice and then
   lexed and compiled as a JS string literal by the engine [code; cost not separately measured].
3. In the vat (`worker-peer-xs.js` `dispatch`): `JSON.parse`, `decodeBase64`, `peer.deliver(frame)`
   -> `pipe-network.js` `deliver` hardens `{ done: false, value: bytes }`. SES `harden` of the
   `Uint8Array` allocates one descriptor object per byte (C-5): about 10 us per byte, halt above
   about 94 KB per message at 50 M [M0].
4. The in-vat `@endo/ocapn` client decodes the Syrup frame; the ByteArray is copied again by
   `frozenBytes` into an immutable buffer, which on Ironhorse is the emulated
   `@endo/immutable-arraybuffer` wrapper over a hidden genuine buffer (the polyfill comment in
   `rust/endo/xsnap/src/polyfills.js:90-99` says such views "have no indexed elements") [code].
   `aObj` arrives as `desc:import-object <hub export position toward V>` and becomes a presence in
   V's import table [code].
5. Whatever V keeps of `bytes` is in its heap, and so in its next snapshot (SQLite heap image)
   [code: `ironhorse-engine.js` `snapshot`]. Even if V keeps nothing, the bytes stay in the journal
   until that snapshot, and in the hub log until compaction [code].
6. J-0023 records that `Uint8Array` and emulated immutable `ArrayBuffer` values were not passable
   into guests over OCapN in that build (H/JOURNAL.md J-0023) [M0]; not re-checked here. The
   harness rule since then is "bytes never enter vats" (architecture 0.8) [M0].

### 3.4 V to hub to B

V's crank emits `op:deliver` to B's object with `[take, bytes, aObj]`. Outbound from a vat: the
in-vat client encodes Syrup, `encodeBase64`, `JSON.stringify` into the outbox, read by the host with
`JSON.stringify(thixotropeTakeOutbound())`, `JSON.parse`, `decodeBase64` (`durable-worker-transport.js`
around line 625) [code]. Outbound is cheap (a vat returns 4 MiB in one answer) [M0]. The hub repeats
3.2 toward B: decode (the ByteArray copied once more), `aObj` arrives as `desc:export <hub's
position toward V>` and resolves to the same row `A#e:pos`, re-encoded toward B as
`desc:import-object <hub's position toward B>` with a new `facing[B]` entry; frame hex into the
state; Node IPC base64 to B [code].

### 3.5 Copy and cost ledger for N payload bytes on that path

| where | copies or encodings of the N bytes | durable? |
|---|---|---|
| A (Node) encode + IPC | 2 copies, base64 + JSON | no |
| hub decode / encode (twice: inbound to V, inbound from V) | 2 x (1 + 2 + writer) | no |
| hub state (twice) | 2 x hex, 2 N characters each, in a log line | yes, until compaction |
| worker journal | base64, 1.33 N | yes, until the next snapshot |
| engine request and compile | base64 inside JSON inside a JS source literal | no |
| vat | base64 decode, `harden` (one descriptor per byte), Syrup decode, `frozenBytes` copy | in the heap and snapshot if retained |
| vat outbound | Syrup, base64, JSON | no |
| B IPC | base64 + JSON | no |

Only the descriptor for `aObj` is constant-size on every hop.

---

## 4. Descriptor types in use and what the hub does with each

From `ocapn/src/codecs/descriptors.js` `makeDescCodecs`, `passable.js` `makePassableCodecs`, and the
hub's `tableKit` in `provideCodecKit` [code].

| descriptor | wire form | hub, reading from session S | hub, writing toward session D |
|---|---|---|---|
| `desc:import-object` | `<desc:import-object pos>` | `provideRemoteObjectValue`: row `S#e:pos`, `flavor: 'object'`, `mentionsIn += 1` | written when the row's origin is not D: `provideLocalObjectPosition` -> `provideFacingPosition` (allocate `facing[D]`, `refcounts[D] += 1`) |
| `desc:import-promise` | `<desc:import-promise pos>` | `provideRemotePromiseValue`: same, `flavor: 'promise'` | `provideLocalPromisePosition` -> `provideFacingPosition` |
| `desc:export` | `<desc:export pos>` | `provideLocalExportValue`: position 0 is the bootstrap token; otherwise `ourExports[pos]` of S (unknown position throws) | when the row's origin is D and it is an export: `provideRemoteExportPosition` gives D's own position back |
| `desc:answer` | `<desc:answer pos>` | `getLocalAnswerValue`: S's `answersOwed[pos]`: `{ref}`, `{local}`, `{done}`, `{gift}` | when the row is an answer owed by D: `provideRemoteAnswerPosition` |
| resolver (`resolveMeDesc`) | an import descriptor | `provideRemoteResolverValue`: row with `resolver: true` (not counted by vat reachability, anchors listeners) | as an ordinary reference |
| `desc:sig-envelope` + `desc:handoff-give` | signed give | `provideHandoff`: the hub redeems it itself: an answer at a `handoff:<location>` outbound session, `pendingWithdraws`, dials through `handoffs.connect` | never written: `getInfoForVal` answers `isThirdParty: false` for every token |
| `desc:sig-envelope` + `desc:handoff-receive` | signed receive | arrives only as an argument of `withdraw-gift` to the bootstrap; `verifyWithdrawal` checks both signatures against recorded session identities | written by the hub only in `flushPendingWithdraws` toward an exporter |
| `ocapn-sturdyref` | `<ocapn-sturdyref peer swissnum>` | `makeSturdyRef`: an opaque value, re-encoded verbatim | verbatim |
| `desc:tagged` | `<desc:tagged tag value>` | `makeTagged`: transparent; its value is decoded recursively (references inside are rewritten) | transparent |
| `desc:error` | message string only | an `Error` | message string |

Operations the hub handles (`handleMessage`): `op:deliver` (also fire-and-forget with
`answerPosition` and `resolveMeDesc` false), `op:get`, `op:index`, `op:untag`, `op:listen`,
`op:gc-exports`, `op:gc-answers`, `op:abort`. Anything else throws "unsupported operation", which for a
`remote` session aborts the session (`frameError`) and for a local one drops the frame loudly [code].

### 4.1 The hub's tables

| table | key | value | lives in persisted state |
|---|---|---|---|
| `refs` | `refId` = `<origin>#<epoch>:[a]<position>` | `RefRow { origin, epoch, position, backing, flavor, resolver, dead, mentionsIn, listeners[], facing: Map<session, position>, refcounts: Map<session, n> }` (`facing` is rebuilt from `ourExports` on restore) | yes |
| `sessions[k]` | session key (`<workerId>`, `transient:native:<hex>`, `peer:...`, `handoff:<hex>`, endpoint) | `{ epoch, ourExports: Map<position, refId>, nextExport, nextAnswer, answersOwed: Map<pos, AnswerRoute>, processedUpTo, durable, retired, queue: hex[], queueSequences, nextDelivery, identity, usedGiftHandoffs, pendingWithdraws, nextHandoffCount, dialLocation }` | yes (process-local fields omitted) |
| `publications` | swissnum hex | refId (a GC root) | yes |
| `gifts` | `<gifterSessionId>:<giftId>` | refId (a root until withdrawn) | yes |
| `giftWaiters` | gift key | resolver refIds | yes |
| `codecKits`, `tokenInfo`, `gcCounts`, `costs` | | | no |

### 4.2 What a held reference costs

- **Bytes**: one `RefRow` per (origin, position), plus per holding session one `facing` entry, one
  `refcounts` entry and one `ourExports` entry in that session's row. The M2 contract estimates
  about 51 bytes of persisted state per row entry, from measured slopes; 10,012 entries were
  516 KB for a 5,000-turn session without the archive (H/designs/m2-interfaces.md 4.13) [M0].
- **Work per delivery**: every commit calls `serializeHubState` over every row and session, then
  `imageOf` stringifies every entry to diff it (`hub-log-store.js` `deltaOf`): O(total rows) per
  commit even when one entry changed; and a changed session entry (for example its queue or
  `nextExport`) is rewritten whole (C-2, open part) [code], [M0]. So each reference any vat holds
  adds a small constant to **every** commit in the daemon, 21-27 per turn [inferred from code and
  M0]. The architecture measured `hub.growth` 1.40 x fresh after 50 sessions (J-9333) [M0].
- **Release**: `maybeReleaseRef` calls `isPinned`, which scans all publications, gifts, waiters
  and every session's `answersOwed` per released row; `clearListenerEntries` scans every row for a
  released resolver [code]. Release cost is O(state) per row [code].
- **In the vat**: an entry in the OCapN client's import table (WeakRef-tracked when
  `enableImportCollection`, `ocapn/src/captp/finalize.js`), plus the presence object [code]. Not
  measured per entry here.

---

## 5. Byte strings in Syrup and where their cost lands

| step | code | cost |
|---|---|---|
| Syrup grammar | `ocapn/src/syrup/decode.js` (`BYTES_START`), `syrup-frame/README.md` | `<decimal length>:<bytes>`; a Syrup frame is literally a bytestring, the motivation for `@endo/syrup-frame` [code] |
| decode | `decode.js:137-142` `frozenBytes(bufferReader.read(n))` | one copy into an immutable buffer, `harden` of the wrapper [code] |
| encode | `encode.js:79-95` `writeBytestring` | a fresh mutable copy of the window, then into the writer [code] |
| pass style | `pass-style/src/byteArray.js` | `byteArray` is a frozen `Uint8Array` over an immutable `ArrayBuffer`, genuine or emulated [code] |
| hub | section 3.2 | about 145 ns per byte per forward in Node, all-in (section 8) [measured]; 2 N characters of hex per forward in the persisted state [measured] |
| worker boot polyfills | `rust/endo/xsnap/src/polyfills.js` | native UTF-8 and base64 since CORE-1 cost almost nothing (J-0101, J-0110) [M0]; emulated immutable views are not readable by `TextDecoder` and not writable by `encodeInto` (`polyfills.js:56-110`) [code] |
| vat heap | `pipe-network.js` `deliver` -> `harden` | about 10 us per byte, one descriptor object per byte; halts about 94 KB per message at 50 M (C-5) [M0] |
| snapshot | Ironhorse SQLite image | whatever is retained, about 71 bytes of snapshot per live slot (m2 4.13 estimate) [M0] |

The per-byte cost in the vat is not in Syrup: it is the frame harden (C-5). A vat that receives a
descriptor instead of the bytes pays none of it.

---

## 6. Limits and where they are enforced

| limit | value | enforced where | kind |
|---|---|---|---|
| frame into a vat (harness policy) | 24,576 bytes (`frameBytes`, `STAGING_FRAME_BYTES`) | `pkg/src/core/evaluate-source.js` (staging), the harness gateway frame guard; **not** the hub | policy [code], [M0] |
| one message into a vat (physical) | halt above about 94 KB at 50 M; meter halt about 51 KB at 10 M | the engine (`HeapExhausted`, `MeterAbort`) | hard, quarantines the vat [M0] |
| inline text field | 8,192 bytes (`inlineBytes`) | harness guest and adapter code | policy, not measured as a limit [M0] |
| property names per vat | about 57,000, never released | engine name table | hard [M0] |
| crank budget, slot and chunk ceilings | 50 M computrons (harness), `slotCeiling` default 1,000,000 (harness 4,000,000), `chunkCeiling` 256 MiB | `pkg/src/ironhorse/ironhorse-limits.js`, worker | hard [code] |
| crank output | no wire limit found; 4 MiB answer measured fine; answered sends halt at 250-300 per crank, `sendOnly` at 600 | heap | hard via heap [M0] |
| GC frames per crank | 64 | `durable-worker-transport.js` `GC_FRAMES_PER_CRANK` | replay contract [code] |
| control socket frame | 8 MiB | `pkg/src/control/local-control.js:15` | hard [code] |
| Noise netlayer message | 65,535 ciphertext, so 65,519 plaintext per OCapN message; TCP frame 65,551 | `packages/ocapn-noise/src/bindings.js` (encrypt refuses above `65_535 - 16`), `transports/tcp.js:25` | hard; `network.js` encrypts each OCapN message whole [code] (no splitting found) |
| hub | none: the hub decodes any size it is given | `hub.js` | none [code] |
| adapter IPC | none found | Node IPC | not checked |
| worker request line | not checked | `main.rs` | not checked |

So today a large ByteArray between two Node adapters crosses the hub without a size limit but with
the per-byte costs of section 3.5; between hosts over Noise one message cannot exceed 65,519
bytes; into a vat the practical limit is 24,576.

---

## 7. Reachability and garbage collection across the hub

### 7.1 Object level

1. A vat's in-heap OCapN client tracks imports with WeakRefs and a FinalizationRegistry
   (`ocapn/src/captp/finalize.js`); finalizers run at the vat's next collection (allocation
   schedule: up to 32 cranks later, CC-022) and send `op:gc-exports { exportPositions,
   wireDeltas }` [code], [M0].
2. The worker transport holds GC frames and delivers them with the next ordinary frame or in a
   batch of 64 (`journalCranks`) [code]. Adapters coalesce one turn's frames (`coalesceInbound`)
   [code].
3. Hub, `op:gc-exports` from session S: for each position, `refcounts[S] -= delta`; at zero it
   deletes `facing[S]` and `ourExports[pos]` and calls `maybeReleaseRef` [code].
4. `maybeReleaseRef(row)`: if no facing and not pinned (publication, gift, gift waiter, answer
   route), the row is deleted, and the origin is told: `op:gc-answers` for an answer-backed row,
   `op:gc-exports` with `wireDeltas: [mentionsIn]` for an export-backed row that the origin
   mentioned [code]. Outgoing GC frames are batched per destination (`withGcBatch`,
   `makeGcBatcher`) [code].
5. So reachability is a chain of independent refcounts: holder -> hub row -> origin. The hub never
   holds an object; a row lives exactly as long as some session faces it or a pin names it [code].

### 7.2 Session and vat level

1. `retireSession` / `forgetSession` bumps the epoch, tombstones every row whose origin is the
   session (`dead: true`: holders' calls break loudly, "the target session has been retired"),
   breaks orphaned listeners, releases the retiree's holdings in batched GC frames, and turns answer
   routes into the retiree into broken routes [code]. Transient adapter sessions are forgotten at
   exit (`adapters.js` `onExit`) and at startup (architecture 0.5) [code], [M0].
2. Whole-vat collection: `daemon.collectVats` builds the session graph from `hub.inspect()`-style
   holdings (`pkg/src/core/vat-reachability.js` `inspectVatReachability`): roots are awake or kept
   workers and published origins; resolver rows and tombstones do not retain [code].
3. Consequence for data references: **a row whose origin is a transient adapter dies with the
   adapter incarnation**. Every vat that held it keeps a tombstone and finds out only when it uses
   it (C-19) [M0]. The harness works around this by making the manager vat the origin of `Blob`
   handles (D-15) so that handles survive adapter restarts, at the cost of a manager crank to mint
   and a manager crank per batch to resolve after a restart [M0].

---

## 8. Measurement: hub forwarding cost of a descriptor and of a ByteArray

**Method** [measured]. A scratch Node script (not committed; it lives in the session scratch
directory) builds `makeOcapnHub` with `syrupCodec` and an in-memory store whose `setState` does
`JSON.stringify` and `JSON.parse` of the state and returns its length. Sessions V, A, B are
attached with plain `send` (not durable, not batching, no fsync). `hub.introduce` gives V a
reference to A's export 1 and to B's export 1. A sender codec kit for V writes `op:deliver` to B's
object with `answerPosition: false` and `resolveMeDesc: false`. The same frame is delivered 200 times
(descriptor), 50 times (ByteArray up to 64 KiB) or 10 times (256 KiB). Node v22.23.4, one machine,
not under the slot lock (no supervisor was started); numbers are CPU cost of the hub path only, not
production latency (no fsync, the JSON store is not the log store).

| arguments of `B.take(...)` | frame in (bytes) | frame out (bytes) | ms per forward | persisted characters per forward | commits per forward |
|---|---|---|---|---|---|
| `aObj` (a presence of A's object) | 61 | 68 | 0.117 | 2,562 (state is 1,211 characters) | 2 |
| ByteArray 1,024 | 1,072 | 1,072 | 0.215 | 4,573 | 2 |
| ByteArray 8,192 | 8,240 | 8,240 | 1.10 | 18,909 | 2 |
| ByteArray 24,576 | 24,625 | 24,625 | 3.10 | 51,679 | 2 |
| ByteArray 65,536 | 65,585 | 65,585 | 8.26 | 133,599 | 2 |
| ByteArray 262,144 | 262,194 | 262,194 | 37.9 | 526,817 | 2 |

Reading [measured, with inference marked]:

- A descriptor moves alone: 61 bytes in, 68 out (the hub's position toward B is a new number).
- Persisted characters per forward = 2 x state + about 2 N: the first commit carries the frame as
  hex in B's queue, the second records its removal. This is C-1 reproduced on a minimal hub.
- About 145 ns per payload byte per forward all-in at 256 KiB (decode copy, two encode copies, hex,
  the test store's JSON); the hub's own `stats()` attributes 54 ms of the 1,036 ms total to
  persists, so most is decode, encode and hex [measured]. With the log store and fsync the
  persisted size is the same order (the queued entry is the whole session row, C-2) [inferred].
- In production a payload hop adds the IPC base64 and, for a vat, the journal and C-5 costs of
  section 3.

---

## 9. The public OCapN drafts (fetched 2026-11-18)

Sources:

- OCapN, "CapTP Specification" (draft), https://github.com/ocapn/ocapn/blob/main/draft-specifications/CapTP%20Specification.md
  (raw: https://raw.githubusercontent.com/ocapn/ocapn/main/draft-specifications/CapTP%20Specification.md)
- OCapN, "Model" (draft), https://raw.githubusercontent.com/ocapn/ocapn/main/draft-specifications/Model.md
- OCapN issue #138, "Streaming Netstring message framing", https://github.com/ocapn/ocapn/issues/138
- OCapN issues search "stream", https://github.com/ocapn/ocapn/issues?q=stream (also lists #20
  "Backpressure?" and #5 "What are the core data types?")

### 9.1 What the drafts cover

- Operations: `op:start-session` (`captp-version`, `crypto-version`, `session-pubkey`,
  `acceptable-location`, `acceptable-location-sig`), `op:deliver-only` (`to-desc`, `args`),
  `op:deliver` (`to-desc`, `args`, `answer-pos`, `resolve-me-desc`, `listen-mode`), `op:abort`,
  `op:listen` (`to-desc`, `resolver-desc`, `listen-mode`), `op:gc-exports` (`export-pos-list`,
  `wire-delta-list`), `op:gc-answers` (`answer-pos-list`) [spec].
- Descriptors: `desc:import-object`, `desc:import-promise`, `desc:export`, `desc:answer`,
  `desc:sig-envelope`, `desc:handoff-give` (`receiver-key`, `exporter-location`, `session`,
  `gifter-side`, `gift-id`), `desc:handoff-receive` (`receiving-session`, `receiving-side`,
  `handoff-count`, `signed-give`) [spec].
- Handoffs: deposit via `deposit-gift` on the exporter's bootstrap, give to the receiver, withdraw
  via `withdraw-gift`, with signature checks and `handoff-count` replay protection; the exporter
  answers the gift whether the deposit comes before or after the withdrawal [spec].
- ByteArray: "An array of 8-bit bytes", no size bound. Tagged: a pair of a String tag and a value,
  the only route the Model gives to richer semantics [spec].

### 9.2 What they do not cover

- **No bulk or out-of-band data, no byte streams, no chunking, no flow control.** The CapTP draft
  assumes a reliable in-order netlayer [spec]. Issue #138 makes framing a netlayer concern and
  notes Noise's 65,535-byte message cap; it does not address large ByteArrays [spec]. Issue #20
  ("Backpressure?") exists; I did not read its body.
- **No extension or capability negotiation.** `captp-version` MUST be `1.0`; a mismatch aborts.
  There is no field for optional features [spec].
- **No rule for unknown operations or record labels** [spec].
- Handoffs are the only way a reference moves so that the receiver talks to the exporter directly;
  nothing in them carries data, but a gift can be any reference, so a data object can be handed off
  like any other [spec], [inferred].

### 9.3 Where our implementation departs from the draft

| point | draft | ours | evidence |
|---|---|---|---|
| fire-and-forget | `op:deliver-only` | folded into `op:deliver` with `answerPosition: false` and `resolveMeDesc: false`; `op:deliver-only` neither accepted nor emitted | `operations.js` comment and `OpDeliverCodec` [code] |
| `listen-mode` | on `op:deliver` and `op:listen` | absent on `op:deliver`; `op:listen` has `wantsPartial: boolean` | `operations.js` [code] |
| extra operations | none | `op:get`, `op:index`, `op:untag` (pipelined field, index and untag) | `operations.js`, `hub.js` `handleMessage` [code] |
| `op:start-session` | includes `crypto-version` | `captpVersion`, `sessionPublicKey`, `location`, `locationSignature` only | `operations.js` `OpStartSessionCodec` [code] |
| framing | per netlayer (#138) | `@endo/syrup-frame` (length prefix, no comma) for the TCP-for-testing interop; Noise per-message | `syrup-frame/README.md`, `ocapn-noise` [code] |
| version negotiation | none | `ocapn-noise` negotiates "encoding versions" in its handshake (up to 17 versions within a 16-version window) | `ocapn-noise/src/bindings.js` `encodeSupportedEncodingsInto` [code] |
| hub as forwarder | not a concept in the draft | a node that is not a client, rewrites every descriptor, redeems inbound gifts itself, never emits gives | `hub.js` header [code] |
| worker sessions | handshake | handshake-free sessions with identities derived from the worker id | `pipe-network.js` [code] |

The draft text itself is inconsistent in places (the summary I fetched flagged `crypto-version`
`Ed25519_SHA256` against `Ed25519`, and the `deposit-gift` argument count) [spec]; that did not
affect anything here.

### 9.4 Related work (pointers)

- Agoric SwingSet **bundlecaps**: the kernel stores bundles by content hash (`b1-` + SHA-512 of the
  compartment map); vats pass a bundlecap (a device node) instead of the 1-2 MB bundle, and the bytes
  reach a vat only through an explicit `D(bundleCap).getBundle()`; `createVat(bundleCap)` never
  routes the bytes through the caller. https://raw.githubusercontent.com/Agoric/agoric-sdk/master/packages/SwingSet/docs/bundles.md
  [spec]. This is the closest precedent to section 10: a kernel-resident, content-addressed data
  object referenced by an ordinary capability.
- Cap'n Proto 0.8 **`-> stream`**: streaming as ordinary calls with client-side flow control,
  wire-compatible with `-> ()`; three-party handoff listed as not yet implemented.
  https://capnproto.org/news/2020-04-23-capnproto-0.8.html [spec]
- Fuchsia Zircon **VMO handles** passed over channels give zero-copy sharing with per-handle rights
  (read, write, map, duplicate) [memory]. The rights model is the relevant part: a holder can pass a
  handle it cannot read.
- E and Agoric **sealer/unsealer pairs** (brands, rights amplification by WeakMap) [memory]; the
  harness already uses the WeakMap form for `Secret` (D-6) and `Blob` (D-15) [M0].
- XMPP XEP-0265 and AFS-3 out-of-band transport: a small control channel plus a separate byte path
  for bulk data (found by search; not read in depth).
  https://potaroo.net/ietf/all-ids/draft-deason-afs3-oob-00.html

---

## 10. Answers

### (a) V passes a presence of A's object to B: what moves, what it costs, and can B talk to A?

- **What moves**: only the descriptor. V writes `desc:export <hub's position toward V>`; the hub
  resolves it to row `A#e:pos` and writes `desc:import-object <hub's position toward B>` toward B. No
  payload, no call to A, A is not told [code], [measured: 61 bytes in, 68 out].
- **Cost**: one crank of V (the vat must run to send anything, tens of ms of host work per crank,
  architecture 0.1) [M0]; in the hub one decode and encode of a small frame (0.12 ms [measured]),
  on first mention a `facing[B]` entry plus `refcounts[B]` and `ourExports` in B's session row
  (about 51 bytes each persisted, m2 4.13) [M0], and the usual commits: the frame is in the log as
  hex once (small here). From then on, every hub commit in the daemon stringifies that row (section
  4.2) [code].
- **B to A**: only through the hub. The hub never issues a third-party give for its own sessions
  (`tableKit.getInfoForVal`: `isThirdParty: false`), adapters are attached without a wire identity
  and cannot dial (`adapters.js`), so every call B makes on the object is B -> hub -> A, each hop a
  decode, encode, hex-queued commit and IPC [code]. An adapter hop with no vat costs 20-25 ms
  (J-0161, J-9043) [M0].
- **Lifetime**: if A's incarnation ends, the row is tombstoned; B's and V's calls on it break with
  the retired text (C-18, C-19) [code], [M0].

### (b) A hub-resident byte store whose references are ordinary OCapN descriptors

The hub already has one piece of endpoint behaviour (the bootstrap at position 0,
`handleBootstrapDeliver`). A data store is a second endpoint, and the tables already model
everything else it needs.

Design sketch [inferred]:

1. **Origin**: a reserved pseudo-session, say `hub:data`, that is always "attached" and never
   retired. A data object is a row `hub:data#0:<n>`; it is exported to any session through
   `provideFacingPosition`, so every holder sees a plain `desc:import-object`. Passing it on,
   pipelining on it, gifting it and GC all work unchanged.
2. **Bytes outside the hub state**: the row table must carry only `{ length, sha256 }` (or nothing,
   with a side table); the bytes live in a content-addressed directory beside the hub log, written
   with write-fsync-rename-fsync before the row exists, refcounted by hash so identical content is
   stored once. Never in `sessions[k].queue` (C-1) and never in the per-commit serialization (C-2).
3. **Messages to a data row are handled locally** like the bootstrap: in `handleMessage`, a target
   whose origin is `hub:data` goes to a local handler instead of `forwardToRow`. Methods for the
   opaque handle: none, or only `length()`/`hash()` returning small values. Reading is section (d).
4. **Creation without the bytes crossing a vat**: an adapter creates data through a `DataWriter`
   facet the hub gives only to adapters (or through the hub bootstrap with a power check): either
   (i) bytes in ordinary frames, chunked under 64 KiB, written straight to the store by the hub (the
   hub is Node, not a vat, so no C-5; frames toward a hub-local endpoint are not queued, so no C-1)
   [inferred from `handleBootstrapDeliver`, which answers without `dispatchBytes`]; or (ii) a side
   channel: the adapter writes a file into a staging directory it is given and asks the hub to adopt
   it by hash (one copy, no IPC of the bytes). The answer is the data row, which the adapter passes
   to vats as any reference.
5. **GC**: `maybeReleaseRef` on a `hub:data` row (no facing, not pinned) decrements the hash's
   count and unlinks at zero. No origin to notify. Startup sweeps hashes no row names.
6. **What this fixes beyond copying**: data rows outlive adapter incarnations (no tombstones, C-19
   does not apply), no manager-vat crank to mint (D-15's stock) or to resolve after a restart, and
   no vat ever touches the bytes [inferred].
7. **What it does not fix**: one hub row and per-holder entries per data object per holder, and the
   O(rows) per-commit cost (section 4.2). A design that hands vats thousands of data references
   needs C-2's remaining work (per-row dirty tracking instead of stringify-all) first, or rows must
   aggregate (a vat holds one "bundle" row naming many items, the archive pattern of m2 4.10).
8. **Where the hub would change**: `provideSessionState` and `retireSessionInternal` (never retire
   `hub:data`), `handleMessage` (local dispatch), `maybeReleaseRef` (store release, no GC frame),
   `serializeHubState`/`restoreHubState` (a data table, version 3), `inspect` and
   `inspectVatReachability` (data rows retain no vat), the daemon wiring (store directory, sweep),
   and the `transient-hub-client`/endpoint for adapter access [code locations, design inferred].

### (c) A protocol extension for by-reference payload

Three levels, from no wire change to a new descriptor [inferred, informed by section 9].

**Level 0, no wire change: data objects are references, metadata is a Tagged value.** A data
reference on the wire is `<desc:tagged "dataref" {ref: <desc:import-object p>, length: n, sha256:
<32 bytes>}>` (the tag name is illustrative). `desc:tagged` is the Model's own extension point, the
hub already transcodes it transparently and rewrites the reference inside [code], and a peer that
does not know the tag still decodes it as a Tagged passable holding a presence: nothing aborts, and
it can still call the presence [spec], [code]. Length and hash travel with the reference, so a
holder can decide, dedupe or verify without a round trip, and a receiver that already has the hash
need not fetch. Range reads are ordinary calls on a reader (`read(dataref, offset, count)` answering a
ByteArray of at most 32 KiB, well under Noise's 65,519), or a stream object with Cap'n
Proto-style client-side flow control (`-> stream`), all within the existing protocol.

**Level 1, hub-only semantics, same wire.** The hub recognizes Tagged `dataref` values whose
reference is a `hub:data` row and checks `length`/`sha256` against its table when one arrives from
an untrusted session (a forged tag around some other presence is then refused or stripped). This
is a policy in `handleMessage`, not a protocol change.

**Level 2, a new descriptor.** `<desc:data ref length hash>` as a reference kind would let a peer
that knows it hold bytes by hash (fetch from any holder with the hash, as content-addressed
networks do). Cost: every peer that does not know the label fails to decode the frame; our hub
aborts a remote session on an undecodable frame (`frameError`) [code], and the draft says nothing
about unknown labels [spec]. It must therefore be negotiated, and the draft offers no mechanism
(`captp-version` fixed at `1.0`) [spec]. Options: a new encoding version in `ocapn-noise`'s
handshake (our netlayer only) [code]; a `fetch("ocapn-ext:data")` probe on the peer's bootstrap
before first use [inferred]; or proposing a capability field for `op:start-session` upstream. For
the hub's local sessions (workers, adapters, endpoint), all of which run our code, no negotiation is
needed. **Passing onward** stays descriptor rewriting through c-lists; **collection** stays
`op:gc-exports` on the `ref` inside; **range fetch** stays a call. The only thing level 2 adds over
level 0 is that a non-hub peer could resolve the bytes from somewhere other than the reference's
origin, which is not the problem the owner described.

Recommendation for this survey: level 0 plus level 1. The by-reference property comes from making
the hub (or an adapter) the origin and giving vats only descriptors; the wire needs no new kind.

### (d) Can the hub enforce "pass but not dereference"?

Yes, two ways; the first is pure object-capability style and needs no notion of session types.

1. **Rights amplification (sealer/unsealer) inside the hub** [inferred]. The handle has no read
   method. A separate `DataReader` object, itself a hub-local row, has `read(handle, offset, count)`
   and `slice(handle, ...)`. When `read` arrives, the hub decodes `handle` to a token, looks up its
   row and checks that its origin is `hub:data` (identity by row, no names or ids), then answers
   bytes. Only adapters are given a `DataReader` (by the manager, or at adapter launch); vats never
   are. A vat that holds a handle can store it, pass it, gift it, and nothing it can do yields the
   bytes. Secrets fit this directly: a `SecretRef` is a data handle whose reader is held only by
   the provider adapter, and the secret never needs a manager-vat WeakMap or an adapter-side
   mapping that dies with the incarnation.
2. **Session-class policy** [inferred]: the hub refuses `read` on data rows when the sender is a
   worker session. It is cheaper to build but it is ambient authority (any adapter can read any
   data) and it ties policy to session naming, against the owner's principle; not recommended
   except as a defence in depth on top of 1.

A caveat: an adapter given a reader can still forward the bytes to a vat as a ByteArray. The hub
can refuse frames carrying ByteArrays toward worker sessions above a size (a cheap check during
re-encode), which would also turn C-5 halts into loud breaks [inferred].

---

## 11. Every place that would change, smallest first

| # | change | where | wire change? | notes |
|---|---|---|---|---|
| 1 | Convention: data references are presences wrapped in Tagged `dataref` with length and hash | harness guest lib, adapters | no | works today with adapter-origin objects; dies with the adapter incarnation |
| 2 | Hub refuses or breaks a frame toward a worker session whose ByteArrays exceed a bound | `hub.js` `forwardToRow` (count bytestring lengths during encode) | no | turns C-5 halts into breaks; protects the "vats never read" rule |
| 3 | Stop writing queued frames into the persisted state for sessions that do not replay (`discardOnRestart`) and keep them out of the per-commit serialization | `hub.js` `dispatchBytes`/`flushOutbox`, `hub-state.js` | no | C-1; prerequisite for any payload crossing the hub, including data creation by frames |
| 4 | Per-row dirty tracking in the hub store instead of stringify-all | `hub.js` (mark rows), `hub-log-store.js` `deltaOf`/`imageOf` | no | C-2 rest; makes many held references cheap |
| 5 | `isPinned` and `clearListenerEntries` with indexes (pin counts per row, listener index) | `hub.js` | no | release becomes O(1) per row |
| 6 | Hub-resident data rows (`hub:data` origin), local dispatch, content-addressed store, GC hook, sweep | `hub.js` `handleMessage`/`maybeReleaseRef`/`retireSessionInternal`, `hub-state.js` (version 3), `daemon.js`, `vat-reachability.js` | no | answer (b) |
| 7 | `DataReader` and `DataWriter` hub-local objects (amplification), handed to adapters by the embedder | `hub.js`, `native/adapters.js`, `daemon.js` | no | answer (d) |
| 8 | Bulk side channel for adapters (staging directory adopt-by-hash, or a second fd) | `platform/node/adapter-processes.js`, `hub.js` | no (not OCapN) | removes IPC base64 and hub decode for creation and reads |
| 9 | Hub check of Tagged `dataref` metadata against its table | `hub.js` | no | level 1 |
| 10 | Direct adapter-to-adapter paths: the hub emitting gives between local sessions (adapters given identities and a local netlayer) | `hub.js` `getInfoForVal`, `adapters.js`, `pipe-network.js`-like duct | uses existing handoff descriptors | removes the hub hop for B -> A traffic; large change |
| 11 | `desc:data` descriptor with negotiation (Noise encoding version or bootstrap probe) | `ocapn/src/codecs/descriptors.js`, `passable.js`, `ocapn-noise` | yes | level 2; only for peers beyond this daemon |
| 12 | Engine: native harden of TypedArrays (C-5) | `rust/engine` | no | makes reading in a vat affordable when it is wanted; outside this survey |

---

## 12. Hard constraints and open questions

Constraints [code], [M0]:

- The hub commits before every send and serializes its whole state per commit; anything placed in
  a row or a queue is paid on every commit thereafter, daemon-wide, on the supervisor's single
  thread.
- The hub transcodes every frame; it cannot forward a payload without decoding it, so "zero copy
  through the hub" is possible only for payloads that are not in the frame.
- Rows whose origin is a transient adapter die with the incarnation; durable data references need
  a durable origin (a vat, today, or the hub, after change 6).
- A vat pays a crank to pass anything, including a descriptor.
- Over Noise one OCapN message is at most 65,519 bytes; a byte transfer between hosts must chunk.
- The draft has no negotiation; any new label breaks peers that do not know it, and our hub aborts
  remote sessions on undecodable frames.

Not checked in this survey:

- Whether ByteArrays are passable into Ironhorse guests in the current build (J-0023 said not, at
  M0).
- The engine's compile cost per byte of the dispatch source literal, separately from C-5.
- Node IPC and worker request size limits.
- The in-vat cost per held import (bytes per c-list entry).
- The production cost of section 8 with the log store, fsync and the slot lock.
- OCapN issue #20's content, and whether newer upstream drafts or pull requests add negotiation.
