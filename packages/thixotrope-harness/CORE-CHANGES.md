# Journal of changes to Thixotrope and Ironhorse

This journal lists every change this branch makes outside `packages/thixotrope-harness`: to
Thixotrope (`packages/thixotrope`), to the Ironhorse engine and worker (`rust/engine/**`,
`rust/thixotrope-ironhorse-worker/**`), to the boot polyfills (`rust/endo/xsnap/src/polyfills.js`)
and to other Endo packages. For each change it says what changed, why the harness needed it, and
what an upstream reviewer should check. The fit and performance evidence lives in `JOURNAL.md` and
is cited here by entry id (J-nnnn). Candidate ids (C-n) are those of `designs/m0-results.md` page 6;
CORE-n ids are those of `designs/architecture.md` section 1.1.

Paths: `pkg/` = `packages/thixotrope/`, `H/` = `packages/thixotrope-harness/`. The branch starts at
`48d6f3e08b` (the `llm` branch).

## Terms

- **Vat**: one persistent JavaScript object graph that Thixotrope runs in its own Ironhorse worker
  process and reaches by OCapN messages through the hub.
- **Crank** (delivery): one turn of a vat. The worker evaluates one or more inbound frames, drains
  the job queue, runs a full garbage collection, and the host commits the result. A crank has a
  computron budget (`THIXOTROPE_CRANK_BUDGET`); it halts with `MeterAbort` or `HeapExhausted`.
- **Hub**: the OCapN router in the supervisor process (`pkg/src/net/hub.js`). It keeps reference
  tables for every session and persists them to `hub.json` before it sends any frame.
- **Worker journal**: the per-vat log of inbound frames, appended durably by the durable worker
  transport (`pkg/src/core/durable-worker-transport.js`). A restart replays the journal suffix after
  the last snapshot.
- **GC frame**: an OCapN `op:gc-exports` or `op:gc-answers` message. A peer sends one when its
  garbage collector drops references the other side exported or answered.
- **Boot fingerprint**: the Ironhorse engine's hash of its boot intrinsic layout
  (`proto_methods`, `INTRINSIC_KEY_ORDER`). Every Ironhorse snapshot carries it; a snapshot made
  under another fingerprint is refused with `BootLayoutMismatch` (J-9001).
- **Runtime identity** (the "boot digest" of `H/README.md`): the sha256 of the worker binary and
  of each boot bundle in `pkg/dist-ironhorse`, which Thixotrope records per state directory
  (`pkg/src/ironhorse/ironhorse-runtime.js`). A change to the worker or to a bundle changes it, and
  an existing state directory is refused.
- **Lane**: the Ironhorse integration test run, `corepack yarn test:ironhorse` in `pkg/`, whose
  file list is `pkg/ava.ironhorse.config.mjs`.

## How to add an entry

Add the entry in the same commit series as the change it describes. Write one entry per logical
change; several commits may share one entry (a fix and its regression test, for example). Never
rewrite an entry. If an entry turns out wrong or incomplete, add a new entry that names the one it
corrects ("Corrects CC-004"). Number entries CC-001, CC-002, ... in commit order, and add a row to
the summary table and lines to the Accounting list.

```
### CC-nnn YYYY-MM-DD <component> - <short title>
Commits: <short hash> <subject>, one per line.
Files: the main files touched.
What changed: behaviour before and after; name the function or mechanism.
Motivation: the harness need or the measurement that forced it, with numbers and J-nnnn ids; say
  so if the first diagnosis was wrong.
Visible to other users: what another user of Thixotrope or Ironhorse will notice (state refused,
  new exports, new status fields, changed semantics), or "none".
Tests: what was added and which suites were run, with counts where JOURNAL.md records them.
Upstream notes: what a reviewer should check, known limits, follow-ups not done, and whether the
  change stands alone or depends on another entry.
```

The date is the commit's author date. Components: Ironhorse engine, Ironhorse worker, boot
polyfills, Thixotrope core, Thixotrope tests and tooling, other Endo package, upstream merge.

## Summary

