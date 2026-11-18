# Spike dataref: critique of the three designs

Research spike, lane `claude/thix-dataref`, critique unit (`THIX_AGENT=CRIT`). Not product code.
Written 2026-11-18 against lane commit `97f5dc0cdc`. I wrote none of the designs or prototypes
under review; this file is the only file I changed.

The three designs:

- **T1** `design-harness.md`: harness objects and adapters only (registry-minted handles, a shared
  file store, an amplifier given to adapters).
- **T2** `design-ocapn.md`: hub-origin `hub:data` rows, a content-addressed store beside the hub
  log, reader/unsealer powers, a checked `thix:data` envelope.
- **T3** `design-engine.md`: an engine-native vat-side handle on top of T2 (D-1..D-4), measured
  only through a worker-transport stand-in.

Evidence labels: **[measured]** by me in this unit (runs listed in section 9, scratch probes
described where used; nothing of the probes is committed); **[code]** read from the named file
and function; **[reported]** a number or claim from a design doc, not re-run; **[fetched]** a
public source I fetched in this unit; **[memory]** recalled, not fetched; **[inference]** my
reasoning.

Paths: `H/` = `packages/thixotrope-harness/`, `pkg/` = `packages/thixotrope/`, `ocapn/` =
`packages/ocapn/`.

---

## 0. Verdict in one table

| | T1 harness | T2 hub and OCapN | T3 engine |
|---|---|---|---|
| keeps bytes out of vat frames, journals, heaps, snapshots | yes [measured] | yes [measured] | yes, but only the stand-in was measured, which is T1's shared store with a bearer integer [measured] |
| a holding vat cannot get the bytes | **broken in the prototype**: any vat holding the consumer endpoint reads any datum by a guessed sequential name, and the ciphertext of any secret (section 2.1) [measured] | holds for vats; but the envelope check stops at nesting depth 64, and a Node session (an adapter or a remote peer) delivered a forged length to another session (section 3.1) [measured] | **broken in the stand-in**: a string or float payload passes the possession check, and a string id is a path into the store directory (section 4.1) [measured] |
| revocation | per datum, store tombstone, works [measured]; anyone who can call the endpoint can revoke for everyone [measured] | **none** (no store flag; acknowledged) | none |
| bytes freed when the last holder drops | never for durable references [reported, code] | T2 demonstrated it only after closing both adapter sessions; with the adapters left open, my probe saw **no** release in 60 rounds (12 s), nor after closing the consumer (section 3.2) [measured] | never (stand-in) [measured] |
| survives restart and SIGKILL | O and S yes, L no [reported; clean restart rerun]; mid-pass SIGKILL not re-verified | yes [measured, rerun]; the SIGKILL check cannot tell a duplicate from a loss (section 3.3) | yes [measured, rerun] |
| reported numbers reproduce | yes in shape; per-reference holding figures move 50-80 % with the batch size (section 2.4) [measured] | yes, within the run-to-run spread [measured] | yes, within the spread, except "inline 1 KiB is 29 % slower" [measured] |
| "zero copy" | 2 copies (write, read), 2 processes touch the bytes [code] | prototype 5 to create + 1 to read; production about 9 + 1 and the supervisor touches every byte until adopt-by-file exists [code, inference] | as T1 for the stand-in; with D-3 hub ingest as T2 |
| protocol | none | level 1 needs no wire change; the hub interprets an application tag; level 2 needs negotiation OCapN does not have [fetched, code] | none beyond T2 |
| adoption cost as stated | about 2 weeks: understated, collection and ownership are left open | 4-6 days core + 1.5-2 weeks harness: understated by the prerequisites it names (C-1, C-2) and the parts it leaves unbuilt (revocation, generations, adopt-by-file, powers at launch) | D-1/D-2 2-3 weeks: plausible; the benefit is unmeasured |

My recommendation (section 8): T1 and T2 are rivals for **identity** (a registry vat versus the
hub) and agree on the **data path** (a file outside the object system, read by an adapter). T3 is
not a third mechanism; it is an optional vat-side representation of T2's row. The smallest step
that pays for itself is T1's adoption step 1 done with T2's adapter-facing shape (`locate`), and
with the T1 prototype's facet mistakes removed.

---

## 1. Method

- Read the three design docs in full, the three prototypes' code, and the hub, hub state, data
  store and transport diffs (`git diff 36b3035e92..HEAD -- packages/thixotrope`).
- Reran each prototype's benchmark under the slot lock, `--exclusive`, with `THIX_AGENT=CRIT`
  (section 9 has times). T2 and T3 full; T1 with `DR_SIZES=1024,1048576 DR_HOLD=200
  DR_WINDOW_MS=10000`, which keeps the secret case and the 1 MiB forward and drops 64 MiB.