| id | date | component | change | motivation | commits |
|---|---|---|---|---|---|
| CC-001 | 2026-11-16 | other Endo package (root) | `yarn.lock` entry for the harness package | register the private package in the workspace | `0d35cbd569` |
| CC-002 | 2026-11-16 | other Endo package | emulated TypedArray constructors keep the genuine statics | the shim hid `Uint8Array.fromBase64`/`fromHex` from vats | `b10254b252`, `e0f06cbb6d` |
| CC-003 | 2026-11-16 | other Endo package (root) | root `eslint.config.js` loads the harness guest rules | the repository has one flat ESLint config | `4180c69f2b` |
| CC-004 | 2026-11-16 | Ironhorse engine | native UTF-8 statics on `%Uint8Array%` | the JS `TextDecoder` was quadratic and halted at 16 k characters | `1d44da02d0` |
| CC-005 | 2026-11-16 | boot polyfills | `TextDecoder`/`TextEncoder` built on the CC-004 natives | same; also WHATWG `fatal`, `stream`, BOM | `54a42f5eec`, `c786909c1e` |
| CC-006 | 2026-11-16 | Thixotrope core | `evaluateSource` stages 8,192-unit chunks (was 1,024) | a 300 k install took 50 s | `b27ed72bda` |
| CC-007 | 2026-11-16 | Ironhorse engine | `getOwnPropertyDescriptors` interns no index names; skip the intrinsic walk | `harden` of each inbound frame was the dominant inbound cost and leaked names | `d0fd6b1138` |
| CC-008 | 2026-11-16 | other Endo package | Syrup decoders keep a leading U+FEFF | strings starting with U+FEFF did not round-trip | `5a73049032` |
| CC-009 | 2026-11-16 | Thixotrope core | a worker whose OCapN session ended halts | a vat with a full name table went silent, neither halted nor answering | `63927edaba` |
| CC-010 | 2026-11-16 | upstream merge | merge of upstream PR 1667 (bound a vat's crash loop) | one crashing vat must not fail the daemon start for all | `3f2b90954e` |
| CC-011 | 2026-11-16 | Thixotrope core | export `serveThixotrope` and `connectLocalControl` | the harness reached them only by relative path | `042171c094` |
| CC-012 | 2026-11-16 | Ironhorse engine | re-pin snapshot goldens (corrects CC-004) | CC-004 moved the boot fingerprint without re-pinning | `0a4bdb3826` |
| CC-013 | 2026-11-17 | Ironhorse engine | a `const` binding's read-only flag no longer reaches new elements | the session queue's `splice` threw "not writable" (C-16) | `9828522485`, `d6f4e38b9b` |
| CC-014 | 2026-11-17 | Thixotrope core | hub counts GC frames by session (`status().gc`) | measure C-17 | `18c8f633ee` |
| CC-015 | 2026-11-17 | Thixotrope core | GC frames toward a worker wait for its next crank | one full crank per GC frame; restarts woke idle vats (C-17) | `f8bf23c62d` |
| CC-016 | 2026-11-17 | Thixotrope core | worker row `journalLength` is the delivery frontier (corrects CC-015) | held GC frames read as unsnapshotted and as wakes | `a46f505035` |
| CC-017 | 2026-11-17 | Thixotrope tests and tooling | lane fault injectors also wrap `deliverBatch` (follows CC-015) | after CC-015 four lane tests never fired their faults | `2b273930ab` |
| CC-018 | 2026-11-17 | Thixotrope core | hub cost counters per inbound delivery (`status().hub`) | measure C-20 before changing it | `7efa7fb3e4` |
| CC-019 | 2026-11-17 | Thixotrope core | one hub commit per inbound burst; one journal fsync per worker flush | a GC burst cost 16.7 ms of supervisor time per frame (C-20) | `1f1194059b`, `6be1bd3403`, `a3a2b58da5` |
| CC-020 | 2026-11-17 | Thixotrope core | `status().deliveryHistogram`: crank wall-time histogram | the `concurrency.10` check needs crank p95 | `b45da47b93` |
| CC-021 | 2026-11-17 | Thixotrope tests | `measured-engine.test.js` passes a frame-shaped value (tsc) | `lint:types` failed on CC-020's test | `d4241fa77a` |
| CC-022 | 2026-11-17 | Ironhorse worker | collect on an allocation schedule (slot growth, chunk growth, crank interval) and before the image at close, not after every crank; `timing` replies | a trivial delivery cost 17-126 ms of collection, growing with the session (C-7) | `3db48394c9`, `f0ff5e098b` |
| CC-023 | 2026-11-17 | Thixotrope core | `gcPolicy`, `gcSlotAllowance`, `gcChunkAllowance`, `gcCrankInterval` limits, fixed per state directory; lane tests per schedule | choose CC-022's schedule; a replay must collect after the same cranks | `4d6a84e86f`, `2657c03f53`, `4a42dc711c` |
| CC-024 | 2026-11-17 | Thixotrope core | hub cost counters say what each persist wrote (`persistChars`, `stats().store`) and how persists cluster (`persistRuns`) | size C-2's per-commit cost; estimate group commit | `a71e5272b5`, `87e13507b5` |
| CC-025 | 2026-11-17 | Thixotrope core | the hub's state is a write-ahead log of deltas over an image (`hub-log-store.js`, default); `hubStore: 'file'` / `THIXOTROPE_HUB_STORE=file` keeps `hub.json`; migration one way | a commit rewrote and twice fsynced the whole `hub.json` (10-15 ms, C-2) | `72ef46f905` |

---

## Entries

### CC-001 2026-11-16 other Endo package (root) - workspace entry for the harness package
Commits: `0d35cbd569` feat(thixotrope-harness): register the harness package in the workspace
Files: `yarn.lock` (19 lines); the rest of the commit is `H/package.json`.
What changed: `yarn.lock` gains the `@endo/thixotrope-harness` workspace entry. No other package
changes.
Motivation: a new private workspace package must be in the lock file for `yarn install --immutable`.
Visible to other users: none.
Tests: none needed.
Upstream notes: stands alone. Not in the pathspec of the Accounting command (`yarn.lock` is outside
it); listed there separately.

### CC-002 2026-11-16 other Endo package - emulated TypedArray constructors keep the genuine statics
Commits:
- `b10254b252` fix(immutable-arraybuffer): keep the genuine TypedArray statics on emulated
  constructors
- `e0f06cbb6d` test(thixotrope): pin native Uint8Array base64 statics through the SES boot

Files: `packages/immutable-arraybuffer/src/lib.js`,
`packages/immutable-arraybuffer/test/lib-typedarray-statics.test.js`,
`.changeset/immutable-arraybuffer-keep-statics.md`; tests
`rust/engine/ironhorse-vm/tests/ses_boot_intrinsics.rs`, `pkg/test/ironhorse/scenarios.js`.
What changed: on an engine without native immutable ArrayBuffers (Ironhorse), the shim replaces
the eleven TypedArray globals with `makeEmulatedTypedArrayConstructor(Genuine)`. Before, the
emulated constructor copied only `name`, `prototype` and `BYTES_PER_ELEMENT`. Now it also copies
every other own static of the genuine constructor with its descriptor, so
`Uint8Array.fromBase64` and `fromHex` survive the SES boot and `@endo/base64` takes the native
path inside vats.
Motivation: the plan (architecture CORE-1a as first written) guessed that the Ironhorse VM failed
to install the statics. Boot-bundle probes showed the VM installs them and the shim hid them; the
same defect would hit Node 25+ and browsers that ship the base64 proposal (J-0100). In a vat the
JS decoder halted at 128 KiB at the 10 M budget; the native one decodes 192 KiB in one crank in
about 124 ms (J-0101). Native base64 then saved only 5-8 % of inbound time (2,156 -> 1,996 ms for
12 k characters, J-0102): base64 was not the dominant inbound cost (see CC-007).
Visible to other users: on Ironhorse, and on any engine with native base64 statics, the emulated
`Uint8Array` now has `fromBase64`/`fromHex`. The boot bundle changes, so the runtime identity
changes and existing Ironhorse state directories are refused. The worker binary is unchanged.
Tests: the package unit test (247/247 package tests pass); `ses_boot_intrinsics.rs`
`the_ses_boot_keeps_the_native_uint8_array_base64_statics` (15/15 in that file); a lane scenario
(a vat sees both statics and decodes 192 KiB in one crank), which fails on the old bundle and
passes on the new (lane 55 -> 56 tests) (J-0100).
Upstream notes: stands alone and is a candidate for upstream by itself. [inferred, J-0100] every
`new Uint8Array(...)` in a vat still goes through the emulated JS constructor until Ironhorse has
native immutable ArrayBuffers.

### CC-003 2026-11-16 other Endo package (root) - root ESLint config loads the guest rules
Commits: `4180c69f2b` feat(thixotrope-harness): package skeleton with guest bundler, run lock, serve
wrapper and perf harness
Files: `eslint.config.js` (6 lines); everything else in the commit is under `H/`.
What changed: the root flat config spreads `makeHarnessLintConfigs(...)` from
`H/lint/guest-rules.js`, which applies the guest rules (no `Date`, timers, `Math.random`,
`console`, package imports, string growth in loops, and others) to `H/guest/` only.
Motivation: the repository uses one ESLint flat config, so a package-local `.eslintrc` would be
ignored (J-0131).
Visible to other users: none outside `H/`; the extra configs match only harness files.
Tests: `H/test/guest-lint.test.js` (26 cases at the time, J-0131; more added in J-0197).
Upstream notes: stands alone. Drop it if the harness package is not upstreamed.

### CC-004 2026-11-16 Ironhorse engine - native UTF-8 codec statics
Commits: `1d44da02d0` feat(ironhorse-vm): add native UTF-8 codec statics for the boot polyfill
Files: `rust/engine/ironhorse-vm/src/interp/natives/utf8.rs` (new),
`rust/engine/ironhorse-vm/src/interp/{boot.rs,intrinsic_order.rs,native_ids.rs}`,
`rust/engine/ironhorse-vm/src/interp/natives/{dispatch.rs,mod.rs,base64.rs}`,
`rust/engine/ironhorse-vm/tests/utf8_codec.rs`.
What changed: three Ironhorse-only statics on `%Uint8Array%`:
`decodeUtf8(bytes, fatal) -> { text, consumed }` (the WHATWG decoder: one U+FFFD per maximal
subpart, or a TypeError when `fatal`; a sequence cut short at the end is left unconsumed for a
streaming caller), `encodeUtf8(text) -> Uint8Array` and
`encodeUtf8Into(text, bytes) -> { read, written }`. Both encoders write U+FFFD for an unpaired
surrogate. Each input byte or code unit is charged one builtin unit (1/4 computron) before it is
read, and each output is admitted to the heap before it is made. The statics are listed in
`INTRINSIC_KEY_ORDER` after `fromHex`.
Motivation: the pure-JS `TextDecoder` of the boot polyfill appended one code point at a time and
halted with `HeapExhausted` at 16,384 ASCII characters at the 10 M budget; the JS encoder hit
`MeterAbort` at 256 k. With the natives, 1 M characters decode or encode in one crank in 4-7 ms,
about 0.25 computron per byte (J-0110). A static was chosen over a new global because every global
is bound into every compartment while a static is removed once; the worker has no host-function
hook, so a VM intrinsic was the only place (J-0111).
The first diagnosis was partly wrong: the plan blamed the base64 decoder and this `TextDecoder` for
the inbound cost. After CC-002 and this change inbound strings still cost about 230 ms per 1,000
characters and still halted between 49 and 98 KB (J-0112). The dominant cost was SES `harden` of
each frame's bytes in the engine (J-0140, corrected by J-0190; fixed in CC-007). The codec change
did remove outbound as a ceiling: 262,144 characters out in 190 ms (J-0112).
Visible to other users: the boot fingerprint moves (the new natives are in the hashed key order),
so every existing Ironhorse snapshot and state directory is refused with `BootLayoutMismatch`
(J-0111, J-9001). The worker binary changes (sha256 `13aa617b...`, J-0141). The statics never
reach guest code: CC-005 deletes them at boot (`'decodeUtf8' in Uint8Array` is false after the SES
boot, J-0111).
Tests: `tests/utf8_codec.rs` (5 tests, including a 1 M random code point round trip, 1,118,771
computrons); `ironhorse-vm` lib 326 passed; `ses_boot_intrinsics` 15, `ses_prelude_reach` 3,
`es2024_intrinsics` 9, `intrinsic_expando_order` 4, `ironhorse-snapshot` `boot_native_identity` 4
(J-0114). The snapshot golden tests were not run and broke here (see CC-012).
Upstream notes: this commit does not pass the `ironhorse-snapshot` golden tests on its own; CC-012
re-pins them, so the range `1d44da02d0..0a4bdb3826` is not bisectable for those three tests
(J-0197 items 3 and 18, J-9000). `ironhorse-262` could not be built in this work tree (the
`xs-oracle` sources are absent), so test262 parity was not re-run (J-0114, C-15). Depends on
nothing; CC-005 is its only user.

### CC-005 2026-11-16 boot polyfills - TextDecoder and TextEncoder on the native UTF-8 statics
Commits:
- `54a42f5eec` feat(xsnap): build TextDecoder and TextEncoder on the Ironhorse UTF-8 natives
- `c786909c1e` test(thixotrope): text codec lane on the native UTF-8 polyfill

Files: `rust/endo/xsnap/src/polyfills.js`; test `pkg/test/ironhorse/text-codec.js` and one line of
`pkg/ava.ironhorse.config.mjs`.
What changed: when `Uint8Array` carries `decodeUtf8`/`encodeUtf8`/`encodeUtf8Into`, the polyfill's
first block captures and deletes them before the prologue, SES or any guest runs, and installs
WHATWG-style classes on them. Behaviour before -> after on Ironhorse:
- `{ fatal: true }` throws a TypeError on malformed input; otherwise one U+FFFD per maximal subpart.
- `{ stream: true }` carries an incomplete final sequence to the next call.
- A leading byte order mark (U+FEFF) is stripped once per stream unless `ignoreBOM` (the old
  polyfill kept it; the Encoding Standard and Node strip it).
- `decode()` with no input returns `''` (was `'undefined'`); a non-buffer input is a TypeError (was
  `String(input)`); other views are decoded over their bytes.
- `encode()` returns an empty array (was the bytes of `'undefined'`); `encode` and `encodeInto`
  write U+FFFD for an unpaired surrogate (was its 3-byte surrogate encoding).
- Labels are still not checked: every decoder is UTF-8, because `@endo/ocapn` builds
  `new TextDecoder('ascii', { fatal: true })` for bytes it has checked are ASCII.

On XS the statics do not exist, so the guarded block does nothing and the old pure-JS classes,
kept unchanged after it, are installed as before (J-0111).
Motivation: as CC-004 (J-0110, J-0111).
Visible to other users: the BOM, lone-surrogate, empty-input and non-buffer changes above, in every
Ironhorse vat and in the Ironhorse test262 prelude. The BOM change made Syrup strings that begin
with U+FEFF lose that character on the way into a vat; CC-008 fixes that in Syrup (J-0113). The
boot bundle changes, so the runtime identity changes and existing state directories are refused.
Tests: the lane file `text-codec.js` (7 tests: a euro sign split across streaming calls; fatal
TypeError on `c3 28`; overlong, surrogate and out-of-range encodings; U+FFFD for unpaired
surrogates; BOM stripping; a million random code points encoded and decoded in one crank each,
compared with Node; multi-byte strings in and out of a real vat). The M0 gate lane passed 63/63 with
CC-002, CC-004 and this entry (J-0114).
Upstream notes: depends on CC-004. The XS path of `polyfills.js` was not executed (J-0111,
J-0197; C-15). `TextEncoder.encode(Symbol())` does not throw, because the input goes through
`String(input)` (J-0197; C-15). The owner was asked to confirm the BOM change (J-0111); CC-008 is
the fix that makes it safe for Syrup.

### CC-006 2026-11-16 Thixotrope core - evaluateSource stages frame-sized chunks
Commits: `b27ed72bda` feat(thixotrope): stage evaluateSource in frame-sized chunks (CORE-1b)
Files: `pkg/src/core/evaluate-source.js`, `pkg/test/evaluate-source.test.js` (new).
What changed: `evaluateSource` sends a program to a vat in staged chunks. The chunk was a literal
1,024 UTF-16 units, sized for the old quadratic decoder. It is now
`STAGING_CHUNK_CHARS = STAGING_FRAME_BYTES / 3` = 24,576 / 3 = 8,192 units, so a chunk fits one
frame in UTF-8 whatever its text. Surrogate pairs are still never split. A `chunkChars` option (an
integer of at least 2) overrides it. The module comment no longer blames the old decoder.
Motivation: installing a 300 k factory bundle took 50.3-50.5 s at 1 KiB chunks against a 30 s
budget, about 355 deliveries per install; with 8 K chunks 19.8-20.0 s and about 90 deliveries
(J-0120). After CC-007 the same install took 11.6 s (14.0 s for 478 KB of mixed text) (J-0193).
24,576 is the frame size chosen by spike S1 (J-0141, J-0194).
Visible to other users: fewer, larger staging messages; the `chunkChars` option is new. No boot or
worker change, so no state is refused (J-0123).
Tests: `evaluate-source.test.js` (5 tests: a chunk is a third of the frame, ASCII fills chunks, no
chunk ends in a high surrogate, three-byte text fills a frame exactly, `chunkChars` validation).
Install-related Node tests 50 passed in each of 3 configurations; Ironhorse `native-install`,
`supervisor`, `mailbox` 15 passed; the full lane was not run (J-0122, J-0123).
Upstream notes: stands alone. `STAGING_FRAME_BYTES` is a second copy of the harness's `frameBytes`
in core, and no caller (installer, workspaces, supervisor) passes `chunkChars`, so changing the
frame size needs a core commit; `H/test/limits.test.js` keeps the two equal (C-13, J-0122).

### CC-007 2026-11-16 Ironhorse engine - getOwnPropertyDescriptors interns no index names
Commits: `d0fd6b1138` fix(ironhorse-vm): getOwnPropertyDescriptors mints no index names; skip the
global catch-up walk when nothing changed
Files: `rust/engine/ironhorse-vm/src/interp/property/{descriptors.rs,object.rs}`,
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs`,
`rust/engine/ironhorse-vm/src/interp/{link.rs,realm.rs,admission.rs}`,
`rust/engine/ironhorse-snapshot/src/sidetable.rs`,
`rust/engine/ironhorse-vm/tests/descriptors_index_keys.rs` (new).
What changed:
1. `Object.getOwnPropertyDescriptors` (ordinary and Proxy paths) resolved every key with
   `to_property_id`, which interns canonical index strings in the vat's 16-bit key table, and
   stored them in the result as named slots. Indices now stay `ReadKey::Index` and go to the
   result's index store, as XS keeps `(XS_NO_ID, index)`.
2. `install_pending_intrinsics` walked every intrinsic name on each computed key (about 10 us
   each, unmetered). Each environment now caches the sizes at which it last had no global left to
   bind (`globals_caught_up_at`) and skips the walk while they are unchanged. The cache is not
   persisted; a restore starts empty.

Metering is unchanged (same computrons: 2,934,251 for a 16 KiB `harden` before and after).
Motivation: inbound frames were the binding cost of the harness. A 24 KiB message into a vat took
867 ms against a 357 ms budget (J-0145), and the halt point depended on the vat's history: a vat
halted with `property key space exhausted` near 58 KB, earlier if its key table was already used
(J-0140, J-0141). Thixotrope hardens every inbound frame (`pkg/src/net/pipe-network.js` `deliver`,
`harden({ done: false, value: bytes })`), and SES `harden` calls `getOwnPropertyDescriptors` on the
`Uint8Array`, so the vat interned one name per byte of the largest frame it had received.
The diagnosis was corrected once. J-0140 named per-index `getOwnPropertyDescriptor` as the cause;
J-0190 measured the split and found the plural native and the intrinsic walk. After the fix
`harden(new Uint8Array(16384))` takes 118 ms (was 2,646 ms) and consumes no names; 24,576 bytes
174 ms (was 3,830 ms) (J-0190). End to end, `frames.inbound` at 24,576 bytes is 311.8 ms median
(0.87 x of budget) and `vat.evaluateProgram` 150 k is 2.3 s (was 8.6 s) (J-0193). The halt no
longer depends on history: one message halts above 94,208 bytes at 50 M with `HeapExhausted`, the
same on a fresh vat and on a vat whose key table is full (J-0194).
Visible to other users: guest code is faster and no longer loses names to `harden` of typed arrays.
The engine boot fingerprint does not move (J-9000) and no snapshot format bump is needed (J-9001),
but the worker binary changes (sha256 `c2f65dbe...`, J-0193), so the runtime identity changes and
existing state directories are refused.
Tests: `descriptors_index_keys.rs` (3 tests, including `harden(new Uint8Array(60000))` after the
SES boot leaving more than 40 k names); `ironhorse-vm` and `ironhorse-snapshot` suites 2,083 passed;
the side-table ledger test now lists the cache field (J-0190). Lane 65/65 with CC-009 (J-0196).
Full suites on both math providers later: 1,362 + 724 passed (J-9003).
Upstream notes: stands alone. Three snapshot golden tests failed at this commit; they failed
because of CC-004, not this change (J-9000), and CC-012 re-pins them. What remains per byte: SES
`harden` still allocates one descriptor object per frame byte, about 10 us per byte, and caps one
inbound message near 94 KB at 50 M (C-5, J-0190, J-0194).

### CC-008 2026-11-16 other Endo package - Syrup keeps a leading U+FEFF
Commits: `5a73049032` fix(ocapn): keep a leading U+FEFF in Syrup strings, selectors and labels
Files: `packages/ocapn/src/syrup/decode.js`, `packages/ocapn/src/syrup/codec.js`,
`packages/ocapn/test/syrup/codec.test.js`, `.changeset/syrup-keep-leading-bom.md`.
What changed: each Syrup string is decoded by its own non-streaming `TextDecoder` call. Both
decoders were `{ fatal: true }`, so a WHATWG decoder stripped a leading U+FEFF. They are now
`{ fatal: true, ignoreBOM: true }`, so a string, selector or record label beginning with U+FEFF
round-trips.
Motivation: Node already stripped it (vat to host); after CC-005 Ironhorse vats did too (host to
vat), while the old polyfill had kept it, so the two directions disagreed (J-0113, J-0192).
Visible to other users: every `@endo/ocapn` user. A Syrup string beginning with U+FEFF now keeps
that character on every engine (before, it was lost when Node decoded it).
Tests: `codec.test.js` (leading U+FEFF in strings, selectors and labels; malformed UTF-8 `c3 28`,
`ed a0 80`, `c0 af`, `f4 90 80 80` and a truncated `e2 82` refused by `readString`); ocapn suite
572 passed x 3 configurations; a lane test in `text-codec.js` sends a string beginning with U+FEFF
into a vat and back (added in CC-009's commit) (J-0192).
Upstream notes: stands alone and is correct without CC-005; a candidate for upstream by itself.

### CC-009 2026-11-16 Thixotrope core - halt a worker whose OCapN session to the host ended
Commits: `63927edaba` fix(thixotrope): halt a worker whose OCapN session to the host ended
Files: `pkg/src/net/pipe-network.js`, `pkg/src/core/worker-peer.js`,
`pkg/src/core/worker-peer-xs.js`; tests `pkg/test/ironhorse/key-space.js` (new),
`pkg/test/ironhorse/text-codec.js` (BOM round trip), one line of `pkg/ava.ironhorse.config.mjs`.
What changed: before, when the worker's OCapN frame pump failed after the delivery had returned
(for example Syrup's record decode throwing `RangeError: property key space exhausted`), the
session ended silently: the worker stayed awake, dropped every later frame, and the host waited
forever. Now the pipe takes an `onClose`, the worker peer reports `onSessionEnd` (unless it is
shutting down), and `worker-peer-xs.js` latches it: the crank's `thixotropeTakeOutbound` read and
any later frame throw, so the crank halts, the host records the failure, and the hub breaks pending
answers with the retired text ("ocapn hub: the target session has been retired").
Motivation: a vat whose key table was full stopped answering without halting; probes timed out
after 30 s. After the fix the same probes break in 118-341 ms (J-0191).
Visible to other users: a vat whose session ends now halts (quarantined, not retried; J-9040)
instead of hanging. The boot bundle changes (new worker-peer bundle), so the runtime identity
changes and existing state directories are refused (J-0198).
Tests: `key-space.js` (2 tests: inbound frames leave the key table alone; a record that exhausts it
retires the vat); lane 65/65 (J-0196); Node pipe, worker-peer and hub tests 25 passed x 3
configurations (J-0196).
Upstream notes: stands alone. The key table itself remains a permanent per-vat budget of about
57,000 names (C-6). Exhaustion halts the vat only when the throw escapes the crank: guest code that
catches the RangeError keeps a degraded vat (J-0333). Merged without conflict with PR 1667
(CC-010): the session-ended throw is a halt there, not a crash (J-9040).

### CC-010 2026-11-16 upstream merge - PR 1667, bound a vat's crash loop
Commits: `3f2b90954e` Merge PR 1667 (bound a vat's crash loop) into the harness branch. It brings
upstream commits that are not ours: `6a7cdc5e15`, `6f95bbe7c8`, `3d3e79f582`, `71a7716c0e`,
`c01c13078a`, `90ef289c2e`, `a96d4e20f4` (Thixotrope), and `be6462bc23`, `c3baa8c6ea`,
`6ee05b2bfd` (exo-git, agent-tools and CI changes already on `llm`).
Files: `pkg/src/core/daemon.js`, `pkg/src/core/durable-worker-transport.js`,
`pkg/src/core/worker-crash-error.js`, `pkg/src/core/worker-engine.js`, `pkg/src/ironhorse/{ironhorse-engine.js,xs-engine.js}`, `pkg/src/control/supervisor.js`,
`pkg/src/store/store.js`, `pkg/README.md` and tests.
What changed (upstream's work): a worker's crash (`WorkerCrashError`: a signal the host did not
send, or a missed 60 s request deadline) is told apart from a halt and from a host failure; crashes
are counted persistently, retried after doubling waits, and given up after
`THIXOTROPE_MAX_DELIVERY_ATTEMPTS` (2..100, default 5) crashes without progress; startup waits out
a crashing vat; `standDown()`; a failed snapshot waits a cadence before retrying.
Motivation for taking it: without it, one session vat that crashes on every replay fails the
daemon start for every vat. The pull request was still open against `llm` at `6ee05b2bfd` when it
was merged. It merged without conflict with CC-009 (J-9040).
Visible to other users: as described by the pull request. The harness sets the bound on every
serve path (J-9023).
Tests: the PR's own tests (`pkg/test/durable-worker-crash-loop.test.js` and others). Harness
re-validation after the merge: J-9040..J-9051.
Upstream notes: not our change; review it in PR 1667. What the harness found in it is recorded as
candidates C-8..C-12 (startup waits for crashing vats; progress judged by the interrupted frame; a
guest call pending into a vat given up at startup never breaks; no reinstate; host allocation
failure recorded as a halt) (J-9040, J-9046..J-9049).

### CC-011 2026-11-16 Thixotrope core - export serveThixotrope and connectLocalControl
Commits: `042171c094` feat(thixotrope): export serveThixotrope and connectLocalControl
Files: `pkg/package.json`, `pkg/index.js`, `pkg/supervisor.js` (new), `pkg/local-control.js`
(new), `pkg/README.md`.
What changed: `./supervisor.js` and `./local-control.js` are package exports (thunk files like
`node-powers.js`), and the main entry re-exports both functions.
Motivation: architecture D-1 names them as the harness's public surface, but they were reachable
only by relative path into `pkg/src/control/` (J-0132). Their 52-module graph imports no `node:`
builtin and takes every power from the caller (J-9022).
Visible to other users: two new subpath exports and two new names on the main entry. Additive.
Tests: `pkg` `tsc` clean; the harness imports them from four places (J-9022).
Upstream notes: stands alone. `pkg/src/core/evaluate-source.js` is still imported by relative path
from three harness files, on purpose (J-9022).

### CC-012 2026-11-16 Ironhorse engine - re-pin snapshot goldens for the UTF-8 statics
Corrects CC-004.
Commits: `0a4bdb3826` test(ironhorse-snapshot): re-pin snapshot goldens for the Uint8Array UTF-8
codec statics
Files: in `rust/engine/ironhorse-snapshot/tests/fixtures/`: `math-platform-boot.bin`,
`state_golden.tsv`, `state_golden_libm.tsv`, `state_golden_format_19.tsv`,
`state_golden_format_20.tsv`, `state_golden_format_21.tsv`, `state_golden_reserved_ids.tsv`; and
`rust/engine/ironhorse-snapshot/tests/metamorphic_determinism.rs`.
What changed: test data only. The platform boot fingerprint, the initial and final bytes and the
store manifest digest columns, the reserved-id controls, and the `metamorphic_determinism` golden
vector (epoch-3 geometry 1100 -> 1103 slots, 17184 -> 17264 chunk bytes: three function objects
and their names) are re-pinned. Costs and continuation results are unchanged.
Motivation: CC-004 added three boot natives and said the fingerprint moves, but did not re-pin.
Three tests failed from `1d44da02d0` on and passed at the base `48d6f3e08b`; `d0fd6b1138` moves no
bytes (J-9000).
Visible to other users: none at run time. No format or schema bump: a container or store written
by the base engine is refused by the new one with `BootLayoutMismatch` (J-9001).
Tests: `ironhorse-vm` 1,362 and `ironhorse-snapshot` 724 passed, 0 failed, on both math providers
(J-9003).
Upstream notes: re-pinning needs three runs of the ignored `regenerate_persistence_identities`
(plain, `--features ironhorse-vm/deterministic-math`, plain) because the tool reads
`math-platform-boot.bin` through `include_bytes!`; the third run must change nothing (J-9002). Any
later change that adds natives or edits `INTRINSIC_KEY_ORDER` must do this in the same commit.

### CC-013 2026-11-17 Ironhorse engine - const read-only flag no longer reaches new elements
Commits:
- `9828522485` fix(ironhorse-vm): a const binding's read-only flag no longer reaches the elements
  it is stored into
- `d6f4e38b9b` test(thixotrope): Ironhorse lane scenario for elements pushed from const bindings

Files: `rust/engine/ironhorse-vm/src/interp/{environment.rs,frames.rs}`,
`rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs`,
`rust/engine/ironhorse-vm/src/interp/property/indexed.rs`; tests
`rust/engine/ironhorse-vm/tests/index_attribute_matrix.rs` with
`tests/fixtures/index_attribute_matrix.{cjs,tsv}`,
`rust/engine/ironhorse-snapshot/tests/index_attributes_carry.rs`,
`pkg/test/ironhorse/element-attributes.js`, one line of `pkg/ava.ironhorse.config.mjs`.
What changed: `GET_LOCAL` pushed the scope slot whole, so reading a `const` local put the binding's
`XS_DONT_SET_FLAG` (and, for a sloppy function expression's own name, `XS_DONT_ENUM_FLAG`) on the
value stack. The stores that create an element kept the incoming slot's flag for a new index: the
`Array.prototype.push` fast path, `array_item_set` (`a[i] = v`, `unshift`, `fill`, `Array.of`,
`concat` of a non-array, `map`'s result) and the ordinary index store (`o[i] = v`). So
`const x = {}; const a = []; a.push(x); a.splice(0, 1)` created element 0 as writable false,
enumerable true, configurable true and the splice threw "C: xsSet ?: not writable". Now `get_local`
and the with/eval `resolve_frame_get` return the value without attribute bits (as XS
`mxPushSlot`), the three element-creating stores give a new element flag 0, and `Interp::push`
debug-asserts that no pushed value carries attribute bits.
Motivation: harness candidate C-16. The session queue pushed an uncaptured `const` entry and could
never splice it out; acceptance 4 ran one message three times (J-0271). The defect depended on
whether a closure captured the `const`, which is why small reproductions failed for a while
(J-9100). Before the fix 42 of 552 source/store pairs and 4 of 280 matrix cases failed (J-9101).
Visible to other users: elements created from `const` bindings are now ordinary data properties.
The boot fingerprint, snapshot goldens and golden computrons are unchanged; the worker binary
changes (sha256 `c2f65dbe...` -> `7cda4467...`), so the runtime identity changes and existing
state directories are refused. Damaged elements in old state therefore cannot carry forward
(J-9101).
Tests: `index_attribute_matrix.rs` (23 value sources x 24 stores; 280 cases compared with Node 22,
two V8 departures overridden with the ECMA-262 answer) and `index_attributes_carry.rs` (eager,
lazy and blob resume); debug suites 2,086 passed (one fixture fixed before the commit and
re-run); audit run with zero flagged pushes; lane 66/66;
the lane scenario fails on `c2f65dbe...` and passes on `7cda4467...` in about 4 s (J-9101, J-9102).
Upstream notes: stands alone; the defect predates CC-007 (J-9100). The fix adds one byte store per
`GET_LOCAL` and charges nothing. The harness keeps its workarounds (see the last section).

### CC-014 2026-11-17 Thixotrope core - the hub counts OCapN GC frames by session
Commits: `18c8f633ee` feat(thixotrope): count OCapN GC frames by session in the hub
Files: `pkg/src/net/hub.js`, `pkg/src/core/daemon.js`, `pkg/src/control/supervisor.js`.
What changed: the hub keeps process-local counters, never persisted: GC frames and positions
received per source session, and sent per destination with the cause (the session whose GC frame
or retirement let the last holder go). The daemon exposes them as `inspectGc()` and the
supervisor's `status()` as `gc`. No routing, batching or persisted state changes.
Motivation: to measure C-17, a vat paying a full durable delivery per GC frame (J-0277). The
counters showed that every GC frame into the session came from native adapters' transient
sessions (J-9120, J-9121).
Visible to other users: a new `status().gc` field. Additive.
Tests: none in the commit; exercised by `H/perf/gc.perf.mjs` (J-9120).
Upstream notes: stands alone. Diagnostics only; it costs a few map updates per GC frame.

### CC-015 2026-11-17 Thixotrope core - GC frames toward a worker wait for its next crank
Commits: `f8bf23c62d` fix(thixotrope): GC frames toward a worker wait for its next crank
Files: `pkg/src/core/durable-worker-transport.js`, `pkg/src/ironhorse/ironhorse-engine.js`,
`pkg/src/core/worker-engine.js`, `pkg/src/net/hub.js`, `pkg/src/core/daemon.js`,
`pkg/src/control/measured-engine.js`, `pkg/test/worker-gc-cranks.test.js` (new).
What changed: before, every GC frame the hub sent to a worker was its own durable delivery: one
crank, with the full collection that ends every Ironhorse crank, and a frame for a sleeping vat
woke it. Now:
- The durable worker transport journals GC frames as before, marked `gc: true`, but does not
  deliver them on their own. A run of them enters the worker in the same crank as the next ordinary
  frame, before it and in order, or alone once 64 have gathered (`GC_FRAMES_PER_CRANK`).
- Where cranks begin is a pure function of the journal (`journalCranks`), and a snapshot cut is a
  crank boundary, so a replay after a kill or from a snapshot delivers the same cranks and emits the
  same outbound frames under the same sequence numbers.
- A GC frame never wakes a sleeping worker. The startup sweep replays only workers owed a crank
  (`owesDelivery`), not workers whose journal suffix is held GC frames alone.
- Engines may offer `deliverBatch`. Ironhorse runs the frames' dispatch calls as one evaluation
  (one drain, one collection, one outbound read) with the sum of their budgets; engines without it
  get the frames one by one.
- The hub classifies frames by record label (`makeGcFrameTest`) and releases a retired session's
  holdings in one GC batch per destination (up to 64 positions per frame) instead of one frame per
  row.
- Worker rows report `heldFrames`, `wakes` and `cranks` (process-local).

Motivation: harness candidate C-17. 197 turns brought 478 GC frames to the session vat, each a full
crank of about 60-80 ms; bursts of 107-193 frames delayed single turns by 6.7-14.4 s (J-0277).
Turn start p99 was 3,274 ms and max 4,607 ms with 6.55 session cranks per turn (J-9120). The first
restart after setup woke every idle session with GC frames from a dead transient peer, failing the
restart gate in run 1 of every invocation (J-0276, J-0294, J-9120). After the change: turn start
p99 433 ms and max 436 ms, 4.01 session cranks per turn, and no idle session woken in 5 of 5
restarts (J-9123); `turn.start` p99 4,550 -> 457 ms (J-9124); restart gate holds in all runs
(J-9125).
Visible to other users: a vat's memory held only by references a peer dropped is reclaimed at its
next ordinary crank (or after 64 GC frames), not at once; an idle vat keeps up to 64 held frames
across sleeps (3-6 per idle session measured). The crank boundary rule is now part of the replay
contract. Any wrapper that intercepts an engine's `deliver` must also intercept `deliverBatch` or
drop it (J-9126; see CC-017). New worker-row fields. No worker binary, guest bundle or snapshot
golden change (J-9122), so existing state is not refused.
Tests: `worker-gc-cranks.test.js` (9 tests x 3 SES configurations: the classifier for Syrup and
CBOR; crank boundaries; a held frame does not wake a sleeping worker; a full run is one crank; a
worker killed with frames held and replayed emits byte-identical outbound to an uninterrupted
twin, checked also by mutation; the hub sequence advances only with delivery; the startup sweep
leaves a held-only worker asleep); Thixotrope unit suite 411 passed, 3 skipped (XS) x 3 (J-9122).
Upstream notes: the change read `journalLength` wrongly for existing callers until CC-016, and
broke four lane fault injectors until CC-017; review the three together. Not done (J-9122,
J-9127): a GC-only crank still pays the full collection (C-7); XS has no `deliverBatch`, so on XS
held frames go one per collection inside one transport operation; held frames are not flushed when
a vat goes to sleep.

### CC-016 2026-11-17 Thixotrope core - a worker row's journalLength is its delivery frontier
Corrects CC-015.
Commits: `a46f505035` fix(thixotrope): a worker row's journalLength is its delivery frontier
Files: `pkg/src/core/daemon.js`, `pkg/test/worker-gc-cranks.test.js`.
What changed: after CC-015 a checkpointed worker could hold journal entries past its snapshot cut.
`inspectWorkers()` now reports `journalLength` as the store's journal length minus `heldFrames`:
the frames owed or given a crank, as before GC frames waited. The held frames stay visible as
`heldFrames`. The store's own `journalLength` is unchanged.
Motivation: callers read `snapshot.cut === journalLength` as "asleep and checkpointed" and a grown
journal as "woken". With held frames a sleeping worker never looked checkpointed and a held frame
looked like a wake; the first after-run of the GC perf check timed out in its "asleep" check
(J-9123, J-9122).
Visible to other users: `status().workers[].journalLength` now means the delivery frontier, which
is what it meant before CC-015.
Tests: `worker-gc-cranks.test.js` 9/9 x 3 again (J-9126).
Upstream notes: depends on CC-015. A direct `wakes` count is the exact wake signal; `journalLength`
growth is an approximation (J-9127 (5)).

### CC-017 2026-11-17 Thixotrope tests and tooling - lane fault injectors see batched cranks
Follows CC-015 (it corrects CC-015's effect on the lane).
Commits: `2b273930ab` test(thixotrope): lane fault injectors also see cranks that carry held GC
frames
Files: `pkg/test/ironhorse/_fixture.js`, `pkg/test/ironhorse/process-daemon.mjs`.
What changed: the lane's crash and fault scenarios wrap an incarnation's `deliver` to fire at the
counter's increment crank. After CC-015 the increment could arrive in a `deliverBatch` together
with held GC frames, which bypassed the wrappers. Both wrappers now treat a batch as one crank that
is the increment's when any of its frames is the increment.
Motivation: 4 of 66 lane tests failed or timed out ("boundary not reached") at `3c083b304c`. Not a
recovery defect: the production wrapper (`pkg/src/control/measured-engine.js`) was updated in
CC-015 (J-9126).
Visible to other users: none (test code only).
Tests: the two files 28/28; lane 66/66 at `2b273930ab` (J-9126).
Upstream notes: depends on CC-015.

### CC-018 2026-11-17 Thixotrope core - hub cost counters per inbound delivery
Commits: `7efa7fb3e4` perf(thixotrope): hub cost counters per inbound delivery in status().hub
(C-20)
Files: `pkg/src/net/hub.js`, `pkg/src/core/daemon.js`, `pkg/src/control/supervisor.js`.
What changed: the hub times every inbound `deliver`/`deliverBatch` call, split into GC-only
deliveries (`gcOnly`) and the rest (`other`), with the `persist()` calls (serialization and the
`hub.json` replacement) and the sends (a durable worker's journal append) inside each, and counts
persists and sends made outside any delivery (`outside`). Process-local, never persisted. The
daemon exposes them as `inspectHub()` (`hub.stats()`) and `status()` as `hub`.
Motivation: J-9127 proposed measuring the hub's cost per GC frame before changing it. The counters
showed an incoming GC frame cost 16.7 ms of supervisor time: 13.9 ms in 1.26 `hub.json`
replacements per frame (the two full fsyncs of file and directory), 2.6 ms in journal appends;
every frame was its own delivery and commit; a 193-frame burst held the thread 3.6 s (J-9210).
Visible to other users: a new `status().hub` field. Additive.
Tests: none in the commit; exercised by `H/perf/hub.perf.mjs` (J-9210).
Upstream notes: stands alone.

### CC-019 2026-11-17 Thixotrope core - one hub commit per inbound burst and per worker flush
Commits:
- `1f1194059b` perf(thixotrope): worker transport journals a batch of frames with one fsync (C-20)
- `6be1bd3403` perf(thixotrope): one hub commit per inbound burst and per worker flush (C-20)
- `a3a2b58da5` docs(thixotrope): the hub commits once per batch before sending (C-20)

Files: `pkg/src/net/hub.js`, `pkg/src/core/durable-worker-transport.js`,
`pkg/src/store/{store.js,store-fs.js,store-memory.js}`, `pkg/src/core/daemon.js`,
`pkg/src/native/adapters.js`, `pkg/src/net/transient-hub-client.js`; tests
`pkg/test/hub-coalesce.test.js`, `pkg/test/hub-crash-consistency.test.js` with
`pkg/test/_hub-crash-child.mjs` (new), `pkg/test/ironhorse/process-daemon.mjs`.
What changed: the rule is kept that an outbound frame reaches its receiver only after the hub state
that lets a restart re-send or deduplicate it is durable, and a worker owns a frame only once its
journal append returned. Inside that rule:
1. `WorkerStore` gains an optional `appendJournalEntries` (several entries, one durable append, one
   fsync; the file store re-reads its length after a failure), and the durable worker transport a
   `writeBatch`. The journal bytes are those `write` would have written, so cranks,
   `GC_FRAMES_PER_CRANK` and replay are unchanged.
2. Attach option `coalesceInbound` (only with `discardOnRestart`; set for native adapters and
   transient clients): frames such a session delivers in one turn are handled at the end of the
   turn as one `deliverBatch` (one persist, then the sends). Forget, retire and detach handle
   pending frames first.
3. Attach option `sendBatch` (only with `deferCleanup` and no `dialLocation`; set for worker
   sessions): the queue's sequences commit with the delivery that queued the frames, and the flush
   hands the committed queue to `transport.writeBatch` in one call.
4. The hub's module comment now says it commits once per batch before sending.

Motivation: harness candidate C-20. After CC-015 GC bursts no longer cost vat cranks, but each
incoming GC frame still cost a whole `hub.json` replacement and an fsync per outgoing frame on the
supervisor's single thread (J-9127 (1), J-9210). `turn.delta.client` p95 was 564 ms during a
39-frame burst on a path that never enters a vat (J-9124). After: 6.6-7.0 ms per incoming GC frame
(was 16.7); a 117-157-frame burst costs 38-47 ms of hub time (was 2.9-3.6 s); `turn.start` p99
2,583 -> 507 / 785 ms; `turn.delta.client` p95 1,417 -> 22 / 40 ms (J-9213).
Visible to other users: two new attach options for embedders that attach their own sessions, with
guards that refuse unsafe combinations; an optional new `WorkerStore` method. Frames from a
coalescing observer that were not yet committed at a crash are lost, exactly as before (the
observer died with the process; its references are released by its retirement). The hub, transport
and stores run in the supervisor only: the boot bundles are byte-identical and no state is refused
(J-9212).
Tests: `hub-crash-consistency.test.js` SIGKILLs a child hub over the real file store before every
durable operation of a GC burst (39 points) and of sequenced traffic (18 points) and checks that no
frame is lost or journaled twice, every export is released once, and the killed journal is a byte
prefix of the recovered one (identical for sequenced traffic); a mutation that sends before both
commits fails. `hub-coalesce.test.js` (4 tests). The lane's journal fault injector also wraps
`appendJournalEntries`. Thixotrope unit suite 417 passed, 3 skipped x 3 configurations; lane 66/66
at `a3a2b58da5` (J-9212).
Upstream notes: depends on CC-015 (the batch delivery seam) and uses CC-018 for its numbers. A new
session kind must choose its attach options knowing two rules: only sessions with no replay
identity may coalesce inbound, and only never-dialed receivers may take a whole queue (J-9215).
Not done (J-9216): the endpoint still commits once per outgoing frame and once per inbound frame;
each commit still costs about 10 ms of whole-file `hub.json` replacement (C-2), and a plain turn
makes about 24 of them (J-9214). SIGKILL tests cannot model power loss (J-9212). `m0-results.md`
page 6 still lists C-20 as open at the cut-off of this journal.

### CC-020 2026-11-17 Thixotrope core - status() reports a crank wall-time histogram
Commits: `b45da47b93` feat(thixotrope): status() reports a delivery (crank) wall-time histogram
Files: `pkg/src/control/measured-engine.js`, `pkg/src/control/supervisor.js`,
`pkg/test/measured-engine.test.js`.
What changed: `makeMeasuredEngine` also returns `deliveryHistogram()`: cumulative delivery counts
per wall-time bucket (bounds 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000 and
5000 ms, the last bucket open) and the maximum. `status()` reports it as `deliveryHistogram`.
Timings are unchanged.
Motivation: the harness perf check `concurrency.10` has a budget of crank p95 <= 200 ms
(`designs/milestones.md`); the difference of two readings gives a window's crank distribution.
No JOURNAL.md entry records a measurement with it at the cut-off of this journal.
Visible to other users: a new `status().deliveryHistogram` field. Additive.
Tests: `measured-engine.test.js` (deliveries counted, timed and bucketed; inclusive bounds; the
open bucket). No suite run is recorded in JOURNAL.md.
Upstream notes: stands alone. Bucket bounds are fixed in code.
Measured with it (M1b QC, J-0395): `concurrency.10.crank` p95 500 ms against 150 for one session.

### CC-021 2026-11-17 Thixotrope tests - the measured-engine test type-checks
Commits: `d4241fa77a` test(thixotrope): measured-engine test passes a frame-shaped value to deliver
Files: `pkg/test/measured-engine.test.js`.
What changed: the test's fake delivery argument is cast to the frame type instead of a
`Uint8Array`; `corepack yarn lint:types` in `packages/thixotrope` was 1 error (TS2345, M1b QC
finding 16) and is 0. The test passes; nothing under `pkg/src` changed, so the Ironhorse lane was
not re-run (66/66 at CC-019).
Visible to other users: none.

### CC-022 2026-11-17 Ironhorse worker - collect garbage on an allocation schedule
Commits: `3db48394c9` perf(thixotrope-ironhorse-worker): collect garbage on an allocation schedule,
not after every crank
`f0ff5e098b` perf(thixotrope-ironhorse-worker): bound the allocation schedule by a crank interval
Files: `rust/thixotrope-ironhorse-worker/src/main.rs`.
What changed: before, `eval` and `deliver` ran `sweep_and_notify` (a full collection, then
finalizer rounds) after every crank, and `close_heap` checkpointed without collecting. Now a
`GcSchedule` decides. Under `gcPolicy` "allocation" it collects after a crank when the live slot count
grew by `gcSlotAllowance` (default 131,072), or the chunk footprint (arena bytes plus charged side
storage) by `gcChunkAllowance` (16 MiB), since the last collection or the image, or when the crank is
the `gcCrankInterval`th (32) since then; `close_heap` sweeps (without notifying) before the checkpoint
when any crank ran since the last collection, and the cleanups it flags stay pending in the image for
the engine to run at the end of the next crank's drain. "every-crank", and a limits JSON with no
`gcPolicy`, keep the old behaviour exactly; boot always runs under it. A request with
`"timing": true` gets compile, run, collection, notification and extraction wall times and the heap
counts in its reply.
Motivation: J-9300: a trivial delivery to a session vat cost 17 ms new, 32 ms at 50 turns and 126 ms
at 1,000 turns, all but 0.6 ms of it the collection; `turn.start` rose 314 -> 1,076 ms over 1,000
turns. After (J-9303): 0.5-0.6 ms at every size; `turn.start` 170-188 ms at every length; a
`getInfo()` round trip 81 -> 37 ms; 1,000 turns 30.6 -> 17.1 min.
Visible to other users: the worker digest changes (runtime identity: existing state directories are
refused). With "allocation", finalizers (an OCapN peer's gc frames) run at the next collection, up to
32 cranks later or in the first crank after a wake; heap high-water marks rise by up to the
allowance (J-9304). The worker's protocol is unchanged otherwise; `timing` is additive.
Tests: 8 new worker tests (kill-and-replay at seeded points is byte-identical per delivery and to the
next image; replay from a mid-run checkpoint; finalizers exactly once and never earlier; metering
equal without finalizers; slot and chunk churn under the ceiling; crank interval; parsing); worker
25/25; engine suites 2,092 passed, 0 failed (engine unchanged); Ironhorse lane 69/69 with CC-023
(J-9302).
Upstream notes: review the determinism argument in the `GcPolicy` doc comment and J-9301: the
counters restart at each image, which is replay-exact because an image is written only at close and
recorded with its journal cut before anything more is delivered; the schedule reads no ceiling
(ceilings may rise across a restart). Cleanup callbacks run in other runs than before, which moves
their run overhead (0.15 computron over 100 callbacks in the test). No collection inside a crank
(C-21, J-9305: the engine has no kept list and no in-drain safe point). Depends on CC-023 for a host
to choose the policy; stands alone with the old behaviour otherwise.

### CC-023 2026-11-17 Thixotrope core - the collection schedule limits, fixed per state directory
Commits: `4d6a84e86f` feat(thixotrope): choose the Ironhorse collection schedule; pin it per state
directory
`2657c03f53` docs(thixotrope): the collection schedule is the second limit a restart cannot change
`4a42dc711c` feat(thixotrope): gcCrankInterval; lane tests state each collection schedule's contract
Files: `pkg/src/ironhorse/ironhorse-limits.js`, `pkg/src/ironhorse/ironhorse-runtime.js`,
`pkg/src/ironhorse/ironhorse-engine.js`, `pkg/README.md`, `pkg/test/ironhorse-limits.test.js`,
`pkg/test/ironhorse/limits.js`, `pkg/test/ironhorse/delivery.js`, `pkg/test/ironhorse/scenarios.js`,
`pkg/test/ironhorse/_fixture.js`.
What changed: `makeIronhorseLimits` gains `gcPolicy` ("allocation" default, "every-crank"),
`gcSlotAllowance` (131,072), `gcChunkAllowance` (16,777,216) and `gcCrankInterval` (32), read from
`THIXOTROPE_GC_POLICY`, `THIXOTROPE_GC_SLOT_ALLOWANCE`, `THIXOTROPE_GC_CHUNK_ALLOWANCE` and
`THIXOTROPE_GC_CRANK_INTERVAL`; an allowance above half its ceiling is refused. They reach the worker
in its limits JSON, are recorded in `runtime.json` and reported in `status().ironhorse`;
`checkSavedManifest` refuses any change to them ("cannot change from persisted value"). Two lane
tests asserted every-crank finalization timing; each now runs under both schedules, with the
allocation variant asserting when the frames arrive (J-9302).
Motivation: CC-022 needs a host setting; recovery replays a journal onto the last image and the hub
drops replayed outbound by sequence number, so a replay under another schedule would emit other
frames under the same numbers.
Visible to other users: new limits and status fields; a state directory made with one schedule
refuses another; `runtime.json` written by this version carries the four limits.
Tests: `ironhorse-limits.test.js` 9/9 (defaults, environment, refusal of each change, a raised ceiling
does not move the schedule); `test/ironhorse/limits.js`, `delivery.js` (4 variants), `scenarios.js`
(settled answers under both schedules) in the lane, 69/69; Node suite and `lint:types` (J-9302).
Upstream notes: the harness's `scripts/serve.mjs` does not pass `THIXOTROPE_GC_*` through and its
templates do not key on them (J-9307). The refusal is strict: a schedule change needs a fresh state
directory even after a clean shutdown, when no journal suffix would be replayed.

### CC-024 2026-11-17 Thixotrope core - hub persist sizes and clustering in status().hub
Commits: `a71e5272b5` perf(thixotrope): count what each hub persist writes
`87e13507b5` perf(thixotrope): the hub counts how its persists cluster
Files: `pkg/src/net/hub.js`, `pkg/src/store/store.js`, `pkg/src/store/store-fs.js`,
`pkg/src/core/daemon.js`.
What changed: `HubStore.setState` may return the characters it wrote; the hub adds them up per cost
bucket as `persistChars`. A store's own counters (`HubStore.stats`, `ThixotropeStore.hubStoreStats`)
appear as `status().hub.store`. `status().hub.persistRuns` counts runs of persists with no
microtask checkpoint between them (`bursts`, `persists`, `max`). Process-local, never persisted.
Motivation: C-2's cost per commit could be timed but not sized (J-9330); `persistRuns` estimates
what group commit would save (J-9334).
Visible to other users: new `status().hub` fields. Additive.
Tests: exercised by `H/perf/hub.perf.mjs` and `concurrency.perf.mjs` (J-9330, J-9333); hub unit
tests pass unchanged.
Upstream notes: stands alone. `persistRuns` uses a resolved-promise callback to find the end of a
run; it schedules nothing else.

### CC-025 2026-11-17 Thixotrope core - the hub's state as a write-ahead log of deltas
Commits: `72ef46f905` perf(thixotrope): keep the hub's state as a write-ahead log of deltas
Files: `pkg/src/store/hub-log-store.js` (new), `pkg/src/store/store-fs.js`,
`pkg/src/control/supervisor.js`, `pkg/src/ironhorse/ironhorse-runtime.js`,
`pkg/test/hub-log-store.test.js` (new), `pkg/test/_memory-sync-files.js` (new),
`pkg/test/hub-crash-consistency.test.js`, `pkg/test/_hub-crash-child.mjs`,
`pkg/test/ironhorse/supervisor.js`.
What changed: the store commits the hub's state (`setHubState`, durable when it returns, as before)
by appending one line to `hub-log.jsonl` with the entries of each top-level table that changed since
the last commit (set, dropped, or the whole table when its entry order changed), instead of replacing
`hub.json` (scratch file, fsync, rename, directory fsync). Recovery is `hub-image.json` plus the log
records numbered after it, contiguous; a final line without its newline is a torn append and is
dropped; any other damage refuses the directory. Compaction (log over max(1 MiB, 2 x image), after
a failed append, after recovery found a torn tail or stale records, and at the first commit) writes
the image of the commit at hand, then resets the log, both atomically; a commit that changed nothing
writes nothing. `getState()` returns the record in the committed top-level, table and entry order.
`makeFsStore(powers, path, { hubStore: 'log' | 'file', hubLog })`, 'log' by default; the supervisor
reads `THIXOTROPE_HUB_STORE`. The invariant kept: an outbound frame is not sent before the state that
lets a restart re-send or deduplicate it is durable (J-9331).
Motivation: a persist cost 9.8-10.7 ms and wrote 121-337 KB (J-9330); with 10 sessions streaming the
hub spent 32.9 s and wrote 812 MB in 2,261 persists. After: 5.5-6.6 ms and 14-46 KB per persist;
concurrency.10 hub persist time 33.1 -> 24.5 s for 2,756 persists, 133 MB (J-9333).
Visible to other users: the state directory layout changes. A directory with only `hub.json` is
migrated at its first open (image written, then `hub.json` replaced by a marker
`{"version":"hub-log",...}`); a build without this store then refuses it ("Incompatible hub state:
this build requires version 2"), and `hubStore: 'file'` refuses a log directory with a message naming
the log store. Migration is one way. Tools that read `hub.json` directly must read through
`makeFsStore(...).getHubState()` (the harness's `perf/_harness.mjs` `hubJsonBytes` and spike S4 do
not yet: J-9337). The Ironhorse unversioned-state check also looks for `hub-image.json`. Boot bundles
and worker unchanged (bundles rebuilt into a scratch directory are byte-identical).
Tests: `hub-log-store.test.js` 8 tests: every byte prefix of every log (28,212, of which 27,965 end in
a torn record), a failed or torn write at every operation then a retry, interrupted compaction and
migration, refusals of damage, delta size; `hub-crash-consistency.test.js` runs both stores, the log
store migrating and compacting inside the run; with HUB_CRASH_ALL=1 every kill point (log: 44 burst,
22 ordinary) passes in all three ses-ava configurations and its uninterrupted worker journal equals the
whole-file store's byte for byte. Thixotrope Node suite and Ironhorse lane: J-9336.
Upstream notes: a delta is per top-level table entry, so a session row (with its queued frames and
`ourExports`) is rewritten whole when any field of it changes: under load an append is 14-46 KB, not
the few hundred bytes of a ref row (J-9335 (a)). The store still stringifies every row at every commit
to find the changes (CPU comparable to the old `JSON.stringify` of the whole state); hub-side dirty
tracking would remove it (J-9335 (b)). Durability per commit is one `fsync` of the log (F_FULLFSYNC on
macOS through libuv) instead of two plus a rename; SIGKILL tests do not model power loss (J-0163).
The mail experiment scripts (`scripts/measure-mail.mjs` with `THIX_MAIL_HUB=log|sqlite`) wrap
`hub.json` writes and now need `THIXOTROPE_HUB_STORE=file` to measure what they measured. Stands
alone; CC-024's counters measure it.

---

## Open candidates not yet changed

From `designs/m0-results.md` page 6, where the evidence and the full cost are. C-16 and C-17 are
closed (CC-013, CC-015). C-20 is addressed in part by CC-018 and CC-019; page 6 still says open.

| id | what | cost to the harness if left alone |
|---|---|---|
| C-1 | `hub.json` holds frames for transient sessions in clear | no secret may cross the hub, even adapter to adapter |
| C-2 | whole-file `hub.json` rewrite with fsync per commit (about 10-12 ms) | about 24 commits per turn; `hub.growth` 1.32 x fresh after 50 sessions (J-9214) |
| C-3 | restart replays every unsnapshotted journal suffix | idle vats must be checkpointed quickly (`idleSleepMs` 2,000 in tests) |
| C-4 | the control-socket path is kept in a vat heap | a running state directory must never be copied |
| C-5 | SES `harden` allocates one descriptor per inbound frame byte | `frameBytes` 24,576; large text and programs are staged |
| C-6 | each vat's 16-bit name table (about 57,000 names) is permanent | no data-dependent record keys may reach a vat |
| C-7 | a full GC after every crank | about 56 ms per delivery; GC-only cranks still pay it |
| C-8 | startup waits for every crashing vat | the harness is unreachable 20-64 s when one vat crashes on replay |
| C-9 | crash progress is judged by the interrupted frame | give-up time is a floor, not a bound |
| C-10 | a call pending into a vat given up at startup never breaks | recovery never waits on a guest call's settlement |
| C-11 | no reinstate for a given-up vat | a crashing session vat is lost with its transcript |
| C-12 | `HostAllocationFailed` is recorded as a halt | a host-side failure quarantines a vat; rare |
| C-13 | `STAGING_FRAME_BYTES` is a second copy of `frameBytes`; no caller passes `chunkChars` | changing `frameBytes` needs a core commit |
| C-14 | stale docs (async-generator persistence, foreign remotables in specs, attempt bound in `thix status`) | misleads builders |
| C-15 | polyfill corners: `TextEncoder.encode(Symbol())`, XS path not executed, `ironhorse-262` not buildable here | none for the Ironhorse-only harness |
| C-18 | a retired session is signalled only by an `Error` with the hub's text | the harness matches an exact string |
| C-19 | a vat is not told that an adapter incarnation it holds has died | held ports compare two clocks; first turn after a restart pays a reopen |
| C-20 (rest) | endpoint commits per frame; per-commit cost is C-2 | some bursts still cost 0.4-0.9 s of hub time (J-9213, J-9216) |
| C-21 | the slot ceiling bounds live heap plus one crank; no collection inside a crank | the harness serves at 4,000,000 slots (persisted per state); a session's heaviest crank sets how large it may grow (J-0392) |
| C-22 | pattern checks in a vat cost milliseconds per record | import is bounded at 7-13 turns/s; long-session templates take 8-9 min to build (J-0481, J-9464) |
| C-23 | a Node client's presence for a remote object can be collected while the remote still exports it | adapter caches keyed by a presence must hold it strongly (J-9403) |
| C-24 | the worker transport's cadence snapshot (every 256 deliveries) runs between a busy turn's deliveries | `checkpoint.stall` p99 2-6 s against 1 s; the turn that crosses the count waits for a 34 MB snapshot (J-9462, J-9494) |
| C-25 | a frame over `frameBytes` addressed to a vat is journaled and delivered; only the vat's guard refuses it | a 100 KiB inline string reaches the session vat (no halt below about 94 KB, a halt above); M5's CC-070 is the same change (J-9407, J-9489) |

C-2 is addressed in part by CC-025 (one append instead of a whole-file replacement; per persist
9.8-10.7 -> 5.5-6.6 ms, J-9333); the row above keeps the cost it had, and the rest is J-9335.
C-7 is addressed by CC-022 and CC-023 (an allocation schedule; the fixed per-crank cost is gone,
J-9303); the row above keeps the cost it had. C-21 is not changed: the proposal is J-9305.

C-6 now also records that name-table exhaustion is a catchable RangeError, so a vat whose code
catches it lives on degraded instead of halting (J-0333); the harness retires an exec vat that
meets it (J-0390), and an engine halt is the fix.

## Workarounds in the harness that exist because of a core limit

- The session queue keeps waiting entries in a `Set` (`H/guest/session/queue.js`), and the turn
  path makes no in-place element moves (J-0292). Removed cause: CC-013 (C-16); kept as they are.
- `frameBytes` is 24,576 and every text over `inlineBytes` (8,192) becomes a staged Blob; program
  sources are staged through `evaluateSource`. Would be relaxed by C-5.
- `H/test/limits.test.js` keeps `frameBytes` equal to core `STAGING_FRAME_BYTES`. Removed by C-13.
- No data-dependent record keys in guest state or across a vat boundary (guest rule 12.10,
  `limits.vatKeyNames`); the gateway refuses undeclared keys. Removed by C-6 (and J-0333's option
  (a) for the exec vat).
- Restart versus tool failure is decided by an exact match on the hub's retired text
  (`H/guest/lib/retired.js`), and adapter tools must never reject with that text (J-0290). Removed
  by C-18.
- No secret, token or provider payload crosses the hub; secrets stay in the agent-host process.
  Removed by C-1.
- Streams stay inside one adapter process. Relaxed by C-2.
- Tests checkpoint idle vats after 2 s (`idleSleepMs`). Relaxed by C-3.
- Templates are built at a throwaway path, and a running state directory is never copied. Removed
  by C-4.
- After a restart, recovery never waits on a guest call's settlement. Removed by C-10.
- Held ports compare `TurnStarted.at` with the ports' `since` to tell "in flight at the restart"
  from "claimed after it". Removed by C-19.
- Any engine wrapper the harness adds must wrap `deliverBatch` as well as `deliver` (J-9126). A
  consequence of CC-015, not a limit to remove.
- The daemon is served with `THIXOTROPE_SLOT_CEILING` 4,000,000 (`scripts/serve.mjs`), and test
  templates key on it, because a crank's allocation counts against the same ceiling as the live
  heap (J-0392). Relaxed by C-21.
- The exec vat answers `exhausted` on the name-table RangeError and the session retires it
  (J-0390). Removed by C-6 (exhaustion as a halt).

---

## Accounting

Cut-off commit: `b45da47b93` (the newest commit outside `packages/thixotrope-harness` when this
journal was written; branch HEAD was `a83660c2d2`). Command:
`git log --oneline 48d6f3e08b..HEAD -- packages/thixotrope rust packages/immutable-arraybuffer
packages/ocapn eslint.config.js .changeset` (32 commits). Each maps to exactly one entry; the
commits that arrived through the PR 1667 merge map to CC-010.

- `be6462bc23` -> CC-010 (upstream, via merge)
- `b10254b252` -> CC-002
- `e0f06cbb6d` -> CC-002
- `4180c69f2b` -> CC-003
- `1d44da02d0` -> CC-004
- `54a42f5eec` -> CC-005
- `c786909c1e` -> CC-005
- `b27ed72bda` -> CC-006
- `6a7cdc5e15` -> CC-010 (upstream, via merge)
- `6f95bbe7c8` -> CC-010 (upstream, via merge)
- `3d3e79f582` -> CC-010 (upstream, via merge)
- `71a7716c0e` -> CC-010 (upstream, via merge)
- `c01c13078a` -> CC-010 (upstream, via merge)
- `90ef289c2e` -> CC-010 (upstream, via merge)
- `a96d4e20f4` -> CC-010 (upstream, via merge)
- `d0fd6b1138` -> CC-007
- `5a73049032` -> CC-008
- `63927edaba` -> CC-009
- `3f2b90954e` -> CC-010
- `042171c094` -> CC-011
- `0a4bdb3826` -> CC-012
- `9828522485` -> CC-013
- `d6f4e38b9b` -> CC-013
- `18c8f633ee` -> CC-014
- `f8bf23c62d` -> CC-015
- `a46f505035` -> CC-016
- `2b273930ab` -> CC-017
- `7efa7fb3e4` -> CC-018
- `1f1194059b` -> CC-019
- `6be1bd3403` -> CC-019
- `a3a2b58da5` -> CC-019
- `b45da47b93` -> CC-020
- `d4241fa77a` -> CC-021
- `3db48394c9` -> CC-022
- `4d6a84e86f` -> CC-023
- `2657c03f53` -> CC-023
- `f0ff5e098b` -> CC-022
- `4a42dc711c` -> CC-023
- `a71e5272b5` -> CC-024
- `72ef46f905` -> CC-025
- `87e13507b5` -> CC-024

Outside that command's paths but outside `packages/thixotrope-harness` too:

- `0d35cbd569` -> CC-001 (`yarn.lock`)
- `c3baa8c6ea` -> CC-010 (upstream `packages/agent-tools` tests, via merge)
- `6ee05b2bfd` -> CC-010 (upstream CI workflows, via merge)

### Accounting check 2026-11-18 (integration of C-7 and C-2, J-9380..J-9393)

Cut-off commit: `87e13507b5` (the newest commit outside `packages/thixotrope-harness`; branch HEAD
was `4f0661fca2` when checked). Command:
`git log --format='%h %s' 48d6f3e08b..HEAD -- . ':!packages/thixotrope-harness'` (44 commits, merge
commits included). Every one of them appears in an entry above or in the lists of this section; no
entry is missing, so none was added. The integration step changed nothing outside the harness: the
release worker (`367e78ad...`, rebuilt to the same digest under the run lock) and the Ironhorse boot
bundles (rebuilt into a scratch directory, byte-identical) correspond to HEAD, and the lane's last
run (69/69 at `50f1d348eb`, J-9336) postdates every change to `pkg/src`, the worker and the bundles.

Harness follow-ups that CC-023 and CC-025 name, now done in harness commits (no core change):
`758c545380` (`scripts/serve.mjs` passes `THIXOTROPE_GC_*` and `THIXOTROPE_HUB_STORE`),
`ef637da1b6` (test templates key on them when set), `d3b605dbd0` (`perf/_harness.mjs` sizes the log
store's image plus log; rows name `gcPolicy` and `hubStore`). Still open: spike S4 and
`test/spikes/_crash.js` watch `hub.json` (J-9337 (2)); `pkg/scripts/measure-mail.mjs` needs
`THIXOTROPE_HUB_STORE=file` (J-9337 (5)).

The "Open candidates" table above keeps the costs it had when written. Current status, from
`designs/m0-results.md` page 6: C-7 closed for the per-crank collection (CC-022, CC-023); C-2 partly
(CC-025); C-20 partly (CC-019, with CC-025 lowering each commit); C-21 open (proposal J-9305).

### CC-083 2026-11-18 Thixotrope core - hub-resident data rows and their store (spike prototype, not merged)
Commits: `733deabd9b` feat(thixotrope): hub-resident data references (spike prototype); `556596ab1a`
(copy an emulated byteArray once on write).
Files: `pkg/src/net/hub.js`, `pkg/src/net/hub-state.js`, `pkg/src/net/hub-data-store.js` (new).
What changed: a pseudo-origin `hub:data` (never attached, never retired) whose rows the hub serves
itself; a `data` table (`{ kind, hash, length, sealed }`, no bytes) and `dataNext` in the hub state
(optional, so `STATE_VERSION` stays 2 in the spike; production bumps it to 3); a content-addressed
directory of files named by SHA-256, written part file, fsync, rename, directory fsync before a row
is minted; release of a row's last holder unlinks its file after the next commit; startup recount and
sweep of unnamed and part files.
Motivation: the owner's request for references to data no vat reads (spike dataref, track T2,
`designs/spike-dataref/design-ocapn.md`).
Visible to other users: none unless a `dataStore` is passed; hub tests pass (33 in `hub*.test.js` and
`transient-hub-client.test.js`). Boot bundles, worker and goldens unchanged.

### CC-084 2026-11-18 Thixotrope core - data powers and local dispatch (spike prototype, not merged)
Commits: `733deabd9b`. Files: `pkg/src/net/hub.js`, `pkg/src/core/daemon.js` (a `hubDataStore`
option and `publishDataPower` / `inspectHubData`, 9 lines, additive).
What changed: `op:deliver` to a `hub:data` row is answered by the hub: writer (`create`, `put`),
builder (`append`, `close`), data (`describe`), reader and unsealer (`read`, `locate`); amplification
by the argument's row identity; sealed data only through the unsealer; `op:listen` on a data row
fulfils at once.
Motivation: as CC-083.

### CC-085 2026-11-18 Thixotrope core - the `thix:data` envelope is checked by the hub (spike prototype, not merged)
Commits: `733deabd9b`. Files: `pkg/src/net/hub.js` (`checkDataEnvelopes`).
What changed: every `op:deliver` (calls and resolver settlements) is walked for the reserved Tagged
`thix:data` `{ length, ref, sha256 }`; one that does not name a non-sealed data row with that length
and hash breaks the message before routing. No codec, marshal or pass-style change.
Motivation: holders can trust length and hash from their frame (determinism without a round trip).

### CC-086 2026-11-18 Thixotrope core - per-session frame byte counters (spike prototype, not merged)
Commits: `733deabd9b`. Files: `pkg/src/net/hub.js` (`stats().frameBytes`).
What changed: process-local counts of bytes and frames each session sent to and received from the
hub, for the spike's measurements. Not persisted.

### CC-087 2026-11-18 Thixotrope core - worker transport frame-filter seam (spike prototype, not merged)
Commits: `a86340a6a1`. Files: `pkg/src/core/durable-worker-transport.js` (+30, -4, additive).
What changed: an optional filter read once from `globalThis[Symbol.for('thixotrope.spike.dataref.frameFilter')]`;
`inbound(workerId, bytes)` may replace each frame toward a worker before its journal entry is made,
`outbound(workerId, bytes)` sees each frame the worker emits (live or replayed) before the hub.
Absent, behaviour is unchanged. Used only by `H/test/spikes/dataref-engine` (preloaded into the
supervisor child) to move large atoms out of vat frames and check data-reference possession.
Motivation: spike dataref track T3, `designs/spike-dataref/design-engine.md` (a stand-in for an
engine-native data handle). Visible to other users: none. Worker, boot bundles and goldens
unchanged. CC-088 and CC-089 unused (no engine or worker change was made).

### Accounting check 2026-11-18 (M2 review and close-out, M2-CLOSE)

Range `6be8e868cf..HEAD` (the M2 build as integrated, then the M2 review, perf-conversion, fix and
close-out units; checked at `d7fce8e46c`, 30 commits, and again at this unit's last commit). Command:
`git diff --stat 6be8e868cf..HEAD -- . ':!packages/thixotrope-harness'` printed nothing, and
`git log --oneline 6be8e868cf..HEAD -- . ':!packages/thixotrope-harness'` lists no commit. M2's
review and close-out changed nothing outside the harness, so no CC entry was added (CC-030
onwards stay unused by M2). The core candidates it raised (C-24, C-25) are in the table of open
candidates above and on `designs/m0-results.md` page 6.