- Wrote four scratch probes outside the repository (not committed): a direct drive of the T1
  fixture adapter (`fixture/ephemeral.js`) in Node with a stub registry; a scan of the T3
  stand-in's frame scanner and store with hand-written Syrup; a T2 probe with a real daemon and
  Ironhorse vat (forged envelopes at several depths, a known-value secret and an inline control
  searched over the whole state directory, death with adapters left open, hub growth while
  creating through frames); and my own search of the kept state directories.
- To keep the state directories I used a preload around `fs/promises.rm` (T2, which has no keep
  option; side effect: the daemon's own removals of old snapshots under that directory were
  skipped too, so disk use differed, not timing) and `KEEP_STATE=1` (T1, T3). I removed my own
  directories afterwards.

---

## 2. T1, harness only

### 2.1 Security: a vat that holds the consumer endpoint reads anything in the store [measured]

The prototype gives vats the adapters' whole endpoint. In `dataref.test.js` the same `epA` is the
producer (`acquire(epA, ...)`) and the "Reader" (`readHead(epA, ...)`, line 538), and `epB` is the
consumer vats call for `digest` and `hmac` (line 584). `ephemeral.js` `endpoint` also carries
`read`, `revoke`, `setPeer`, `resolveLocal`, `watchGc` and `lastKey`. And `keyOf` (lines 201-235)
falls back, for a handle the registry does not know, to `E(peer).resolveLocal(handle)` and uses
whatever string comes back as a store key, checked only against the key regex. Store keys are
sequential (`d<n>`, `s<n>`, `fixture/durable.js` `mint`).

I drove `ephemeral.js` directly in Node (two adapters A and B, a stub registry identical to
`durable.js` `mint`/`resolve`). An "attacker" holding only `epB`, and never given any reference:

| step | result |
|---|---|
| `E(epB).setPeer(evil)` where `evil.resolveLocal()` answers `'d1'`, then `E(epB).read({ datum: Far('Forged', {}) }, 0, 4096)` | **the 64 bytes of A's private datum `d1`** |
| same with `'s65'` (the first secret key of a stock) | **the 71-byte ciphertext of the secret** (12 nonce + 43 + 16 tag) |
| same with `'d2'` (no such file) | break with `ENOENT ... stat '<absolute store path>/d2'`: an existence oracle, and the absolute path of the store goes into the caller's journal |
| `E(epB).revoke(datumItWasPassed)` | ok; every holder's next use fails `dataref: revoked` |
| `E(epB).read(secretRef, 0, 4096)` with the honest peer | the secret's ciphertext |

Some of this is prototype hygiene (`setPeer` and `read` on the endpoint vats get). Three parts are
design-level and must be fixed in any production T1:

1. **The L-form resolution is a confused deputy by construction.** To use an adapter-origin datum
   the consumer must ask another party for a key and trust the name it answers. Any party that can
   place itself, or a forwarder, where the consumer asks can point the consumer at any file.
   Remove L or resolve it only through an amplifier the consumer was given, never through a peer.
2. **The store is a flat, guessable name space shared by every adapter.** Sequential keys plus a
   path built from a name means any amplification bug becomes "read everything". Keys should be
   random (as tickets already are), and an adapter should be able to open only what an amplifier
   answered for a handle it actually holds.
3. **Revoke and read need their own facets.** The design text says a vat reads "only through a
   Reader it was explicitly given"; the prototype measured that property with a Reader that is the
   producer endpoint. The secret case also lets any holder of the consumer get the ciphertext.

### 2.2 Security: the rest

- **S tickets** are AES-GCM under the same key that encrypts the secrets (`seal` and `adopt` both
  use `keyBytes()`) [code]. Feeding a secret file's bytes as a ticket decrypts it inside `unseal`
  and then fails the key regex, so it does not leak the value, but one key for two purposes
  should not survive into production. Tickets are bearer strings in vat heaps and journals, as T1
  says.
- **Kind confusion**: `keyOf` takes `ref.datum ?? ref.secret` and does not check the handle's
  kind, so `{ datum: secretHandle }` digests and reads the ciphertext and `{ secret: datumHandle }`
  tries to decrypt a plain file [code].
- **`bytes` is unchecked**: `{ datum, bytes }` is a plain record; any vat can rewrap a handle with
  a false length and the next holder believes it. T2's envelope check is the fix [code].
- **The amplifier is reachable from the service facet**: `durable.js` `facet.unsealer()` returns
  it. The test needs that to configure B; a production facet given to vats must not have it
  [code].
- **Holder-applied use** (`hmacVia`) is a MAC oracle over caller-chosen input for anyone who can
  call the consumer. For request-signing secrets that is full use authority. That is the intended
  semantics of "use without reveal", but the doc should say so; destinations must be bound at
  mint, as T1 says (2.2).
- **Canary search**: my own search of the kept state of my rerun, with the test's actual secret values
  (captured by a preload around `crypto.randomBytes`, 48-byte and 1 MiB calls only), over all 491
  files (266 MB) of the state directory, the store included, and over the auxiliary directory
  (key file, effects), in raw, hex (both cases), UTF-16 (both orders), base64 and base64url at
  three alignments: **0 hits** for the 64-byte and the 1 MiB secret; the inline canary was found
  in V1's snapshot (raw, UTF-16BE). T1's own scan agreed (78 live files, 74 stopped, 0 hits;
  canary found in V1's journal while live and its snapshot after the stop). [measured]

### 2.3 Determinism, persistence, collection

- Determinism holds: vats see only frame content; the registry is a vat [code, agree].
- **Dangling after restart**: L references held by a vat become tombstones after an adapter
  restart [reported]. T1 limits L to one turn; the prototype stores them in vats anyway.
- **Leak on vat deletion**: O handles are never collected (no `FinalizationRegistry` in guest
  code [reported]). "Explicit release (session delete)" needs the registry to know which datums a
  deleted session owned; the registry keeps only a non-enumerable `WeakMap`, and a datum passed
  from session X to Y has no owner rule. Nothing in the prototype or the doc answers who frees a
  datum that crossed sessions [code, inference].
- My rerun repeated the clean restart (O, S, secret work; L refused) and a SIGKILL that landed after
  the pass had finished (2.4), so the reported mid-pass SIGKILL is not re-verified.

### 2.4 Measurements

Rerun, exclusive, 04:26-04:30Z, commit `97f5dc0cdc` (plus this untracked file), with
`DR_SIZES=1024,1048576 DR_HOLD=200 DR_WINDOW_MS=10000` (2 min 8 s of test):

| case | reported | my rerun |
|---|---|---|
| O 1 MiB: total (acquire + pass + send) | 385 ms (119 + 116 + 93) | 311 ms (88 + 57 + 91) |
| O 1 MiB: registry resolve at B | 24-54 ms | 22-38 ms |
| S 1 MiB total | 199 ms | 313 ms |
| inline 1 MiB | vat halted after 3,479 ms, hub log +2.46 MB | halted after 2,047 ms, hub log +1.26 MB |
| baseline (b) 1 MiB, 52 pages | 1,480 ms (28.5 ms per page), hub log +2.93 MB | 1,278 ms (24.6 ms per page), +3.02 MB |
| rare read 1 KiB | 75 ms, 1,224 frame bytes | 61.6 ms, 1,223 frame bytes |
| secret 64 B: adopt / direct / via | 209 / 62 / 74 ms | 240 / 57 / 68 ms |
| secret 1 MiB: adopt / direct / via | 25 / 71 / 68 ms | 26 / 45 / 58 ms |
| revoke, next use | fails, 83 ms | fails, 78 ms |
| restart: first O use / cached / S / secret / L | 188 / 59 / 55 / 174 ms / refused | 481 / 51 / 53 / 155 ms / refused |
| holding, O: slots and snapshot bytes per reference | 121, 4,166 (1,000 references) | 186, 5,489 (200 references) |
| holding, S | 23, 578 | 13, 184 |
| holding, O: persisted hub chars per reference | about 444 | about 503 (100,528 for 200 O and 200 S) |
| property names left | 57,027 | 57,027 |

Times reproduce within the spread. The **holding figures do not**: per-reference slots and
snapshot bytes move 50-80 % with the number of references, because they are slot-page capacity
(256-slot pages) divided by N. They are good for "O costs several times S", not for any absolute
per-handle cost; T1's doc quotes them as per-reference costs. My SIGKILL run used 1 MiB (I dropped
64 MiB), and the pass had finished before the kill (`effectsAtKill: 1`), so it does not test the
reported scenario.

### 2.5 Adoption cost

"About two weeks, no core work" covers the generalisation. It leaves out what production needs
and the doc lists as open: an ownership and release rule for datums that cross sessions (no GC),
random keys and a separate Reader and admin facet (2.1), quotas and an archive-aware sweep, secret
generations. T1 also keeps the per-handle hub row (C-2) that made the archive convert references
into names. I would put production T1 at 3 weeks, and it still does not free bytes [inference].

---

## 3. T2, hub and OCapN

### 3.1 Security

- **Envelope check** (`hub.js` `checkDataEnvelopes`): the walk stops silently at depth 64
  (`if (depth > 64) return;`), and neither `ocapn/src/syrup/decode.js` nor the passable codecs
  limit nesting [code]. My probe (a real daemon, an Ironhorse vat, two transient clients):

  | sender | nesting of the forged envelope (claimed length 7, true 1,024) | result |
  |---|---|---|
  | a vat | 0, 1, 40 | broken: "envelope does not match its reference" |
  | a vat | 63 and more | the vat halts first: `guest crank halted: StackOverflow` while encoding |
  | a Node session (adapter stand-in) to another session | 0 | broken |
  | a Node session | **64, 65, 70** | **delivered**; the receiver saw `length: 7n` |

  So vats cannot exploit it (their stack gives out first), but any adapter or remote peer can hand
  a vat-or-adapter consumer an envelope whose metadata the design says can be trusted "without a
  round trip". Fix: refuse, rather than accept, a message deeper than the walk's bound.
- **Powers by fixed swissnum in the prototype**: the benchmark publishes the writer, reader and
  unsealer under constant strings (`bench.mjs` `POWERS`, `daemon.publishDataPower`). Any session
  that can `lookup` publications and knows the string has the unsealer. The design says
  production introduces powers at adapter launch; until that exists the authority is a bearer
  name, against the owner's rule [code].
- **No revocation.** A sealed row stays readable by every unsealer holder until every holder lets
  go, and `locate` hands out the file name (a content hash) that stays valid as long as the file
  exists. An adapter that once located a secret can keep reading the file after the reference it
  held is gone [code]. The doc lists revocation as unbuilt; for secrets it is a requirement
  (M4's P-58 has revoke and delete-after-revoke), so T2 alone cannot carry secrets.
- **`locate` makes the reader power advisory against adapters.** All adapters run as the daemon
  user and can list `hub-data/`; ciphertext of every secret is there, and every provider that uses
  secrets holds the same AES key in T2's secret flow (2.2: "providers get the unsealer and the key
  file"). That is the widening T1 explicitly avoided with holder-applied use; T2 does not mention
  it [code, inference]. The boundary T2 actually enforces is vat versus adapter, as for T1.
- **Hash disclosure**: `describe()` and the envelope give every holder, vats included, the
  SHA-256 of non-sealed data. If a low-entropy credential is ever forwarded as ordinary data (an
  `.env` file from a workspace), its hash sits in vat journals and model context as a guess
  oracle [inference].
- **Break texts can carry paths**: `respondLocal` breaks with `String(error.message)`; a store
  error from `dataStore.read` would carry its file path to the caller [code; not triggered].
- **Canary search** [measured, own probe]: a 64-byte secret with a recognisable prefix and a 1 MiB
  secret holding it, sealed by the writer, kept in V1, V1 put to sleep (snapshot), used by a
  provider through the unsealer and `locate` (both keyed digests correct); then the whole state
  directory searched after shutdown (15 files, 31 MB; raw, hex, UTF-16, base64, base64url):
  **0 hits** for both. The inline control (the same kind of string, kept by V1) was found in V1's
  snapshot (UTF-16BE) **and in `hub-log.jsonl` as hex**, the C-1 queue, which is exactly the
  exposure T2 avoids.

### 3.2 Determinism, persistence, collection

- Determinism: what a vat sees is frame content, and the envelope check's answer comes back as a
  journaled frame [code, agree]. Export positions are monotonic within a session epoch
  (`provideFacingPosition`, `session.nextExport += 1n`; reset only on retire) [code], which also
  answers T3's open question 4.7.
- Release and unlink: `releaseDataEntry` queues the hash and `persist` unlinks only after
  `store.setState` returned, and only if no row minted since names it [code, agree]. A
  crash between rename and row commit leaves a file the startup sweep removes [code].
- **Death with live adapters**: T2's case 5 frees the file only after closing both adapter
  sessions (`bench.mjs` case 5: `A.client.close(); B.client.close();`). In production adapters
  stay up. My probe: A creates a 4 KiB datum inside a closure (so A keeps no presence), V1 keeps
  it, gives it to B's consumer (which `locate`s and reads it and keeps nothing), and drops it; then
  60 rounds of a 50,000-allocation crank in V1, `global.gc()` in the adapters' process and 50 ms:
  **not freed** (12 s). Closing B and 30 more rounds: still not freed. I did not diagnose who holds
  it (A's client import table, B's, or the hub's mention accounting). This is the same symptom T1
  saw for adapter-origin data (T1 7.6) and means T2's "lifetime is OCapN GC" is unproven for the
  production shape, where adapters live as long as the daemon. [measured, not diagnosed]
- **Every commit serializes the whole `data` table** (`hub-state.js` `serializeHubState` builds
  `state.data` from every entry); the log store then diffs it per entry. T2 says this (C-2); it
  means 10^4 held datums cost about 1.3 MB of stringify per commit [inference from about 130
  chars per entry, T2's figure].

### 3.3 Measurements (rerun, exclusive, 2026-11-18 04:09Z, commit `97f5dc0cdc`)

| case | reported run 1 / run 2 | my rerun |
|---|---|---|
| secret 64 B: use ms, hits | 146 / 243, 0 | 188, 0 |
| secret 1 MiB: use ms, hits | 155 / 195, 0 | 133, 0 |
| bulk 1 MiB: A->V1 / V1->V2 / V2->B ms | 114/437, 165/321, 48/81 | 108, 145, 51 |
| bulk 1 MiB: V1 / V2 journal growth | 706-778 / 758 B | 778 / 758 B |
| bulk 1 MiB: hub log over three hops | 35.7 / 34.6 KB | 33.6 KB |
| create 64 MiB through frames | 422 / 950 ms | 521 ms |
| `read` in frames, one 1 MiB answer: hub log | +1.72 MB | +1.72 MB |
| baseline (b) 1 MiB, 20 KiB pages | 759 / 1,238 ms | 788 ms |
| death | 3 rounds, 622 / 1,093 ms | 3 rounds, 647 ms |
| SIGKILL | 3 started, 6 -> 8 keeps | same |

The numbers reproduce. Two method problems:

- **The SIGKILL check is too weak**: `noDuplicate: keepsAfter - keeps0 <= passesStarted` cannot
  tell "one pass applied twice and one lost" from "two applied once". It needs per-pass ids. The
  loop also exercises only V1 -> V2, not an adapter.
- **Creation is measured, its hub-state cost is not**: case 2 measures hub growth after
  `createDatum`. My probe measured it: creating a 64-byte and a 1 MiB sealed datum through
  frames grew the hub files by 37 KB in all, so the bytes do not enter the hub state on creation
  either (in-process clients; the production IPC leg is not on this path). [measured]

### 3.4 Protocol

- **What an old peer does**: it decodes `desc:tagged` with tag `thix:data` into an ordinary Tagged
  holding a presence, and can pass it on. The OCapN Model draft defines Tagged as a pair of a tag
  and a value, gives no reserved tags and no namespacing, and says nothing about unknown tags or
  intermediaries [fetched: OCapN Model draft,
  https://github.com/ocapn/ocapn/blob/main/draft-specifications/Model.md]. So level 1 is
  expressible without a new descriptor, and T2's claim holds.
- **The conflict is semantic, not syntactic**: the hub breaks a message because an application
  value has a particular tag. Any application (or remote peer) that happens to use `thix:data`
  gets breaks. The tag must be namespaced and documented, as T2 says in its risks.
- **Encoding detail not checked**: the Model draft says a tag "must be a String"; Endo's codec
  writes and reads the tag as a Syrup selector (`ocapn/src/codecs/passable.js` `OcapnTaggedCodec`,
  `writeSelectorFromString`). I did not check the Syrup/CapTP draft's encoding of `desc:tagged`,
  so whether a non-Endo peer would decode the envelope is not verified.
- **Local answers without a value**: `respondLocal` records `{ done: true }` for non-reference
  answers, so a peer that uses `op:listen` on the answer of `describe`, `read` or `locate` gets a
  fulfilment without the value (T2 says so). For non-Endo remote peers that is a conformance bug,
  not a corner case [code].
- **Level 2 (`desc:data`)**: the drafts I fetched have no extension negotiation; T2's options (an
  `ocapn-noise` encoding version or a bootstrap probe) are ours only. Not needed by any of the
  owner's cases; I agree it should stay unbuilt.

### 3.5 Adoption cost

T2 estimates 4-6 days of core and 1.5-2 weeks of harness, with C-2 as "a separate prerequisite".
Unbuilt parts that the owner's cases need: revocation (secrets), mutable slots or generations
(secrets), adopt-by-file (otherwise every created byte crosses the supervisor's single hub thread,
with synchronous fsyncs, and in production four more IPC encodings), powers introduced at adapter
launch (otherwise powers are bearer strings), quotas, a measured concurrency run. Plus C-1 and C-2
for holding many references. I would put T2 to production for the bulk case at 3-4 weeks of core
and harness work, and secrets on T2 later still [inference].

---

## 4. T3, engine and worker

### 4.1 Security of the stand-in: the forgery check covers one encoding [measured]

The stand-in's outbound check (`dataref-store.mjs` `makeFrameFilter` `outbound`) refuses only
references that `scanFrame` recognises, and `refAt` recognises only `<desc:tagged 'thix-dataref
INT+>`. The consumer and reader then use `ref.payload` as a file name (`fileOf(id)` =
`path.join(segDir, id.toString(16))`). I fed the scanner and filter hand-written Syrup of the
shapes the codec writes:

| payload | `scanFrame` sees a reference | outbound filter, worker holds nothing | consequence |
|---|---|---|---|
| integer `12345` | yes | refused | as measured by T3 |
| string `"3039"` | no | **passes** | `fileOf("3039") === fileOf(12345n)`: the same segment |
| float | no | passes | names the same file when the id is exactly representable |
| string `"../possess/v1"` | no | passes | `store.read("../outside.txt")` returned a file outside the segment directory |

So a vat that learns a datum's number from anywhere (a log line, a model's text, another vat) can
present it as a string; and a vat given the stand-in's `Reader` can read any file the supervisor
user can open. T3 states that adapters are unchecked and the integer is guest-visible; the doc's
"measured refusal" (5.3) is true only for the integer encoding and should say so. Possession is
also append-only and never revoked: a worker that once received an id may emit it forever.

None of this applies to D-1 as designed (an engine handle with no readable id); it does mean the
stand-in measured nothing about unforgeability.

### 4.2 Canary search, my own [measured]

On the kept state of my rerun: the two secret segments (identified as the store's 64-byte and
1 MiB files that are not lowercase letters) were searched in raw, hex (both cases), UTF-16 (both
orders), base64 and base64url at three alignments over every file of the supervisor's state
directory (96 files, 278 MB, after the final restart) and over the store's possession logs and
frame log: **0 hits**. Positive control: the inline 1 MiB baseline's text was found in the inline
vat's journal (base64). T3's "transport-ingested secret found in `hub-image.json`" was no longer
there after the final restart: the queued frame had been delivered and the image compacted, so
that finding is "present until the hub queue drains and compacts", which is still a persistence
of a secret in clear.

### 4.3 Determinism, persistence, collection

- The filter runs before `journalEntryOf` builds the entry, so replay reads the filtered frame
  [code, agree]. Outbound frames are filtered live and on replay alike [code].
- Crash between the segment write or possession grant and the journal append over-grants and
  orphans a segment [reported, agree].
- No death signal at all: 1,008 segment files before and after [reported, measured].
- D-2's safety argument rests on positions not being reused within an epoch; that holds in
  `hub.js` (3.2) [code].

### 4.4 Measurements (rerun, exclusive, 2026-11-18 04:15-04:17Z, 116 s in the script)

| case | reported | my rerun |
|---|---|---|
| bulk 1 KiB / 1 MiB / 64 MiB, ms per pass (median) | 83.3 / 83.0 / 179.8 | 77.6 / 114.0 / 129.8 |
| 1 MiB passes, all five | 182.9, 178.2, 78, 83, 83 | 170.2, 175.7, 114.0, 71.9, 73.1 |
| journal growth per 5 passes, 1 MiB (V1, V2) | 2,322 / 2,360 | 2,322 / 2,360 |
| blob-like 1 MiB | 885.7 ms | 743.7 ms |
| page through hub, inferred 64 MiB read | 16.35 ms, 53.6 s | 12.77 ms, 41.8 s |
| inline 1 KiB | 107.2 ms | 79.0 ms |
| inline 1 MiB | retired after 4,510 ms | retired after 3,799 ms |
| secret use 64 B / 1 MiB | 53.1 / 47.0 ms | 40.7 / 43.1 ms |
| secret search, live / after snapshot | 0 hits, controls found | 0 hits, controls found |
| forgery (integer encoding) | refused | refused |
| death | 1,008 / 1,008 | 1,008 / 1,008 |

Byte counts are identical; times are within the spread. The 1 MiB median of five is bimodal (two
passes near 175 ms, three near 75 ms), so "83.0" and "114.0" are the same distribution. **Not
reproduced**: "the 1 KiB inline pass is 29 % slower" (7.3); in my run inline (79.0 ms) and data
reference (77.6 ms) are the same.

### 4.5 What T3's numbers are

The stand-in's producer and consumer write and read the store directly, so its case-2 numbers
measure T1's data path with a bearer integer, not the engine design, and not T2's hub path. T3
says so (7.5). The one number specific to the engine question, the in-vat cost of a held handle,
was not measured: "Tagged 71 slots, presence 136 slots per reference" are slot-page capacity over
batches. T1 measured 23 slots for a ticket record and 121 for a presence on the same kind of
batch. The two tracks disagree by 3x on similar objects; neither isolates the handle.

### 4.6 Adoption cost

D-1/D-2 at 2-3 weeks plus golden re-pins and a state migration is plausible [inference]. Its
benefit is unmeasured, and T3 itself says build it only above about 10^4 held references. D-1a
(in-vat client, JavaScript) relies on the bootstrap having `FinalizationRegistry` and `WeakRef`,
which guest code does not (T1's probe) [reported]; I did not check the bootstrap.

---

## 5. Were the baselines made to look bad?

- **Baseline (b) pages at 20,480 bytes between two Node processes.** That page size exists because
  a *vat* refuses inbound frames over 24,576 bytes. Adapter-to-adapter calls through the hub are
  not bound by it: T2's `read` answers 1 MiB toward a local session, and its "read in frames"
  case moved one 1 MiB answer in 210-304 ms [measured, rerun 210 ms]. A fair "no new mechanism"
  baseline for a 64 MiB adapter-to-adapter transfer is therefore about 64 x 0.21-0.30 s = 13-19 s
  [inference], not the 42-93 s the docs extrapolate. The real cost of that baseline is the hub log
  (+1.72 MB per MiB, C-1), not the time.
- **T1's baseline (b) is the outlier**: 28.5 ms per page (24.6 in my rerun) against 12.8-16.4 ms
  in T2 and T3. Its
  page path goes through A's endpoint and answers latin1 text strings, and its run was under load.
  Its 93 s extrapolation should not be quoted beside T2's and T3's.
- **Baseline (a) inline 1 MiB** is not a design anyone would build (the harness already caps
  inline values at 8 KiB); it shows why, fairly.
- **Restart baseline in T3** ("blob-like fails after restart: unknown blob") compares with an
  adapter-held object without the manager vat, which the harness abandoned for exactly this reason
  (D-15). The harness's actual blobs survive restart via `resolveBlobs`. Unfair as stated.

---

## 6. "Zero copy", counted

For N bytes forwarded A -> V1 -> V2 -> B, with B reading all of it:

| design | user-space copies of the N bytes | kernel copies | processes that read or write the bytes | in vats, hub state, journals, snapshots |
|---|---|---|---|---|
| T1 O or S [code: `writeDurably`, `digestFile`] | 0 beyond the source buffer and B's read buffer | 2: A `writeSync` into the page cache, B `readSync` out of it | A, B | none |
| T2 prototype, in-process adapters [code: `bench.mjs` `createDatum`, `ocapn/src/syrup/encode.js` `writeBytestring`, `decode.js`, `hub.js` `bytesOf`, `hub-data-store.js`] | 2 encode in A, 1 decode in the hub, 1 `bytesOf` slice | 1 write, 1 read by B | A, the supervisor (hub thread, with fsyncs), B | none |
| T2 production, adapters over Node IPC [inference from the IPC path in survey S2 3.1] | the above plus about 4 (base64, JSON, parse, decode), 2 of them inflated 4/3 | 1 + 1 | A, the supervisor, B | none |
| T2 with adopt-by-file (unbuilt) | as T1 | 1 + 1 | A, B | none |
| T2 `read` in frames (rare read) | about 6 more per read, plus 2N hex in the hub log | | A, supervisor, the reader | the reader's journal; the hub log until compaction |
| T3 stand-in | as T1 (B reads the whole file into memory with `readFileSync`) | 1 + 1 | A, B | none |
| T3 D-3 transport ingest | producer and IPC as T2 production, plus hex in the hub queue | | producer, supervisor | **the hub image, in clear** (measured by T3, 2.2 MB per MiB) |

No design maps memory or passes descriptors; every "zero copy" here means "zero copies inside the
object system", which is the property the owner asked for. T2 in production is the only one where
the supervisor touches every created byte; that is the biggest practical difference between T1
and T2 today, and adopt-by-file removes it.

---

## 7. Do they compose?

- **T1 versus T2 is a real choice of where identity lives**: a registry vat (one crank per
  consumer per fresh datum and per restart, no collection, per-handle hub rows) or the hub (no
  crank, collection by OCapN GC, a core change). Both put the bytes in a file outside the object
  system and let an adapter read it. Nothing stops T1's adapter-side contract ("given a reference
  and an amplifier, open a file") from later being backed by T2's `locate`. They should be
  designed as one adapter contract with two backings, not as rivals for the whole mechanism.
- **T3 composes with T2 only**: D-1 wraps a `hub:data` import; D-3 belongs in the hub; D-2 feeds
  T2's release. Its one change request (a sealed envelope) is cheap and sensible. It does not
  compose with T1 (registry handles are ordinary remotables a vat already holds).
- **End to end** the composed mechanism is: adapter writes a file and adopts it (T2 adopt-by-file,
  or T1's write); the reference is a `hub:data` row in an envelope (T2); vats hold a presence
  (today) or a D-1 handle (later); consumers `locate` (T2) and read the file; secrets are used by
  the holder (T1's holder-applied use), never decrypted by consumers.

### 7.1 The owner's cases, and the right layer for each

| case | home | why |
|---|---|---|
| secrets used but not read | **harness** (T1's holder-applied use, which is today's D-6 rule) | the value never needs to move. The harness already gives vats `Secret` handles and only the agent-host process reads values (m4-interfaces, D-6). What remains is the CLI's large sealed-box write through the hub, which is an adopt-by-file problem, not a reference problem. T2 sealed rows add every provider holding the key and no revocation. |
| bulk forwarding | **hub (T2)**, with T1 step 1 as the bridge | restart-stable, collectable, no registry cranks; needs adopt-by-file and C-1/C-2 to pay at scale |
| the rare read | an async reader call answered in frames, all three agree | bounded pages toward vats; the cost is C-5 per byte, so deliver-v2 and the harden fix (survey S3) matter more than any reference design |
| data produced inside a vat | **not solved by any design** | T1 and T3 say a vat must emit bytes in frames. With T2, a vat given a builder (an attenuated writer) could `append` pieces: the bytes cross the vat's outbound frames and the hub decode once, and land in a file, not in the hub state or any journal [inference from `handleDataDeliver`: builder calls are served locally and not queued]. Builders do not survive a restart, so the vat must handle a break. Nobody proposed or measured this. |

### 7.2 The smallest first step that pays for itself

1. **Give the workspace and containers adapters the existing blob store path and the manager's
   `resolveBlobs` amplifier in their binding specs, and let them open blob files themselves**
   (T1 adoption step 1). It needs no core change, reuses D-15's handles, and removes 20 KiB
   paging through the hub for `runCommand` stdin, `viewImage` and export. Do it with: random
   blob keys (2.1), an adapter-side function shaped like T2's `locate(handle) -> file` so a later
   T2 backing does not change consumers, no `resolveLocal`-style fallback, and binary data.
2. Then T2's hub rows **for bulk data only**, together with adopt-by-file and C-1. Leave secrets
   on D-6 holder-applied use.
3. T3's D-1a/D-1/D-2 only when a measured vat holds enough references for the per-presence cost
   to matter; first measure that cost properly (one handle, not slot-page capacity).

---

## 8. Recommendation

Adopt the data path (file outside the object system, adapter reads it) now through the harness
(7.2 step 1); move identity and lifetime into the hub (T2) for bulk data once adopt-by-file,
revocation flags and C-1/C-2 are scoped; keep secrets as holder-applied use. Treat T3 as a later
optimisation of T2. Before any of it ships, fix the two security mistakes the prototypes show:
name-based amplification over a shared flat store (T1) and a possession check keyed to one
encoding (T3); and close T2's depth-limited envelope walk (refuse beyond the bound).

---

## 9. Runs, times and what I did not check

Runs (all through `scripts/run-lock.mjs`, `THIX_AGENT=CRIT`):

| run | lock | wall | result |
|---|---|---|---|
| T2 `bench.mjs`, all cases | exclusive | 04:07:47-04:09:36 (about 16 s of benchmark) | exit 0 |
| T3 `bench.mjs` | exclusive | 04:11:05-04:17:48 (116 s in the script; the rest waiting) | exit 0 |
| T2 probe, first attempt | shared | 04:17:50-04:24:42 (mostly waiting) | my bug: calls routed through the wrong session; results discarded |
| T1 `dataref.test.js` part `bench`, reduced sizes | exclusive | 04:24:42-04:30:16 (2 min 8 s of test) | passed |
| T2 probe, second attempt | shared | 04:30:18-04:31:56 | vat halted on deep nesting (StackOverflow) before the rest ran; the depth result is kept |
| T2 probe, third attempt | shared | 04:32:39-04:32:57 | exit 0; results in 3.1, 3.2, 3.3 |

Unit-level probes (no supervisor, no lock): the T1 fixture driven directly; the T3 scanner and
store.

Not checked:

- T1's mid-pass SIGKILL (my kill landed after the pass) and T1's isolated death part.
- Whether a non-Endo OCapN peer decodes the envelope (tag as selector versus string).
- The bootstrap's access to `FinalizationRegistry` (T3 D-1a).
- The cost of T2's envelope walk per `op:deliver`; concurrency on the hub thread.
- The exact copy count on the production Node IPC path (taken from survey S2, not re-read).
- Whether vats in the harness can reach the hub's publication `lookup` (which would make T2's
  prototype swissnums reachable from a vat).
