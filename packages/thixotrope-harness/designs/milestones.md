# Build milestones: the Endo harness on Thixotrope

Companion to `architecture.md` (decisions D-1..D-16, core changes CORE-1a/1/1b, settings in its
section 9, budgets in its section 11). All code is written in the harness checkout (T) on branch
`claude/thixotrope-harness` and its lanes (`process.md`).
`H/` = `packages/thixotrope-harness/`. `pkg/` = `packages/thixotrope/`. `AH/` =
`H/resources/agent-host/impl/` (the run-time-loaded implementation, D-14).
Endo reference files are read with `git -C <T> show 1315bef86:<path>`. Spec items are cited as
SPEC:<line> in `endo-harness-spec.md`. M0, M1a, M1b and M5 are done; M2, M3 and M4 are done with
open items (listed at the top of each section; M3-M5 closed by X-CLOSE after the cross-lane
integration): what M0 measured and changed is in
`m0-results.md` (which also keeps every core-change candidate's status), M1a's outcome table is in its
section below, and decisions or budgets changed because of them are listed in "Changes after M0 and
M1a" at the end of this file.

## Conventions for every milestone

- **Ownership.** Each milestone owns the paths listed. Milestones that run in parallel own disjoint
  paths. Shared files and directories are of these kinds:
  - **Hook tables** (append-only: a milestone adds registration lines or table entries, never edits
    another milestone's entries; the PM resolves trivial merges). Each is created by the milestone
    named in brackets:
    `H/guest/session/tool-table.js` [M1a] (`toolTable`, static entries only),
    `H/guest/session/runtime-parts.js` [M5] (the runtime parts: since step 3 of the harness review
    the one per-session extension point, replacing the deleted `turn-hooks.js` lists and
    `toolSources`; a part is one name in `PartName` and `requiredParts`, one getter and one entry
    in `runtimeParts`, and its value carries `hooks` { `onClaim`, `beforeRound`, `onCancel`,
    `onSettle`, `onRecover`, `nextTurn` } and `tools`; `arch-review/step3-plan.md` section 2),
    `H/guest/session/holds-table.js` [M2],
    `H/guest/factory/services.js` [M1a] (per-session `SessionServices` builders),
    `H/guest/factory/session-options.js` [M1a] (`createSession` option resolvers),
    `AH/index.js` [M1a] (implementation registrations), `AH/channel-taps.js` [M1a],
    `AH/projection-hooks.js` [M1b], the step table in `H/scripts/provision-steps.js` [M1a] (M0-M2
    steps only; later milestones use the provisioning seam below).
  - **Directory registries** (a milestone adds its own new files; nobody edits a list; the collector
    is the only shared code and belongs to the milestone in brackets; `m3-interfaces.md` 11):
    `AH/gateway/extensions/` [M3 W3.2] (one `<milestone>-<name>.js` per lane, loaded in name order by
    `AH/gateway/extensions.js`: M4 `m4-secrets.js`; M11's is `speech.js` by review rule 1), `H/ui/src/<dir>/feature.js`
    [M3 W3.4] (one directory per lane feature group, collected in directory-name order by
    `H/ui/build.mjs` and `H/ui/src/features.js`), and `H/test/browser/`. These replace the hook
    tables the gateway route table and `H/ui/src/features.js` this list named before M3's contract.
    The gateway's key vocabulary is no longer a registry: a table module that adds browser-sendable
    shapes is one entry in `H/guest/lib/vocabulary-tables.js` (HR-SYN-7; a module not listed or
    excluded there fails `test/adapter/gateway-vocabulary-tables.test.js`). New files in these
    directories follow the naming rule below, not `<milestone>-<name>`.
  - **Provisioning seam** [M2-T1, `scripts/provision-steps.js` header]: a later milestone's
    provisioning step is a file `H/scripts/provision-steps/<two digits>-<name>.js` exporting
    `steps` (a `ProvisionStep[]`), run after the table in file-name order (M3 `30-gateway.js`,
    M4 `40-subscriptions.js`, M5 `50-m5-fixtures.js`, M6 `60-environments.js`, M11 `70-voice.js`;
    later milestones take further numbers);
    `makeProvision` forwards every option it does not use itself to every step unchanged, and a step
    that is not asked for answers `{ skipped: true }`; `has` is exported for idempotence checks.
  - **PM-merged files**: `H/package.json`, `H/perf/_harness.mjs`, `H/JOURNAL.md`. Builders append;
    the PM merges. Journal entry numbers are pre-allocated per milestone so parallel builders never
    collide: M0 J-0100.., M1a J-0200.., M1b J-0300.., M2 J-0400.., M3 J-0500.., M4 J-0600..,
    M5 J-0700.., M6 J-0800.., M7 J-0900.., M8 J-1000.., M9 J-1100.., M10 J-1200.., M11 J-1300..,
    M12 J-1400.., M13 J-1500.., PM J-9000...
  - **Ownership transfers** (sequential only): `H/guest/session/prompt.js` M2 -> M5;
    `H/scripts/provision.mjs` runner M1a -> M12 (the steps table stays append-only for everyone).
- **Run lock.** Integration tests, spikes, perf checks and the Ironhorse lane run only under
  `H/scripts/run-lock.mjs` (architecture section 10); integration files take it with
  `takeIntegrationLock(test, label)`, perf scripts through `runPerf`, anything else with
  `node scripts/run-lock.mjs --label L -- <command>`. Parallel builders wait for it; never run two
  Ironhorse workloads at once.
- **Integration gate.** Integration files are skipped unless `THIX_HARNESS_INTEGRATION=1`; they start
  from the state template (`H/test/template/index.js`, architecture section 10) with `idleSleepMs`
  2,000, and kill only the supervisor process (`state.kill()`).
- **Done means:** unit + adapter tests pass; the milestone's integration files pass alone, each in
  under 5 minutes with the state template (M0 S8); every listed perf check has been run and its JSON
  lines pasted into `H/JOURNAL.md` with commit, crank budget and load average; at least one journal
  entry on fit; temporary state deleted; commits are incremental (at least one per work unit; core
  changes in their own commits).
- **Work units** are sized for one subagent in one sitting (roughly one focused day).
- **External software** is always behind an adapter with a fake. Steps needing the real thing are
  tagged `[real-podman]`, `[real-git]` (the Mac has git; always available), `[real-moonshine]`,
  `[real-piper]`, `[real-provider]` (needs credentials; owner-run only), `[real-browser]`.
- **Perf budgets** are medians unless stated; failing at > 1.25x budget blocks the milestone and is
  escalated to the PM with a journal entry. Bulk fixtures are built with `importState`, not by
  running turns.
- **Acceptance tests are observable behaviour** (public API, browser, network, fake-provider and
  fake-tool logs). Implementation counts (wake counters, record counts, deliveries) are perf/gate
  checks.

### Rules from the harness review (binding from M6; `arch-review/harness.md` section 4)

The review traced most of its findings to how M1a-M5 were built (themes T1-T7). These rules hold
for all later work and win over any milestone section below that says otherwise (for example
one that names `H/test/*/m6-*` or an `interfaces-m6.js`).

1. **Name by vat or concept, never by milestone or work unit** (T3). Files, exports, types,
   helpers and runtime directory tags carry no `m6`, `M6`, `interfaces-m6`, `W6.3` or `w48-`. A
   guard goes into its vat's table (`guest/lib/guards/base.js`, `session.js`, `factory.js`, or the
   one Node-side table); a limit into `limits.js`; a text beside its guard. Test files are named
   for the subject and the behaviour (`gateway-vocabulary-tables.test.js`, not
   `m3-w32-vocabulary.test.js`). A **contract** may be per milestone (`m6-interfaces.md`), the code
   is not. Milestone ids live in contracts, the journal and commit messages only. The existing
   milestone-named modules are renamed by the fold (`arch-review/fold-plan.md`).
2. **Every merge of parallel lanes ends with a fold unit** (T1). Its done-criterion is deletion:
   no view, widening, seam, `notBuilt` stub, empty registry or copy that the lanes left behind,
   checked by a grep or a test, not a sentence in a contract.
3. **Export, don't copy** (T2). A lane may export a helper from another lane's or an earlier
   milestone's module instead of copying it; the export is a one-line seam listed in the lane's
   contract and reviewed by the module's owner. Copying more than 15 lines is a review finding.
   `corepack yarn lint:duplicates` fails above the duplicate ceiling (`scripts/check-duplicates.mjs`:
   2.05 % of normalised lines over `guest`, `resources` and `ui` since step 3, `d94ad96129`;
   measured 1.80 %, 478 of 26,614 lines, at `804398c4d9`; 3.25 % and 3.00 % after the fold);
   the ceiling only goes down.
4. **Fakes are built from the real guards** (T5): `makeExo` with the product's interface,
   assemblies exported by the product rather than re-assembled in a fixture; a product branch
   that only tests take ("for tests") is a review failure.
5. **Manager-part changes are batched** (T6): each change to the agent-host manager part
   (`resources/agent-host/*.js` outside `impl/`) is a reinstall that breaks live references, so a
   contract gives the reason the change cannot live in the adapter, and a parallel group makes one
   batched manager change.
6. **Objects and fields at the seams** (T4): a contract review asks "what here is a string that
   stands for an object, a reason or a position?"; a list of files is explicit, never a glob.
7. **A new job names its module** (T7): when a contract adds a job to an existing closure, it
   names the module the job lives in.

**Where later jobs go after step 3 of the review** (`arch-review/step3-plan.md`; as built:
`architecture.md` 4.7-4.9, D-6, D-8, D-18; J-10200..J-10253). A per-session job is a runtime
part (`guest/session/runtime-parts.js`, 4.8), never a new member of `turn.js`; its hooks are
synchronous and get a `HookTurn { active, round, append, emit }`, which can add records and
events to the crank but cannot change the round request or skip a round (M8's tool-less summary
round needs a contract addition there, J-10253). A backend kind is one `backendKinds` entry in
`AH/providers/kinds.js` under the provider shell; a pool kind also adds one line to
`providerOfKind` in `guest/lib/subscription-texts.js` (a guest file: templates rebuild). A feed
builds on `AH/channel-subscriber.js`; an atomic file write uses `AH/files.js`; anything keyed by
the wrapping key takes the incarnation's `makeWrappingKey` object. A history or archive preview
uses `guest/lib/record-preview.js`, and usage arithmetic `guest/lib/usage-counts.js`.

## Order and parallelism

```
M0 -> M1a -> M1b -> M2 -> { M3 | M4 | M5 }      (M3 W3.0 merged before any M4/M5 UI unit starts)
M5 -> cleanup step 3 -> WX.1 -> { M6 | M8 | M9 | M11 }
     -> merge M11 + fold -> merge M6 + W6.8 -> merge M8 + fold -> merge M9 + W9.F -> WX.F
M6 -> { M7 | M10 } ;  { M3, M4, M5 } -> M12 (parallel with M7, M10) ;  everything -> M13
```

Parallel groups: **{M3, M4, M5}**, then **{M6, M8, M9, M11}**, then **{M7, M10, M12}**. The ownership
check at the end lists every file and hook point each group touches.

**The group {M6, M8, M9, M11}** (contracts settled; X-17). Before the lanes: cleanup step 3
merged, then the PM's cross-lane seam unit WX.1 (every shared guard entry, the part-API typedefs,
the part and tool order, the call table and label-lookup exports, one vocabulary re-pin; see
"The group {M6, M8, M9, M11}" above M6), then the owner's ruling on the session program (G-1) and
the PM's per-lane caps before W6.4, W8.1, W8.4 and W9.8. The four lanes then run in parallel, each
in its own worktree. They merge one at a time, in this order, each merge followed by its own fold
(review rule 2) before the next lane rebases:

| step | merge | hand-merged shared files (seams) | fold right after it |
|---|---|---|---|
| 1 | M11 (no `guest/session/` file) | `guest/factory/factory.js` (H2), `root.js` and `main.js` (H2b), `GW/server.js` (H5), `GW/index.js`, `extensions.js`, `protocol.js` (H6), `AH/index.js` (H7), `scripts/test-integration.mjs` (H8), `perf/_pass.mjs` (H9), `UI/src/controller/index.js` (H10) | F-1..F-11 (F-7 waits for M6 or moves to WX.F) |
| 2 | M6 | `runtime-parts.js` (R-1), `turn.js` `claimNext` (R-2), `session.js` (R-3), `queue.js` (R-4), `export.js` (X-E), `tool-table.js` (T-1), `label-seeds.js` (L-1), `preset-templates.js` (F-1), `services.js` (F-2), `factory.js` (F-3, F-4 after M11's H2), `root.js` (F-5 after H2b), `prompt-sections.js` (P-1), `AH/composer.js` (C-1), `package.json` (K-1), `scripts/test-integration.mjs` (K-2) | W6.8 (section 14 of its contract; X-1 alignment after M8) |
| 3 | M8 | `turn.js` (S-5), `session.js` (S-6), `runtime-parts.js` (S-7, after `environment`), `turn-import.js` (S-8), `archive.js` (S-9), `tool-table.js` (S-10b, after the shell entries), `tool-args.js` (S-10d), `AH/index.js` (S-14, S-18 after H7), adapter seams S-10..S-20 | items 1-3 and 6 of its section 18 |
| 4 | M9 | `runtime-parts.js` (S1, after `compaction`), `packages.js` (S3), `tool-args.js` (S4, after S-10d), `session.js` (S5), `tool-table.js` (S6, last), `export.js` (S7), `label-seeds.js` (S8, `user` last), `factory.js` (F1, F2 in the object M6's F-3 made, F3, F5 first in M6's hooks array), `services.js` (F4, after F-2), `prompt-sections.js` (F7), `AH/blobs.js` (A1), `guest/exec/inspect.js` (X1) | W9.F (section 12 of its contract) |
| 5 | - | - | WX.F: vocabulary and session bundle measured once against the ruled limit; the four cross-lane tests; M8 fold items 4 and 5; regression and perf lists; `architecture.md`; the ownership-check row below |

**Core requests across lanes.** CC-051 (M3, `m3-interfaces.md` 13: per-entry diffs of a hub session
row, C-2's rest) and CC-060 (M4, `m4-interfaces.md` 19: the alleged interface name stored once per
export row, for object-granular reachability) both change the hub's row format in
`pkg/src/net/hub.js` and its log store. They must be made as **one** core change (one format, one
migration, one `CORE-CHANGES.md` entry), whichever lane asks first. Status (X-CLOSE): requested,
not built; the row is in `CORE-CHANGES.md` "Core requests from the M3, M4 and M5 contracts".

---

## M0. Groundwork: frame cost, package skeleton, fit spikes

**Status: done.** Build commits `0d35cbd569..7fa1a7057a`; PM follow-ups `3f2b90954e..6677f92fcc`
(upstream PR 1667 merged, snapshot goldens re-pinned, run lock and serve fixes, perf through the
template helper, restart re-validated). Journal J-0100..J-0198 and J-9000..J-9051; summary in
`m0-results.md`. The work-unit table below is kept as the record of what M0 was asked to do; the
outcome follows it.

**Goal.** Make a vat survive the messages the harness needs, choose the frame and crank-budget
settings with numbers, and prove the Thixotrope mechanisms the architecture rests on, before any
harness code depends on them.

- **P / R:** none (enabling). Settles core.md section 11 checks 1, 5, 6 and native.md first tasks 1-2.
- **Depends on:** nothing.
- **Owns:** `rust/engine/ironhorse-vm/src/interp/boot.rs` and the boot path for CORE-1a, the new
  native in `rust/engine/ironhorse-vm` and `rust/endo/xsnap/src/polyfills.js` (CORE-1),
  `pkg/src/core/evaluate-source.js` (CORE-1b), `pkg/test/ironhorse/text-codec.js` (new),
  `H/package.json`, `H/README.md`, `H/JOURNAL.md`, `H/scripts/{bundle-guest,run-lock,serve}.mjs`,
  `H/perf/_harness.mjs`, `H/perf/frames.perf.mjs`, `H/test/spikes/`, `H/test/template/`,
  `H/lint/guest-rules.js` guest rules (hooked into the root `eslint.config.js`; the repository has no
  per-package `.eslintrc`), root workspace registration of `H`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W0.1 CORE-1a | VM boot / vat compartment path; rebuild worker | trace why `typeof Uint8Array.fromBase64` is `undefined` in a vat while the VM installs it (`boot.rs:800-808`); fix so `packages/base64/src/decode.js:86` captures the native at load | vat probe: `typeof Uint8Array.fromBase64 === 'function'`; base64 of 192 KiB decodes in one crank at 10 M |
| W0.2 CORE-1 | native `decodeUtf8`/`encodeUtf8Into` in `rust/engine/ironhorse-vm`; `polyfills.js:20-160` wrappers | `TextDecoder.decode` calls the native; `{stream:true}` carries an incomplete tail in JS; `{fatal:true}` throws `TypeError` on malformed input, else U+FFFD; `TextEncoder` uses the native encoder; rebuild `pkg/dist-ironhorse` | new `pkg/test/ironhorse/text-codec.js`: split `e2 82 \| ac` gives `€`; fatal throws on `c3 28`; 1 M random code points round-trip; `test:ironhorse` lane still 55/55 (run serially, under the run lock) |
| W0.3 CORE-1b | `pkg/src/core/evaluate-source.js:32` | staging chunk = `frameBytes / 3` characters (from S1), surrogate-safe as now | install of a 300 k bundle; existing install tests |
| W0.4 skeleton | `H/package.json`, `H/scripts/{bundle-guest,run-lock,serve}.mjs`, `H/perf/_harness.mjs`, `H/JOURNAL.md` (from journal-seed.md), lint rules | `bundle-guest` turns `H/guest/<prog>/main.js` into one source string with prelude names as globals (no bundled `@endo/*`); lint forbids `Date`, `Math.random`, `setTimeout`, string `+=` in loops in `H/guest/`; `serve.mjs` sets the env allowlist and `THIXOTROPE_CRANK_BUDGET`, refuses to lower the budget unless the last shutdown was clean; `run-lock.mjs` (O_EXCL, pid, stale break); `_harness.mjs` from `survey/baseline.mjs` plus `provision()`, `idleSleepMs`, `hubJsonBytes()` | unit: a guest importing `@endo/patterns` fails lint; bundle has no copy of `@endo/patterns`; two lock takers serialise |
| W0.5 spikes A | `H/test/spikes/{s1,s3,s5}.test.js` | **S1** frame halt points in and out, single string and 8-32 strings per message, several messages per crank, sends per crank, runaway-loop wall time, each with and without CORE-1a/CORE-1 and at crank budgets 10 M / 50 M / 100 M; output sets `frameBytes`, `crankOutBytes` and the crank budget. **S3** evaluate a 150 k and 400 k program source in a fresh vat in one message at the chosen settings (sets `execSourceBytes`). **S5** does a suspended async generator persist across a delivery and a restart in the shipped worker | each spike asserts its finding and prints JSON lines; verdicts are journal entries |
| W0.6 spikes B | `H/test/spikes/{s2,s4,s7,s9}.test.js` | **S2** attach pattern: (a) a durable vat holds and calls a transient adapter object, (b) the call breaks with the retired text after restart, (c) restore re-attaches, (d) the adapter sees one stable presence for one vat object within an incarnation. **S4** adapter-to-adapter hop cost and whether `hub.json` ever holds frame payloads bound for transient sessions. **S7** a registration spec carrying a foreign remotable survives restart. **S9** SIGKILL right after a vat crank that records an intent and sends a call to an adapter object: after restart the record exists and the adapter ran the call at most once (intent-before-effect, coverage 17) | as above |
| W0.7 spikes C | `H/test/spikes/{s6,s8}.test.js`, `H/test/template/` | **S6** spare-vat pool: create, sleep, take, wake, first `make()` cost and disk per vat. **S8** state template: provision once, clean shutdown, copy the directory per test under a new short path; check path independence (socket path, `runtime/` copies); measure copy + start | as above; template helper used by every later integration file |

**Acceptance tests**
1. With the settings S1 chose, 200 messages of `frameBytes` each are sent into a vat and 200 out of
   it with no halt, and S1 records a halt point of at least 2 x `frameBytes`.
2. A Syrup string with malformed UTF-8 is refused by a Node peer and by a vat alike (fatal decoding).
3. `test:ironhorse` passes 55/55 with the new boot bundle (gate).
4. Spikes S1-S9 have a recorded verdict in `JOURNAL.md`; D-7 (attach) and D-4 (spare pool) are
   confirmed or the fallback (CORE-2 / CORE-3) is raised to the PM.

**Perf checks**
| check | budget |
|---|---|
| `frames.halt` per configuration (S1) | recorded; chosen `frameBytes` <= half the halt point |
| `frames.inbound` / `frames.outbound` at `frameBytes` | <= 300 ms over the ping floor |
| `vat.evaluateProgram` 150 k source | <= 2 s, no MeterAbort |
| `vat.spareTake` wake + `make()` | <= 500 ms |
| install of a 300 k factory bundle (CORE-1b) | <= 30 s |
| `loop.runaway` wall time until MeterAbort at the chosen budget | <= 1 s |
| `template.start` copy + start to serving | <= 20 s |

**Outcome.**

| item | result | entries |
|---|---|---|
| Acceptance 1 (200 frames in and out; halt point >= 2 x `frameBytes`) | pass: 200 x 24,576 in (median 349 ms) and out (68 ms); halt at 94,208-98,304 on fresh and used vats | J-0194 |
| Acceptance 2 (malformed UTF-8 refused by Node and vats) | pass: fatal decoding in both Syrup decoders and the vat polyfill; a crafted-frame vat test was not written | J-0192, J-0197 |
| Acceptance 3 (`test:ironhorse` gate) | pass: 65/65 (55 original + 1 base64 scenario + 7 text-codec + 2 key-space), re-run after the PR merge | J-0196, J-9042 |
| Acceptance 4 (spike verdicts) | S1 settings chosen (J-0141..J-0144, J-0194); S2 D-7 confirmed, CORE-2 not needed (J-0160); S3 sources must be staged (J-0146, J-0195); S4 hop 25 ms, `hub.json` holds transient frames in clear (J-0163, J-0164); S5 async generators persist (J-0147); S6 D-4 confirmed, CORE-3 not needed (J-0183..J-0185); S7 foreign remotables in specs survive (J-0162); S8 templates work (J-0180..J-0182); S9 intent before effect holds (J-0165) | |
| Perf table | all pass; `vat.evaluateProgram` 2.2-2.3 s passes under the 1.25 x rule only (staging cost, C-5) | `m0-results.md` page 7 |
| W0.1 CORE-1a | landed in `@endo/immutable-arraybuffer`, not in `boot.rs` (the shim hid the statics) | J-0100 |
| W0.3 CORE-1b | the staging chunk is 8,192 units (`frameBytes / 3`); install 300 k in 11.6 s | J-0120, J-0193 |
| Core changes beyond the plan | CORE-4 engine `getOwnPropertyDescriptors` index keys (`d0fd6b1138`), CORE-5 Syrup BOM (`5a73049032`), CORE-6 halt on session end (`63927edaba`), CORE-7 exports (`042171c094`) | architecture 1.1 |
| Open | the core-change candidates C-1..C-15 | `m0-results.md` page 6 |

**Deferred:** nothing from M0's scope; CORE-2 and CORE-3 are not needed.

---

## M1a. Headless session slice (smallest end-to-end)

**Status: done.** Build commits `6e3b8692f7..91458e17b5` (W1a.0..W1a.7 and the QC fixes); hardening
`a88ecbf159..58e7b572c1` (adapter channels and tooling, ports held per adapter incarnation, settled
turns as records, the C-16 engine fix `9828522485` and the C-17 core change `f8bf23c62d`, integration
fixes). Journal J-0200..J-0296, J-9100..J-9127, J-9150..J-9157, J-9170..J-9174, J-9190..J-9200. The
work-unit table below is kept as the record of what M1a was asked to do; the outcome follows it.
Where the contract changed after the build (ports per incarnation, records for settled turns),
`m1a-interfaces.md` is current and the rows below are historical.

**Goal.** One session vat, a scripted fake backend and an adapter tool: submit a message, stream
events to a subscriber, run one parallel tool round, kill and restart, and find the session,
transcript and queue intact with the in-flight turn marked outcome-unknown and nothing sent twice.

- **P:** P-03 (factory API, no UI), P-08 (single round loop, parallel calls), P-09 (one subscriber),
  P-10 (FIFO only), P-13 (records), P-14, P-21.
- **R:** R3-23, R3-24, R3-25, R3-26, R4-1, R4-2, R4-3, R4-6 (title, preset, backend, `modelId`;
  creating/ready), R4-10, R4-40, R4-43, R4-44, R4-45, R4-50, R4-52, R4-54, R4-60, R4-65 (as amended
  by D-5), R4-66, R4-67.
- **Depends on:** M0.
- **Owns:** `H/guest/lib/{interfaces,limits,turn-engine,reply-fold,transcript-records,bounded,retired}.js`,
  `H/designs/m1a-interfaces.md`,
  `H/guest/session/{main,session,turn,turn-hooks,queue,records,live,recovery,tool-table}.js`,
  `H/guest/factory/{main,root,factory,services,session-options,rows}.js`,
  `H/resources/agent-host/{durable,ephemeral}.js`, `AH/{index,attach,endpoint,channels,channel-taps,live-service,composer,timers}.js`,
  `AH/providers/scripted.js`, `AH/tools/echo.js`, `H/scripts/{provision.mjs,provision-steps.js}`,
  `H/test/{unit,adapter,integration}/m1a-*`, `H/test/fixtures/scripts/`,
  `H/perf/{turn,restart,session}.perf.mjs`.

**Note for builders.** reuse.md:353 says an interrupted provider call should be re-issued; do not:
R4-66 and architecture section 4.4 forbid it. Read `m0-results.md` first: in particular the frame
ceiling (no single message over `frameBytes`), the per-vat name table (no data-dependent record keys,
architecture rule 12.10), staged sources (rule 12.11), and crashes versus halts (D-17).

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W1a.0 interface contract | `H/guest/lib/interfaces.js`, `H/guest/lib/limits.js`, `H/designs/m1a-interfaces.md`, `H/test/unit/m1a-interfaces.test.js` | One subagent, first, alone. `interfaces.js` exports the `M.interface` guards and method names of every object that crosses between M1a's units, in object-passing style (objects as arguments, strings only for F.2 reasons): `Session`, `SessionInternal`, `Turn`, `QueueEntry` and `Receipt`, `Endpoint`, `TurnSink`, `ContextSource` (shape only; built in M1b), `Live` and `Composer`, the channel `Publisher` and `Subscriber` facets, the tool-table entry (`describe()`, `execute(args)`), `SessionServices`, `SessionHostFacet`, `RowReporter`, `AgentHostAdmin` and `Backend` (M1a subset of architecture 3.3), `HarnessRoot`, `Operator`, `SessionFactory`, `SpareMaker` (shape only; M1b), and the record shapes of architecture 4.3 (`TurnStarted`, `Dispatched`, `Partial`, `RoundSettled`, `ToolIntents`, `ToolResult`, `TurnSettled`) and of `SessionRow`. Every string and array in a guard is bounded from `limits.js`; every record shape is a closed `M.splitRecord` with a fixed key vocabulary (rule 12.10); tool arguments are JSON text. `limits.js` is the guest copy of `config/defaults.js` `limits` (frameBytes, crankOutBytes, inlineBytes, sendsPerCrank, execSourceBytes, previews, queue bounds, calls per round and window). `m1a-interfaces.md` says, for each method: who calls it (vat, adapter, gateway, test), in which crank of the turn sequence (architecture 4.1), answered or `sendOnly`, the largest message it can carry in bytes, and what a retired break from it means (restart or vat lost). | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown record key; `limits.js` equals `config/defaults.js` `limits` for every shared name |
| W1a.1 guest lib | `H/guest/lib/{turn-engine,reply-fold,transcript-records,bounded,retired}.js` copied from `fae/src/turn-engine.js`, `fae/session/reply-fold.js`, `hosted-agent/src/transcript-records.js` (subset); `bounded.js` (byte estimate units x 3, frame and crank-out checks, chunking of a text into `frameBytes` pieces); `retired.js` (`isRetiredBreak`) | prelude globals only; injected ids and times; imports `limits.js` and `interfaces.js`, never edits them | ported `fae/test/turn-engine.test.js`, `reply-fold.test.js`, `transcript-records.test.js` (Node, ses-ava); chunking keeps surrogate pairs |
| W1a.2 agent-host manager + attach | `durable.js`, `ephemeral.js` loader (D-14), `AH/{index,attach,endpoint}.js`, `AH/providers/scripted.js`, `AH/tools/echo.js`, `AH/timers.js` | attach pattern exactly as the S2 fixture (`H/test/spikes/fixtures/attach/`: `bind` awaits `attach`; `open()` retries once through `register` when its facet is retired); `AgentHostAdmin.makeBackend({kind:'scripted', script})`, `forSession`, `onStart`; Endpoint with `holdTurn`/`releaseTurn` lease, `startRound`, `cancelRound`, `armDeadline`/`disarm`; `dispatching()` handshake before round 0; scripted provider (chunks with delays, tool calls, usage, errors, stall-until-cancel); `echo` adapter tool with `delayMs` and output size; tool-call arguments passed to the vat as JSON text; any message to a vat over `frameBytes` fails the round with "round output exceeds this build's frame limit" (no staging until M1b) | adapter tests with a fake vat sink: handshake order, lease settles at release, oversize refused before sending, no record built from model JSON |
| W1a.3 channels | `AH/{channels,channel-taps,live-service,composer}.js` | session channel with publisher/subscriber facets (D-8), seq numbers, current-turn fold, subscriber dropped on close; `Live.subscribe(session, rev)`; `Composer.submit(session, text, requestId)` stamping `at` (no staging yet: text over `inlineBytes` refused); both reachable for tests through `AgentHostAdmin.live()` / `.composer()` (operator only) | adapter tests: fold equals replay; dropped subscriber; publish batch order |
| W1a.4 session vat: turn | `H/guest/session/{main,session,turn,turn-hooks,records,live,tool-table}.js` | `Session`, `Turn`, records of section 4.3, atomic claim, lease, publish batching (sendOnly in a turn, answered outside), `watch()`, tool table with `echo`, results in call order, R4-43/R4-45 texts, round limit; data-keyed state in `Map`s only | unit tests with in-memory fakes: intent before result, call order, round limit, claim removes the entry |
| W1a.5 session vat: queue + recovery | `H/guest/session/{queue,recovery}.js` | FIFO queue (`enqueueOnce` with receipt per request id, minimal), `restart` hold, `recoverAfterRestart()` (section 4.4) triggered by `isRetiredBreak` on the lease or any adapter call on the turn path, never by a guest-vat break; abandons guest calls by generation instead of awaiting them; `startTurn` refusal text R4-10 | unit: every recovery case; a retired break on a tool call never becomes a tool failure; recovery completes while a guest call stays pending forever |
| W1a.6 factory + provisioning | `H/guest/factory/*`, `H/scripts/provision*.{mjs,js}` | `HarnessRoot`, `Operator.getFactory`, `createSession({title, preset, backend, modelId})` with the built-in preset `chat-only`; sessions created directly (no pool yet): `E(vats).createWorker`, the session bundle staged in `frameBytes`-unit chunks (ASCII) or `frameBytes / 3` (otherwise), one evaluating crank, then `make(config)`; `listSessions` paged, `findSession(key)`, per-session `RowReporter` (row-visible transitions only); a row becomes `lost` when a call into its session breaks with the retired text (D-17); start listener (pool none yet; completes or rolls back interrupted creations); provisioning steps table: `install-native agentHost`, `inventory.set('vats', vats)` in the workspace vat, `install harness ... grants`; `provision-steps.js` is also the `provision` of an `ensureTemplate({ id: 'm1a' })` template | integration: provision on a fresh state dir; re-running is a no-op; the bundle-size check |
| W1a.7 slice tests + perf | `H/test/integration/m1a-slice.test.js`, `H/perf/{turn,restart,session}.perf.mjs` | the acceptance list below, from the `m1a` template with `idleSleepMs: 2000`, SIGKILL through `state.kill()` | acceptance 1-10 |

**Order and parallelism inside M1a.** W1a.0 runs first, alone (one subagent); nothing else starts
until its contract is committed. Then **W1a.1, W1a.2 and W1a.3 run in parallel**, then **W1a.4, W1a.5
and W1a.6 run in parallel** (W1a.6 needs W1a.2's resource for its integration test, not for its unit
tests), then W1a.7. Each unit owns exactly the files in its row; the sets are disjoint. No unit edits
`interfaces.js` or `limits.js`: a unit that needs a contract change stops and asks the PM, who amends
W1a.0's files in one commit and tells the other units. `turn-hooks.js` and `tool-table.js` are created
by W1a.4; `services.js`, `session-options.js` and `provision-steps.js` by W1a.6; later milestones
append to them (hook tables).

**Acceptance tests (observable)**
1. Provision a fresh state directory; `createSession({title:'t', preset: chatOnly, backend: scripted})`
   returns a Session; `listSessions` shows it `ready`, activity `passive`. `createSession({model:'x'})`
   is rejected (R4-6).
2. Submit "hi" through the Composer: a subscriber gets the snapshot, then `phase`, at least 3
   `delta`, `final`, `usage`, `end`.
3. A round with two `echo` calls of `delayMs: 1000`: the round takes less than 1.6 x a round with one
   such call; the history page shows one intent record before both results, results in call order.
4. Submit while a turn runs: the message waits and runs next (FIFO). `startTurn` while a turn is
   active fails with "Session already has an active turn; observe or cancel it first" (R4-10).
5. Stall-until-cancel script: SIGKILL after `Dispatched`, restart: as soon as the daemon serves,
   session, transcript and queue are there and the turn is already `outcome-unknown` (the lease break
   is delivered during startup); the fake provider received exactly one request; a queued message is
   held `restart` with the A.4 text; `turn.resolve(note)` works while idle.
6. SIGKILL before `dispatching()` was answered: the turn is closed "Interrupted before dispatch; no
   backend execution was started."; the user message appears **once** in history; sending a new
   message releases the hold and does not resend the old one (coverage 10).
7. SIGKILL while an `echo` call is in flight: after restart its result reads "Tool outcome unknown; do
   not automatically retry.", the turn is outcome-unknown, no further round was requested, and the
   echo log shows the call ran at most once.
8. Frame limit: a scripted reply of 64 KiB, and an `echo` result of 64 KiB, each fail the turn with the
   recorded reason "round output exceeds this build's frame limit" before any message reaches the vat;
   the session then runs a normal turn (it was not halted).
9. Record keys: a scripted tool call whose JSON arguments carry 2,000 distinct keys reaches `echo`
   intact, is recorded as text, and the session then runs 3 more turns.
10. Crashing session vat at restart (bound 2 through `--max-delivery-attempts 2`, to keep the test
    short): SIGKILL with session A awake and unsnapshotted, then kill A's worker each time it appears
    (the killer of `perf/crash.perf.mjs`). The daemon serves after A is given up; the factory and
    session B answer; a call on A rejects with the retired text and does not hang; `listSessions` shows
    A `lost`. No other vat was given up.

**Perf checks**
| check | budget |
|---|---|
| `turn.start` submit to scripted provider request | <= 350 ms; <= 3 deliveries |
| `turn.delta` adapter chunk to subscriber | <= 5 ms; 0 deliveries per delta |
| `turn.round` deliveries per round with 2 tool calls | <= 3, plus 1 lease delivery per turn |
| `session.program` size of the bundled session program | <= 200 KB (record the bytes) |
| `session.createCold` `createSession` without a pool | <= 6 s (6.4 s for a 246 KB program in M0, J-9045; depends on C-5) |
| `install.factory` provisioning install of the factory bundle | <= 15 s |
| `restart.serving` 10 checkpointed idle sessions + 1 in flight | <= 10 s; woken session vats = 1 (gate) |
| `restart.crashingSession` as acceptance 10 with bound 5 | recorded; target 15 s depends on C-8, C-9 (M0: 36-69 s) |
| too-big probes: 64 KiB round output; 300 k-char echo output; 2,000-key tool arguments | refused / cut in the callee / kept as text; no vat halt; the session answers afterwards |

**Fit risk:** awkward. The loop maps well onto vats; the risks are the live-channel ordering across
hub and process, relying on the retired text as the restart signal (it also means "vat lost" from a
guest vat), and the cold session create cost while there is no pool.

**Deferred:** exec, spare pool, staging, context cache, list feed (M1b); real providers and the full
queue (M2); UI (M3).

**Outcome.** Release worker `7cda4467...`, crank budget 50 M, Apple M3 Max with other agents
running. "Before" is the M1a build (J-0270..J-0293, worker `c2f65dbe...`); "after" is
`2ea74a02f8`..`ddcdfc68e3` (J-9190..J-9192). Verdicts use the 1.25 x rule.

| item | before | after | verdict | entries |
|---|---|---|---|---|
| Acceptance 1-4, 8, 9, QC 1 (`m1a-slice`) | 6/6 | 6/6; acceptance 1 also checks `createdAt` | pass | J-0284, J-0295, J-9190 |
| Acceptance 5-7 (`m1a-slice-restart`) | 3/3, one kill each | 3/3, then 20/20 at kill delays 0, 100, 500, 1,500, 4,000 ms (5, 6, 7 and the held-ports case 3, five each); no provider request or tool run twice | pass | J-0284, J-9190 |
| Acceptance 10 (`m1a-slice-crash`) | 1/1, served 6.1 s | 1/1, served 6.0 s | pass | J-0284, J-9190 |
| Provisioning (`m1a-provision`) | 1/1 | 1/1 | pass | J-0295, J-9190 |
| `turn.start` (budget 350 ms; 3 frames) | median 573-575 ms, p99 5.7-10.4 s; 4 frames | median 255 ms (two runs of 200), p95 288-293, p99 1.9-3.0 s; 2 frames | **pass** (0.73 x); p99 tail is C-20 | J-0272, J-0293, J-9191 |
| `turn.delta` (5 ms; 0 deliveries) | 18 ms through a control client (wrong place) | 0.17-0.18 ms in the adapter process; 0 deliveries | pass | J-0274, J-9173, J-9191 |
| `turn.delta.client` (no budget) | 18 ms, p95 2.7-3.0 s in GC bursts | 18 ms, p95 0.74-1.8 s in GC bursts | recorded; C-20 | J-0274, J-9191 |
| `turn.round` (3) / `turn.lease` (1) | 3 / 1 (a plain turn 5 deliver frames) | 3 / 1 (a plain turn 4 deliver frames) | pass | J-0273, J-9191, J-9193 |
| too-big probes | pass (keys2000 11.1 s in a burst) | pass (0.7 / 0.8 / 1.2 s) | pass | J-0278, J-9191 |
| `session.program` (200 KB) | 142,994 bytes | 157,493 bytes, ASCII, 7 pieces | pass (0.79 x) | J-0281, J-9192 |
| `session.createCold` (6 s) | 5,890 ms | 6,138 ms (6.03-6.18 s) | pass under the rule (1.02 x); depends on C-5 | J-0281, J-9192 |
| `install.factory` (15 s) | 5,725 ms | 5,950 ms | pass | J-0281, J-9192 |
| `restart.serving` (10 s; woken session vats = 1) | median 6.7 s; gate failed in run 1 of every invocation (11 woken) | median 6.2 s (6.1-9.7); gate 5/5 (wakes) | pass | J-0276, J-0294, J-9125, J-9192 |
| `restart.crashingSession` (15 s; depends on C-8, C-9) | 20.5 s | 20.4 s | **miss** (1.36 x), recorded | J-0280, J-9192 |
| `gc.burst.turnStart` / `gc.restart` (C-17, new) | p99 3.3 s; 10 idle sessions woken at the first restart | p99 0.52 s (max 4.0 s with 6 session cranks); 0 woken in 5 of 5 runs | pass | J-9120, J-9123, J-9192 |
| `crash.restart.*` (M0 rows, 15 s) | bound 5 35.8-68.5 s; bound 2 7.6-9.0 s; healthy 4.6-5.8 s | bound 5 35.7 s; bound 2 5.5 s; healthy 4.6-4.9 s | bound 5 **miss** (C-8, C-9); others pass | J-9046, J-9192 |
| `test:ironhorse` lane | 65/65 | 66/66 (worker and core unchanged since) | pass | J-9102, J-9126 |
| Unit lane | 275 passed | 313 passed, 23 skipped | pass | J-0295, J-9190 |

Fit (J-9194): the turn loop, intent before effect and restart recovery fit vats well; holding ports
across turns is awkward (a clock comparison stands in for a restart notice, C-19); GC traffic was a
poor fit until CORE-9 and still costs host time per frame (C-20). Remaining performance risks:
J-9195..J-9200.

---

## M1b. Exec scope, staging, context cache, pool, list feed

**Files after the review's fold (CL-CLOSE, 2026-11-18).** The `m1bShapes`, `m1bInterfaces` and
`m1bMethodNames` views of `guest/lib/interfaces.js` are gone (`a1373d71b9`): read `shapes`,
`interfaces` and `methodNames` there (Node) or in `guest/lib/guards/*.js` (vats); M1b's method
lists stay as the build ingredient `m1bMethodLists`. The live probe of `turn.delta` is switched on
by `THIX_HARNESS_LIVE_PROBE_DIR`, no longer by a file (`84bb177365`). Rename map:
`arch-review/fold-plan.md` section 6.

**Status: done, with recorded perf misses for the PM to rule on.** Build commits
`3df16eafd4..4efd2d795c` (W1b.0..W1b.6, the C-20 core change `7efa7fb3e4..a3a2b58da5`, the delivery
histogram `b45da47b93`); QC fixes `d4241fa77a..e48dffe8f7` plus the documentation commits that follow it. Journal J-0300..J-0370, J-0390..J-0398,
J-9210..J-9216. Acceptance 1-12 pass in real vats except acceptance 9's delete, which needs M2's
`deleteSession` and moves to M2 (acceptance 13). Four budgets still miss (`session.create` with the
pool, `concurrency.10` turn start and crank p95, `history.page`, `context.rebuild`: see the outcome);
they are kept, not re-based, and name the core candidate each depends on. The work-unit table below
is the record of what M1b was asked to do; where the contract changed (QC: `ExecScope.abandon`,
`exhausted`, answered `TurnSink.progress`), `m1b-interfaces.md` is current.

**Goal.** Complete the headless core's structure: the confined persistent `exec` scope, large text
staged as blobs, the adapter-owned context projection, the spare-vat pool, the session list feed, and
the first multi-session performance checks.

- **P:** P-09 (late join), P-16 (basic exec), P-03 (list feed), P-13 (large content).
- **R:** R3-29, R3-41, R3-42, R4-31, R4-46, R4-63, R4-100.
- **Depends on:** M1a (done; read its outcome table and the "Changes after" rows first).
- **Owns:** `H/guest/exec/`, `H/guest/session/tools/exec.js`, `H/guest/session/{context-source,staging}.js`,
  `H/guest/lib/tool-output.js` (from `fae/session/tool-output.js`), `H/guest/factory/{pool,list-feed}.js`,
  `AH/{blobs,content,context-cache,projection,projection-hooks}.js`, `H/designs/m1b-interfaces.md`,
  `H/test/*/m1b-*`, `H/perf/{exec,pool,concurrency,hub,history}.perf.mjs`; for W1b.0 only:
  `H/guest/lib/{interfaces,limits}.js`, `H/designs/m1a-interfaces.md`, `H/guest/session/live.js`
  (the outside-publish bound).

**What M1a leaves for builders to know.** Ports are held per adapter incarnation and opened in
`make` (contract 6.1, 7.1): a spare's `make()` sends the creation-time open, which the manager
answers only after the factory's `bindSession` (the pool must keep that order). A turn start is one
crank on held ports; a claim after an unannounced restart reopens (case 3). GC frames ride the next
ordinary crank and never wake a vat (architecture 4.6), so do not count journal growth as wakes:
read the worker row's `wakes`. Settled turns are records; only 32 `Turn` handles are kept
(compare by `turnId`). `createSession` takes `at` (the caller's clock). Guest bundles are ASCII
(escaped by the bundler). Integration files run one per invocation or through
`corepack yarn test:integration`.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W1b.0 interface contract | `H/guest/lib/{interfaces,limits}.js`, `H/designs/m1b-interfaces.md` (new; `m1a-interfaces.md` stays the M1a contract and gets only corrections), `H/test/unit/m1b-interfaces.test.js`, `H/guest/session/live.js` | One subagent, first, alone, as W1a.0. Guards and method lists for every object that crosses between M1b's units: `Blob`, `BlobWriter`, `Content`, the staged-submission and staged-field shapes (`{ blob, preview, bytes }`), `ContextSource.page` (records only), `ExecHandle` (run, retire), the exec vat's `ExecScope` (run, busy answer), `SpareMaker` (completed from its M1a shape), `SessionListFeed` and its publisher, the `PoolStatus`/`whenSettled()` shape, `ToolOutput` cut rules (R4-46). For each method: caller, crank of the turn sequence (`m1a-interfaces.md` 6), answered or `sendOnly`, largest message in bytes, what a retired break means (adapter: restart; exec vat or spare: that vat is lost). Carried from M1a (J-9172, J-9150): an optional close `reason` on `LiveBatch`; a bound on the chain of outside-a-turn publishes in `live.js` (`outsideTail`: keep at most one batch's worth pending and drop the oldest, so a `liveChannel()` that never settles cannot grow it); the text of the blank-submission refusal once the PM rules on it. | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown key; `limits.js` equals `config/defaults.js`; a `liveChannel()` that never settles leaves at most the bound of outside batches pending |
| W1b.1 blobs + staging | `AH/{blobs,content}.js`, `H/guest/session/staging.js`, Composer staging | D-15 pre-minted handles, fsync before handing out; `BlobWriter`; `Content.read(blob, offset, length)` in-process; staging of submissions, model messages, tool args, tool results and native context over `inlineBytes`; progress as `{partial: Blob, tail}` replacing one record | adapter: handle never handed out before fsync; resolve after restart; unit: partial record replaced |
| W1b.2 context cache | `AH/{context-cache,projection,projection-hooks}.js`, `H/guest/session/context-source.js` | D-9: records in, projection in Node; `{count, epoch}` check; page pull from the latest compaction boundary; batched blob resolve; native context replayed from blob; a reopen after an unannounced restart (contract 7.1 case 3) re-sends round 0 with `base` unchanged, so the cache rebuild must not count `TurnStarted` twice | adapter: rebuild equals incremental; a round 0 sent twice to two incarnations projects once; integration: rebuild after restart |
| W1b.3 exec vat | `H/guest/exec/main.js` | one persistent `Compartment`; async-body wrapper; endowments `E, harden, sleep, console(bounded), powers` (empty live facet until M5); `{busy}` answer while a call runs; large results cut (R4-46) and written to the passed `BlobWriter` in pieces of at most `frameBytes / 2`; a source over `inlineBytes` read from its Blob in pages of at most `frameBytes`, joined and evaluated in one crank (never one message: S3); `execSourceBytes` refusal; no data-keyed records leave the vat (`console` lines and results are text) | unit (Node Compartment) |
| W1b.4 exec tool | `H/guest/session/tools/exec.js` | `exec` in the tool table; adapter deadline armed with the call; a retired break from the exec vat (halt or crash give-up, D-17; indistinguishable from inside) -> the neutral terminated result of architecture section 6 + explicit `retire()`; deadline -> timeout result + retire (this also bounds a worker that misses the watchdog and is being retried); cancel abandons by generation (no retire); busy at next call -> retire + "the previous exec call was still running; the scope was reset"; after a restart the pending exec call is abandoned, never awaited (J-9048) | integration |
| W1b.5 pool + list feed | `H/guest/factory/{pool,list-feed}.js` | spare pool (D-4) with `whenSettled()`: spares made as in S6 (`createWorker`, staged bundle, evaluating crank returning a `SpareMaker`), refilled with up to 4 creations in parallel; a take is `make(config)` then `bindSession`, in that order (the creation-time open waits for the bind); `ExecHandle` (run, retire); session list channel (one publish per crank of row changes, `rev`, delivered in rev order as the session channel); `sessionListFeed()`; publisher refreshed in the start listener; calls-per-round cap and window in `turn.js` via `turn-hooks.js` settings | integration |
| W1b.6 tests + perf | `H/test/integration/m1b-*.test.js`, `H/perf/{exec,pool,concurrency,hub,history}.perf.mjs` | acceptance below; perf rows below, including the vat row for history pages that M1a measured only in Node (J-9153, J-9155) | acceptance 1-12 |

**Order and parallelism inside M1b.** W1b.0 first, alone; then W1b.1, W1b.3 and W1b.5 in parallel;
then W1b.2 and W1b.4 in parallel (W1b.2 needs W1b.1's blobs, W1b.4 needs W1b.3's vat and W1b.5's
`ExecHandle`); then W1b.6. No unit edits W1b.0's files; a unit that needs a contract change stops and
asks the PM, as in M1a.

**Acceptance tests (observable)**
1. A second subscriber attached mid-turn receives a fold equal to the events so far, then the same live
   events.
2. An `exec` returning 100,000 characters is cut to 32,768 units with the exact R4-46 marker, without
   splitting a surrogate pair; the fake provider receives exactly that text in the next round.
3. `globalThis.x = 5` in one `exec`; `return x` in the next turn after a restart returns 5. Cancel a
   turn during a 30 s `exec` sleep; in the next turn `return x` still returns 5 (scope kept).
4. `while(true){}` yields "exec scope terminated: ..."; the session keeps working; the next call has a
   fresh scope.
5. An `exec` that awaits forever with `execDeadlineMs` set to 5 s yields the timeout result and the
   scope-reset text.
6. A round with 100 `echo` calls: 64 run, 36 get the too-many-calls text; the session keeps working.
7. A 1 MiB scripted reply and a 300 KiB `exec` body: the transcript content is complete through
   `getTurnContent` / `Content`, the next round's provider request contains the full reply; an `exec`
   body over `execSourceBytes` gets the "exec source too large" result.
8. After a daemon restart, the next turn of a 200-turn session rebuilds the context cache; the fake
   provider receives the same context as before the restart, including the scripted native context.
   The same holds when the session was idle across the restart (its first claim goes to dead ports
   and is re-sent to fresh ones, contract 7.1 case 3): the provider receives that turn once.
9. Two list-feed subscribers see create, rename and delete within 500 ms; a closed subscriber is
   dropped and costs no further work.
10. SIGKILL during a 30 s `exec` sleep, restart: the turn is outcome-unknown and recovery did not wait
    for the exec call; the next turn's `exec` works and, when the exec vat survived, still sees
    `globalThis` bindings from before.
11. An exec vat whose worker is killed on every attempt while a call runs (live, no restart): the
    call ends with the terminated result after the bound is spent, the lost exec vat is retired, and
    the next `exec` gets a fresh scope.
12. A session created from a spare (`createSession` with the pool) runs its first turn on ports
    opened by its `make()`; a SIGKILL right after the take and a restart leave the session listed
    once and its first turn runs once.

**Perf checks**
| check | budget |
|---|---|
| `exec.trivial` | <= 250 ms |
| `exec.first` (spare exec vat) | <= 750 ms (spare take 157-176 ms in M0) |
| `exec.sends` 100 answered / 100 `sendOnly` from one body | <= 8 s / <= 1 s; no MeterAbort (M0 probe: 9.4-10.6 s / 0.5 s; answered depends on C-7) |
| `session.create` with spare pool / without | <= 750 ms / <= 6 s (without: depends on C-5; M1a 5.9-6.2 s for a 157 KB program, no margin) |
| `pool.refill` 2 spares after 2 takes, 4 lanes | recorded (M0: 6.4 s per spare, 50 in 108.7 s) |
| `context.rebuild` 1,000-turn session after restart | <= 5 s before the request is sent |
| `history.page` 32 turns of 8 records, in a vat | <= 300 ms (Node: 0.77 ms after the structural guard, J-9153) |
| `concurrency.10` 10 sessions streaming with tool rounds | per-session turn start <= 2 x single; crank p95 <= 200 ms; row push <= 500 ms; GC frames per session per turn recorded |
| `hub.growth` `hub.json` bytes and ms per delivery after 1,000 turns with a subscriber, after 50 sessions | <= 2 MB; <= 1.25 x fresh |
| `hub.gcBurst` host time per incoming GC frame (hub persist and journal append, timed separately) | recorded; decides C-20 (J-9127) |
| `turn.start` and `gc.burst.turnStart` (M1a rows, re-run) | median <= 350 ms; p99 recorded (M1a: 0.5-3.0 s from GC bursts' host cost; p99 <= 1 s **depends on C-20**) |
| `exec.retire` disk returned after a lost exec vat is retired | >= 15 MB (M0: 17.3 MB per vat) |
| too-big probes: 300 tool calls in one round; 1 MiB reply; 10 MiB echo output; 300 KiB exec body; an exec body building an object with 60,000 fresh keys | no session vat halt (the last halts only the exec vat, which is retired) |

**Fit risk:** awkward. Persistent scope and guest-to-guest exec fit well; the cost is blob plumbing
for anything over a few KB and the exec compute ceiling per crank. The cold create has no margin
until the pool exists (C-5).

**Deferred:** real providers (M2), presets and `powers` content (M5), UI (M3).

**Outcome.** Release worker `7cda4467...`, crank budget 50 M, slot ceiling 4,000,000 (M1b QC),
Apple M3 Max with other agents' processes; load 1.5-3.5. "Build" is W1b.6's run (`a99abea744..
1647fcbc41`, J-0360..J-0370, slot ceiling 1,000,000); "QC" is `6794d9e808..e48dffe8f7` (J-0395,
J-0396). Verdicts use the 1.25 x rule.

| item | build | QC | verdict | entries |
|---|---|---|---|---|
| 1 late join (`m1b-live`) | pass | pass | pass | J-0360, J-0396 |
| 2 exec result cut, R4-46 marker, provider gets it (`m1b-content`) | pass | pass (32,767 units; turn 2.2 s) | pass | J-0360, J-0396 |
| 3 `x` across a clean restart; cancel during a 30 s sleep keeps the scope (`m1b-exec-tool-restart`) | pass only when the next exec came after the sleep ended (else busy reset) | pass as written: the next turn's exec 164-165 ms after the cancel, 28.4 s of the sleep left, `x === 5`; an abandoned loop stops | pass | J-0340, J-0391 |
| 4 runaway: terminated text, fresh scope (`m1b-exec-tool`) | pass (604-766 ms) | pass (598-722 ms; one outlier 12.9 s after a wake from snapshot, not reproduced in 4 runs) | pass | J-0341, J-0396 |
| 5 deadline 5 s: timeout and reset texts | pass (5.17 s) | pass (5.16 s) | pass | J-0341, J-0396 |
| 6 100 echo calls: 64 run, 36 refused, session goes on (`m1b-live`) | **fail**: session vat `HeapExhausted` | pass (8.2 s); 256 echo and 256 unknown-tool calls pass too (`m1b-qc`, 11.1-11.3 / 6.1-6.2 s) | pass | J-0362, J-0392 |
| 7 1 MiB reply and 300 KiB exec body through Content; too large refused (`m1b-content`) | pass | pass (reply turn 2.5 s, read 2.2 s) | pass | J-0360, J-0396 |
| 8 200-turn rebuild after a clean restart and an idle SIGKILL (`m1b-context-restart`) | pass (2.3-2.6 s) | pass (2.4 / 2.3 s) | pass | J-0368, J-0396 |
| 9 list feed create and rename within 500 ms; closed subscriber dropped (`m1b-live`) | pass | pass (row 24-35 ms after `createSession` returned; rename 191-195 ms) | pass | J-0360, J-0396 |
| 9 delete | `test.failing` (`deleteSession` is M2) | unchanged; moved to M2 acceptance 13 | M2 | J-0309, J-0396 |
| 10 SIGKILL during a 30 s sleep; next exec sees `x` (`m1b-exec-tool-restart`) | pass | pass (served 7.0 s; outcome-unknown 1.8 s after serving) | pass | J-0340, J-0396 |
| 11 exec worker killed on every attempt (`m1b-exec-tool`) | pass (5.6 s) | pass (5.6-6.1 s) | pass | J-0341, J-0396 |
| 12 spare take, then SIGKILL after the take (`m1b-pool`, `m1b-pool-restart`) | pass | pass | pass | J-0352, J-0396 |
| M1a files (`m1a-slice`, `-restart`, `-crash`, `m1a-provision`) | pass | pass | pass | J-0367, J-0396 |
| `exec.trivial` (250 ms) | 181-191 | 174-179 | pass | J-0341, J-0396 |
| `exec.first` (750 ms) | 536-542 | 537-547 | pass | J-0341, J-0396 |
| `exec.sends` 100 answered (8 s) / sendOnly (1 s) | 4.1-5.6 s / not measurable (empty `powers`, M5) | 4.8-6.7 s (a `then` per sleep doubled it, removed, J-0391) / not measurable | pass / M5 | J-0341, J-0391 |
| `session.create` with the pool (750 ms) | 1,184-1,346 | 1,209-1,255 (awake spare 1,111) | **miss** (1.6-1.7 x); C-2, C-7 (7 serial cranks plus a wake) | J-0351, J-0397 |
| `session.create` without (6 s; C-5) | 7.7 s (198 KB program) | 5.8-5.9 s (130 KB program, comments stripped) | pass | J-0364, J-0394 |
| `pool.refill` 2 spares, 4 lanes (recorded) | 4.7-6.1 s | 4.2 s | recorded | J-0353, J-0396 |
| `context.rebuild` 1,000 turns (5 s) | no result: the session vat halted (`HeapExhausted`); 8.3 s at 400 turns | completes, no halt: 21.7 s (14 pages, 21.1 s of page cranks); live heap about 300,000 slots | **miss** (4.3 x); session no longer lost; C-5, C-7; J-0322 (b) | J-0368, J-0395 |
| `history.page` (300 ms) | 598-666 | 603-715, median 627 (floor 95) | **miss**; C-5, C-7; M2 W2.5 bounds pages by records | J-0370, J-0395 |
| `concurrency.10` turn start (2 x single) / crank p95 (200 ms) / row push (500 ms) | 3.4-3.6 x / 500 / 342 | 3.63 x (1,009 vs 278 ms) / 500 / 372 | **miss** / **miss** / pass; C-2, C-7 | J-0365, J-0397 |
| `hub.growth` (2 MB; 1.25 x fresh) | 570 KB; 1.32 x (C-20 run), 1.22 x (verifier) | not re-run | borderline; C-2 | J-9214 |
| `hub.gcBurst` (recorded; decides C-20) | 16.7 -> 6.6-7.0 ms per GC frame | not re-run | C-20 partly closed | J-9211..J-9213 |
| `turn.start` (350 ms; p99 1 s with C-20) | 291, p99 536 | 282, p99 688 | pass | J-0367, J-0395 |
| `exec.retire` (15 MB) | 25-62 MB | 60 MB | pass | J-0366, J-0396 |
| too-big probes (no session vat halt; keys60k halts or retires only the exec vat) | keys60k **fail** (vat survived, degraded) | all pass: calls300 refused (frame limit), 1 MiB reply, echo 1 MiB cut and staged (10 MiB is an argument error), exec300k refused, keys60k `exhausted` and retired | pass | J-0366, J-0390 |
| `session.program` (200 KB) | 198,438 | 130,798 | pass | J-0394 |
| Unit lane | 423 passed, 37 skipped | 434 passed, 38 skipped | pass | J-0396 |
| Core tsc (`packages/thixotrope` `lint:types`) | 1 error (`b45da47b93`) | 0 | pass | J-0396 |

**After the core changes C-7 and C-2** (CORE-11, CORE-12; worker `367e78ad...`, hub log store;
integration J-9380..J-9399, every row in J-9382). The M1b rows, re-run at `be7d2a84aa`..`bd14ef7e08`:

| item | QC (above) | after | verdict | entries |
|---|---|---|---|---|
| acceptance 1-12, M1a files, `m1b-qc`, `m1b-followups` | pass | pass; 35 SIGKILL runs at varied kill points (M1a 5, 6, 7, held ports x 5; M1b 3/10 x 5, 8 x 5, 12 x 5), no duplicated request, tool run or exec evaluation | pass | J-9380, J-9381 |
| `exec.trivial` (250 ms) | 174-179 | 53 | pass | J-9382 |
| `exec.first` (750 ms) | 537-547 | 285-298 | pass | J-9382 |
| `exec.sends` 100 answered (8 s) | 4.8-6.7 s; 7.0 s (J-9368) | 1.3-1.4 s | pass | J-9382 |
| `session.create` with the pool (750 ms) | 1,209-1,255, **miss** | 849-864 (p95 989) | pass (1.13-1.15 x) | J-9382 |
| `session.create` without (6 s) | 5.8-5.9 s | 4.5 s | pass | J-9382 |
| `pool.refill` (recorded) | 4.2 s | 2.8-3.4 s | recorded | J-9382 |
| `context.rebuild` 1,000 turns (5 s) | 21.7 s | 22.1-22.8 s | **miss**; C-5 (page cranks), J-0322 (b) | J-9382, J-9387 |
| `history.page` (300 ms) | 603-715 | 568-596 at 50 turns, 869 at 1,000 | **miss**; C-5; W2.5 record bound | J-9382, J-9387 |
| `concurrency.10` turn start (2 x) / crank p95 (200 ms) / row push (500 ms) | 3.63 x / 500 / 372 | 6.5 x (728 vs 112 ms) / 500 / 189 | **miss** / **miss** / pass; C-2 (the rest) | J-9382, J-9386 |
| `hub.growth` (2 MB; 1.25 x fresh) | 1.32 x (C-20 run) | 1.36 x, 1.35 MB | **miss**; C-2 (the rest) | J-9382, J-9386 |
| `hub.gcBurst` (recorded) | 6.6-7.0 ms per GC frame | 1.9 ms | recorded | J-9382 |
| `turn.start` (350 ms) | 282, p99 688 | 105, p99 428; 233 ms (p95 1.4 s) at 4,000 turns | pass (median) | J-9382, J-9383 |
| `exec.retire` (15 MB) | 60 MB | 52 MB | pass | J-9382 |
| too-big probes | all pass | all pass | pass | J-9382 |
| `session.program` (200 KB) | 130,798 | 132,588 | pass | J-9382 |
| long sessions, 50 / 1,000 / 5,000 turns (recorded) | per turn 0.69 -> 2.46 s over 1,000 turns (J-0370) | per turn 0.84 / 1.0 / 3.2 s; `turn.start` 121-130 / 142-152 / 271 ms (p95 1.8 s at 5,000); `history.page` 0.54-0.60 / 0.84-0.87 / 2.0 s; rebuild 1.3 / 21-22 / 180 s; slot capacity 13 / 22 / 48 % of 4,000,000 | still grows with length (about +0.53 s per turn per 1,000 turns) | J-9383..J-9389 |

Fit (J-0398): the exec scope, the blob model and the call fence fit vats well; the heap model does
not: the slot ceiling bounds live heap plus one crank (C-21) and every crank collects the whole heap
(C-7), so the cost of a session grows with its length and its heaviest crank sets how long it may
get. Open for the PM: the four misses above, the engine halt for name-table exhaustion (C-6), a
per-session disk quota (J-0393), and the advisories listed in J-0397. After CORE-11 and CORE-12
(J-9385): the per-crank collection is gone and a vat is cheap to talk to, but a collection still
marks the whole live heap and a hub session row grows with the handles a session keeps, so session
cost still grows with length, about 3.3 x more slowly; a 5,000-turn session takes 3.2 s per turn,
180 s to rebuild its context and 48 % of the slot ceiling (J-9383, J-9386..J-9389). New for the PM:
a session takes at most 4,096 Composer submissions in 24 h (J-9391).

---

## M2. Turn loop completeness on API-key backends (with minimal secrets)

**Files after the review's fold (CL-CLOSE, 2026-11-18).** The `m2Interfaces` and
`m2MethodNames` views are gone (`a1373d71b9`; read `interfaces`, `methodNames`). Rename map:
`arch-review/fold-plan.md` section 6.

**Status: done with open items** (M2-CLOSE, 2026-11-18; the outcome table at the end of this
section). Every acceptance item passes except one ratio of 15 at 1,000 turns; reviews M2-R1, M2-R2
(reject, fixed by M2-FIX) and M2-R3 are closed except the items below. Open:

- **closed** (was major, security): `SecretWriter.replace` from a remote (hub) caller now takes
  only a `SealedBox`; the gateway writes a page's value through its own in-process writer
  (`replaceLocal`), handed to pages in `GatewayPowers.extras` and refused as an argument toward a
  vat; a refused plain value is answered `secretFailed("INVALID_SECRET_BYTES")`, which never
  quotes it (XA J-10005..J-10009, X-FIX J-10054, J-10055; `m2-secrets`,
  `m2-secret-writer-paths`, `m4-ui` pass at X-CLOSE, J-10060).
- **CC-026 merged, partly closed** (was major, perf): `checkpoint.stall` p99 1.40 x on a session
  grown by turns, 1.05 x on imported ones; the cause is the core's cadence snapshot (C-24, J-9494).
  The core lane's CC-026 (a due snapshot waits for 50 ms of quiet in the worker's queue) is merged
  into this lane (K1, J-10070) and lowers it partly (p99 2,170 -> 1,195 ms at load 2, J-10112); a
  snapshot can still land in a gap inside a turn under load (4,024 ms once at load 4.5).
  Re-measured on the combination (K2, J-10077..J-10086): `archive.stall.at200` p99 1,239 ms
  (1.24 x, inside the 1.25 x rule; was 1,397 ms), `checkpoint.stall` on imported sessions
  965 / 975 / 1,011 ms at 200 / 1,000 / 5,000 turns (was 1,050 / 951 / 1,025).
- **closed** (was fail, acceptance 15 at 1,000 turns, `archive.flat.hubRow.at1000`): read at a
  quiescent point (`quiescentHubRow` in `perf/_long-session.mjs`) the ratio is 1.01 x at 1,000
  and 0.95 x at 5,000 (K2); the 1.39 x reading had caught an answer owed (J-9496).
- **fail** (new, K2): `archive.flat.turnStart.at1000` 1.99 x (261 ms against 131 ms at 200
  turns, both under the 350 ms budget; the 200-turn point fell from 247 ms, the 1,000-turn point
  did not move). Not explained, not re-based; `history.perf` exits 1 on this row.
- **fail** (perf, carried or recorded): `disk.session` 41.7 MB against 25 MB (C-22's import
  high-water); `session.create` with the pool 1,097 ms against 750; `concurrency.10` turn start
  3.2 x single and crank p95 500 ms (C-2's rest); `hub.growth` projected to 50 sessions 3.26 MB
  (C-2, CC-051/CC-060); `crash.restart.bound5` (C-8, C-9, by design).
- **closed** (was a known failure, deferred by PM ruling 4): the 100 KiB inline probe is now
  refused by the hub before it reaches the vat (core CC-027, C-25); `m2-probes` asserts it as a
  plain test: `FRAME_TOO_LARGE`, no growth of the vat's journal, the next turn served (J-10127).
- **minor** (from M2-FIX, not fixed): delete racing a session's first seal (a leak); delete step 2
  skipping on any `blobPage` error; export of a busy session failing when a seal lands between
  pages; usage of a cancelled round dropped when the cancel settles first; one pending diff per
  change (R4-61, an M3 contract change); origin binding of a Secret's key, per-purpose subkeys and
  `logPath` confinement; an unapplied seal answer kept on disk until that ordinal is sealed again
  (deliberate).
- **not run**: `secrets.read` (no perf file carries it; W2.3 measured 0.02 ms); the repeated
  SIGKILL series of acceptance 16 after the M2-FIX archive change (one run per point here).

**Goal.** Make the headless core correct and complete for daily use on the API-key backends: real
streamed providers, the full queue, exactly-once submission, stop, failure handling, usage, paging,
delete with reclamation, data-only export/import, and fixed prompt composition.

- **P:** P-05 (`provider` slot: OpenRouter streamed and Anthropic API; second `openrouter` slot),
  P-08 (full), P-10 (full), P-11, P-12 (non-shell), P-13 (full), P-15 (fixed composition), P-25,
  P-26 (create, replace, revoke, read grant; no UI), P-27 (per turn and session), P-46 (API part).
- **R:** R3-27, R3-28, R3-231, R3-232, R4-6 (rollback), R4-7, R4-9, R4-12, R4-13, R4-17, R4-20,
  R4-21, R4-22, R4-26, R4-27, R4-28, R4-32, R4-33, R4-41, R4-42, R4-47, R4-48, R4-49, R4-51, R4-53,
  R4-55, R4-56, R4-61, R4-62, R4-64, R4-74, R4-77, R4-78, R4-79, R4-82, R4-83, R4-87, R4-88, R4-92,
  R4-93, R4-94, R4-95, R4-96, R4-97, R4-98, R4-104, R4-106, R4-107, R4-108, R4-109, R7-15, R7-23,
  R7-24, R7-28.
- **Depends on:** M1b (done with recorded perf misses; read its outcome table, the M1b rows of
  "Changes after" and `m1b-interfaces.md` 16 first).
- **Owns:** `AH/providers/{openrouter,anthropic,http,sse,retry,catalog,round}.js`,
  `AH/secrets/{store,manager,writer,seal}.js`, `AH/archive/` (the record archive, D-M2-1),
  `H/guest/session/{submissions,holds,holds-table,history,archive,usage,prompt,export}.js`,
  `H/guest/factory/{delete,export}.js`,
  `H/guest/lib/{pending-queue,journal-usage,token-usage,system-prompt-base}.js`,
  `H/scripts/export.mjs`, `H/test/fixtures/fake-provider-server.mjs`, `H/test/fixtures/sse/`,
  `H/test/*/m2-*`, `H/perf/{journal,history,queue,provider,throughput,archive}.perf.mjs`; the M1a
  and M1b files M2 edits are assigned per group in `m2-interfaces.md` 2.2.

**What M1b leaves for builders to know.** The daemon serves with a slot ceiling of 4,000,000
(`config/defaults.js` `slotCeiling`, `scripts/serve.mjs`): a vat's live heap plus everything one
crank allocates must fit (the engine collects only between cranks, C-7, C-21), so a session vat has a
size at which its heaviest cranks stop fitting; `perf/history.perf.mjs` reports the session vat's
slot capacity per 100 turns (`history.grow` `heap`, `history.heap`), and `perf/crank.perf.mjs` with
`CRANK_POINTS` the long-session table (J-9383). Since CORE-11 a crank no longer pays a collection
of the live heap: the worker collects on an allocation schedule (after 131,072 slots or 16 MiB of
growth, every 32nd crank, at close), so a crank may start with that much uncollected growth, and a
vat's finalizers (its `gc-*` frames) leave up to 32 cranks after the reference died; do not assert
a release in the crank that freed it. Per-turn time still grows with session length, more slowly
(J-9383, J-9388), and a hub session row grows with the handles the session keeps (J-9386).
Since CORE-12 the hub keeps `hub-image.json` plus `hub-log.jsonl` (`hub.json` is a marker; tools
that read hub state read through the store). A scripted backend's script crosses the manager vat:
it must fit one frame; floods of fresh keys use `keys` / `argsFreshKeys` (m1b-interfaces 17.6). Guest bundles carry
no comments (`bundle-guest.mjs`; session program 130 KB of 200 KB). Exec calls end at their answer or
at `ExecScope.abandon()` (cancel, recovery) and model code cannot outlive its call (`sleep` dies with
the call); `exhausted` retires an exec vat whose name table ran out. Progress checkpoints are
answered (`TurnSink.progress -> boolean`), write bytes linear in the reply and leave no superseded
file. Real providers may send up to `maxCallsPerMessage` (256) calls a round: 256-call rounds pass at
the current ceiling (`m1b-qc.test.js`); keep that test green when the record or event shapes grow.

**Work units**

| id | files | behaviour | tests |
|---|---|---|---|
| W2.0 interface contract | `H/guest/lib/{interfaces,limits}.js`, `H/designs/m2-interfaces.md` (new), `H/test/unit/m2-interfaces.test.js` | **Done** (`58980f7d9e`, `d0a2f565e2`; J-0400..J-0404). One subagent, first, alone, as W1a.0 and W1b.0; also designs the record archive (D-M2-1, `m2-interfaces.md` 4) and assigns every file M2 edits to one unit per group (2.2). Fold the M1b tables into the M1a ones (`m1bShapes`, `m1bInterfaces`, `m1bMethodNames` into `shapes`, `interfaces`, `methodNames`; adapt `m1a-interfaces.test.js` and `m1b-interfaces.test.js` in the same commit). Add M2's guards and texts: `SessionInternal.blobPage` and `AgentHostAdmin.releaseBlobs` exactly as `m1b-interfaces.md` 4.8 specifies; `SessionFactory.deleteSession` and the `row-removed` list event; the full queue (`QueueEntry.edit/cancel/sendNow`, holds); history pages bounded by records and bytes as well as turns (W2.5); provider, catalogue and secrets shapes. For each method: caller, crank, answered or sendOnly, largest message, retired-break meaning, and the heaviest crank it can cause in records, events and sends (M1b J-0392: crank allocation, not only bytes, halts a vat). | unit: every guard accepts a sample and refuses an unbounded string, an oversize array and an unknown key; the folded tables keep every M1a and M1b method in order |
| W2.1a HTTP, SSE, OpenRouter (group A) | `AH/providers/{http,sse,openrouter,round}.js`, `guest/lib/token-usage.js`, the fake server; `AH/endpoint.js` | Node `fetch` (Node 22 pinned); SSE parser adapted from `lal/providers/subscription-events.js` (linear); OpenRouter **streamed** (G-03), `tool_choice:'auto'`; provider bodies never in failure text | fake-server fixtures: deltas, tool calls, empty answer, length stop, mid-stream disconnect; ported `lal/test/openrouter.test.js` parts |
| W2.1b Anthropic, retry, timeouts (group B) | `AH/providers/{anthropic,retry}.js`; group B owner of the W2.1a files | Anthropic Messages streamed; R4-74 retry schedule only while nothing delivered; R4-77/R4-78/R4-79 texts; timeouts (R4-93, configurable; Anthropic gets one, G-04) | fixtures: 401, 429 Retry-After, 5xx, overload |
| W2.2 model catalogue (group B) | `AH/providers/catalog.js`, `session-options.js` entry; group B owner of `AH/{index,attach}.js` (the factory's `listBackends/listModels` are W2.7's forwards) | catalogue read with the backend credential through the R4-104 cache; rows sorted per R4-20; `unavailable` on failure; selection rules R4-21; the resolved model is stored at creation (R4-22) | adapter + unit tests |
| W2.3 secrets minimal (group A) | `AH/secrets/*`; group A owner of `resources/agent-host/durable.js` (every M2 manager method, `m2-interfaces.md` 3.3) and `scripts/serve.mjs` (the key-file variable) | encrypted file (AES-GCM, key file outside state dir, D-6), `SecretsAdmin.create`, `Secret.makeReadGrant/revoke/delete/describe`, `SecretWriter.replace(secret, value, expectedGeneration)` with amplification inside the resource, sealed-box import for the CLI path, audited reads, values re-read every round (R4-82); adapters never log tool arguments, results or secret values (W-13) | stale generation refused; revoked read fails; grep of the state dir (heaps, journals, `hub.json`, blobs) after a test finds no secret value |
| W2.4 queue and submissions (group A) | `guest/session/{submissions,holds,holds-table}.js`, `guest/lib/pending-queue.js` (adapted, heap Map, no pet names); group A owner of `guest/session/{queue,session,turn,recovery}.js` and `AH/composer.js` | bounded 100 waiting, 4,096 receipts, request-id window from the Composer's `at`, `QueueEntry.edit/cancel/sendNow` (edits go through the Composer for staging), holds `restart/stopped/refused/unavailable` with the A.4 texts (no `interrupted` state, section 4.3), release rule R4-56, duplicate detection | ported `fae/test/session/pending-queue.test.js`, `session-submissions.test.js` (minus `interrupted` cases, recorded) |
| W2.5 history and archive (vat side; group B) | `guest/session/{history,archive}.js`; `turn.js`, `records.js`, `context-source.js` (`m2-interfaces.md` 2.2) | history pages of at most 32 turns, `frameBytes` **and `historyPageRecords` (48)** (a page crank marshals about 3 ms per record, J-0370, J-9387; measure and propose another bound if it misses); the vat side of the record archive (D-M2-1, `m2-interfaces.md` 4): seal in the settle crank when 160 settled turns are kept (32 turns per segment, 128 kept), intent before effect, drop only on the adapter's durable answer, the index of `SegmentEntry`s and the chained `ArchiveState`, `RoundRequest.base.archive`, `ContextSource` from `sealedTo` and `segments()`, archived turns in history (`archived`, `archive`), `Session.findTurn`, `Turn.getContent`/`resolve` of archived turns, at most 64 archived unresolved turns kept; the seams of 2.4 for W2.6 and W2.7; snapshot time and size and the session vat's slot capacity at 200 and 1,000 turns (`journal.snapshot`, `session.heap`, `archive.flat` at those lengths) | unit (archive and history in Node, with a fake port); integration `m2-history` (acceptance 9), `m2-archive-restart` (acceptance 16) |
| W2.6 turn completeness (group B) | `guest/session/{usage,prompt}.js`, `guest/lib/{journal-usage,system-prompt-base}.js`, hook lines; through the seams W2.5 builds in `turn.js` (`m2-interfaces.md` 2.4) | unknown tool / bad JSON texts (R4-43, R4-45), synthesized ids R4-42, round limit fallback R4-47, cancel tears down the stream (R4-7, R4-49) and records late results as ignored, usage five counts and context reading (R4-33, R4-83 "skipped if not read in time"), turn deadline setting (default off), fixed prompt composition (R4-26 parts 1-2, 7) | integration `m2-turns.test.js` |
| W2.7 delete, rollback, export | `guest/factory/{delete,export}.js`, `guest/session/export.js`, `scripts/export.mjs`; group B owner of `session.js`, the factory files and `durable.js` (`m2-interfaces.md` 2.2) | `deleteSession` publishes `row-removed` on the list feed (M1b acceptance 9 "delete", moved here) and marks `deleting`, fences the session (`deleteSelf`), releases the live tail's blobs (`blobPage` -> `releaseBlobs`) and the archive's (`releaseArchive`: segments, the blobs they name, the mirror), retires the session and exec vats (also a `lost` session's, D-17: this is the only way its disk is returned), completes after a restart (R4-9); failed creation rolls back including after a restart (R4-6); `exportState`/`importState` of factory and session records, archived turns read through `History` and re-sealed by the importing session (exec bindings are not exportable: documented loss); `SessionFactory.listBackends`/`listModels`, `Operator.getSecrets`, the M2 `HarnessSettings` | integration `m2-lifecycle.test.js` (acceptance 13, 14) |
| W2.8 archive store (adapter side; group A) | `AH/archive/`; group A owner of `AH/{index,attach,context-cache,projection,blobs,content}.js` (`m2-interfaces.md` 2.2) | the adapter side of the record archive (D-M2-1, `m2-interfaces.md` 4): `ArchivePort.seal` (fingerprint check, segment written and fsynced with a chained digest before the answer, a half-written segment never read), the per-session archive directory (manifest, `context.jsonl` persisted projection, `mirror.jsonl` of the kept records), validation against the vat's `ArchiveState` (orphans deleted), the context cache's sealed part (a restart reads one file and the tail, not a page per 512 records), `History` and `SealedText` (archived pages without a vat crank), `releaseArchive`, `BlobStore.release`, `archiveKeys` for M13; every M2 ops method in `attach.js` (handlers or `notBuilt`) | adapter tests over a fake session (seal, SIGKILL points by killing a child process mid-write, validation, rebuild equals incremental, history pages back to turn 1) |
| W2.9 integration | everything | the wiring of `m2-interfaces.md` 2.3, no `notBuilt` stub left, the fold of `m2Interfaces`; acceptance 7, 11 and 15; perf `throughput`, `restart.serving`, `hub.row`, `archive.flat` at 5,000 turns (fixtures by `importState`) | all M2 integration files, each alone |

**Order and parallelism inside M2.** W2.0 first, alone (done); then **group A** = W2.1a, W2.3, W2.4,
W2.8 in parallel; then **group B** = W2.1b, W2.2, W2.5, W2.6, W2.7 in parallel; then W2.9, which
owns every file. No two units of a group edit one file (`m2-interfaces.md` 2.2 names the owner of
every M1a/M1b file M2 edits); hook tables take lines from several units; an exo switches to its
M2 guard once, with stubs (`textOf.notBuilt`) for methods a later unit builds (`m2-interfaces.md`
1.3); a unit that needs a contract change makes it by the contract rule and reports it.

**Acceptance tests**
1. Against the fake server: an OpenRouter-format session streams more than one delta per reply.
2. A response with two tool calls, an unknown tool and bad JSON produce the R4-43 / R4-45 texts; the
   turn continues.
3. Round limit 2 with an always-tool script ends with the R4-47 text, status completed.
4. Queue at 100 refuses with the R4-53 text; edit/delete/send-now work; the same request id twice
   returns the same id with `duplicate: true` and one transcript entry.
5. With messages held `restart`, sending a new message or pressing send-now releases the hold and
   sends in FIFO order (R4-56).
6. Cancel mid-stream: the fake server sees the connection closed; the turn is `cancelled`; the
   turn's live stream ends with `end { status: 'cancelled' }` (the event contract,
   `m2-interfaces.md` decision 11; no separate `abort` event, PM ruling 1, J-9487).
7. Replace the API-key secret; the next turn uses it without restart; revoke it; the next turn fails
   with a recorded reason that contains no provider body. No secret value appears anywhere in the state
   directory.
8. 429 with Retry-After: retried per R4-74 only while nothing was delivered.
9. After 300 turns, history pages of 32 turns load back to turn 1, and every page message is at most
   `frameBytes`.
10. Two clients (two admin connections) see the same queue and transcript (P-25).
11. Change the factory's default model: an existing session keeps its model; a new one gets the new
    default (R4-22, R4-21).
12. A turn that failed and an outcome-unknown turn both appear in the next round's context with the
    "Tool outcome unknown" text; a never-dispatched turn does not (R4-32).
13. SIGKILL during `deleteSession`: after restart the delete completes and the session's vats and blobs
    are gone; SIGKILL during `createSession`: after restart nothing half-made is listed (R4-9, R4-6).
    Two list-feed subscribers see the delete (`row-removed`) within 500 ms (M1b acceptance 9's
    delete part; `m1b-live.test.js` keeps it as a known failure until then).
14. `exportState` then `importState` into a fresh state directory yields the same sessions, history,
    queues and presets.
15. **A 5,000-turn session behaves like a 200-turn one** (D-M2-1; `m2-interfaces.md` 4): per-turn
    wall time, `turn.start`, the session vat's snapshot size, its slot capacity and its hub row
    bytes are each within 1.25 x of the 200-turn session's (the scripted backend with
    `logContext: false`); after a restart the next turn's context is rebuilt in at most 5 s and
    the provider receives the same context as before (`turnDigests`); `history.page` is at most
    300 ms; history pages load from the newest turn back to turn 1 across archived and kept turns
    with every turn exactly once. The same at 1,000 turns.
    **Procedure (fixed windows, imported templates; process.md 3):** each length (200, 1,000,
    5,000) is a copy of a cached template of that many plain turns written by
    `writeSyntheticExport` and loaded with `importState` (which seals as a grown session does),
    built once per worker and bundle change by `node perf/_long-template.mjs history` (each
    template its own boxed step). At each length one 60 s window of turns gives the per-turn
    median and p99, `turn.start`, snapshot, seal and hub rows (`perf/history.perf.mjs`), then the
    session vat's heap after a clean stop; history pages are read for 15 s each (newest and
    archived), the walk goes from the newest turn to turn 1, and the context is rebuilt after a
    clean restart (`perf/history.restart.perf.mjs`). No turn count is run to reach a length, and
    each file stays inside its 10-minute box.
16. **SIGKILL during a seal** (`m2-interfaces.md` 4.5): a supervisor SIGKILL after the seal crank,
    while the segment file is written (before its rename), after the adapter's answer, and after
    the answer crank; after each restart history from the newest turn back to turn 1 shows every
    turn exactly once, the provider's next request carries the same context as before, no
    half-written segment is read or left, and the next seal succeeds.

**Perf checks**
| check | budget |
|---|---|
| `queue.enqueue` while a turn runs, round trip | <= 150 ms |
| `history.page` 32 turns on a 1,000-turn session | <= 300 ms (M1b: 598-666 ms for 26 turns of 7 records, J-0370; after CORE-11 869 ms at 1,000 turns, J-9383; needs the record bound of W2.5 or C-5; with the archive a session keeps at most 159 settled turns, so the page crank no longer grows with session length, `m2-interfaces.md` 4.13) |
| `context.rebuild` 1,000-turn session after restart (M1b row, carried) | <= 5 s (M1b: see its outcome table; after CORE-11 22.1 s, 14 page cranks of about 1.55 s, linear in turns, J-9383, J-9387; J-0322 option (b), the adapter's cache persisted next to the blobs, removes the page cranks from the restart path: built by W2.8 as `context.jsonl` and the mirror, `m2-interfaces.md` 4.7, 4.8) |
| `hub.row` bytes per hub commit of a session's row at 1,000 / 5,000 turns | recorded; decides J-9335 (a) in M2 or M3 (a row carries one entry per handle the session holds, and the log store rewrites the whole row per change, J-9386) |
| `session.heap` session vat slot capacity at 1,000 / 10,000 / 30,000 turns | recorded against the slot ceiling (4,000,000); the heaviest crank of a session at that size must still fit |
| `journal.snapshot` session vat at 1,000 / 10,000 / 30,000 turns | <= 500 ms / <= 1 s / recorded |
| `checkpoint.stall` turn latency while a busy session vat snapshots | p99 <= 1 s |
| `provider.overhead` fake-server first byte to subscriber delta | <= 5 ms per delta; 0 deliveries |
| `secrets.read` per round | <= 1 ms, in-process |
| `restart.serving` 50 checkpointed sessions x 300 turns (built by `importState`), no vat crashing | <= 15 s; 0 idle vats woken (gate) (M0: 5.3 s with 50 sleeping spares) |
| `throughput` deliveries per second at saturation (20 sessions) | recorded; journal if < 50/s |
| `disk.session` idle session after 300 turns; after delete | <= 25 MB plus blobs; returned on delete |
| too-big probes: 200 k-char submission accepted through the Composer, 200 k + 1 refused; a 100 KiB string sent straight to a vat method through the admin path is refused by the client library before sending | no halt |
| `archive.flat.turn` wall time per turn (the median over one 60 s window of turns on a copy of the imported template of that length, acceptance 15's procedure), 5,000 against 200 turns | <= 1.25 x (D-M2-1) |
| `archive.flat.turnStart` `turn.start` median, 5,000 against 200 turns | <= 1.25 x and <= 350 ms |
| `archive.flat.snapshot` session vat snapshot bytes and ms, 5,000 against 200 turns | <= 1.25 x (expected about 20 MB, `m2-interfaces.md` 4.13) |
| `archive.flat.slots` session vat slot capacity, 5,000 against 200 turns | <= 1.25 x (expected about 16 % of 4,000,000) |
| `archive.flat.hubRow` the session's hub row bytes and entries, 5,000 against 200 turns | <= 1.25 x (expected about 290 entries, 15 KB) |
| (the `archive.flat.*` rows) | all measured by `perf/history.perf.mjs` on the same imported templates and windows as acceptance 15 (its procedure); the snapshot, slot and hub-row rows are read after the window and a clean stop, not after a turn count |
| `context.rebuild` at 1,000 and 5,000 turns (archive) | <= 5 s each (D-M2-1) |
| `history.page` at 1,000 and 5,000 turns: the newest page (vat) and an archived page (`History`) | <= 300 ms each (D-M2-1) |
| `archive.seal` per seal: session crank ms (S, Z), adapter ms, bytes written, fsyncs | recorded |
| `archive.disk` bytes per archived turn (segments, `context.jsonl`) | recorded |

**Fit risk:** good for queue/records (heap Maps replace 1,320 lines of pet-name storage; atomic claim
removes the `interrupted` window); awkward for time-window checks (time stamped by the gateway).

**Deferred:** subscription backends (M4), compaction (M8; the archive's compaction hook is specified,
`m2-interfaces.md` 4.12), presets (M5), UI (M3). The record archive is **built in M2** (D-M2-1: W2.5
vat side, W2.8 adapter side), not in M13.

**Outcome (M2 close-out, M2-CLOSE; replaces W2.9's table, whose numbers stay in J-9400..J-9414).**
Regression run at `d7fce8e46c` in shared slots (load 2.3-5, three template builds beside it).
Recorded perf pass at `6628dbf8a1` (the tree differed only in `README.md` and `designs/process.md`,
so rows say `-dirty`; `perf/queue.perf.mjs` rerun after the fix of J-9495), every file one after
another in exclusive mode, 2026-11-18 10:48-11:58 UTC, load 1.1-2.4. Release worker
`367e78ad...`, crank budget 50 M, slot ceiling 4,000,000, allocation collection schedule, log hub
store, Node 22.23.4, Apple M3 Max. Verdicts use the 1.25 x rule: "miss" is over the budget,
"**fail**" over 1.25 x; misses are recorded, never re-based. JSON lines and readings are in
J-9495..J-9499.

| item | proving test (this run) | result | verdict |
|---|---|---|---|
| 1 more than one delta per reply | `m2-providers` acceptance 1 | 5 deltas each for OpenRouter and Anthropic; turn 481 / 516 ms | pass |
| 2 R4-43 / R4-45 texts, synthesized id, the turn continues | `m2-turns` "2: tool texts ..." | pass; a 100-round turn at 278 ms a round, flat | pass |
| 3 round limit ends with the R4-47 text, completed | Node at limit 2 (unit lane); `m2-turns` "3: the round rate ..." in a vat | Node: pass at the limit. Vat: 5.3 rounds/s over a 60 s window (318 rounds, median 240 ms), so a 1,024-round turn takes about 193 s (253 s at the last-20 rate): derived, not run | pass (limit proved in Node; vat rate within the box) |
| 4 queue at 100 refused, edit / delete / send-now, duplicate id | `m2-queue` "4 and 10" | pass; `queue.enqueue.e2e` median 125 ms over 0-99 waiting, 72 ms shallow | pass |
| 5 held `restart`: a new message or send-now releases, FIFO | `m2-queue` "5" | pass | pass |
| 6 cancel mid-stream: the server sees the close; `cancelled`; stream ends `end { status: 'cancelled' }` | `m2-providers` acceptance 6 | close seen 103 ms after `cancel` | pass |
| 7 replace the key; revoke; no value in the state dir | `m2-secrets` acceptance 7 | pass; grep of 48 files / 207 MB for every encoding: 0 hits, controls found | pass |
| 8 429 Retry-After retried only while nothing was delivered | `m2-providers` acceptance 8 | 1.52 s turn with one 429 | pass |
| 9 300 turns, pages back to turn 1, every page <= `frameBytes` | `m2-history` "9" | 21 pages, largest 15,601 B, 5 segments, no `.part` | pass |
| 10 two clients see the same queue and transcript | `m2-queue` "4 and 10" | pass | pass |
| 11 default model change reaches new sessions only | `m2-catalog` acceptance 11 | pass; one catalogue read | pass |
| 12 failed and outcome-unknown turns in the next context; never-dispatched not | `m2-turns` "12" | pass | pass |
| 13 SIGKILL during delete and create; `row-removed` to two viewers <= 500 ms | `m2-lifecycle` (both tests) | row removed 5 ms after the answer; delete killed at 0 ms: after restart the doomed archive directory and blobs are gone (82 bytes left are the kept session's directory); create killed 320 ms after the call: only `s2` listed | pass |
| 14 export, import into fresh state: same sessions, history, queues | `m2-lifecycle-export` "14" | 1,370 records; export 18.5 s, import 32.5 s; presets are M5 | pass |
| 15 a 5,000-turn session behaves like a 200-turn one; the same at 1,000 | `perf/history.perf.mjs`, `perf/history.restart.perf.mjs` (exclusive) | 5,000 / 200: turn 1.02 x, `turn.start` 1.07 x (264 ms), snapshot bytes 1.04 x, ms 0.95 x, slots 1.04 x, hub row 1.00 x (entries 0.98 x); rebuild 253 ms, same context; newest page 252 ms, archived 33 ms; walk 5,003 turns once each, 358 pages, none over `frameBytes`. 1,000 / 200: every ratio 0.96-1.04 x **except hub row characters 1.39 x** (13,010 against 9,374; entries 0.995 x; the 1,000-turn read caught one answer owed, the 200-turn read none); rebuild 219 ms; walk 1,003 once each | pass at 5,000; **fail** at 1,000 on one ratio (row characters), open |
| 16 SIGKILL during a seal at S, A2, A3, Z | `m2-archive-restart` (S, A3), `m2-archive-restart-2` (A2, Z) | pass, one run each here (M2-R3: 20 kills at the four points before the M2-FIX archive change; not repeated after it) | pass |
| M1a and M1b files (regression) | all 13 files | all pass; `m1b-live` 9 passed under load this time | pass |
| Unit and adapter lanes | `corepack yarn test` | 727 passed, 0 failed, 59 skipped, 66 s | pass |
| Regression run wall time (20 min) | unit lane + `test:integration --jobs 4` | 66 s + 1,040 s (25 files, longest held 266 s); per file in `process.md` 3.1 | pass |

M2 perf table (exclusive pass unless stated):

| check (budget) | result | verdict |
|---|---|---|
| `queue.enqueue` round trip while a turn runs (150 ms) | e2e in a vat (`m2-queue`, shared): median 125 ms over 0-99 waiting, 72 ms shallow; in Node 0.13-0.19 ms | pass |
| `history.page` 32 turns at 1,000 (300 ms) | newest page 244 ms (vat), archived 35 ms; at 5,000: 252 / 33 ms; `archive.perf` at 200 grown: 301 ms (1.00 x) | pass |
| `context.rebuild` 1,000 / 5,000 (5 s) | 219 / 253 ms, `sameContext`; grown 200: 435 ms; crank 1,038: 106 ms | pass |
| `hub.row` 1,000 / 5,000 | 13,010 / 9,345 characters, 192 / 190 entries (at 200: 9,374, 193) | recorded |
| `session.heap` 1,000 / 10,000 / 30,000 (recorded) | 790,272 / 792,064 slots at 1,000 / 5,000 (20 % of 4,000,000); 10,000 and 30,000 projected 794,304 / 803,264 (`projected: true`, slope from 1,000 to 5,000) | recorded (flat) |
| `journal.snapshot` 1,000 / 10,000 / 30,000 (500 ms / 1 s / recorded) | 245 ms (31.9 MB) / projected 242 ms / projected 234 ms (32.7 MB); measured at 5,000: 244 ms | pass / pass (projected) / recorded |
| `checkpoint.stall` p99 (1 s) | p99 of per-turn wall in 60 s windows on imported sessions: 1,050 / 951 / 1,025 ms at 200 / 1,000 / 5,000 (`history`), 1,007 / 959 ms (`journal`); on the session grown by turns (`archive`, 200): **1,397 ms**; the slow turns are the snapshot turns (C-24) | miss (1.05 x) on imported sessions; **fail** (1.40 x) on the grown one |
| `provider.overhead` (5 ms; 0 deliveries) | 0.64 ms OpenRouter, 0.59 ms Anthropic, 1,800 deltas each; 0 deliveries | pass |
| `secrets.read` (1 ms) | not re-measured here (no perf file carries it; W2.3: 0.018-0.025 ms) | not run |
| `restart.serving` 50 x 300 by import (15 s; 0 woken) | 3.5 / 3.9 / 4.2 s, 0 woken, 0 crashes | pass |
| `throughput` 20 sessions (journal if < 50/s) | 41.2 deliveries/s over a 60 s window (2,582 deliveries, 7 turns/s, turn p99 55 s: 14 wakes in the window) | recorded, under 50/s (J-9497) |
| `disk.session` 300 turns (25 MB plus blobs) / after delete | 41.7 MB (41.1 MB the vat snapshot of an imported session, C-22) / all returned (`m2-lifecycle`, shared) | **fail** / pass |
| too-big probes | 200,000 characters accepted (turn 1.06 s), 200,001 refused by the Composer; a 100 KiB inline string refused by the vat's guard after delivery | pass / known failure (PM ruling 4, C-25) |
| `archive.flat.turn` 5,000 / 1,000 (1.25 x) | 1.02 / 1.01 x | pass |
| `archive.flat.turnStart` (1.25 x and 350 ms) | 1.07 x (264 ms) / 1.02 x (251 ms) | pass |
| `archive.flat.snapshot` bytes and ms | 1.04 / 0.95 x at 5,000; 1.03 / 0.96 x at 1,000 | pass |
| `archive.flat.slots` | 1.04 x at both | pass |
| `archive.flat.hubRow` characters and entries | 1.00 / 0.98 x at 5,000; **1.39** / 1.00 x at 1,000 (see 15) | pass at 5,000; **fail** at 1,000 (characters) |
| `archive.seal` | seal turns 747 ms against 587 ms for others at 5,000 (3 seals in the window); 648 / 663 ms at 200 grown | recorded |
| `archive.disk` | 1,745 B of segment and 1,300 B of `context.jsonl` per archived turn | recorded |
| `session.program` (200 KB) | 186,998 bytes | pass (13.0 KB left) |
| import rate (W2.7, recorded) | 7.1 turns/s of tool turns over 60 s (`import.rate`); 300-turn walk back, 42 pages | recorded (C-22) |

M0, M1a and M1b rows in the same pass (their budgets; the M1b and M1a rows were carried):

| check (budget) | result | verdict |
|---|---|---|
| `frames.inbound` / `.outbound` at 24,576 (floor + 300 ms = 321) | 313 / 38 ms (floor 21 ms) | pass |
| `vat.evaluateProgram` 150 k (2 s) | 2,120 ms | miss (1.06 x, C-5) |
| `loop.runaway` (1 s) | 222 ms | pass |
| install of a 300 k factory bundle (30 s) / `install.factory` (15 s) | 8.6 s (mixed text 10.9 s) / 5.8 s | pass |
| `turn.start` (350 ms; <= 3 deliveries) | median 108 ms, p99 364 ms, 111 samples; 2 deliveries | pass |
| `turn.delta` (5 ms; 0 deliveries) / `turn.round` (3) / lease (1) | 0.21 ms, 0 / 3 / 1 | pass |
| `session.createCold` (6 s) | 5.53 s (6 samples) | pass |
| `restart.serving` 10 + 1 (10 s; 1 woken) | median 4.86 s, 13 runs | pass |
| `restart.crashingSession` (target 15 s, recorded; C-8, C-9) | 18.2 s (5 runs) | miss (1.21 x) |
| `crash.restart.bound5` (15 s) / `.bound2` / healthy | 65.9 s / 3.4 s / 2.9 s | **fail** by design (C-8, C-9) / pass / pass |
| `exec.trivial` (250 ms) | median 56 ms (52 samples, 30 s): the 9 s seen under load by M2-P2 was load, not a regression | pass |
| `exec.first` (750 ms) / `exec.sends` answered (8 s) / `exec.retire` (15 MB) | 299 ms / 1.31 s / 25.5 MB | pass |
| `session.create` with the pool (750 ms) / cold (6 s) | 1,097 ms (8 samples, 45 s) / 5.71 s | **fail** (1.46 x) / pass |
| `concurrency.10` turn start (2 x single = 222 ms) / crank p95 (200 ms) / row push (500 ms) | 701 ms (3.2 x single) / 500 ms / 179 ms | **fail** / **fail** / pass (M1b: 6.5 x / 500 / 189) |
| `hub.growth` 1,000 turns / 20 sessions (2 MB; 1.25 x fresh ms) | 0.77 MB / 1.37 MB, pass; 50 sessions projected 3.26 MB, 1.37 x (`projected: true`) | pass / **fail** (projected) |
| `hub.gcBurst` (recorded) / `gc.burst.turnStart` (350 ms) / `hub.gcBurst.turnStart` | 4.2 ms per incoming GC frame / 104 ms (p99 1.4 s) / 106 ms | recorded / pass / pass |
| `crank.turn.start` early / mid / late (350 ms) | 224 / 126 / 236 ms | pass |
| `crank.history.page` (300 ms) | 269 ms; late 247 ms | pass |
| `gc.restart` (10 s) | 3.1-3.4 s, 12 runs | pass |

M2 is **done with open items** (top of this section). Fit, from this pass (J-9498): the archive
holds: a 5,000-turn session costs what a 200-turn one does in every vat-side measure; on an idle
machine `checkpoint.stall` is at its budget's edge on imported sessions and over it on a grown
one, both from the engine's cadence snapshot (C-24); what still grows or misses is the hub
(`concurrency.10`, `hub.growth` toward 50 sessions: C-2's rest, CC-051/CC-060), the pool take
(`session.create.pool`), a carried imported-session high-water (`disk.session`, C-22) and the
inline too-big refusal (C-25).

---

## M3. Chat UI and gateway

**Files after the review's fold (CL-CLOSE, 2026-11-18).** `AH/gateway/contract-m3.js` is
`AH/gateway/protocol.js` (exports unchanged, `33e726b912`). The gateway's vocabulary reads the
explicit list `guest/lib/vocabulary-tables.js`, not the glob `interfaces-m*.js` (`b621c04535`).
`guest/lib/interfaces-m3.js` keeps its name until the step-4 reinstall. Rename map:
`arch-review/fold-plan.md` section 6.

**Status: done with open items** (X-CLOSE, 2026-11-18, after the cross-lane integration of M3, M4
and M5; the outcome table at the end of this section). Every acceptance item passes in this run.
Open:

- **closed** (was major, test process): `perf/gateway-session.perf.mjs` exited 124 in the
  recorded pass (J-10061). The `ui.restartReady.*` rows now live in
  `perf/gateway-restart.perf.mjs`; the two files hold 375 s and 311 s in exclusive mode (K2).
  The serve time across SIGKILL restarts grows with the journal replay (52 -> 1,010 owed frames
  over 20 kills, 3.9 -> 8.5 s, about 4.7 ms per frame); CC-026 bounds it per worker (C-3).
- **fail** (perf, carried): `ui.hubGrowth` session row exports 1.91 x the start (budget 1.25 x)
  while the hub stays at 1.15 MB; the request is CC-051 + CC-060, one hub row-format change
  (`CORE-CHANGES.md`, requested, not built).
- **minor**: the bridge's answers table (bounded at 4,096 since XA) holds about 1,000 questions per
  busy minute in the Node client (`gcImports` drops wait for V8 GC; peak 1,443 in this pass's
  `ui.call` window), so a page that goes about 4 minutes without a major GC can see evictions;
  Chrome's drop cadence is not measured. Close code 4008 is shared by the exports cap and an
  answers table of only unsettled answers.
- **minor**: a gateway-exported promise (`p-n`) that later resolves to the page's secret writer
  is not checked by rule `gatewayObject` (the writer is only ever handed out as an object).
- **minor**: the browser tests read refusals from a 16 KB stderr tail polled every 200 ms; per-rule
  counts in the bridge's `stats()` would be exact. Every vat presence reaches a page with the
  alleged interface `Remote Object N`.
- **minor** (carried, J-9605): a long reply watched live needs a reload to show in full.
- **contract text owed** (rule: a contract change updates the design in the same series):
  `m3-interfaces.md` 4.4 rule 2 and section 14 (`gatewayTexts.gatewayObject`, rule
  `gatewayObject`), 6.1 `GatewayContext.secretWriter()` (now the gateway-local writer in
  `extras`, not `SecretsAdmin.openWriter()`), acceptance 16 wording, the section 6 M4 row, the
  W3.7 row and the H4 seam text.

**Goal.** The daily surface: open the chat page from a desktop or phone browser, sign in by the
fragment secret, create sessions, chat with streaming, reload and reconnect without losing anything.
The contract is `m3-interfaces.md` (W3.0); its decisions D-M3-1..D-M3-6 and section numbers are
cited below.

- **P:** P-01, P-02, P-04 (preset/backend/model; the internet toggle is M7's field), P-22, P-23,
  P-24, P-27 (status bar), P-48; the browser half of P-03, P-09, P-10, P-11, P-12, P-14, P-25.
- **R:** R2-1, R2-12 (`/ws` only, decision 1), R2-14, R4-62, R6-1, R6-8..R6-14, R6-35..R6-39,
  R6-40 (composer, without @-mention), R6-41..R6-46, R6-49, R6-51, R6-52, R6-59, R6-61, R6-62,
  R6-75, R6-76, R7-2, R7-11, R7-13, R7-17, R7-46..R7-49, R8-39; fixes W-1, W-8, W-15.
- **Depends on:** M2 (built; `m3-interfaces.md` 5 lists every M2 object and method used and the
  assumptions A-1..A-11). Parallel with M4 and M5. **W3.0 is merged before M4 or M5 start a UI
  unit**; they add UI features, gateway extensions and browser-sendable record keys by new files
  only (`m3-interfaces.md` 6, 11 "Not hotspots"). M4's and M5's UI component tests use M3's
  `test/unit/_m3-fake-powers.js` once M3's group A is merged; their browser acceptance (M4 #14,
  M5 #15) uses `test/browser/_harness.mjs` `startBrowserGateway` and runs after M3 is merged. Merge
  order M3, M4, M5.
- **Owns (new files):** `AH/gateway/` (server, static, csp, signin, limiter, bridge, guard,
  vocabulary, powers, extensions loader, index, `contract-m3.js`; `extensions/` is a directory
  others add files to), `H/resources/agent-host/durable-gateway.js`,
  `H/guest/lib/interfaces-m3.js`, `H/ui/` (`build.mjs`, `index.html`,
  `src/{main.js,features.js,net,controller,shell,styles,sessions,conversation}`),
  `H/scripts/gateway.mjs`, `H/test/**/m3-*`, `H/test/unit/_m3-fake-powers.js`,
  `H/test/browser/_harness.mjs` and `H/test/browser/m3-*.mjs` (M4 and M5 own their own
  `m4-*`/`m5-*` files there), `H/perf/{ui,gateway,gateway-session}.perf.mjs`,
  `H/perf/_m3-client.mjs`. **Shared edits** (merge hotspots with their exact seams,
  `m3-interfaces.md` 11): none in `guest/lib/interfaces.js` (H1 dropped; session and exec bundles
  grow 0 bytes); `resources/agent-host/durable.js` (H2: two imports, `const gateway =
  makeGatewayManager({ manager })`, the facet guard `withGatewayAdmin(m2Interfaces.AgentHostAdmin)`
  with `gateway: () => gateway.admin` as its last method), `AH/attach.js` (H3: `bindings` option
  of `makeAttach`), `AH/index.js` (H4: two imports, one `makeGatewayService` statement with
  `secretWriter` before `makeAttach`, one `bindings` property, `gateway.attached()` in `onSink`),
  `scripts/provision-steps.js` (H5: one appended step, gated on `options.gateway`), `package.json`
  (H6, PM-merged). Journal J-0510..J-0529 (build units J-0520..J-0529).

**Design in brief.** The gateway is part of the agent-host adapter and a second manager-kit
registration (`gateway`) of its native resource, restored at every start (D-M3-3). A page signs in
over a WebSocket with `fetch(secret)` and receives `GatewayPowers`: the factory's `Operator`,
passed through, and this incarnation's `Live`, `Content`, `Composer`, `History`. From then on it
calls the daemon's own objects through a pass-through CapTP bridge (D-M3-1) that checks every
call on its encoded form before CapTP decodes it: frame bytes, record keys against a vocabulary
derived from the guards, depth, page-made objects, calls in flight (D-M3-2). The sign-in secret
lives in an encrypted adapter file and never enters a vat or the hub.

**Work units** (after W3.0 and M2's merge: group A in parallel, then group B in parallel, then
W3.8 alone; files, entry points and estimates in `m3-interfaces.md` 10, 17)

| id | group | files | behaviour | tests | supervisor |
|---|---|---|---|---|---|
| W3.0 contract | - | `designs/m3-interfaces.md`, `guest/lib/interfaces-m3.js`, `AH/gateway/contract-m3.js` | **Done** (J-0510..J-0519), with the M3/M4/M5 cross-check applied (`m3-interfaces.md` "Cross-check"). Objects, protocol, seams, restart and security, units, acceptance, perf | - | no |
| W3.1 HTTP server, sign-in, limiter | A | `AH/gateway/{server,static,csp,signin,limiter}.js` | loopback listener; shell for every non-upgrade GET, hashed assets, CSP, 400 on query configuration; `/ws` upgrade with the Origin check and connection caps; sign-in secret in `signin.enc` (wrapping key, rotation atomic); +1,000 ms per failure per client address with trusted-proxy forwarding, forget after 10 s, global ceiling | adapter tests (fake clock, child-process kill mid-write) | no |
| W3.2 CapTP bridge and guards | A | `AH/gateway/{bridge,guard,vocabulary,powers,extensions}.js`, `AH/gateway/extensions/README.md`, the Node CapTP test client | per-connection captp; bootstrap `fetch` -> `GatewayPowers`; pass-through of daemon objects; pre-dispatch frame, key, depth, page-object and in-flight guards; key vocabulary from every `interfaces-m*.js` `vocabularyShapes()` (shapes and interface argument patterns; a file without it logged and skipped); export cap; per-connection `Live` facade; extension loader | adapter tests over an in-memory socket pair | no |
| W3.3 manager side and seams | A | `resources/agent-host/durable-gateway.js`; seams H2 (`durable.js`), H3 (`AH/attach.js`) | `AgentHostAdmin.gateway()` -> `GatewayAdmin` (`serve`, `status`, `rotateSignIn`, `stop`) over a kit registration carrying the operator, added to the manager facet's guard by `withGatewayAdmin`; `makeAttach` `bindings` | unit: the M3 guards (contract samples), `withGatewayAdmin` methods = M2's plus `gateway` (pins `payload.methodGuards`, CC-072), `GatewayAdmin` with a fake kit, attach dispatch; bundle sizes (session and exec growth 0 bytes) | no |
| W3.4 UI foundation | A | `ui/build.mjs`, `ui/index.html`, `ui/src/{main.js,features.js,net,controller,shell,styles}`, `test/unit/_m3-fake-powers.js` | esbuild bundle (SES, captp, Preact) into `AH/gateway/assets/`; fragment parsing; connection with the R6-14 schedule and "Server starting..."; controller (sessions, presets with availability, live view, records kept as received, exactly-once drafts with Web Locks sent and resent through the `composer.addon` chain, rebuild and re-attach); shell, overlay, drawer, status bar, feature slots (a `feature.js` exports one feature or an array) | unit with happy-dom | no |
| W3.5 sessions UI | B | `ui/src/sessions/` | sidebar (circles, two lines, live), rename and delete, new-session dialog (presets from `describe()`, unavailable ones disabled with their reason; backends; catalogue with Factory default; R6-39) | unit with fake powers | no |
| W3.6 conversation UI | B | `ui/src/conversation/` | streaming bubble, thinking row, tool groups, exec highlight, raw view, links, status rows, recovery panel and acknowledgement, queue rows, Stop, blocked sending, send-error line, usage bar, large content; `composer.addon` props (input, caret, `replaceRange`) and `message.renderer` props (`{ context, turn, record }`) | unit with fake powers | no |
| W3.7 gateway wiring | B | `AH/gateway/index.js`, seams H4-H5, `scripts/gateway.mjs`, `test/integration/{_m3-gateway,m3-gateway,m3-sessions}*` | `makeGatewayService` composes W3.1-W3.2 for the kit binding, with `GatewayContext.secretWriter` for extensions; provisioning step; operator script (serve, status, rotate, stop, url) | integration: acceptance 1-3, 10-14 (protocol), 16; kill points K1, K2 | **yes** |
| W3.8 integration | alone | `test/browser/_harness.mjs`, `test/browser/m3-*.mjs`, `test/integration/m3-reconnect.test.js`, `perf/{ui,gateway,gateway-session}.perf.mjs`, `perf/_m3-client.mjs` | `startBrowserGateway({ template, provision? }) -> { page, url, client, close() }` for M3, M4 and M5 browser files; browser acceptance, kill points K3-K5, every perf row; checks `m3-interfaces.md` 5 against M2 as merged | browser (Playwright, `THIX_HARNESS_BROWSER=1`) and integration | **yes** |

**Acceptance tests** (each under 5 minutes; `m3-interfaces.md` 12 says which file and whether
through the Node client or the browser)
1. Any non-upgrade path returns the shell with the CSP header; assets carry their type and the
   immutable cache header; a `/ws` upgrade with the configured Origin succeeds, another Origin is
   refused (403), another path 404; configuration in the query string is refused (400, and the
   page says so).
2. Fragment secret yields the powers; a wrong one is refused and an attempt within 1,000 ms gets
   the R7-49 text; through a trusted proxy, failures from one forwarded address do not delay
   another; an untrusted `X-Forwarded-For` is ignored; the global ceiling trips; the secret never
   appears in an HTTP request (network log).
3. Session list updates live across two clients within 500 ms; rename and delete propagate; rows
   show the R6-36 fields.
4. Kill the WS: "Reconnecting…" overlay, retries on the R6-14 schedule; the running turn
   reattaches and keeps streaming. With the gateway not listening for 60 s (daemon stopped), the
   overlay says "Server starting..." and the page reconnects by itself within 30 s of the
   gateway's return.
5. Close the tab mid-turn, reopen: the turn finished on the server and is in the transcript.
   Reload mid-turn: the page re-attaches to the running turn (R4-62).
6. Drop the connection between send and receipt; resend from the saved draft creates no
   duplicate (kill points K3, K4).
7. SIGKILL the daemon mid-turn with two pages open: both show the interrupted or outcome-unknown
   row; Details opens "Turn journal and recovery"; "Record acknowledgement" works while idle; no
   provider request or tool run happened twice (K5).
8. Tool calls fold into "Thought for ..." groups; `exec` shows highlighted source; `</>` raw
   view; "Load earlier messages" pages a 300-turn imported session back to turn 1 across the
   archive; a 1 MiB reply renders fully.
9. At 640 px the sidebar becomes a drawer; at 641 px it does not.
10. A call carrying a 100 KiB string to a session method, one with a record of 2,000 invented
    keys, one passing a page-made object, and a `createSession` whose `networkPolicy` is a record
    of invented keys are each refused by the gateway; the vats receive nothing and keep working.
11. After a SIGKILL the gateway serves again on the same port with the same secret (K1);
    `rotateSignIn` closes open pages, the old secret fails and the new one works; a SIGKILL during
    the rotation leaves exactly one valid secret (K2).
12. Queue during a turn: Send now, Edit and Delete work; after a restart the queue is held with
    its hold line and Send now releases it in FIFO order.
13. New-session dialog: presets, backends, catalogue with "Factory default" and the unavailable
    text; the session runs on the chosen model.
14. The status bar shows `↑in ↓out · ctx N%` equal to `getUsage()`.
15. ■ Stop cancels the running turn; closing the page leaves it running to completion.
16. A fixture gateway extension and UI feature add a service, a route, a CSP source and a panel
    with no M3 file edited; the extension's `context.secretWriter()` after attach is the object
    `SecretsAdmin.openWriter()` answers; a throwing extension file is skipped.

**Perf checks** (each a fixed window, 60 s per point unless stated, median and p95/p99 with the
sample count; no row counts runs; each file under 10 minutes, a file reports a window it cannot
finish by 9 min 30 s as not measured; fixtures by import, the cached `m3-300` template; with the
M2 archive a 300-turn session stands for any length, J-0461). Files (`m3-interfaces.md` 13):
`perf/gateway.perf.mjs` (about 6 min), `perf/gateway-session.perf.mjs` (about 9 min with the
template cached), `perf/ui.perf.mjs` (browser, about 7 min).
| check | file | window | budget |
|---|---|---|---|
| `gateway.fetch` sign-in to powers | gateway | 60 s | <= 50 ms; 0 vat deliveries |
| `gateway.guard` pre-dispatch check of a `frameBytes` call | gateway | 60 s | <= 2 ms per call |
| `ui.call` client `E(session).listPending()` | gateway | 60 s | <= 150 ms |
| `ui.submit` `Composer.submit` while a turn runs | gateway | 60 s | <= 150 ms |
| `ui.deltaFanout` 5 clients, adapter chunk to each WS frame | gateway | 60 s | <= 5 ms per delta; 0 vat deliveries per delta |
| too-big probes: 100 KiB call, 2,000 fresh keys, depth 33, 33 calls in flight, 4,097 exports | gateway | one probe each (correctness) | refused; no halt; 0 deliveries to the target |
| `ui.snapshot` `watch()` of the 300-turn session | gateway-session | 60 s | <= 300 ms; message <= `frameBytes` |
| `ui.history.newest` (vat) and `ui.history.archived` (`History`) page through the gateway | gateway-session | 60 s each | <= 300 ms each |
| `ui.reconnect` socket open to rebuilt state | gateway-session | 60 s | <= 1 s |
| `ui.restartReady` serving to the gateway answering `fetch` | gateway-session | restarts repeated over 150 s per mode (clean, SIGKILL), sample count reported | <= 2 s |
| `ui.coldLoad` navigation to sessions listed (browser), bundle size | ui | 60 s | <= 1.5 s; bundle <= 600 KB gz |
| `ui.hubGrowth` hub state and the session's hub row while a browser reloads every 10 s and turns run | ui | 5 min | hub <= 2 MB; row entries back to <= 1.25 x the start after the viewer closes |

Test files take about 8 minutes on four slots; the three perf files about 22 minutes in exclusive
mode after them (owner decision 12 in `m3-interfaces.md` 16: whether the 20-minute bound covers
perf).

**Fit risk:** good. CapTP-through-adapter is the mail-UI bridge pattern
(`pkg/src/platform/node/mail-ui-server.js`) with object references instead of tokens, and with
pass-through (D-M3-1) the gateway needs no per-interface tables. Awkward: guards must run in Node
before decoding (D-M3-2), and every presence a page holds is a hub row entry of its vat until the
page drops it and that vat next collects (J-9386, J-9392).

**Deferred:** @-mention (M5), preset editor (M5), widgets (M12), secrets view and account chips
(M4), Network chip and internet toggle (M7), emergency stop (M6), voice and `/audio` (M11), Home,
spaces and the admin CLI (M12), assistant launch R6-60 (M11).

**Outcome (X-CLOSE, cross-lane close-out; replaces W3.8's lane table, whose numbers stay in
J-9600..J-9609).** Regression run at `717e26789f` (lane `endo-thix-int`, M3, M4 and M5 merged),
shared slots, load 2.2-4.8; browser files in the same run (headless Chromium from Playwright's
cache). Recorded perf pass at `404e60ea3a`, every file one after another in exclusive mode,
2026-11-18 16:12-17:19 UTC, load 1.0-2.8 (rows after the first three say `-dirty`: only this
file was being edited). Release worker `367e78ad...`, crank budget 50 M, slot ceiling 4,000,000.
Verdicts use the 1.25 x rule ("miss" over the budget, "**fail**" over 1.25 x); misses are recorded,
never re-based. Rows and readings: J-10060..J-10064.

| item | proving test (this run) | result | verdict |
|---|---|---|---|
| 1 shell, CSP, assets, Origin, 404, query refused | `m3-gateway` (client), `test/browser/m3-ui` (page part) | pass; held 114 s / 110 s | pass |
| 2 fragment secret, limiter, proxy, ceiling, secret in no request | `m3-gateway`, `m3-ui` (network log) | pass | pass |
| 3 list live across two clients, rename, delete | `m3-sessions` | pass; held 118 s | pass |
| 4 reconnect overlay, R6-14 schedule, re-attach; 60 s down | `m3-reconnect` (protocol), `m3-ui` (socket), `m3-ui-restart` (60 s down) | pass; held 159 s / 202 s | pass |
| 5 close and reopen mid-turn; reload re-attaches | `m3-reconnect`, `m3-ui` | pass | pass |
| 6 resend from the saved draft, no duplicate (K3, K4) | `m3-reconnect`, `m3-ui` | pass | pass |
| 7 SIGKILL mid-turn with two pages (K5) | `m3-reconnect`, `m3-ui-restart` | pass | pass |
| 8 tool groups, exec highlight, raw view, 300-turn paging, 1 MiB reply | `m3-ui-history` (`m3-300` template) | pass; held 110 s | pass (J-9605's live-watch gap open, minor) |
| 9 drawer at 640 px, none at 641 px | `m3-ui` | pass | pass |
| 10 100 KiB, 2,000 keys, page-made object, invented `networkPolicy` refused | `m3-gateway` | pass; no delivery for the refused calls | pass |
| 11 K1 same port and secret; rotation; K2 one valid secret | `m3-gateway` | pass | pass |
| 12 queue: Send now, Edit, Delete; held after a restart, FIFO release | `m3-sessions` (protocol), `m3-ui-restart`, `m3-ui` (Send now during a running turn, XD) | pass | pass |
| 13 new-session dialog, catalogue, chosen model | `m3-sessions` | pass | pass |
| 14 status bar equals `getUsage()` | `m3-sessions`, `m3-ui` | pass | pass |
| 15 Stop cancels; closing leaves the turn running | `m3-ui` | pass | pass |
| 16 fixture extension and feature; `secretWriter()` is the page's writer; a throwing extension skipped | `m3-gateway` | pass (the writer is now the gateway-local one in `extras`, XA) | pass |
| Rule 4a: no admitted call refused for its method | every browser file asserts `gatewayLog.refused('method')` empty; `m4-ui` probes three vat presences | pass | pass |
| M0-M2 files (regression) | 25 files | all pass; `m1b-live` 9 failed once at load 3-4 (rename row 638 ms against 500) and passed alone (61-158 ms) | pass (load-sensitive, as recorded before) |

| check (budget) | result (exclusive pass) | verdict |
|---|---|---|
| `gateway.fetch` (50 ms; 0 deliveries) | median 0.52 ms (n 55,674); 0 per sign-in | pass |
| `gateway.guard` (2 ms) | median 0.113 ms (24,544-byte call, 446 records, 258 vocabulary keys) | pass |
| `ui.call` (150 ms) | median 23 ms, p99 183 (n 1,690); answers peak 1,443 of 4,096 | pass |
| `ui.submit` (150 ms) | median 42 ms, p99 223 (n 493) | pass |
| `ui.deltaFanout` (5 ms; 0 deliveries per delta) | median 2 ms, p99 15 (5 clients, 1,100 deltas); 0 deliveries | pass (the lane's 0.007-0.010 per delta is gone) |
| too-big probes | 100 KiB, 2,000 keys, depth 33 refused with 0 journal growth; 33 in flight: 1 refused; 4,097 exports: closed 4008 after 4,089; still serving | pass |
| `ui.snapshot` (300 ms; within `frameBytes`) | median 31 ms, 371 characters | pass |
| `ui.history.newest` / `.archived` (300 ms) | median 208 ms (p99 275) / 2.2 ms | pass |
| `ui.reconnect` (1 s) | median 360 ms, p99 561 (n 169) | pass |
| `ui.restartReady.clean` / `.sigkill` (2 s) | the gateway answered `fetch` 2.2 s / 1.9 s before `serve()` resolved (29 / 24 restarts); the supervisor's serve time grew from 3.8 to 8.5 s over the SIGKILL series | pass (trivially, as J-9607); the file then exited 124 (open, major) |
| `ui.bundle` (600 KB gz) | 101,321 bytes gzip (308,059 raw) | pass |
| `ui.coldLoad` (1.5 s) | median 320 ms, p99 825 (n 181) | pass |
| `ui.hubGrowth` (hub 2 MB; row 1.25 x) | hub 1.17 -> 1.15 MB over 5 min (60 turns, 29 reloads); session row exports 11 -> 21 (**1.91 x**) | hub pass; row **fail** (carried; CC-051 + CC-060) |

Perf files held: `gateway` 329 s, `gateway-session` 602 s (exit 124), `ui` 438 s (exit 1:
`ui.hubGrowth`). Section 5 against M2 as merged was checked by W3.8 (J-9609) and not rerun.

---

## M4. Secrets manager and subscription pools

**Files after the review's fold (CL-CLOSE, 2026-11-18).** `config/defaults-m4.js` is
`config/subscription-defaults.js`, `AH/gateway/extensions/m4-secrets.js` is
`AH/gateway/extensions/secrets.js` (its `name` stays `m4-secrets`; `33e726b912`),
`guest/lib/limits-m4.js` `m4Limits` is `subscription-limits.js` `subscriptionLimits` and
`texts-m4.js` `m4Texts` is `subscription-texts.js` `subscriptionTexts` (`93b410bf4b`). A closed
accounts watch answers `AccountsBatch { closed, reason }` (`4eda82d98d`). `interfaces-m4.js` keeps
its name until the step-4 reinstall. Rename map: `arch-review/fold-plan.md` section 6.

**Status: done with open items** (X-CLOSE, 2026-11-18; the outcome table at the end of this
section). Acceptance 1-17 pass; the `[real-provider]` repeats of 3, 7, 8 and 10 are deferred
because they need the owner's credentials and an owner's run (never by an agent). Open:

- **closed** (was major, perf): `subscriptions.servedWrites` read 4.97 manager frames per session
  per 60 s against 1. Diagnosed by K2: the row counted journal frames, 7 of 9 of them GC frames
  whose number moves with when the engine collects, plus one warm-up stamp inside the window; no
  extra message per turn exists. The row now counts manager cranks, which is what the budget
  names, from after the warm-up stamp: 1.00 per 60 s, pass (2.00 frames).
- **fail** (perf, carried): `secrets.catalog` 775 ms against 300 (64 secrets, a 57-entry first
  page, 2.21 manager frames per page; lane 745 ms).
- **miss** (perf): `subscriptions.firstOpen` median 827 ms against 750 (1.10 x; lane 688 ms), 3
  manager frames on each first turn against 1 crank.
- **stale row**: `subscriptions.bundles` compares with `3588cab190` (before M3 and M5), so its
  session +28,242 and factory +27,762 measure M3 and M5 as well; the manager bundle is not
  measurable by `bundle-guest.mjs` (it refuses the package's dependencies). M4's own share stays
  W4.8's (+33, +33, factory +6,874: a miss).
- **minor**: the 8,193-byte credential probe is now refused at session creation as "Model catalog
  unavailable" (the creation's catalogue read fails on the credential), not by its own bound text;
  no halt. `accountStatus` was exercised on the Claude pool only (Codex and OpenRouter wires not).
- **contract text owed**: `m4-interfaces.md` 3.1 and D-M4-10 (`retire` and `retirePool` are
  `M.callWhen` and wait for an answered `poolsChanged`), 9.4 first bullet and D-M4-9 (the generic
  adapter-tool entry), 17 row 14 (the file is `test/browser/m4-ui.test.mjs`; "no frame carries the
  value and no Secrets call is sent" instead of "no frame is sent").

**Goal.** Full Secrets manager and UI, and the two subscription backends with pooled accounts,
renewal, refusal marks and account status.

- **P:** P-26 (full), P-58, P-07, P-06, P-05 (`fae-codex`, `fae-claude`), P-45, P-46 (pool, Codex and
  Claude parts).
- **R:** R2-18, R3-35, R3-233, R3-237, R4-14, R4-15, R4-16, R4-18, R4-19, R4-23, R4-24, R4-25,
  R4-30, R4-75, R4-76 (with the G-05 retry, open decision 12), R4-84, R4-85, R4-90, R4-103, R4-105,
  R6-29, R6-54, R6-67, R7-16, R7-22, R7-25, R7-26, R7-29, R7-30, R7-63, R8-13, R8-14, R8-30, R8-31,
  R8-34, R8-35, R8-36, R8-37, R8-38.
- **Depends on:** M2. Parallel with M3 and M5 (UI units after W3.0).
- **Owns:** `AH/subscriptions/` (pool core, rate-limit headers, pool-state bridge, Messages and
  Responses clients, pool catalogue, credentials, renewal, accounts, account file, `accountStatus`
  tool, pool provider, composition, credential ops), `AH/secrets/{credential-access,audit,catalog}.js`,
  `H/resources/agent-host/durable-subscriptions.js`, `H/guest/lib/{interfaces-m4,texts-m4,limits-m4}.js`,
  `H/guest/factory/subscription-options.js` (registered in `session-options.js`),
  `H/config/defaults-m4.js`, `H/scripts/subscription-login.mjs`, `H/ui/src/secrets/`,
  `H/ui/src/accounts/` (and `H/ui/src/account-chip/` if needed), `AH/gateway/extensions/m4-secrets.js`,
  `H/test/fixtures/{fake-subscription-server,fake-oauth-server}.mjs`,
  `H/test/fixtures/sse/subscriptions/`, `H/test/*/m4-*` (in `test/browser/` only `m4-*.mjs`),
  `H/perf/{subscriptions,secrets,accounts}.perf.mjs` (not `perf/pool.perf.mjs`, which is M1b's
  spare pool). M3's seams are directory registries: M4 adds files there and edits none of M3's
  collectors. Edits to shared files are the merge hotspots H-1..H-8, H-11, H-12 and H-14 of
  `m4-interfaces.md` 15, each with its exact seam and the single owner of each shared file.

**Contract.** `designs/m4-interfaces.md` (W4.0) with `guest/lib/{interfaces-m4,texts-m4,limits-m4}.js`
and `resources/agent-host/impl/subscriptions/types.js`. Pools hang off `SecretsAdmin.subscriptions()`
(D-M4-1), so `AgentHostAdmin`, `Operator` and every session interface stay as M2 left them; M4 adds
nothing to the session or exec programs (the session program has 13,552 bytes of its 200 KB left
for M3, M4 and M5 together, measured at `3588cab190`).

**Work units** (order: W4.0 done; **group A** = W4.1-W4.5 in parallel; **group B** = W4.6 and
W4.7 in parallel, W4.7 against M3's merged W3.0 contract with its component tests once M3's group
A is on the shared branch; then W4.8, which owns every M4 file; only W4.8 needs a running
supervisor; merge order M3, M4, M5; estimates in hours of one Opus agent, `m4-interfaces.md` 16)

| id | files | behaviour | tests | est. |
|---|---|---|---|---|
| W4.0 contract | `designs/m4-interfaces.md`, `guest/lib/{interfaces-m4,texts-m4,limits-m4}.js`, `AH/subscriptions/types.js` | **Done** (J-0610..J-0629), including the cross-check follow-ups (`vocabularyShapes`, `browserSecretBytes`, accounts eviction, `m4-secrets.js` seam) | guards built and sampled in Node | - |
| W4.1 manager part and creation (A) | `resources/agent-host/durable-subscriptions.js`, `guest/factory/subscription-options.js`, `config/defaults-m4.js`; hotspots H-1, H-2, H-6, H-7, H-11 | `SubscriptionsAdmin` (members from Secrets, pools as Backends, idempotent by label, R8-31 conflicts, retire), pool `Backend` with `resolveEffort`, sink `poolState`/`poolChanged`/`poolOf`, marks per member, served records (256, LRU), Secrets catalogue page, `setDescription`, audit reader forward; the effort resolver (R4-23) and `reasoningEffort` into `SessionConfig` | unit: M4 guards and `vocabularyShapes`; M4 `SecretsAdmin`/`Secret` keep M2's method guards (payload comparison, CC-072's technique); the part with fake ops; the resolver | 6 |
| W4.2 pool core (A) | `AH/subscriptions/{pool,rate-limit-headers,pool-state}.js` | selection R4-24 (object keys, `auto` only), marks R4-25/R4-103, dated marks lifted by newer open readings, the manager bridge (marks at once, served stamps coalesced, one `poolState` per incarnation) | ported `subscription-pool.test.js`, `rate-limit-headers.test.js` | 5 |
| W4.3 wire clients and catalogue (A) | `AH/subscriptions/{messages,responses,catalog}.js`, `anthropic.js` options (H-14), `test/fixtures/fake-subscription-server.mjs`, `test/fixtures/sse/subscriptions/` | Claude Messages SSE (R4-30 headers and billing block, adaptive thinking efforts, 16,384 output tokens, R4-76 texts, overload retry G-05), Codex Responses SSE (`instructions`, `store:false`, encrypted reasoning, `server_is_overloaded` retry R4-75/R4-105, `ultra` as `max`), both taking the system text as a plain string; pool catalogue R4-18/R4-19 with the R4-104 cache and the configured Claude context window (decision 13) | fixtures; ported lal `subscription-responses`/`subscription-messages` tests | 9 |
| W4.4 credentials, renewal, Secrets adapter (A) | `AH/subscriptions/{credentials,renewal}.js`, `AH/secrets/{credential-access,audit,catalog}.js`, H-5, `test/fixtures/fake-oauth-server.mjs` | credential parse and bounds (R7-25), write-ahead renewal with generation-conditioned write-back, fail closed `CONSUMED` (D-M4-8), single-flight per member, the one-key accessor (W-5 fix), audit reader to 1,000 (R7-63), describe batch | concurrent renewals, killed child at the renewal kill points, audit paging | 7 |
| W4.5 accounts (A) | `AH/subscriptions/{accounts,account-file,account-tool}.js` | readings with provenance (observed, declared, remembered, unavailable), pushed on an adapter channel (R4-85) with keepalive (30 s) and idle eviction (60 s; oldest idle evicted at the cap), on-demand refresh, readings file, `accountStatus` text (R3-35, R4-84), banked credits shown (R4-86, no redeem) | adapter tests; ported `account-tool` rendering; 40 abandoned watchers then a new watch succeeds | 6 |
| W4.6 composition and wiring (B) | `AH/subscriptions/{provider,index,credential-ops}.js`, `AH/gateway/extensions/m4-secrets.js`, `scripts/subscription-login.mjs`, H-3, H-4, H-8, kind tool lines (H-14) | the pool round (system text once through `systemTextOf`, member hand-over before delivery, one attempt per member plus one renewal retry, "Provider subscriptions exhausted" with the reset time, G-07), `claude-pool`/`codex-pool` kinds, `accountStatus` on pool and API kinds, ops `credentials()`, provisioning step, sign-in helper and `--value-file` (sealed boxes only), the `largeCalls` extension for `SecretWriter.replace` | adapter tests over both fake servers and a fake sink; the extension against a fake `GatewayContext` | 8 |
| W4.7 UI (B) | `ui/src/secrets/feature.js` (`app.panel`), `ui/src/accounts/feature.js` (`app.panel` Subscriptions and `statusbar.chip`, or the chip in `ui/src/account-chip/feature.js`), their components | Secrets panel (write-only, R6-67, R7-26; refuses values over `browserSecretBytes` and non-text files in the page), Subscriptions panel and account chip (R6-54) | component tests with M3's `_m3-fake-powers.js` | 7 |
| W4.8 integration | everything of M4; `test/integration/m4-*`, `test/browser/m4-*.mjs`, `perf/{subscriptions,secrets,accounts}.perf.mjs` | acceptance 1-16 (14 after M3's merge, 13's system-text case after M5's), kill points K-1..K-6, perf below | all M4 files, four slots, under 20 min | 9 |

**Acceptance tests** (fake servers; `[real-provider]` repeats 3, 7, 8 and 10 once with owner
credentials; each one integration test under 5 minutes; files in `m4-interfaces.md` 17)
1. Secrets: create, replace with expected generation (stale refused), revoke (next read fails),
   delete only after revoke, description edit, catalogue without values, audit lists each read
   (pages to 1,000).
2. `auto` picks the member resetting soonest; ties by used fraction then declaration order; a
   session stays on its member within the cache lifetime and moves after it.
3. A 429 with exhaustion headers marks the member and the same request goes once to the next; all
   exhausted fails "Provider subscriptions exhausted" with the first reset time; no body in the
   reason.
4. Marks survive a SIGKILL restart; a newer open reading lifts a dated mark.
5. From a session vat and its exec vat no `AgentHostAdmin`, `SecretsAdmin`, `SubscriptionsAdmin`,
   `Secret`, `PoolMember`, `Accounts`, gateway facet, factory or other session is reachable
   (method of `m4-interfaces.md` 19 until CC-060).
6. Catalogue: `codex-pool` intersection (R4-18); `claude-pool` synthetic `auto` with efforts and the
   configured window; a read with no member answering is `unavailable`; the cache holds 15 min.
7. `accountStatus` and the account chips show plan, windows and resets with provenance labels;
   refresh updates them; a watcher gets one batch per change; after a restart they are
   `remembered`.
8. Claude 529 before any delivery is retried; after a delivery it fails with an R4-76 text; SSE
   error, non-200 and empty answer give the three R4-76 texts.
9. Codex `server_is_overloaded` before visible delivery is retried on the schedule, after it is
   not; failure texts carry symbolic facts only.
10. Renewal: an expired token is renewed once; a 401 gets one renewal and one retry, then the
    member is marked and the next serves; a concurrent renewal fails `GENERATION_CONFLICT`.
11. SIGKILL mid-round (between a 429 and the next member's request, mid-stream, before the first
    byte): the turn is outcome-unknown and no member attempt is sent twice.
12. SIGKILL during renewal (after the write-ahead mark; after the token endpoint answered): at most
    one refresh per token; the member reports `CONSUMED`; the other member serves.
13. Efforts: unsupported refused at creation, supported stored and sent; an effort on an API
    backend refused; R4-30 header names present; after the M5 merge, a two-part system text
    reaches both fake servers joined with a blank line.
14. Browser (M3's `startBrowserGateway`, after M3's merge): Secrets panel create, replace, revoke,
    delete after revoke, audit, value never in the DOM or a gateway frame; account chips update
    live; a value of exactly 1,040,384 JSON-escaped bytes (quotes included) is written from the
    page, one byte more is refused in the page and nothing is sent.
15. No access token, refresh token or API key value anywhere in the state directory, the adapter's
    event log or captured stderr; neither browser size-probe value reached the hub.
16. Provisioning twice is a no-op; a member label bound to another Secret is refused until
    retired; a revoked Secret is never rewritten; `makePool` again after a SIGKILL answers the
    same pool.

**Perf checks** (each a rate or latency over a fixed window, 60 s unless stated; no state built by
replaying turns; each file under 10 minutes with at most 7 timed windows; reasons in
`m4-interfaces.md` 18)
| check | file | budget |
|---|---|---|
| `subscriptions.select` member order, 16 members, 256 sessions | subscriptions | median <= 0.5 ms; 0 deliveries |
| `subscriptions.turnStart` on a pool backend | subscriptions | median <= 350 ms; <= 3 session deliveries; 0 manager deliveries |
| `subscriptions.handover` 429 on A then B | subscriptions | <= 50 ms over the fake server; 1 manager delivery per refusal |
| `subscriptions.servedWrites` sticky session | subscriptions | <= 1 manager delivery per session per 60 s |
| `subscriptions.renewal` 16 concurrent rounds on an expired member | subscriptions | 1 refresh POST per expiry; <= fake + 50 ms |
| `subscriptions.firstOpen` restarts over a 150 s window | subscriptions | median <= 750 ms; 1 manager crank per restart |
| `catalog.pool` one 60 s window of (invalidate, cold read, warm read) | subscriptions | warm median <= 300 ms; cold median <= 2 s |
| `subscriptions.bundles` (one build) | subscriptions | session and exec + <= 64 bytes; factory <= +6 KB |
| too-big probes (single runs) | subscriptions | no halt; credential 8,193 bytes, secret 1 MiB + 1, audit 1,001, 17 members, 16 MiB + 1 SSE line refused on the sending side; `poolState` at 256 served fits a frame |
| `secrets.credentialRead` per round | secrets | median <= 1 ms; 0 deliveries |
| `secrets.catalog` 64 secrets | secrets | median <= 300 ms; 1 manager crank |
| `secrets.auditReader` 1,000 events | secrets | median <= 50 ms; 0 vat deliveries |
| `accounts.push` reading to subscriber | accounts | median <= 5 ms; 0 vat deliveries per change and per viewer |
| `accounts.refresh` 2 members | accounts | median <= fake + 100 ms |

Files: `perf/subscriptions.perf.mjs` 7 windows, 510 s timed, <= 595 s with setup;
`perf/secrets.perf.mjs` 3 windows, <= 270 s; `perf/accounts.perf.mjs` 2 windows, <= 210 s.

**Fit risk:** good. All token-bearing code is Node in one process; the vat side is a few handles.

**Deferred:** Codex reset-credit redeem (open decision 8), voice preset model (M11).

**Outcome (X-CLOSE, cross-lane close-out; replaces W4.8's lane table, whose numbers stay in
J-9640..J-9647).** The same regression run and exclusive perf pass as M3's outcome (commits, load
and worker there). Rows and readings: J-10060..J-10064.

| # | acceptance | proving test (this run) | result |
|---|---|---|---|
| 1 | Secrets full | `m4-secrets` (and `m2-secrets` for the sealed hub writer) | pass; held 89 s |
| 2, 3 | selection, stickiness, hand-over, all exhausted | `m4-pools` | pass; held 101 s |
| 4, 11 | marks across SIGKILL; K-2, K-3, K-4 | `m4-restart` | pass; held 180 s |
| 5 | reachability | `m4-reachability` (return-guard closure; origin-granular holdings until CC-060) | pass; held 86 s |
| 6, 13 | catalogue; efforts, R4-30 headers, two-part system text to both fake servers | `m4-catalog` | pass; held 86 s (13's system-text case added by XB after the M5 merge) |
| 7 | accounts, including the model calling `accountStatus` (generic adapter-tool entry, XC) | `m4-accounts` | pass; held 86 s |
| 8, 9 | Claude and Codex overload and failure texts | `m4-wire` | pass; held 110 s |
| 10 | renewal | `m4-renewal` | pass; held 93 s |
| 12 | K-5, K-6 | `m4-restart-renewal` | pass; held 101 s |
| 14 | browser: Secrets and Subscriptions panels, chips live, 1,040,384-byte value, one byte more refused in the page | `test/browser/m4-ui.test.mjs` | pass; held 95 s |
| 15 | no credential anywhere (state directory, event log, stderr, page storage, frames, DOM) | in 1, 2-3, 10, 12 and `m4-ui` | pass |
| 16 | provisioning twice, R8-31, R8-38, K-1 through `makeProvision({ subscriptions })` | `m4-provision` | pass; held 103 s |
| 17 | retirement seen by the next turn (now waits for the adapter's answer, X-FIX) | `m4-retire` | pass; held 79 s |
| `[real-provider]` 3, 7, 8, 10 | owner's credentials | not run | deferred (owner's run) |

| check (budget) | result (exclusive pass) | verdict |
|---|---|---|
| `subscriptions.select` (0.5 ms; 0 deliveries) | median 0.086 ms (16 members, 256 served); 0 | pass |
| `subscriptions.turnStart` (350 ms; <= 3 session, 0 manager deliveries) | median 114 ms, p99 565 (n 143); 0.035 manager frames per turn | pass (frames are served stamps) |
| `subscriptions.handover` (50 ms; 1 manager per refusal) | 3.1 ms (n 31); 1.26 frames per refusal including the turn's stamp | pass |
| `subscriptions.servedWrites` (1 per session per 60 s) | **4.97** (5 manager frames in 60.4 s, 143 turns) | **fail** (open, major) |
| `subscriptions.renewal` (1 POST per expiry; +50 ms) | 1 POST for each of 24 expiries; -72 ms against unexpired (384 rounds) | pass |
| `subscriptions.firstOpen` (750 ms; 1 manager crank) | median 827 ms, p99 866 (19 restarts over 158 s); 3 manager frames per first turn | miss (1.10 x) |
| `catalog.pool` (warm 300 ms; cold 2 s) | warm 66 ms, cold 94 ms (n 19) | pass |
| `subscriptions.bundles` (session, exec +64; factory +6 KB) | not comparable: the baseline predates M3 and M5 (session +28,242, exec -20,528, factory +27,762); manager not measurable | stale row (open) |
| too-big probes (no halt; refused on the sending side) | audit 1,001 and 17 members refused by the guards; credential 8,193 refused at creation by the catalogue read; `poolState` at 256 served 15,839 B (unit); no halt | pass (credential indirect, minor) |
| `secrets.credentialRead` (1 ms; 0 deliveries) | median 0.030 ms (n 1.4 M); 0 | pass |
| `secrets.catalog` (300 ms; 1 manager crank) | median **775 ms**, p99 961 (n 77); 2.21 manager frames per page | **fail** (carried) |
| `secrets.auditReader` (50 ms; 0 deliveries) | 26.7 ms in the adapter (361 ms through the hub, informative) | pass |
| `accounts.push` (5 ms; 0 deliveries) | median 0.345 ms, 4 viewers; 0 | pass |
| `accounts.refresh` (fake + 100 ms) | median 42 ms (2 usage reads, 0 manager frames) | pass |

Perf files held: `subscriptions` 208 s (exit 1: `servedWrites`, `bundles`),
`subscriptions-lifecycle` 371 s, `secrets` 275 s (exit 1: `catalog`), `accounts` 128 s.

---

## M5. Presets, prompt composition, object and exec tools, grants, mentions

**Files after the review's fold (CL-CLOSE, 2026-11-18).** `guest/lib/interfaces-m5.js` and
`interfaces-m5-factory.js` are folded into `guest/lib/guards/base.js`, `session.js` and
`factory.js` (one guard per interface under its plain name), `limits-m5.js` into `limits.js`, and
`guest/session/m5-parts.js` is `runtime-parts.js` (`46b5602b19`, `a1373d71b9`, `33e726b912`). The
session program is 206,907 bytes (was 214,690) and the exec program 61,688 (was 63,826). Rename
map: `arch-review/fold-plan.md` section 6.

**Status: done** (X-CLOSE, 2026-11-18; the outcome table at the end of this section). Acceptance
1-15 pass, the browser item included; no blocker or major is open. Recorded and carried (not
re-based):

- **fail** (perf, carried; cause about 7-15 ms per handle crossing into or out of a vat, J-9696):
  `presets.save` 248 ms against 150 (32 endowments), `inventory.page` 729 ms against 200,
  `tools.local` +126 ms against +30, `prompt.compose` largest preset +408 ms against +150 and
  1,499 ms against 750, `mentions.turnStart` 388 ms against 350 and +247 ms against +100 with
  0.6 extra deliveries per turn (the file's bound 0.5).
- **miss** (perf): `session.createCold` 6.25-6.54 s against 6 s (1.04-1.09 x) with the 214,690-byte
  session program (M2: 5.53 s at 186,998 bytes; the staging cost, C-5).
- **minor**: attachment chips show once the turn settles, not while it runs (the vat's turn-start
  event carries no `attachments`; a guest change, for the PM to decide). K5's second kill point
  records the true result through replay before recovery marks the turn outcome-unknown (the
  contract rows say so; the PM to confirm that this is the wanted behaviour).
- **contract text owed**: `m5-interfaces.md` O-1 (the interface split was done after the limit
  raise: session 214,690 of 240,000, exec 63,826 of 120,000), 4.1 item 3 (chips from
  `TurnStarted.attachments` after the settled re-read), and a contract row for
  `guest/lib/guards/` (`base < session < factory < interfaces.js`).
- **minor** (since main was merged, K1 J-10071..J-10073): the core's CC-027 (hub frame ceiling,
  65,536 in the harness) refuses M5's too-big foreign answers at the hub before the exec vat
  decodes them, the third accepted outcome (`hubRefused`): the 300 KB granted-tool answer reaches
  the model as `Error: ocapn hub: the message exceeds the inbound frame ceiling of its target`
  instead of a cut, staged preview, and the 200 KB `help` leaves `describeCapability` with its
  method names and documentation `unavailable`. No halt, the session goes on; acceptance 5 and 10
  pass on the combination (`m5-objects` 96 s, `m5-security` 77 s held). The model is told that
  the answer was refused but not why in its own terms or what to do; a guest-side rendering of
  the hub's text is proposed to the PM (J-10073), not built. The `perf/exec-m5` and
  `perf/tools` probes (a, b, c, e) were not rerun on the combination.

**Goal.** Sessions get their authority from presets: built-in and user presets, the grant flow,
composed prompts frozen at creation, the full exec and object tool sets, granted tools, a minimal
operator inventory and @-mentions.

- **P:** P-20 (non-shell presets: `chat-only`, `general` without shell), P-53, P-15 (full), P-16
  (full), P-17, P-65, P-40, P-49 (except the voice shortcut, M11).
- **R:** R3-1, R3-5, R3-6, R3-7, R3-8, R3-9, R3-11, R3-16, R3-17, R3-20, R3-22, R3-29, R3-30 (stub
  until M8), R3-31, R3-32, R3-41, R3-42, R3-265, R3-270, R3-271, R3-273, R4-4, R4-26, R4-27, R4-28,
  R4-29, R4-38, R4-99, R6-40, R6-55, R7-6, R7-38, R7-45.
- **Depends on:** M2 (takes over `guest/session/prompt.js`). Parallel with M3 and M4 (UI units after W3.0).
- **Owns:** new `H/guest/factory/{presets,inventory,preset-templates}.js`,
  `H/guest/lib/{preset-catalog,prompt-sections,tool-args,interfaces-m5,interfaces-m5-factory,limits-m5}.js`,
  `H/guest/session/{labels,label-seeds,m5-parts,powers-source,packages}.js`,
  `H/guest/session/tools/{objects,inspection,inspect-client,granted,mentions}.js`,
  `H/guest/exec/{powers,membrane,inspect}.js`, `H/test/fixtures/m5-objects.js`, `H/ui/src/presets/`,
  `H/ui/src/mentions/`, `H/test/*/m5-*` (in `test/browser/` only `m5-*.mjs`), `H/perf/{tools,exec-m5,presets,mentions,creation-m5}.perf.mjs`;
  `H/guest/session/prompt.js` (from M2) and `H/guest/lib/system-prompt-base.js`; the M2, M1b and
  M1a files M5 edits are assigned per unit in `m5-interfaces.md` section 7, and the lines it adds
  to files M3 or M4 may also edit are the seams of its section 9.1.

**Contract.** `designs/m5-interfaces.md` (W5.0, done) with `guest/lib/interfaces-m5.js`,
`interfaces-m5-factory.js` and `limits-m5.js`. Two decisions shape the rest: no answer from an
object the session did not mint enters a session vat (the exec vat's `inspect` calls such objects
and answers a bounded, rendered result; D-M5-2), and model code reaches other vats' objects only
through a per-call membrane that bounds every message (D-M5-3). Core requests CC-070..CC-073 and
owner decisions O-1..O-12 are in its section 9.

**Work units** (W5.0 first, done and settled after the M3/M4/M5 cross-check; then group A in
parallel; then group B in parallel; then W5.9; hours for one Opus agent; files and reasons in the
contract, section 7; merge order M3, M4, M5, with W5.3's first commit allowed early)

| id | files | behaviour | tests | hours |
|---|---|---|---|---|
| W5.0 contract | `designs/m5-interfaces.md`, `guest/lib/{interfaces-m5,interfaces-m5-factory,limits-m5}.js` | **Done**. Objects, seams, units, acceptance, perf, hotspots; settled: `vocabularyShapes()` in both interface files, UI by `feature.js` directories, the mention addon on M3's `composer.addon`, `presetRecordBytes` | the guards build and match samples (W5.0 check in Node); the contract test is W5.3's | - |
| W5.1 presets and inventory (A) | `guest/factory/{presets,inventory,preset-templates}.js`, `guest/lib/preset-catalog.js`; edits `factory.js` (H-1..H-3), `services.js` (append), `scripts/export.mjs`; `perf/presets.perf.mjs` | catalogue and `Preset` objects (no ids), revision compare-and-set, built-ins and reset, Fae's validation texts plus the whole-record bound `presetRecordBytes`, defaults rule R3-20, creation from a preset (defaults, data snapshot, endowments at the snapshot's revision), minimal inventory, presets in export/import | unit: ported `preset-catalog.test.js`, the guard-boundary test of the maximal record; integration `m5-presets` (acceptance 2, 13, 14; kill points K1, K2) | 6 |
| W5.2 prompt composition (A) | `guest/session/prompt.js`, `guest/lib/{system-prompt-base,prompt-sections}.js` | parts in order through the section table (1, 2 rewritten for M5's `powers`, 3 empty, 7); parts 4-6 left to M9, M12, M6 | unit: ported `system-prompts.test.js`; integration `m5-prompt` (acceptance 9) | 3 |
| W5.3 session seams, labels, local object tools (A) | the four widenings in `interfaces.js` (first commit, may merge early); `guest/lib/tool-args.js`, `guest/session/{labels,label-seeds,m5-parts}.js`, `tools/objects.js`; edits `turn.js`, `turn-hooks.js`, `tool-table.js`, `session.js`, `AH/providers/{round,scripted}.js`; `perf/tools.perf.mjs` (runner and `rows`) | one label map per session; `list`, `lookup`, `store`, `remove` in the session vat with `parseClosedArgs` (no `JSON.parse`); tools re-read every round; the per-turn system note; claim hooks; the M5 `Session` guard with forwards | unit: the contract test (with `vocabularyShapes`), closed-args floods, a 256-call `store` round at the slot ceiling; integration `m5-labels` (acceptance 3, local part) | 7 |
| W5.4 exec side (A) | edits `guest/exec/{main,render}.js`, `guest/session/tools/exec.js`; `guest/exec/{powers,membrane,inspect}.js`, `guest/session/tools/inspect-client.js`, `test/fixtures/m5-objects.js` | per-call `powers` (`lookup`, `list`, `store`, `remove`) that die with the call; the membrane; `ExecScope.inspect` (`methods`, `describe`, `readSources`, `toolSchema`, `toolExecute`) with Fae's bounds; the session's inspector client | unit (exec program in Node with fakes) | 7 |
| W5.5 powers and inspection tools (B) | `guest/session/powers-source.js`, `tools/inspection.js`; appends `tool-table.js`, `m5-parts.js`, `provision-steps.js` (M5 fixture step, a no-op unless `options.m5Fixtures`); `perf/exec-m5.perf.mjs`, the `tools.inspect` row of `tools.perf.mjs` | `ExecPowersSource`; `describeCapability`, `readSources`, `lookup` of objects through the inspector; endowments seen by the model | integration `m5-objects` (acceptance 3, 4, 5, 8; K7), `m5-security` (acceptance 10) | 5 |
| W5.6 granted tools (B) | `guest/session/tools/granted.js`; appends `tool-table.js` (`toolSources`), `m5-parts.js`, the `grants.round` row of `tools.perf.mjs` | `Session.grants()`, `grantTool`, `withdraw`; discovery every round (built-in names = static table plus the round's adapter tools, duplicates both refused, size budget); calls through the inspector | unit: a grant named `accountStatus` on ports offering it is refused-builtin; integration `m5-grants` (acceptance 6), `m5-grants-restart` (acceptance 11b) | 5 |
| W5.7 packages and mentions (B) | `guest/session/packages.js`, `tools/mentions.js`; edits `queue.js`, `submissions.js`, `guest/lib/pending-queue.js`, `AH/composer.js`; appends `turn-hooks.js`, `tool-table.js`, `m5-parts.js`; `perf/mentions.perf.mjs` | `enqueueMessageOnce`, `Composer.submit(..., { attachments })`, packages per turn, the R4-29 line, `adopt`, `adoptTool`, release at settle and in recovery | integration `m5-mentions` (acceptance 7), `m5-mentions-restart` (acceptance 11a) | 6 |
| W5.8 preset and mention UI (B; component tests after M3's W3.4 is in the shared branch, browser test after M3 merges) | new `ui/src/presets/feature.js` (`app.panel`), `ui/src/mentions/feature.js` (`composer.addon` with `send`, `message.renderer` chips); `test/unit/m5-w58-*.test.js`; `test/browser/m5-*.mjs`; no M3 file edited | the preset editor (R6-55) shared across devices, refusing an over-size record before sending; composer `@` autocomplete over the inventory with chips, sent through `Composer.submit`'s fourth argument on first send and resend; attachment chips in the transcript | unit with M3's `_m3-fake-powers.js`; browser on M3's `startBrowserGateway` (acceptance 15) | 6 |
| W5.9 integration | every file after group B; `perf/creation-m5.perf.mjs` | the runtime wiring left (no `notBuilt` stub), the bundle budget (O-1: the PM raises the limits to 240,000 / 120,000 in the M5 merge commit), the merge seams with M3 and M4 as landed | integration `m5-snapshot` (acceptance 1, 9 part 7), `m5-reachability` (acceptance 12); every perf row; the regression wall time | 6 |

**Acceptance tests** (each one integration test of at most 5 minutes; details and the file of
each in `m5-interfaces.md` 8.1)
1. A session keeps its prompt and its endowed labels after its preset is edited; a new session
   gets the edit (R3-7, R4-4, R4-28).
2. Two clients edit the catalogue: a save at a stale revision is refused with Fae's text; a
   built-in cannot be deleted, only reset; an over-size record is refused; a save survives a
   SIGKILL exactly once.
3. `list`, `lookup` (a stored value; an object rendered as a remote capability without calling
   it), `store` across a SIGKILL restart, `remove`, an unheld label, the 257th label and an
   unknown argument key are each answered as specified.
4. exec `powers` sees `store` and `remove` from the same turn; `powers` kept from an earlier call
   is dead; `globalThis` bindings survive a SIGKILL restart.
5. `describeCapability` and `readSources` answer bounded results; an object whose `help()` answers
   200 KB costs the exec scope (stated) and never the session.
6. A granted tool is offered next round and runs; `exec` as a granted name and two grants of one
   name are not offered; withdrawing one offers the other next round.
7. A message with two attachments: only that turn's requests carry the R4-29 line; `adopt` keeps
   one; the other is released after the turn; 33 attachments are refused; `adoptTool` grants a
   tool.
8. A user preset's inventory endowments appear in its sessions' `list`; reserved, invalid,
   duplicate and 33 endowments are refused; `chat-only` takes none (P-53, R3-22).
9. Typed and spoken sessions get their introductions; the guest section describes the persistent
   scope and `powers`; a `systemPrompt` replaces the composition; a blank one fails.
10. Model code cannot send a 100 KiB argument or a 40-key record to another vat's object (the
    membrane refuses it in the exec vat); a granted tool answering 300 KB never reaches the
    session vat.
11. SIGKILL at the kill points of `m5-interfaces.md` 5: no tool runs twice; stored labels and
    adoptions exist exactly once; held messages keep their attachments.
12. Neither a session vat holding endowments, adoptions and grants nor its exec vat reaches the
    catalogue, the inventory, the Operator, the factory or any admin facet (`thix reachability`).
13. Inventory add, page, relabel and remove; a duplicate label refused.
14. Export and import carry user presets (without endowments) (M2 acceptance 14's presets).
15. Browser (after M3 merges, `THIX_HARNESS_BROWSER=1`): a preset saved on one device appears on
    another; a stale save is refused; `@` autocomplete attaches an inventory object and the
    transcript shows its chip; a resend after a reload whose chips were lost is refused with a
    fixed text and the draft kept.

P-52 mapping rows for M12: named references and directories map to M5 acceptance 3 and 13;
plugin installation with explicit powers maps to M5 acceptance 8.

**Perf checks** (fixed windows: each measured point is a latency or rate over 60 s unless stated;
a comparison alternates both sides in one window unless "each"; no check builds a long session;
every perf file under 6 minutes; reasons in `m5-interfaces.md` 8.2)
| check | file | budget |
|---|---|---|
| `tools.local` four session-local object tools in one round vs an `echo` round (60 s, alternating) | `tools` | median <= +30 ms; 0 extra session deliveries |
| `labels.full` turn start with 256 labels vs none (60 s, alternating) | `tools` | <= 1.1 x |
| `tools.inspect` `describeCapability` through the inspector (60 s) | `tools` | median <= 300 ms |
| `grants.round` turn start with 32 offered grants (60 s) | `tools` | median <= 350 ms |
| `exec.powersLookup` per `E(powers).lookup` (60 s) | `exec-m5` | median <= 150 ms |
| `exec.membrane` wrapped call vs raw call (60 s, alternating) | `exec-m5` | <= +5 ms |
| `exec.scope1000` trivial call in a scope with 1,000 globals (60 s) | `exec-m5` | median <= 300 ms |
| `presets.save` round trip (60 s) | `presets` | median <= 150 ms |
| `inventory.page` 50 rows of 1,000 entries made by `addAll` (60 s) | `presets` | median <= 200 ms |
| `mentions.turnStart` 32 attachments vs none (60 s each) | `mentions` | <= +100 ms, <= 350 ms, <= 3 deliveries |
| `prompt.compose` Node: compositions over 10 s; vat: creations over a 120 s window, largest preset and `chat-only` alternating (pool 4) | `creation-m5` | <= 5 ms; <= +150 ms and <= 750 ms |
| `session.program`, `exec.program` bundle bytes; `session.createCold` cold creations over a 120 s window | `creation-m5` | the limits after O-1; <= 6 s |
| too-big probes, each capped at 15-30 s: (a) 100 KiB through the membrane, (b) 200 KB `help`, (c) 20,000-key answer, (f) exec 300 k iterations ok and 10 x the crank ceiling terminated | `exec-m5` | no halt of the session vat or the target's vat |
| too-big probes, each capped at 30 s: (d) oversize `store`, 257th label, 33 attachments; (e) oversize granted schema | `tools` | as above |

The whole M5 regression (11 integration files and the browser file of at most 4 minutes each,
five perf files of at most 5.5 minutes each) is at most 69 slot-minutes: about 17 minutes on four
test slots.

**Outcome (X-CLOSE, cross-lane close-out; replaces W5.9's lane table, whose numbers stay in
J-9690..J-9698).** The same regression run and exclusive perf pass as M3's outcome (commits, load
and worker there). Rows and readings: J-10060..J-10064.

| item | proving test (this run) | result | verdict |
|---|---|---|---|
| 1 snapshot isolation; 9 part 7 | `m5-snapshot` | pass; held 75 s | pass |
| 2, 13, 14, K1, K2 | `m5-presets`, `m5-presets-inventory` (the split file, XC) | pass; held 110 s / 98 s | pass |
| 3 local object tools | `m5-labels`, `m5-objects` | pass; held 106 s / 95 s | pass |
| 4, 5, 8, K7 | `m5-objects` (`powers.store` refuses a model-made remotable, X-FIX) | pass | pass |
| 6 granted tools | `m5-grants` | pass; held 86 s | pass |
| 7 attachments, `adopt`, `adoptTool` (grant label kept) | `m5-mentions` | pass; held 74 s | pass |
| 9 introductions, guest section, `systemPrompt` | `m5-prompt` | pass; held 95 s | pass |
| 10 membrane bounds; 300 KB granted answer never reaches the session | `m5-security` | pass; held 77 s | pass |
| 11a K3, K6; 11b K4, K5 (second kill point included) | `m5-mentions-restart`, `m5-grants-restart` | pass; held 93 s / 118 s | pass |
| 12 reachability | `m5-reachability` (origin granularity until CC-060) | pass; held 81 s | pass |
| 15 browser: preset on two devices, stale save refused, `@` chip, lost chips refused on resend | `test/browser/m5-ui.test.mjs` | pass; held 105 s | pass |
| Seams with M3 and M4 as landed (`systemTextOf` on pools, adapter tools offered to the model, gateway presences) | `m4-catalog` 13, `m4-accounts` 7, browser files | pass | pass |

| check (budget) | result (exclusive pass) | verdict |
|---|---|---|
| `tools.local` (+30 ms; 0 extra deliveries) | +126 ms (640 against 513, n 52 + 52); -0.8 deliveries | **fail** / pass |
| `labels.full` (1.1 x) | 1.023 (135 against 132 ms) | pass |
| `tools.inspect` (300 ms) | median 220 ms (n 83) | pass (lane 339) |
| `grants.round` (350 ms; tool set 10 ms) | 158 ms with 32 grants (plain 139); tool set 0.017 ms in Node | pass |
| `exec.powersLookup` (150 ms) / `exec.membrane` (+5 ms) / `exec.scope1000` (300 ms) | 53 ms / -10.8 ms (Node +0.001) / 60 ms | pass |
| `presets.save` (150 ms) / `inventory.page` (200 ms) | 248 ms with 32 endowments (24 ms without) / 729 ms (one entry 24 ms) | **fail** / **fail** (carried) |
| `mentions.turnStart` (+100 ms, 350 ms, deliveries) | 388 against 141 ms (+247); +0.6 deliveries per turn | **fail** (carried) |
| `prompt.compose` Node (5 ms) / vat (+150 ms, 750 ms; pool 4) | 0.002 ms / largest 1,499 against `chat-only` 1,092 (+408), n 11 + 11 | pass / **fail** (carried) |
| `session.program` / `exec.program` (240,000 / 120,000) | 214,690 / 63,826 bytes | pass |
| `session.createCold` (6 s) | 6,537 ms (n 19, 120 s; `creation-m5`), 6,249 ms (n 5, 30 s; `session.perf`) | miss (1.09 / 1.04 x) |
| probes a, b, c, f (no halt) | (a) refused in the exec vat; (b) staged, 8,194 characters; (c) answered "Documentation is unavailable", no halt (the lane's halt is gone); (f1) 300 k iterations; (f2) terminated | pass |
| probes d, e | oversize `store`, 257th label, 33 attachments refused; granted schema of 3,074 characters `refused-schema`; no halt | pass |

Perf files held: `presets` 199 s, `creation-m5` 285 s, `exec-m5` 277 s, `tools` 348 s, `mentions`
148 s (each exit 1 except `exec-m5`: the fails above).

M0-M2 cross-check in the same pass (did the M2 rows move?): `turn.start` median 112 ms, p99 352,
2 deliveries (M2 108 ms); `turn.delta` 0.21 ms, 0 deliveries; `turn.round` 3, lease 1;
`install.factory` 6.55 s (M2 5.8 s); `exec.first` 299 ms (299), `exec.trivial` 68 ms (56),
`exec.sends.answered` 1.13 s (1.31), `exec.retire` 78 MB; `session.createCold` above. Only
`session.createCold` moved, with the session program's size.

**Fit risk:** good. Persistent scope and object endowments are what Thixotrope offers; Appendix F
drops most of Endo's name plumbing.

**Deferred:** shell presets (M6), `viewImage` real input (M8), voice shortcut preset (M11).

---

## The group {M6, M8, M9, M11}: shared units, owner questions, core requests

**Status: contracts settled, not built** (2026-11-18). The four contracts are the reference:
`m6-interfaces.md`, `m8-interfaces.md`, `m9-interfaces.md`, `m11-interfaces.md`, settled against
the cross-check WX.0 (journal J-1410..J-1417, issues X-01..X-17) and against cleanup step 3
(`arch-review/step3-plan.md` and the step-3 code as built in the cleanup lane). No seam is
provisional. Each milestone section below keeps only the goal, the P and R numbers, its
dependencies, what it owns and its three tables, condensed: where a section and its contract
disagree, the contract wins. Paths in these sections: `EV/` = `H/resources/environments/`,
`EVI/` = `EV/impl/`, `GW/` = `AH/gateway/`, `UI/` = `H/ui/`; other paths are relative to `H/`.
Test files in the tables are named without their directory and `.test.js` suffix where the
column says which kind they are.

**Two units outside the lanes.**

- **WX.1, the cross-lane seam unit** (the PM's; one agent, after step 3 merges, before any lane
  unit). It applies, in one commit, every lane's entries in shared guard modules and part-API
  typedefs, and rebases the two tests those entries would break: M6 section 15 (15.1 `Session`
  methods, `ExecutionState`, `SessionServices` fields, `SessionExportPage.execution`; 15.2
  `HarnessSettings.environments`, `runnerRequired`, `VatEvent` `execution`; 15.3 `PartHooks.admit`
  with the `RuntimeHooks.admit` fan-out; 15.4 the `guards/environments.js` exclusion); M8 G-1..G-5,
  T-1, T-2, S-10c; M9 S2, S2b, S9, S9b, S10, F6, V1, G1, L1, C1; M11 appendix A (H1), H3, H4. It
  owns `guest/lib/guards/{session,factory,base}.js`, `guest/lib/interfaces.js`,
  `guest/session/records.js`, `guest/session/turn-types.js`, `guest/session/runtime-parts.js`
  (typedefs, `combineHooks`, the part-order comment), `guest/session/turn.js` (`claimNext`: M9 S2
  only), `guest/session/tools/objects.js` (the `readArgs` and label-lookup export),
  `guest/session/tools/exec.js` (the per-part call table export), `guest/lib/vocabulary-tables.js`,
  `test/unit/guards-split.test.js` with `test/fixtures/guard-fold-map.json` (an `added` list
  replaces the before-split check) and `test/adapter/gateway-vocabulary-tables.test.js` (one
  re-pin, plus the not-browser-sendable exclusion rule). It fixes the part order `powers,
  inspector, grants, exec, packages, environment, compaction, inbox, subagents` and the tool order
  shell entries, `viewImage`, mail, requests, subagents. No lane unit edits a line WX.1 makes; a
  lane that finds WX.1 missing stops.
- **WX.F, the group fold** (after the four merges and their own folds). It measures the gateway
  vocabulary and the session bundle once against the ruled limit
  (`test/unit/m1a-session-program.test.js`), owns the four cross-lane acceptance tests
  (`test/integration/voice-preset.test.js`: R3-13 complete `voice` preset and Talk without a
  runner; `test/integration/view-image-workspace.test.js`: R3-30, M8 acceptance 19;
  `test/integration/subagents-environment.test.js`: R4-70; `test/integration/mail-stopped-session.test.js`:
  D-M6-20, D-M9-5), M8's fold items 4 and 5, M11's F-7 if M6 had not merged when M11's fold
  ended, the regression and perf lists, `architecture.md`, and the ownership-check row of this
  group below (rewritten from what was built).

**Merge order** (X-17): step 3, WX.1, the four lanes in parallel, then merge **M11** (no
`guest/session/` file) and its fold F-1..F-11; **M6** and W6.8 (X-1 exists for M8; the `voice`
preset's M6 half); **M8** and its fold items 1-3 and 6; **M9** (the most runner and factory seams;
its delete hook stands first in the shared array) and W9.F; then WX.F. The shared files each merge
touches are in "Ownership check for parallel groups".

**Session program caps.** 212,483 of the 240,000-byte `sessionProgramBytes` are used on the
step-3 tree (27,517 left, J-1410). Asked: M6 9,000 (D-M6-18), M8 9,000 (D-M8-19, can give back
about 400), M9 32,768 (D-M9-19, derived from its measured guards and peer-sized modules), M11 0
(D-M11-24: no session-side code). Sum 50,768: 263,251 bytes, over the limit. W6.4, W8.1, W8.4 and
W9.8 wait for the owner's ruling (question G-1) and the PM's per-lane caps, which sum to the ruled
limit.

**Caps as set (WX.1, J-1427; G-1's default until the owner rules).** `sessionProgramBytes` is
270,336 everywhere it lives (`guest/lib/limits.js`, `scripts/provision-steps.js`, the factory's
program store `guest/factory/root.js` `maxProgramBytes`, which was the 262,144-byte
`execSourceBytes`; README, `architecture.md` D-4, 11, 12.9): every cap on the path is the
harness's own, none an engine or core limit. The caps are over the step-3 base, 212,484 bytes
measured at `ea4e2c1c11`: **environments (M6) 9,000, context window (M8) 9,000, mail and subagents
(M9) 32,768, voice (M11) 0**, sum 50,768, spare 7,084. WX.1 itself brought the base to **233,126**
(+20,642: the lanes' shared guard lines, `guards/context.js`, `guards/mail.js` with
`mail-limits.js`, the part API), counted against the caps. By line (a keyword attribution of the
bundle diff, about +/- 1 KB): environments about 2,600, context window about 5,400, mail about
11,200, the shared part API about 1,300. So each lane may add over the base after WX.1 (233,126):
**environments 6,400, context window 3,500, mail and subagents 21,500, voice 0** (rounded down;
spare about 5,800 for the group fold). `test/unit/m1a-session-program.test.js` prints the base and
the caps; each lane reports its own growth from `node scripts/bundle-guest.mjs session` against
its line here.

**Journal numbers of the group's units** (WX.1; twenty a unit, from each milestone's own hundred,
then its overflow block, so no two units can write the same number):

| lane | units | numbers |
|---|---|---|
| environments (M6) | W6.1, W6.2, W6.3a | J-0830..J-0849, J-0850..J-0869, J-0870..J-0889 |
| | W6.3b, W6.3c, W6.4, W6.5, W6.6, W6.7, W6.8 | J-12000..J-12019, J-12020..J-12039, J-12040..J-12059, J-12060..J-12079, J-12080..J-12099, J-12100..J-12119, J-12120..J-12139 |
| | PM spare | J-0890..J-0899, J-12140..J-12199 |
| context window (M8) | W8.1, W8.2, W8.3 | J-1030..J-1049, J-1050..J-1069, J-1070..J-1089 |
| | W8.4, W8.5, W8.6, W8.7 | J-12200..J-12219, J-12220..J-12239, J-12240..J-12259, J-12260..J-12279 |
| | PM spare | J-1090..J-1099, J-12280..J-12399 |
| mail and subagents (M9) | W9.1, W9.2, W9.3 | J-1130..J-1149, J-1150..J-1169, J-1170..J-1189 |
| | W9.4, W9.5, W9.6, W9.7, W9.8, W9.9, W9.10, W9.F | J-12400..J-12419, J-12420..J-12439, J-12440..J-12459, J-12460..J-12479, J-12480..J-12499, J-12500..J-12519, J-12520..J-12539, J-12540..J-12559 |
| | PM spare | J-1190..J-1199, J-12560..J-12599 |
| voice (M11) | W11.1, W11.2, W11.3 | J-1330..J-1349, J-1350..J-1369, J-1370..J-1389 |
| | W11.4, W11.5, W11.6, W11.7, W11.8, W11.9 | J-12600..J-12619, J-12620..J-12639, J-12640..J-12659, J-12660..J-12679, J-12680..J-12699, J-12700..J-12719 |
| | PM spare | J-1390..J-1399, J-12720..J-12799 |
| group | WX.1 / WX.F | J-1425..J-1439 / J-1440..J-1479 |
| lane review and fix | environments review, fix | J-12800..J-12819, J-12820..J-12839 |
| | context window review, fix | J-12840..J-12859, J-12860..J-12879 |
| | mail review, fix | J-12880..J-12899, J-12900..J-12919 |
| | voice review, fix | J-12920..J-12939, J-12940..J-12959 |
| | PM spare | J-12960..J-12999 |

The contracts' own blocks stay theirs (M6 J-0810..J-0829, M8 J-1010..J-1029, M9 J-1110..J-1129,
M11 J-1310..J-1329). A unit that runs out asks the PM for twenty from its lane's spare.

**What WX.1 applied (J-1425..J-1439)** and how a lane continues from it:

- Guard entries, in the shared modules, exactly as the contracts list them (M6 15.1-15.4; M8 G-1 to
  G-4, T-1, T-2, S-10c; M9 S2, S2b, S9, S9b, S10, F6, V1, G1, L1, C1; M11 appendix A, H1, H3, H4),
  with the pins re-based once (`guard-fold-map.json` `added`, `changed`, `vocabularyAdded`: 25 new
  entries, 35 changed, 70 keys and 33 methods; the vocabulary is 328 keys and 174 methods).
- An exo must implement every method of its guard, so each new method of an existing interface
  has a "not built here" body: `Session.emergencyStop`/`resume` refuse with
  `noEnvironmentToStop` and `getExecutionState` answers `{ running, supported: false }`
  (`session.js`; the environments lane replaces them, R-3); `SessionInternal.deliverMail` answers
  `{ refused: notBuiltYet }` and `cancelMail` does nothing (mail lane, S5); `TurnSink.compacted`
  answers `{ go: false }` (`turn.js` `makeSink`; context lane, S-5d; also the TurnSink fakes of six
  adapter test files and `perf/provider.perf.mjs`); `Operator.getMail` and `getVoice` refuse with
  `notBuiltYet` (`factory.js`; mail F1, voice H2); `HarnessRoot.configureSpeech` refuses with
  `voiceTexts.speechNotWired` (`root.js`; voice H2b). `standin-session.js` refuses all five.
- The part API: `PartHooks.admit` and `RuntimeHooks.admit` (first refusal in table order),
  `NextTurn.take`, the `restart` hold in `claimNext` (S2), `makeRuntime({ contextWindow })` and
  `Runtime.contextWindow`, `HookTurn.reading`, `ActiveTurn.startIndex` and `compactionAsk`
  (optional until the context lane sets them). Not applied: the claim-path calls of `admit` (M6
  R-2 in `claimNext`, R-4 in `queue.js`, R-3 in `session.js`): the environments lane's.
- Orders: `PartName` names all nine parts and `Runtime` the four to come; each lane adds four
  lines in `runtime-parts.js` (import, `requiredParts`, `runtimeParts`, getter) and two in
  `tool-table.js` (import, spread), each directly below its own `// slot: <name>` comment, so no
  two lanes' lines touch. `requiredParts` gains a part in the lane commit that adds it.
- Shared exports: `guest/session/tools/call-table.js` `makeCallTable` (C1, S-6); `tools/objects.js`
  `readArgs` and `labelsOf` (S-10c, L1).
- Reserved: `scripts/provision-steps/60-environments.js` and `70-voice.js` (no files); the
  regression and perf lists `environments`, `context`, `mail`, `voice` (empty).
- `CORE-CHANGES.md`: CC-090 (with CC-091), CC-092, CC-100, CC-101, CC-110, CC-111, CC-112,
  CC-120, all requested, not built.

**Owner questions of the group** (the default is what the lanes build until the owner rules).

| id | question | default |
|---|---|---|
| G-1 (M6 O-12, M8 Q-7, M9 O-M9-8; X-01) | The session program limit cannot hold the four lanes. Raise `sessionProgramBytes` (cold create about 20 ms per KB, J-10192, hidden by the spare pool) or cut features? | raise to 270,336 (about +1.2 s of cold create); PM caps M6 9,000, M8 9,000, M9 32,768, M11 0; ruled before W6.4, W8.1, W8.4, W9.8 |
| G-2 (M6 O-11, M8 Q-8; X-06) | Build the data-reference spike's step 1 now as the one adapter-to-adapter data path for M6 and M8? | later: M6 W6.2 builds `openImage` with adapter-side pages (X-1), both lanes accept the hub-log cost, CC-100 asked once |
| G-3 (M6 O-13, M11 O-11; X-12) | Talk on a state with no environment runner, where the built-in `voice` preset needs a shell | refuse with `runnerRequired`; the Voice panel offers another shortcut preset |
| M6 O-1 | One `environments` resource instead of `workspace` and `containers`? | one (D-M6-1) |
| M6 O-2 | May a served state use the `fake` runtime (unconfined host processes)? | yes when configured so; `status()` and `inspectShell` say `fake`; provisioning never picks it unasked |
| M6 O-3 | Delete home with the session (R3-46: until admin disposal)? | delete with the session |
| M6 O-4 | Container limits (W-12; R7-39 found none) | 4 GiB memory, 1,024 processes, 2 CPUs, configurable |
| M6 O-5 | Default command timeout | 24 h (R3-47) |
| M6 O-6 | A failed environment stop: quarantine (R4-81) or retry (D-16)? | retry at the next adapter start and before the environment runs again |
| M6 O-7 | Git surface: linked worktrees, tree views, commit stream, `show`, `revParse`, `detach`, `checkoutConflict` | not in M6; backlog |
| M6 O-8 | Where the resource's guard table lives | `guest/lib/guards/environments.js`, excluded from the gateway vocabulary as not browser-sendable |
| M6 O-9 | Export and import of a session with an environment | workspace and home not exported (an import gets a fresh workspace); the execution state is, and an imported stopped session stays stopped |
| M6 O-10 | Fixed texts | Fae's words where they exist; five reworded texts as in contract section 15 |
| M8 Q-1 | Pin the compaction boundary at an unknown tool outcome only while its turn is kept and unresolved (lal refuses to compact at all)? | pin while kept and unresolved |
| M8 Q-2 | Send at most the newest 20 images natively per request? | 20 |
| M8 Q-3 | Backfill a window for Anthropic API sessions created before M8? | leave them; new sessions get 200,000 |
| M8 Q-4 | A plan or summary that cannot reduce: skip or fail the turn? | skip |
| M8 Q-5 | Image sources speak the harness's page read only, not Endo's `streamBase64`? | page read only |
| M8 Q-6 | One Anthropic window for every model, or a per-model table? | one value, 200,000 |
| M9 O-M9-1 | Own mail rather than reusing or wrapping core mail (AR-SYN-15)? | own mail; P-62 interop later through a bridge |
| M9 O-M9-2 | Mail cut off by shutdown: handled again (R4-59) or at most one turn per message (R4-57)? | at most one turn; the sender gets `Error: ...` |
| M9 O-M9-3 | `definition` messages and `endow` (R3-218) | not built |
| M9 O-M9-4 | 65,536 retained closed asks (R4-102) | a 4,096-postmark ring and the transcript |
| M9 O-M9-5 | Inbox bound (G-13) | 256 messages per session, refuse when full |
| M9 O-M9-6 | Mail waiting across a restart | dormant until the session next wakes (D-5) |
| M9 O-M9-7 | The operator's mail UI | M12's Home view |
| M9 O-M9-9 | Should `adopt` reach a subagent's reply attachments? | reported only |
| M9 O-M9-10 | `dismiss` as a model tool (not in A.3) | offered, for `kept` messages only |
| M9 O-M9-11 | A child's `systemPrompt` inline (8,192 bytes) where R3-39 allows 1 Mi characters | inline; large input goes in the task |
| M9 O-M9-12 | Should an M13 upgrade re-bind imported mail through postmarks? | imported mail is read-only in M9; M13 decides |
| M11 O-1 | Build the `openai-audio` kind now, with partials by re-transcription? | build; partials on every 1.5 s, interval in the settings |
| M11 O-2 | Speak only voice-started sessions (R5-52 says every UI session)? | voice-started only |
| M11 O-3 | Replay per turn or per message? | per turn |
| M11 O-4 | Harness downloads of Piper voices or Moonshine weights (R8-43)? | none; the operator and `uv` do it |
| M11 O-5 | Audio on its own binary `/audio` route instead of CapTP? | binary route |
| M11 O-6 | A warm spare Piper process (R5-66 improved) | on |
| M11 O-7 | Re-speak a running turn after a reconnect? | no; the page offers Replay |
| M11 O-8 | A launch interrupted inside the creation window may leave one extra session (K11-4) | accept |
| M11 O-9 | Where the voice-shortcut preset is chosen | the Voice panel |
| M11 O-10 | Speech keys from API-key `Secret`s only | API keys only |
| M11 O-12 | Start speech engines at first use in each incarnation instead of at every start (R8-29 departure) | first use |

**Core requests of the group** (none is reserved unbuilt work for a lane: every one has a harness
workaround the lanes build).

| id | asked by | change | same change as | status |
|---|---|---|---|---|
| CC-090 | M6 | a service shape for native resources: the manager kit's `provideAdapter()`, `installNative(name, directory, config)` with a passable config record, the launcher passing `{ stateDirectory }`; workaround `resources/native-attach.js`, configuration through the service spec | AR-SYN-28, core step 4 (with its `WORKSPACE_VERSION` bump); CC-091 merged into it | requested, not built |
| CC-091 | M6 (draft) | install-time configuration | merged into CC-090; unused | - |
| CC-092 | M6, used by M11 K11-1 | name each adapter process (installation, pid) in `status()`; workaround the shared helper `test/integration/_adapter-processes.js` | - | requested, not built |
| CC-100 | M8 and M6 (one row) | frames between two transient adapter sessions are not persisted in `hub-log.jsonl` (+2.9-3.0 MB per MiB measured); workaround bounded base64 pages and log compaction | a policy of core step 3's persisted session kinds | requested, not built |
| CC-101 | M8 | a large binary as a data reference | the data-reference spike's step 2 (after core C-1, C-2) | withdrawn from this group |
| CC-110 | M9 | a call pending into a vat given up during startup never settles; workaround re-drive at each start, asks stamped with an earlier start closed | core candidate C-10 (core step 2), not a new request | recorded as C-10 |
| CC-111 | M9 | third-party handoff of relayed presences inside one hub; workaround at most 32 attachments, references dropped after delivery, `mail.hubGrowth` | core step 3's handoff question | routed there, not built |
| CC-112 | M9 | a per-vat idle-sleep exemption for the factory vat; not needed for the budgets | - | requested, not built (low) |
| CC-120 | M11 (conditional) | an adapter process exits when its supervisor dies even if its IPC channel stays open; asked only if K11-1 finds an engine alive | - | reserved, not asked |

The PM writes the rows of `CORE-CHANGES.md`: one for CC-090 under AR-SYN-28, one for CC-100
naming M6 and M8, CC-101 as spike step 2, CC-110 as C-10.

---

## M6. Containers and git workspace

**Status: contract settled, not built.** Reference: `m6-interfaces.md` (work units 8, acceptance
9, perf 10, probes 11, fold 14); guards and texts `guest/lib/guards/environments.js`.

**Goal.** Development sessions: a per-session rootless container with `/workspace` backed by the
session's live git workspace, a branch-tracking git capability, emergency stop.

- **P:** P-19, P-18, P-55, P-47, P-12 (shell part), P-20 (shell presets `development`,
  `new-project`, `voice` objects, `general` as selected). `full-control` waits for open decision 5.
- **R:** R2-7, R3-12, R3-13 (M6 half), R3-14, R3-15, R3-21, R3-30 (`openImage`, X-1), R3-37,
  R3-40, R3-44..R3-47, R3-240, R3-246, R3-247, R3-248, R3-266, R4-7, R4-8, R4-49, R4-81 (improved,
  D-16), R6-50, R6-57, R7-9, R7-36, R7-39, R7-65, R8-41, R8-42; W-12, G-29. Deferred: R3-10 (M7),
  R3-16 (open decision 5).
- **Depends on:** M5, cleanup step 3, WX.1; W6.4 also on the session-program ruling (G-1). Parallel
  with M8, M9, M11; merges second.
- **Owns:** `H/resources/environments/` (`durable.js`, `ephemeral.js`, `impl/`),
  `H/resources/native-attach.js`, `H/guest/lib/guards/environments.js`,
  `H/guest/session/environment.js`, `H/guest/session/tools/shell.js`,
  `H/guest/factory/environments.js`, `H/guest/lib/environment-prompt.js`, `H/ui/src/environment/`,
  `H/scripts/provision-steps/60-environments.js`, `H/test/fixtures/fake-bin/oci-cli.mjs`, the test
  and perf files of the table; seams R-1..R-4, X-E, T-1, L-1 (session), F-1..F-5, P-1 (factory),
  C-1 (`AH/composer.js`), K-1 (`package.json`), K-2 (`scripts/test-integration.mjs`).

**Work units** (W6.1-W6.6 in parallel after WX.1, disjoint files; journal ranges PM assigns;
J-0817..J-0829 kept for the PM's notes)

| id | files owned | behaviour | tests | depends on |
|---|---|---|---|---|
| W6.1 resource core | `EV/durable.js`, `EV/ephemeral.js`, `resources/native-attach.js`, `EVI/index.js`, `EVI/ops.js`, `EVI/layout.js`, `scripts/provision-steps/60-environments.js` | manager records, amplification, forwarding with reattach, read retry and write `outcomeUnknown`, stopped and released refusals, withdrawn set, pending work; loader; state layout; attach and sweep at bind; provisioning | `environments-manager`, `environments-layout`, `environments-provision` (adapter), `native-attach` (unit) | WX.1; its `index.js` composition after W6.2, W6.3b, W6.3c export |
| W6.2 git and images | `EVI/git.js`, `EVI/image-source.js`, `H/package.json` (K-1) | every `Git` op on `@endo/git`, answers cut to `answerBytes`, ref and path checks, read-only refusal, serial per workspace, stale-lock removal, `SourceReader.read`; `openImage` and the adapter-side `ImageSource` (X-1) | `environments-git` (exo-git conformance subset, `[real-git]`), `environments-git-hostile`, `environments-image-source` | WX.1 |
| W6.3a OCI runtime | `EVI/runtime-oci.js`, `EVI/images.js`, `test/fixtures/fake-bin/oci-cli.mjs` | argv of start, exec, stop, remove, sweep for podman and docker; pin form and presence; timeout kills by process group | `environments-runtime-oci` (fake CLI everywhere; `[real-runtime]` gated) | WX.1 |
| W6.3b fake runtime and runner | `EVI/runtime-fake.js`, `EVI/runner.js` | lazy start, idle stop, stop, release, sweep from `run/`, timeout then kill after 2 s, scrubbed env, allowlist | `environments-runner`, `environments-fake-runtime` | WX.1 |
| W6.3c shell port and output | `EVI/shell-port.js`, `EVI/command-args.js`, `EVI/command-output.js`, `EVI/blob-access.js` | model-JSON parsing with Fae's texts, the tool-path output budget, staging through `BlobWriters`, staged args through `Content`, refusal of a withdrawn key | `environments-shell-port`, `environments-command-output` (property test: valid JSON, at most 32,768 units) | WX.1 |
| W6.4 session part and tools | `guest/session/environment.js`, `guest/session/tools/shell.js`; seams R-1 (`runtime-parts.js`), R-2 (`turn.js` `claimNext`), R-3 (`session.js`), R-4 (`queue.js`), X-E (`export.js`), T-1 (`tool-table.js`), L-1 (`label-seeds.js`) | the `environment` part, `runCommand` and `inspectShell`, cancel (`hooks.onCancel`), recovery (`hooks.onRecover`), emergency stop and resume, admission refusals (`hooks.admit`), export and import of the execution state | `session-environment`, `session-shell-tool`, `session-environment-export` (unit, crank order; bundle within M6's cap) | WX.1; the PM's caps |
| W6.5 factory and prompt | `guest/factory/environments.js`, `guest/lib/environment-prompt.js`; seams F-1 (`preset-templates.js`), F-2 (`services.js`), F-3, F-4 (`factory.js`), F-5 (`root.js`), P-1 (`prompt-sections.js`) | availability by setting, provide on creation, binder after make, releaser on rollback, the delete hook (children first), prompt part 6 | `factory-environments`, `environment-prompt` (unit) | WX.1 |
| W6.6 UI and composer | `ui/src/environment/{feature,ExecutionPanel,texts}.js`; seam C-1 (`AH/composer.js`) | Settings "Sandbox execution": state, Emergency stop, Resume; hidden when unsupported; a refused submission's staged file deleted | `ui-environment` (unit), `test/browser/environment-ui.test.mjs` | WX.1 |
| W6.7 integration (last) | `test/integration/{_environments,_adapter-processes}.js`, `environments-{shell,restart,stop,presets}.test.js`, `perf/environments{,-git,-restart}.perf.mjs`; seam K-2 | acceptance and perf on the combination; the `environments` template and regression list | each integration file under 5 min; each perf file under its time | W6.1-W6.6 |
| W6.8 fold (after the merge) | contract section 14 | deletion of every seam, copy and stub; X-1 aligned after M8; documents | the greps and tests of section 14 | the M6 merge |

**Acceptance** (test files under `test/integration/` unless named; `[real-runtime]` repeated in an
owner run)

1. Pin refusal: a non-digest pin refused; an absent image puts the runner in `refused`. `environments-runtime-oci.test.js` (fake CLI); `[real-runtime]`.
2. One repository: `runCommand(git ...)` and `E(workspace)` see each other's commits. `environments-shell.test.js`.
3. Command contract: allowlist, exit as data, 64 KiB per stream, timeout then SIGKILL after 2 s, 10 MiB stdout gives valid JSON of at most 32,768 units, staged. `environments-shell-port.test.js`, `environments-command-output.test.js`, `environments-shell.test.js`.
4. Home survives turns and a SIGKILL restart; delete removes directory, container and records. `environments-restart.test.js`, `environments-stop.test.js`.
5. Git surface: no `gitAbsentMethodNames` method; the reader refuses writes; `trackingStatus` has no upstream. `environments-git.test.js`, `environments-shell.test.js`.
6. Emergency stop fences, holds, cancels, stops, withdraws (manager and adapter), survives SIGKILL; resume keeps the queue held. `environments-stop.test.js`, `session-environment.test.js`.
7. One `exec`, one `runCommand`, one `echo` in a round run concurrently (under 1.6 x one call), results in call order. `environments-shell.test.js`.
8. After a SIGKILL and restart no container runs until a first command; leftovers are gone. `environments-restart.test.js`.
9. `[real-runtime]` isolation: uid 1000, `CapEff` 0, read-only outside the three paths, only `lo`. `environments-runtime-oci.test.js` (gated).
10. Cancel during `sleep 600` ends `cancelled` within 1 s and kills the process. `environments-shell.test.js`.
11. Killing the environments adapter alone gives `commandOutcomeUnknown`; the turn continues. `environments-restart.test.js`.
12. SIGKILL during a command: turn `outcome-unknown`, process gone, next command works. `environments-restart.test.js`.
13. Delete during a command completes; directory and process gone. `environments-stop.test.js`.
14. Presets: without the setting `development`, `voice`, `new-project`, `general` with objects are unavailable (`runnerRequired`); with it, available with the right objects. `environments-presets.test.js`.
15. `inspectShell` answers its three fields and no host path. `environments-shell.test.js`.
16. `readSources` over the workspace; `..` refused. `environments-shell.test.js`.
17. Reachability: no `EnvironmentsAdmin` or other session's objects reachable; no state path in any vat heap, journal or snapshot. `environments-presets.test.js`.
18. `sh -c env` lists only A.3's variables. `environments-shell.test.js`; `[real-runtime]`.
19. UI: Sandbox execution, Emergency stop, Resume. `test/browser/environment-ui.test.mjs`.
20. Bounded state: 20 sessions created and deleted leave the record count as before (gate). `environments-stop.test.js`.
21. Workspace images (X-1): `openImage` pages reassemble the file; bad paths refused; withdrawn after stop. `environments-image-source.test.js`, `environments-shell.test.js`.
22. Export and import of a stopped session keep it stopped, held and withdrawn; resume works. `session-environment-export.test.js`, `environments-stop.test.js`.

Cross-lane (WX.F): the complete `voice` preset, `viewImage` of a workspace path, a shell-preset
subagent's own workspace and shell, mail to an emergency-stopped session.

**Perf** (60 s windows; gate rows pass or fail; recorded rows set their budget from the first run)

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `environments.runTrue` (overhead over the runtime) | `perf/environments.perf.mjs` | 60 s | median <= 150 ms; 1 session, 0 manager deliveries | 70-76 ms vat-adapter-vat (J-9043), spawn 1.0 ms (J-0811) |
| `environments.firstCommand` | same | 60 s | median <= 500 ms | manager hop 151-175 ms (J-0222) |
| `environments.sessionCreate` (`development` minus `chat-only`) | same | 60 s | median <= 175 ms | one manager crank (J-0494) + 3 handles at 7-15 ms |
| `environments.cancel` | same | 60 s | recorded (expected <= 1 s) | - |
| `environments.stopCleanup` | same | 60 s | recorded | - |
| `environments.tooBig` (10 MiB stdout) | same | gate, 5 runs | each <= 2 s; <= 32,768 units; 0 halts | 329 ms drain (J-0811) |
| `environments.bundles` | same | gate | session growth <= M6's cap; manager bundle <= 80 KB; install <= 5 s | J-1410, J-0193 |
| `environments.gitStatus` (10,000 files, from exec code) | `perf/environments-git.perf.mjs` | 60 s | median <= 1 s | git 30 ms (J-0811) + 2 x 75 ms + 53 ms + inbound bytes |
| `environments.gitLog` (50 of 1,000 commits) | same | 60 s | median <= 500 ms | git 12 ms (J-0811) + the same hops |
| `environments.restart` (20 sessions with environments) | `perf/environments-restart.perf.mjs` | gate, 5 runs | each <= 15 s; 0 containers started; 0 idle vats woken | restart 3.3-6.9 s (J-9382) |
| `environments.coldStart` `[real-runtime]` | `perf/environments.perf.mjs` (gated) | 10 runs | recorded | - |

File times: about 6, 3 and 3 minutes. Probes: contract section 11.

**Fit risk:** awkward. Lazy desired state (D-16) because `restore` re-binds every registration;
workspace projection into a Podman machine VM on macOS without root is environment-specific; no
container number is measured yet (docker and podman not available at contract time).

**Deferred:** network policy and egress (M7), publishing (M10), `full-control` (open decision 5),
the git surface of O-7.

---

## M7. Network policy and public egress

**Goal.** Per-session network policy `off` / `public-internet` under an operator ceiling, agent
requests and operator approval, and public-only egress for shells.

- **P:** P-38, P-39, P-04 (internet toggle in the new-session flow).
- **R:** R2-8, R2-21, R3-10, R3-36, R3-48, R3-49, R6-56, R7-10, R7-41, R7-54, R7-55, R7-56, R8-15.
- **Depends on:** M6. Parallel with M10 and M12.
- **Owns:** `H/resources/environments/impl/egress/` (proxy, DNS, policy; moved from
  `resources/containers/egress/` by the M6 contract, 6.4 M-1, because M6 builds one
  `environments` resource), `H/guest/session/network-policy.js`,
  `H/guest/session/tools/network.js`, `H/ui/src/network/`, entries in `session-options.js` and
  a file under `scripts/provision-steps/`, test files named by subject (review rule 1),
  `H/perf/egress.perf.mjs`.
- **Moved here by the {M6, M8, M9, M11} contracts:** R3-10 and the internet-dependent preset
  parts M6 leaves (`general`'s shell "because internet is on", `new-project`'s shell while
  internet is on, the default preset `general`, R3-20); `setNetworkPolicy` goes into one batched
  change of `EV/durable.js` with M10's route methods (M6 M-1, review rule 5); M9's seam N1
  (`networkPolicy` in `SpawnRequest`, so a subagent inherits the parent's current policy).

**Work units:** W7.1 egress proxy + DNS in the containers adapter (adapted from
`hosted-agent/src/public-egress*.js`, `public-dns-listener.js`, policy from `hosted-agent-policy.js`):
80/443 only, public addresses only, host's own refused, caps (connections, bytes, time, configurable
lower than Endo's 1 TiB/24 h). W7.2 session policy record, `requestNetworkPolicyChange` (pending
request, one at a time), operator approval with note applies next turn and restarts the environment,
audit. W7.3 UI panel and the new-session internet toggle (only where the preset allows).

**Acceptance tests**
1. `off`: the container cannot resolve or connect `[real-podman]` (fake: policy object refuses).
2. `public-internet`: HTTPS to a public host works; 10/8, 127/8, 169.254/16, 100.64/10, host addresses
   and other ports refused (proxy unit tests run everywhere with a fake resolver).
3. Agent request records a pending request and grants nothing; a second while pending is refused;
   approval applies at the next turn and restarts the environment; every step audited.
4. New-session flow: the internet toggle is offered only for presets that allow it, and the created
   session's policy matches the toggle (P-04).

**Perf checks:** `egress.connectSetup` <= 50 ms over direct; `egress.throughput` >= 50 MB/s loopback;
policy change to next turn <= environment restart time + 1 s.

**Fit risk:** good (all Node); the real container networking is environment-specific.

**Deferred:** daemon-side outbound filtering (W-11).

---

## M8. Compaction, images and context window

**Status: contract settled, not built.** Reference: `m8-interfaces.md` (seams 10, work units 11,
acceptance 12, perf 13, probes 14, fold 18); constants and guards in `guest/lib/guards/context.js`,
`guest/lib/guards/images.js`, `guest/lib/image-guards.js` (Node only) and
`AH/providers/compaction-texts.js`, frozen until the fold.

**Goal.** Long sessions keep working: automatic compaction at 70 % of the context window,
`viewImage` image input, the window known for every backend kind.

- **P:** P-36, P-37, P-27 (window share).
- **R:** R3-30, R4-32 (images), R4-33, R4-34, R4-35, R4-36, R4-37 (open decision 13), R4-39,
  R4-100, R6-52.
- **Depends on:** M5, cleanup step 3, WX.1; W8.1 and W8.4 also on the session-program ruling (G-1).
  Parallel with M6, M9, M11; merges third, after M6 (so X-1 exists).
- **Owns:** `guest/session/compaction.js`, `guest/session/tools/view-image.js`,
  `AH/providers/{compaction,compaction-round,images}.js`, `AH/tools/view-image.js`,
  `guest/lib/guards/{context,images}.js`, `guest/lib/image-guards.js` and
  `AH/providers/compaction-texts.js` (until the fold), the test and perf files of the table; seams
  S-5..S-20 (G-1..G-5, T-1, T-2 and S-10c are WX.1's). X-1 (`Git.openImage`) is built by M6 W6.2.

**Work units** (W8.2, W8.3, W8.5, W8.6 start right after WX.1; W8.1 and W8.4 after the ruling and
M8's cap; disjoint files; journal ranges PM assigns, at least 20 each)

| id | files owned | behaviour | tests | depends on |
|---|---|---|---|---|
| W8.1 session compaction | `guest/session/compaction.js`; seams S-5 (`turn.js`), S-6 (`session.js`), S-7 (`runtime-parts.js`), S-8 (`turn-import.js`), S-9 (`archive.js`) | the decision (crank X, `hooks.beforeRound`), the ask, the adapter's answer (crank Y), the context window object, export and import | `context-guards`, `compaction-decision`, `compaction-sink`, `compaction-import` (unit); step 3's crank-order suites unchanged | WX.1; ruling and cap |
| W8.2 plan and summary | `AH/providers/compaction.js` (pure) | the plan, the summary request and its checks, the projection hook | `compaction-plan`, `compaction-summary`, `compaction-hook` (adapter) | WX.1; `imageReceiptText` (W8.6 first commit) |
| W8.3 adapter wiring | `AH/providers/compaction-round.js`; seams S-10 (`projection.js`), S-11 (`projection-hooks.js`), S-12 (`archive/store.js`), S-13 (`context-cache.js`), S-14 and S-18 (`endpoint.js`, `AH/index.js`), S-15 (`round.js`, `api.js`, `subscriptions/provider.js`), S-16 (`scripted.js`), S-17 (`transcript-records.js`) | round step 2b, cache rebase, projection, the `viewImage` adapter-tool registration | `compaction-round`, `context-cache-compaction`, `compaction-scripted`, `image-tool-offered` (adapter) | WX.1; W8.2 functions (stubs); W8.5 first commit |
| W8.4 viewImage entry | `guest/session/tools/view-image.js`; seams S-10b (`tool-table.js`), S-10d (`tool-args.js`) | the session's `viewImage` entry: argument checks before any send, the request carries the object | `view-image-entry` (unit) | WX.1; ruling and cap; W8.1's part API (fake) |
| W8.5 image tool | `AH/tools/view-image.js`; `test/spikes/byte-array-passing.test.js` | `ImageTool`: sources, 2 MiB and magic-byte checks, staging; the byte-array probe | `image-tool` (adapter), the spike | WX.1 |
| W8.6 image wire and window | `AH/providers/images.js`; seams S-19 (`anthropic.js`, `openrouter.js`, `subscriptions/responses.js`), S-20 (`anthropic.js` `readModels`) | native image input per wire, 20-image cap, receipts; the Anthropic 200,000-token window | `image-wire` (adapter); one case in `m2-w22-catalog.test.js` | WX.1; W8.3's `incomplete` flag (fixture until then) |
| W8.7 integration (last) | `test/integration/{compaction,compaction-archive,view-image}.test.js`, `perf/{compaction,images}.perf.mjs` | acceptance 1-18 end to end, perf, probes | integration files under 5 min; perf files under 10 | W8.1-W8.6 |
| M8 fold (after the merge) | contract section 18 items 1-3, 6 | guard and text modules folded into the vat tables and `limits.js`; `compaction-texts.js` merged | greps of section 18 | the M8 merge |

**Acceptance** (`[owner]` = a real-provider repeat)

1. A forced small window crossing 70 % writes a `compaction` record with the R4-36 headings; the next request starts with the summary, the last directive verbatim, then the tail; unknown outcomes stay visible. `compaction.test.js`.
2. SIGKILL during the summary call: turn `outcome-unknown`, no `compaction` record, next request uncompacted. `compaction.test.js`.
3. `viewImage` of a 1 MiB PNG reaches the fake Anthropic server as an image block; 3 MiB refused with the fixed text; the transcript shows the receipt. `view-image.test.js`.
4. A round with a new image is not followed by a compaction ask. `compaction-decision.test.js`.
5. No ask when the reading or window is unknown, below threshold, after a skip, right after a compaction, past 4 per turn. `compaction-decision.test.js`.
6. The plan keeps complete groups, a tail within half the headroom, the directive, and never passes an unresolved unknown outcome. `compaction-plan.test.js`.
7. Summary tokens charged to the turn and the session; the reading after it is the next real round's. `compaction-sink.test.js`, `compaction.test.js`.
8. Phases `compacting context` then `thinking`, in order. `compaction-sink.test.js`, `compaction.test.js`.
9. A 300-turn imported session compacts, is killed and restarted: same context, archive starts at the boundary, history from turn 1. `compaction-archive.test.js`.
10. Export and import of a compacted session keep summary and tail. `compaction-import.test.js`, `compaction-archive.test.js`.
11. Kill points K1-K7 and I1-I4 give the contract's outcomes; never two `compaction` records. `compaction.test.js`, `context-cache-compaction.test.js`, `image-tool.test.js`, `view-image.test.js`.
12. Each wire carries the image natively. `image-wire.test.js`; `[owner]` once per real backend kind.
13. An incomplete turn's image and the 21st image go as receipts. `image-wire.test.js`.
14. `viewImage` argument errors, unknown label, non-image, over the limit, 65 empty pages, lost source: fixed texts, the turn continues. `view-image-entry.test.js`, `image-tool.test.js`.
15. A new Anthropic API session stores a 200,000-token window; `getUsage().context` reports it. `m2-w22-catalog.test.js`, `compaction.test.js`.
16. Image bytes never enter a vat: largest frame into the session vat under 4 KB (perf gate row). `perf/images.perf.mjs`.
17. A plan that cannot reduce records `compaction-skipped` and the turn completes. `compaction-round.test.js`, `compaction.test.js`.
18. `[owner]` A Claude pool session passes 70 % in normal use, compacts and continues coherently.
19. Cross-lane (WX.F): `viewImage` of a PNG in the session's workspace through `Git.openImage`; no frame over 4 KB into M6's manager or the session vat. `test/integration/view-image-workspace.test.js`.

**Perf** (60 s windows; templates, never replayed turns)

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `compaction.plan` (150,000 tokens, adapter only) | `perf/compaction.perf.mjs` | 60 s | <= 50 ms | sizing 0.9-3.4 ms (J-1010), projection 7.5 ms (J-0491) |
| `compaction.overhead` (crank X to the real request, minus the summary call) | same | 60 s | <= 300 ms; +1 session delivery per compaction | answered call 70-76 ms (J-0161, J-9043) |
| `compaction.record` | same | gate, in that window | exactly 1 delivery per compaction | D-M8-1 |
| `compaction.prepareAfter` | same | in that window | <= 15 ms; 0 vat pages | prepare 0.6-7.5 ms (J-0491) |
| `compaction.flat` (5,000 against 200 turns) | same | 60 s per length | ratio <= 1.25 | J-0491, J-9413 |
| `compaction.rebuild` (300-turn compacted session after restart) | same | 60 s of cycles | <= 1.25 x M2's 200-turn rebuild | 85-359 ms (J-9404, J-0461) |
| `images.view` (1 MiB, adapter-held source) | `perf/images.perf.mjs` | 60 s | <= 400 ms; 0 extra session deliveries | 6 pages x 20-25 ms (J-0161) + staging + 70 ms |
| `images.viewFromVat` (source in a guest vat, 20,480-character pages) | same | 60 s | recorded; <= 6 s | 69 pages x about 70 ms = 4.8 s (J-0461, J-9043) |
| `images.requestBuild` | same | 60 s | <= 15 ms per 2 MiB image | 12 ms parse and check (J-1010) |
| `images.contextPrepare` (20 images of 2 MiB) | same | 60 s | <= 50 ms; under `maxTextUnits` | 56 M of 128 M units |
| `images.frameIntoVat` | same | gate, every view | < 4 KB | StagedText about 3.5 KB |
| `session.program` | `perf/session.perf.mjs` | gate | M8 adds <= its cap (asked 9,000) | J-1410, J-10192 |

File times: about 7 and 6 minutes. Probes: contract section 14.

**Fit risk:** good. The vat decides and records; the adapter plans, summarizes and carries bytes;
nothing large enters a vat. The risk is the number of small seams in shared files, all
append-only or one statement.

**Deferred:** a forced-compaction switch beyond tests; a `readBytes` image page (probe 6.6);
images shown to the user (R6-62).

---

## M9. Mail and subagents

**Status: contract settled, not built.** Reference: `m9-interfaces.md` (seams 6, work units 7,
acceptance 8, restart files 9, perf 10, probes 11, fold 12); guards and limits in
`guest/lib/guards/mail.js` (session vat), `guest/lib/guards/post-office.js` (factory) and
`guest/lib/mail-limits.js`, until W9.F.

**Goal.** Agents talk to each other and to the operator: mail with packages and typed requests,
mail-started turns, and subagents with tree and depth limits that survive restart.

- **P:** P-41, P-42; prompt part 4 (delegation).
- **R:** R3-33, R3-34, R3-39, R3-214, R3-215, R3-216, R3-217, R3-218 (no `define`/`endow`),
  R3-272, R4-5, R4-57, R4-58, R4-59, R4-67, R4-69, R4-70, R4-71, R4-72, R4-73, R4-101, R4-102,
  R7-43, R7-44.
- **Depends on:** M5, cleanup step 3, WX.1; W9.8 also on the session-program ruling (G-1).
  Parallel with M6, M8, M11; merges last of the four.
- **Owns:** `guest/session/{inbox,subagents}.js`, `guest/session/tools/{mail,requests,subagents}.js`,
  `guest/factory/{post-office,operator-mail,subagents}.js`, `guest/lib/{mail-text,mail-prompt}.js`,
  `guest/exec/split-args.js`, `guest/lib/guards/{mail,post-office}.js` and `guest/lib/mail-limits.js`
  (until W9.F), the test, fixture and perf files of the table; seams S1, S3-S8 (session), X1
  (`guest/exec/inspect.js`), F1-F5, F7 (factory), A1 (`AH/blobs.js`). N1 (`networkPolicy` in
  `SpawnRequest`) is M7's.

**Work units** (group A in parallel, then group B, then W9.10; journal ranges PM assigns inside
J-1100..J-1199; J-1110..J-1129 are the contract's)

| id | files owned | behaviour | tests | depends on |
|---|---|---|---|---|
| W9.1 inbox (A) | `guest/session/inbox.js`, `guest/lib/mail-text.js` | the `inbox` part: delivery rule, duplicate ring, 256 bound, states, `nextTurn` with `take`, claim and settle, cancel, views, dismiss, export and import pages | `session-inbox`, `mail-text` (unit) | WX.1 |
| W9.2 mail tools (A) | `guest/session/tools/{mail,requests}.js` | `listMessages`, `send`, `reply`, `dismiss`, `resolveRequest`, `rejectRequest`, `submitForm`; refusals before any send | `mail-tools`, `request-tools` (unit) | WX.1 (L1) |
| W9.3 subagent tools (A) | `guest/session/{subagents,tools/subagents}.js` | the `subagents` part on WX.1's call table; spawn, ask, stop; deadlines; cancel and recovery | `subagent-tools` (unit) | WX.1 (C1, L1) |
| W9.4 post office (A) | `guest/factory/{post-office,operator-mail}.js` | addresses, outboxes, `post`, postmarks, in-flight count and bytes, receipts, reply correlation, restart re-drive; operator mailbox and tickets | `post-office`, `operator-mail` (unit) | WX.1 |
| W9.5 subagent tree (A) | `guest/factory/subagents.js` | `Delegation`, admission counting spawns in flight, depth, hidden children, inheritance (backend, model, effort, preset snapshot), depth-first stop, `deleteChildren`, restart | `subagent-tree` (unit) | WX.1; W9.4's `post` (stand-in) |
| W9.6 relay copy (A) | `AH/blobs.js` (A1) | `RelayWriters.copy`: link, cut, suffix; quota; fsync through `AH/files.js` | `blob-copy` (adapter) | WX.1 |
| W9.7 split arguments (A) | `guest/exec/split-args.js`; seam X1 | the `splitArgs` inspector op | `exec-split-args` (unit) | WX.1 (S10) |
| W9.8 session wiring (B) | seams S1 (`runtime-parts.js`), S3 (`packages.js`), S4 (`tool-args.js`), S5 (`session.js`), S6 (`tool-table.js`), S7 (`export.js`), S8 (`label-seeds.js`) | the two parts and tool entries registered; `deliverMail`, `cancelMail`; inbox export; the `user` seed; bundle within M9's cap | `session-mail-wiring`, `session-mail-export` (unit) | W9.1, W9.2, W9.3 |
| W9.9 factory wiring (B) | seams F1-F3, F5 (`factory.js`, `rows.js`), F4 (`services.js`), F7 (`prompt-sections.js`); `guest/lib/mail-prompt.js` | post office, operator mail, subagents in the kit; builders; hidden rows; the delete hook (first); start steps; `Operator.getMail`; prompt parts 2 and 4 | `factory-mail-wiring`, `mail-prompt` (unit) | W9.4, W9.5 |
| W9.10 integration (C, last) | `test/integration/{mail,mail-restart-delivery,mail-restart-turn,subagents,subagents-restart}.test.js`, `perf/{mail,subagents}.perf.mjs`, mail fixtures under `test/fixtures/` | acceptance 1-22, perf and gate rows, probes; the `test:regression:mail` list | integration files under 5 min (restart files split by kill point); perf files under 10 | W9.6-W9.9 |
| W9.F fold (after the merge) | contract section 12 | guard modules and limits folded into the vat tables and `limits.js`; V1 entries removed | greps; guards-split and vocabulary tests | the M9 merge |

**Acceptance** (`[real-provider]` repeats of 1, 5 and 9 in an owner run)

1. An operator package with an attachment starts a turn; `adopt` binds it; an un-adopted attachment is released. `mail.test.js`.
2. A typed request answered with `resolveRequest`; an unanswered completed turn rejects with "Agent ended the turn without a typed answer"; a failed turn keeps it listed. `mail.test.js`.
3. Forms: wrong kind, missing field (default or refusal), valid submission posts a `value` message. `mail.test.js`.
4. At most one turn per message across SIGKILL at KM2-KM5; the sender gets `Error: ...` at KM4 and KM5. `mail-restart-delivery.test.js`, `mail-restart-turn.test.js`.
5. B `send`s to A: A's turn runs; B receives one `reply` that starts no turn; a failing turn replies `Error: ...`. `mail.test.js`.
6. Senders cannot be forged; a foreign postmark is "Mail fraud: unrecognized parcel"; a non-address recipient is refused without a call. `mail.test.js`.
7. A child is hidden, titled `<parent> / <name>`, inherits backend, model, effort, preset snapshot (a pool parent's child gets the same Backend), holds only `user` and its attachments. `subagents.test.js`.
8. Nine spawns in one round admit eight (R4-71 text); depth 2 gets no subagent tools; `maxDepth` 0 removes them. `subagents.test.js`.
9. `askSubagent` answers; 100,000 characters cut with the R4-46 marker; one ask per child; timeout cancels the child's turn. `subagents.test.js`.
10. `stopSubagent` deletes deepest first; deleting the parent deletes both children and their blobs. `subagents.test.js`.
11. An ask across a SIGKILL (KM7, KM8) ends outcome-unknown, no reply reaches the parent. `subagents-restart.test.js`.
12. Replies claimed by their ask; own mail never in the own inbox; a late reply stays listed. `mail.test.js`.
13. Bounds: the 257th delivery `inboxFull`; a 20,000-character reply cut; `dismissUnhandled`; an oversized form refused. `mail.test.js`.
14. A 1 MiB task reaches the child as its own copy; the parent's handle is refused to the child. `subagents.test.js`.
15. Twenty idle sessions with waiting mail restart with no vat woken; a UI message runs, then the mail turn. `mail-restart-turn.test.js`.
16. Spawn across a restart (KM9, KM10): no half-made child; the completed one is found by name. `subagents-restart.test.js`.
17. A gateway CapTP client calls `getMail().send`; an unexpected field is refused before decode. `mail.test.js`.
18. Session delete releases staged bodies and drops the address (`recipientLost`). `mail.test.js`.
19. Relay copies are hard links and survive the source's delete. `blob-copy.test.js`.
20. KM12 leaves at most one unreferenced file and no handle without its file. `blob-copy.test.js`.
21. Export and import carry the inbox: listed `kept`, bodies readable, read-only, no turn; KM14 leaves nothing half-imported. `mail-restart-delivery.test.js`, `session-mail-export.test.js`.
22. The in-flight bound holds in bytes: `postOfficeBusy` before 4 MiB of kept envelopes. `post-office.test.js`.

Cross-lane (WX.F): a shell-preset subagent's own environment
(`subagents-environment.test.js`), mail to an emergency-stopped session waiting until resume
(`mail-stopped-session.test.js`), the session program of all four lanes under the ruled limit.

**Perf** (60 s windows unless stated)

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `mail.sessionToSession` | `perf/mail.perf.mjs` | 60 s | median <= 300 ms; <= 4 deliveries per mail | 2 x 33 ms + 118 ms turn start (J-10192) |
| `mail.post.operator` | same | 60 s | median <= 200 ms | 37 ms + 2 x 66 ms (J-9333, J-10192) |
| `mail.throughput` (4 senders, 8 recipients, each post starts a turn) | same | 60 s | >= 3 per second | about 7 deliveries per mail at 29 deliveries/s (J-9408) |
| `mail.inboxCrank` (32 attachments into an inbox of 255, prefilled by import) | same | 60 s | p95 <= 550 ms | 32 x 7-15 ms + about 70 ms (J-0161) |
| `mail.copy` (1 MiB plain / cut) | `test/adapter/blob-copy.test.js` | 200 samples | median <= 5 ms / <= 20 ms | J-0313 |
| `mail.hubGrowth` (120 s of posts with 2 attachments, all settled and dismissed) | `perf/mail.perf.mjs` | 120 s, one measurement | <= 1.25 x fresh | M3 `hub.growth`; finalizers within 32 cranks |
| `subagent.spawn` (pool of 2) | `perf/subagents.perf.mjs` | 60 s | median <= 1.5 s | spare take 864 ms (J-9382) |
| `subagent.ask` overhead | same | 60 s | median <= 300 ms | 4 x 33 ms + 70 ms copy |
| `subagent.burst8` | same | gate, 3 runs | each <= 30 s | 2 spares + 6 cold creates of 6.1 s (J-10192) |
| `subagent.stop` (subtree of 3) | same | gate, 3 runs | deepest first; recorded | m2 7.1 |
| `restart.mailIdle` (20 idle sessions) | `mail-restart-turn.test.js` | gate, 1 run | <= 15 s; 0 vats woken | architecture 11 |
| `session.program` with M9 | `bundle-guest.mjs` in W9.8, W9.10 | gate | under the PM's cap (32,768 by default) | J-1410, J-1116 |

File times: about 7 and 5.5 minutes; restart files 3-3.75 minutes each. Probes: contract
section 11.

**Fit risk:** good (contacts are objects; Thixotrope mail showed the pattern); spare-pool sizing
under subagent bursts and asks into a child given up at startup (core C-10, worked around) are
the risks.

**Deferred:** interop with Thixotrope core mail between daemons (P-62, open decision 7); workflow
services (P-59); the operator's mail UI (M12); network-policy inheritance until M7 (N1).

---

## M10. Workspace publishing and asset server

**Goal.** A session can publish its workspace at a stable unguessable URL on a separate origin, served
straight from disk, revocable and released on delete.

- **P:** P-43, P-44, P-64.
- **R:** R2-5, R2-13, R3-38, R3-50, R3-241, R6-3, R6-78, R7-18, R7-40, R7-52, R8-16, R8-27, R8-50.
- **Depends on:** M6. Parallel with M7, M12.
- **Owns:** `H/resources/environments/impl/publishing/` (the asset listener, routes, MIME; moved
  from `resources/workspace/{assets,routes,mime}.js` by the M6 contract, 6.4 M-1: the listener
  lives in the environments adapter process, D-M6-1), `H/guest/session/tools/publish.js`, a file
  under `scripts/provision-steps/` (asset listener port), test files named by subject (review
  rule 1), `H/perf/assets.perf.mjs`. Its manager methods (routes) join M7's in one batched change
  of `EV/durable.js`.

**Work units:** W10.1 asset listener in the workspace adapter (copied
`endo-fs-asset-server/src/{serve-tree,mime,type-guards}.js`), 192-bit tokens minted in Node, routes as
registrations (restored after restart), `Route {url, revoke, describe}`; per-publication sandboxing CSP
(W-14). W10.2 `publishWorkspace` tool, release on session delete; admin route list and revoke;
read-only static site (P-64).

**Acceptance tests**
1. `publishWorkspace` returns a URL with a 192-bit token on the asset origin; the same URL works after
   a restart; live edits are visible; a path without a valid token gives 404.
2. Deleting the session releases the route (503 or 404 after).
3. The admin lists routes and revokes one.

**Perf checks:** `assets.firstByte` <= 20 ms; 0 vat deliveries per request; throughput >= 100 MB/s.

**Fit risk:** good: no vat on the request path.

**Deferred:** per-publication subdomains (needs the proxy, out of scope).

---

## M11. Voice

**Status: contract settled, not built.** Reference: `m11-interfaces.md` (seams 11, work units 12,
acceptance 13, perf and probes 14, fold 17, appendix A for WX.1, appendix C item by item); fixed
files `AH/speech/{audio-protocol,engine-protocol,engine-types}.js`,
`guest/lib/{voice-preferences,speech-guards}.js`, `UI/src/voice/{endpointing-defaults,texts}.js`.

**Goal.** Speak to the assistant and hear replies: streamed STT with partials, sentence-pipelined TTS
fed from the live turn, client endpointing, gapless playback, barge-in, and timeouts on every stream.
Audio never reaches a vat; voice keeps no per-session vat state.

- **P:** P-30, P-31, P-32, P-33, P-34, P-35, P-49 (voice shortcut preset), P-61, P-66.
- **R:** R2-6, R2-20, R3-13 (M11 half), R3-244, R3-245, R4-89, R5-1..R5-62 (appendix C), R5-67,
  R5-68, R6-53, R6-60, R8-17, R8-29 (departure: engines at first use, O-12), R8-43.
- **Depends on:** M3, M4, cleanup step 3, WX.1 (H1, H3, H4). Parallel with M6, M8, M9; merges
  first.
- **Owns:** `AH/speech/`, `GW/extensions/speech.js`, `guest/factory/voice.js`,
  `guest/lib/{voice-preferences,speech-guards}.js`, `UI/src/voice/`,
  `scripts/provision-steps/70-voice.js`, the test, fixture and perf files of the table; seams H2
  (`factory.js`), H2b (`main.js`, `root.js`), H5 (`GW/server.js`), H6 (`GW/index.js`,
  `GW/extensions.js`, `GW/protocol.js`), H7 (`AH/index.js`), H8 (`scripts/test-integration.mjs`),
  H9 (`perf/_pass.mjs`), H10 (`UI/src/controller/index.js`), H12 (`GW/extensions/README.md`). No
  `guest/session/` file, runtime part, `channel-taps.js` or `projection-hooks.js`.

**Work units** ({W11.1, W11.3-W11.7} in parallel after WX.1; W11.2 after W11.1's first commit;
W11.8 after WX.1; journal ranges PM assigns, 30 or more each)

| id | files owned | behaviour | tests | depends on |
|---|---|---|---|---|
| W11.1 speech in, `process` | `AH/speech/{child-engine,stt-process}.js`, `AH/speech/engines/moonshine_daemon.py`, `test/fixtures/fake-stt.mjs` | resident engine, timeouts, backlog and utterance bounds, respawn and pacing, exit at stdin EOF | `speech-child-engine`, `speech-stt-process` (adapter; `[real-moonshine]` gated) | WX.1 |
| W11.2 speech out, `process` | `AH/speech/{tts-process,voice-catalogue}.js`, `test/fixtures/fake-tts.mjs`, `test/fixtures/voices/` | Piper, catalogue with range checks, synthesis timeout, warm spare, backpressure | `speech-voice-catalogue` (unit), `speech-tts-process` (`[real-piper]` gated) | W11.1's `child-engine.js` |
| W11.3 speech text and view | `AH/speech/{code-filter,speech-text,turn-view}.js` | code and markdown removed, sentence split, the speech view from the live channel | `speech-text` (unit), `speech-turn-view` (adapter) | WX.1 |
| W11.4 `openai-audio` | `AH/speech/openai-audio.js`, `test/fixtures/fake-speech-server.mjs` | HTTP speech provider; key through `readGrant` per request | `speech-openai-audio` (`[real-provider]` gated) | WX.1 |
| W11.5 host, route, extension | `AH/speech/{host,kinds,route,playback}.js`, `GW/extensions/speech.js`; seams H5, H6, H7 | `Speech` and `AudioPort`, the `/audio` socket, bounds, timeouts, per-extension powers | `speech-audio-route`, `speech-host`, `speech-timeouts`, `gateway-speech-extension` (adapter) | WX.1 |
| W11.6 client audio | `AH/speech/capture-worklet.js`, `UI/src/voice/{capture,endpointing,audio-socket,playback,wake-lock}.js` | capture, endpointing, socket client, gapless playback, wake lock | `voice-endpointing`, `voice-audio-socket`, `voice-playback` (unit) | WX.1 |
| W11.7 factory `Voice` | `guest/factory/voice.js`, `scripts/provision-steps/70-voice.js`; seams H2, H2b | preferences, launch claims, `HarnessRoot.configureSpeech`, the `voice` preset pin | `factory-voice` (unit), `voice-session`, `voice-restart` (integration) | WX.1 |
| W11.8 voice UI | `UI/src/voice/{feature,state,VoiceControls,VoicePanel,ReplayButton}.js`, `UI/src/voice/voice.css`; seam H10 | the voice feature, settings, slots, launch link | `voice-state` (unit); browser cases in W11.9 | WX.1; W11.6 signatures |
| W11.9 integration (last) | `test/integration/{voice-speak,voice-provider}.test.js`, `test/browser/voice-ui.mjs`, `test/fixtures/voice-clip.mjs`, `perf/{voice,voice-session}.perf.mjs`; seams H8, H9, H12 | wiring, acceptance, perf; session and exec bundles byte-identical | the files named; M11 regression list under 20 min | W11.1-W11.8 |
| M11 fold (after the merge) | contract section 17 F-1..F-11 | documents, plain exports in `speech-guards.js`, no in-test engines; F-7 after M6 (or WX.F) | greps and tests of section 17 | the M11 merge |

**Acceptance** (fakes everywhere; owner runs `[real-moonshine]` 1, 2; `[real-piper]` 5;
`[real-provider]` 15; `[real-browser]` 6, 7)

1. A 16 kHz clip in 85 ms frames gives cumulative partials and a final after END; an odd byte dropped; ABORT and close abort. `speech-stt-process.test.js`, `speech-audio-route.test.js`.
2. One engine load for three utterances; a killed engine respawns; a speech-in start failure leaves speech out working. `speech-stt-process.test.js`, `speech-host.test.js`.
3. Code blocks and markup not spoken; abbreviations and lists do not split; short chunks merge. `speech-text.test.js`.
4. `speak` plays finished messages then live deltas; a tool call breaks the sentence; the last finished turn replays; older answers `turnNotLive`. `speech-turn-view.test.js`, `voice-speak.test.js`.
5. Out-of-range or non-finite speed, unknown voice: R5-41 texts, no stream; broken voices skipped. `speech-tts-process.test.js`, `speech-voice-catalogue.test.js`, `speech-host.test.js`.
6. Endpointing: calibration, 400 ms burst, junk, 1,200 ms silence then 800 ms grace, speech during grace. `voice-endpointing.test.js`, `voice-ui.mjs`.
7. Barge-in stops audio and synthesis; the turn completes; the new utterance queues. `voice-ui.mjs`, `voice-speak.test.js`.
8. Preferences shared between connections; a stale shortcut revision refused; Talk uses the chosen preset. `voice-session.test.js`, `voice-ui.mjs`.
9. Only voice-started sessions get the spoken introduction. `voice-session.test.js`.
10. Timeouts: engine, `sttIdle`, a hanging TTS sentence skipped, no HELLO, token expiry. `speech-timeouts.test.js`.
11. Replay of a finished turn (inline and staged pieces); the level meter moves. `speech-audio-route.test.js`, `voice-ui.mjs`.
12. Auto-speak on the sending page only, also for a queued message. `voice-ui.mjs`.
13. Launch claims: one session per invocation id, 32 kept, survives a restart. `voice-session.test.js`, `voice-restart.test.js`.
14. G-11: a pinned model missing from the catalogue falls back with `voiceModelUnavailable`. `voice-session.test.js`.
15. The provider key reaches the fake server as a bearer and never the state or a log; 401 aborts. `voice-provider.test.js`.
16. Restart kill points K11-1..K11-5 as the contract's section 8 states. `voice-restart.test.js`.
17. Security: token, HELLO and Origin checks; no `Voice`, `Speech` or port reachable from a session vat. `speech-audio-route.test.js`, `voice-session.test.js`.
18. The wake lock is held while mic, speech or turn are active. `voice-ui.mjs`.
19. No `configureSpeech` on `Voice`; `HarnessRoot.configureSpeech` changes the settings revision. `factory-voice.test.js`, `voice-session.test.js`.
20. Only the speech extension's context has `readGrant`. `gateway-speech-extension.test.js`.
21. After a clean restart the engine starts at the first `openAudio` with the earlier settings. `voice-restart.test.js`.
22. Talk with the `voice` preset unavailable rejects with its reason; a user shortcut preset works. `voice-session.test.js`.

Cross-lane (WX.F): the complete built-in `voice` preset and Talk without a runner,
`test/integration/voice-preset.test.js`.

**Perf** (60 s windows)

| row | file | window | budget | derived from |
|---|---|---|---|---|
| `speech.audioForward` | `perf/voice.perf.mjs` | 60 s real-time | median <= 1 ms, p99 <= 3 ms | 0.055 + 0.009 + 0.022 ms (J-1310) |
| `speech.audioForward.load` (16 utterances) | same | 60 s | p99 <= 5 ms | as above |
| `speech.partialRelay` | same | 60 s | median <= 2 ms | J-1310 |
| `speech.firstAudio` (fake TTS) | same | 60 s | median <= 20 ms, p99 <= 50 | delta 0.2 ms (J-9173), pipe and socket (J-1310) |
| `speech.engineRespawn` | same | 60 s | <= 100 ms | spawn to ready 20.5 ms (J-1310) |
| `voice.deliveries` | `perf/voice-session.perf.mjs` | gate, inside `voice.speakOpen` | 0 on every spoken turn | D-M11-1 |
| `voice.speakOpen` | same | 60 s | median <= 10 ms; 0 deliveries | gateway-local call |
| `voice.preferences` | same | 60 s | median <= 50 ms; 1 delivery | `ui.call` 23 ms (J-10192) |
| `voice.startSession` | same | 60 s | median <= 950 ms | 864 ms pool take (J-9382) + 76 ms |
| `voice.launchDuplicate` | same | 60 s | median <= 50 ms | one factory crank, 23 ms |
| `voice.settingsRead` | same | 60 s | median <= 100 ms; 2 deliveries | two factory calls of 23-37 ms |
| `stt.partialLatency`, `stt.finalLatency` `[real-moonshine]` | `perf/voice.perf.mjs` (gated) | 60 s | <= 300 ms, <= 500 ms (recorded) | architecture 11 |
| `tts.firstAudio` `[real-piper]` | gated | 60 s | warm <= 1 s; cold recorded | architecture 11 |
| `provider.*` `[real-provider]` | gated | 60 s | recorded | - |

File times: about 6 minutes each. Session and exec bundles unchanged; the factory bundle's growth
(estimated 8-12 KB) recorded. Probes: contract section 14.2.

**Fit risk:** good, because audio never touches a vat; audio decoding shares the agent-host process
with tokens (blast radius, journal).

**Deferred:** Android (P-60, open decision 7), wake word (R5-71), per-message replay (O-3).

---

## M12. Operator surfaces: provisioning, service, CLI, diagnostics, Home, spaces, widgets

**Goal.** Everything needed to operate the harness: idempotent provisioning, a supervised service with
an environment allowlist, an attach-only admin CLI, diagnostics, and the remaining chat-UI spaces.

- **P:** P-28, P-29, P-54, P-56, P-67, P-50, P-51, P-57, P-52 (mapped below).
- **R:** R2-3, R2-4, R2-10, R2-17, R2-25, R3-201, R3-202, R3-203, R3-204, R3-213, R3-219..R3-228,
  R3-230, R3-275, R3-276, R6-2, R6-15, R6-16, R6-17, R6-18, R6-24..R6-32, R6-47, R6-48, R6-70,
  R6-72, R6-73, R7-31, R8-4, R8-5, R8-19..R8-31, R8-47, R8-48, R8-49.
- **Depends on:** M3, M4, M5. Parallel with M7 and M10.
- **Owns:** `H/bin/harness.js`, `H/scripts/{provision,serve}.mjs` (the runners; steps stay in the
  append-only table), `H/guest/factory/{home,spaces,diagnostics}.js`, `H/ui/src/{home,spaces,widgets}/`,
  `H/test/*/m12-*`, `H/perf/admin.perf.mjs`.
- **From the {M6, M8, M9, M11} contracts:** the operator's mail UI in the Home view and the CLI's
  mail commands read M9's `Operator.getMail` API (M9 O-M9-7); the service start calls M6's image
  pin check before serving (P-55, R8-42); orphaned adapter-owned containers are M6's sweep at
  bind, which W12.1's leftover clearing relies on; prompt part 5 is M12's slot in
  `guest/lib/prompt-sections.js` beside M9's parts 2 and 4 and M6's part 6.

**P-54 and P-52 mapping (owner principle 2: CLI for admin only).**

| P-54 / P-52 part | Provided by | Checked by |
|---|---|---|
| attach to the running daemon without starting another | `harness` CLI over `connectLocalControl`; exits "no daemon was started" otherwise (G-53; R6-71 not built) | acceptance 1 |
| run setup scripts with chosen powers | `thix install` / `thix install-native` with grants; `harness provision` | acceptance 4 |
| list and show objects | `thix status`, `thix installations`, `harness sessions`, `harness status` | acceptance 5 |
| read and send mail | `thix inbox`, `thix send`, `thix mail` (operator inbox in M9) | acceptance 5 |
| inspect | `thix reachability`, `harness diagnose` | acceptance 3 |
| evaluate, create agents | dropped as admin-irrelevant: evaluation is the session's `exec`; agents are created in the UI or by `harness sessions create` | recorded |
| P-52 named references, directories | Thixotrope inventory (README 171) and the factory's operator inventory (M5) | M5 acceptance 3 (object tools) and 13 (inventory) |
| P-52 host and guest identities, confined evaluation | vats and the exec Compartment (D-11) | M1b acceptance 3-4, M4 acceptance 5 |
| P-52 plugin installation with explicit powers | `thix install` grants; presets' `{label, value}` endowments | M5 acceptance 8 (endowments) |
| P-52 cancellation | `Turn.cancel`, `retire()` | M2 acceptance 6 |

**Work units:** W12.1 provisioning runner: fixed order from `provision-steps.js`, each step's outcome
recorded, identities kept (same name + digest + grants), refuses to start without state; serve wrapper
with an environment allowlist (P-56) that clears leftovers of a previous run before starting (stale
socket, stale lock whose pid is gone, orphaned adapter-owned containers) (P-29); launchd/systemd unit
sample (no NixOS). W12.2 CLI `harness`: status, sessions (list/create/delete), secrets import (sealed),
rotate sign-in, reachability, diagnose. W12.3 diagnostics: object description, reachability explanation
(`thix reachability`), turn traces. W12.4a Home view (operator inbox, inventory over M5's store with
relabel and remove, live through a home channel). W12.4b command bar with @-refs and the needed slash
commands only; saved spaces on the server with colour schemes. W12.4c `endowidget` rendering in an
isolated iframe with 65,536-unit / 2,048-node / depth-32 limits.

**Acceptance tests**
1. The CLI with no daemon running exits with "no daemon was started" and does not start one.
2. The Home inventory updates live; relabel and remove work; the command bar autocompletes `@label`.
3. Diagnostics: the reachability report explains why an object is retained.
4. Provisioning twice is a no-op; serve without state refuses; an environment variable outside the
   allowlist never reaches an adapter.
5. Spaces saved on one device appear on another; Home cannot be removed.
6. A reply containing an `endowidget` block renders in isolation; a widget over 65,536 units or 2,048
   nodes is refused.
7. Kill the service with a stale socket, stale lock and an orphaned fake container left behind: the
   next start clears them and serves (P-29).

**Perf checks:** `admin.cliStatus` <= 500 ms; `home.inventoryWatch` 1,000 entries <= 300 ms snapshot;
`provision.fresh` <= 3 min, `provision.noop` <= 20 s.

**Fit risk:** good; the CLI and diagnostics reuse `connectLocalControl` and `thix reachability`.

**Deferred:** P-59, P-60, P-62, P-63 (backlog below).

---

## M13. Upgrade, collection and longevity

**Goal.** The harness survives its own evolution and weeks of use: new program versions without
losing sessions, native reinstalls without breaking references, reclaimed state, bounded disk.

- **P:** hardening of P-13, P-14, P-28, P-29; G-29, G-33 decisions.
- **R:** R2-25, R4-63, R4-64 (and the spec's defect "removed state never reclaimed").
- **Depends on:** all earlier milestones.
- **Owns:** `H/guest/factory/upgrade.js`, `H/scripts/{upgrade,soak}.mjs`, `H/test/*/m13-*`,
  `H/perf/soak.perf.mjs`. (The record archive moved to M2, D-M2-1.)
- **From the {M6, M8, M9, M11} contracts:** the upgrade carries M11's `Voice` records
  (preferences, the shortcut preset by label at the export boundary, speech settings with key
  labels; M11 F-6); it decides whether imported mail is re-bound through the post office's
  postmarks (M9 O-M9-12; M9 imports it read-only); a session export already carries M6's
  execution state and M9's inbox (X-07), while workspace and home are not exported (M6 O-9).

**Work units:** W13.1 `upgrade.mjs`: automates M2's `exportState`/`importState` into new program
versions and swaps references in the factory. W13.2 native reinstall migration: re-mint
Secrets/Backends/Blobs/Routes handles from adapter-side state and push new `SessionServices` (D-13).
W13.3 collection sweep: `collectVats` with the factory as root, snapshot and incarnation cleanup
verified on disk (per-delete reclamation is already in M2); a sweep of blob files must keep every
key an archive names (`archiveKeys`, `m2-interfaces.md` 4.10). W13.4 (archive) moved to M2 (D-M2-1:
W2.5, W2.8). W13.5 soak: 50 sessions, 7 simulated days of turns with the scripted backend.

**Acceptance tests:** upgrade a state directory with 20 sessions to a new session program:
transcripts, queues, presets intact; reinstall agent-host: sessions keep working; delete 10 sessions:
disk returns to within 10 % of before.

**Perf checks:** `soak.diskPerSession` <= 25 MB + content; `soak.cranks` p99 <= 300 ms over the run;
`upgrade.perSession` <= 10 s; `soak.hubJson` stays <= 2 MB.

**Fit risk:** awkward. Thixotrope has no live upgrade (README 286; `designs/vat-replacement.md` not
implemented), so this is application-level export/import.

**Deferred:** nothing beyond the backlog.

---

## Backlog: parity is not complete until the owner rules on open decision 7

These items are not out of scope under the owner's principles (they are not host infrastructure,
Whylip or irrelevant slash commands). They are scheduled after M13 by default only.

| P | status | notes |
|---|---|---|
| P-59 workflow service | after M13 pending decision 7 | would reuse M9 typed-request forms and the operator inbox |
| P-60 Android shell | after M13 pending decision 7; needs a device | WebView around the M3 UI and M11 voice |
| P-62 daemon-to-daemon peers | after M13 pending decision 7 | not the browser peer relay; Thixotrope peers are same-user same-machine only (README 429-436), so a real remote netlayer is needed first |
| P-63 file explorer, inventory graph, peers, channels | after M13 pending decision 7 | after P-62 |

## Ownership check for parallel groups

- **{M3, M4, M5}:** M3 `AH/gateway/`, `ui/build.mjs`, `ui/src/{features.js,shell,conversation,sessions}`
  (W3.0 merged first); M4 `AH/subscriptions/`, `AH/secrets/{audit,catalog}.js`,
  `guest/factory/{backends,accounts}.js`, `ui/src/{secrets,accounts}`; M5
  `guest/factory/{presets,grants,inventory}.js`, `guest/lib/{preset-catalog,system-prompt}.js`,
  `guest/session/{prompt,labels}.js`, `guest/session/tools/{objects,granted,mentions}.js`,
  `guest/exec/powers.js`, `ui/src/{presets,mentions}`. Hook points: M4 and M5 add entries to
  `session-options.js` (backend/model resolution; preset snapshot), `services.js`, `tool-table.js`
  (`accountStatus`; object tools), `features.js`. Disjoint otherwise.
- **{M6, M8, M9, M11}** (from the settled contracts; WX.F rewrites this row from what was
  built). Own files: M6 `EV/` (`durable.js`, `ephemeral.js`, `impl/`), `resources/native-attach.js`,
  `guest/lib/guards/environments.js`, `guest/session/{environment,tools/shell}.js`,
  `guest/factory/environments.js`, `guest/lib/environment-prompt.js`, `ui/src/environment/`,
  `scripts/provision-steps/60-environments.js`; M8 `guest/session/{compaction,tools/view-image}.js`,
  `AH/providers/{compaction,compaction-round,images,compaction-texts}.js`, `AH/tools/view-image.js`,
  `guest/lib/guards/{context,images}.js`, `guest/lib/image-guards.js`; M9
  `guest/session/{inbox,subagents}.js`, `guest/session/tools/{mail,requests,subagents}.js`,
  `guest/factory/{post-office,operator-mail,subagents}.js`, `guest/lib/{mail-text,mail-prompt,mail-limits}.js`,
  `guest/lib/guards/{mail,post-office}.js`, `guest/exec/split-args.js`; M11 `AH/speech/`,
  `GW/extensions/speech.js`, `guest/factory/voice.js`, `guest/lib/{voice-preferences,speech-guards}.js`,
  `UI/src/voice/`, `scripts/provision-steps/70-voice.js`. Each lane also owns its test, fixture and
  perf files, named by subject. **WX.1 alone** edits `guest/lib/guards/{session,factory,base}.js`,
  `guest/lib/interfaces.js`, `guest/session/records.js`, `turn-types.js`, the typedefs and
  `combineHooks` of `runtime-parts.js`, `turn.js` `claimNext` (M9 S2), `tools/objects.js` and
  `tools/exec.js` (exports), `guest/lib/vocabulary-tables.js`, `test/unit/guards-split.test.js`,
  `test/fixtures/guard-fold-map.json`, `test/adapter/gateway-vocabulary-tables.test.js`. Shared
  files the lanes edit, with the editors in merge order (each one statement or line at a position
  WX.1 fixed; the PM merges them by hand):

  | file | M11 | M6 | M8 | M9 |
  |---|---|---|---|---|
  | `guest/session/runtime-parts.js` (five places: import, `PartName`, `requiredParts`, `runtimeParts`, getter) | - | R-1 `environment` | S-7 `compaction` | S1 `inbox`, `subagents` |
  | `guest/session/turn.js` | - | R-2: one `admit` line in `claimNext` | S-5: `claim`, `roundRequest`, `invoke`, `makeSink`, `hookTurn` | (S2 is WX.1's) |
  | `guest/session/session.js` | - | R-3: `refuseIfStopped`, three `Session` methods, `makeQueue` option, export power | S-6: record log above `makeRuntime`, the window | S5: `deliverMail`, `cancelMail`, export `inbox` |
  | `guest/session/export.js` | - | X-E: head page `execution` | - | S7: inbox page, `extras` |
  | `guest/session/tool-table.js` | - | T-1 shell entries | S-10b `viewImage` | S6 mail, requests, subagents |
  | `guest/session/label-seeds.js` | - | L-1 `workspace`, `shell` | - | S8 `user` (last) |
  | `guest/lib/tool-args.js` | - | - | S-10d `viewImage` | S4 `'strings'` kind |
  | `guest/factory/factory.js` | H2: `makeVoice`, `getVoice`, `configureSpeech` | F-3: settings in the one `buildSessionServices` context, binders, releasers; F-4: its hook second | - | F1, F2 (same context object), F3, F5: its hook first |
  | `guest/factory/services.js` | - | F-2: builder, `serviceBinders`, `serviceReleasers` | - | F4: two builders |
  | `guest/factory/root.js` | H2b: `configureSpeech` | F-5: `makeHarnessSettings` | - | - |
  | `guest/lib/prompt-sections.js` | - | P-1 part 6 | - | F7 parts 2 and 4 (M12 part 5 later) |
  | `AH/index.js` | H7: speech `extensionPowers` | - | S-14 `prepare` options, S-18 `adapterTools` | - |
  | `AH/blobs.js` | - | - | (image bytes if read through the blob store) | A1 `RelayWriters.copy` |
  | `H/package.json` (PM-merged) | - | K-1 `@endo/git`, `@endo/exo-git` | - | - |
  | `scripts/test-integration.mjs` (one list each) | H8 | K-2 `environments` | its W8.7 list | `mail` |
  | `perf/_pass.mjs` (PM-merged) | H9 | its perf files | its perf files | its perf files |

  Files no lane of the group edits: `channels.js`, `AH/channel-taps.js` (M8's S-11 is the only
  edit of `AH/projection-hooks.js`), the agent-host manager part (`resources/agent-host/*.js` outside
  `impl/`), `guest/factory/delete.js` and `starts.js`, `config/defaults.js` until M8's fold,
  `limits.js` until the folds. M11's H8 and H9 name their lists `M11`; review rule 1 asks a
  concept name (`voice`), which M11's fold applies.
- **{M7, M10, M12}:** M7 `EVI/egress/` (moved from `resources/containers/egress/` by the M6
  contract), `guest/session/{network-policy}.js`, `tools/network.js`, `ui/src/network/`; M10
  `EVI/publishing/` (moved from `resources/workspace/{assets,routes,mime}.js` by the M6 contract),
  `tools/publish.js`; M7 and M10 make one batched change of `EV/durable.js` (M6 M-1); M12 `bin/`, `scripts/{provision,serve}.mjs`, `guest/factory/{home,spaces,diagnostics}.js`,
  `ui/src/{home,spaces,widgets}`. Hook points: M7 and M10 append to `provision-steps.js` and
  `session-options.js`; M12 changes only the provisioning runner. Disjoint otherwise.
- All groups: `H/package.json`, `H/perf/_harness.mjs` and `H/JOURNAL.md` are PM-merged; integration
  and perf runs take the run lock.

---

## Disposition of review points

Blocking points from `critique-feasibility.md` (F) and `critique-coverage.md` (C). Each was checked
against the code or the spec before acting.

| point | verified at | disposition |
|---|---|---|
| F B-1 JS decode cannot give 256 k (or 64 k) frames | `pkg/src/core/worker-peer-xs.js:79`; `packages/base64/src/decode.js:86,160`; `boot.rs:800-808`; `polyfills.js:106-160` (ignores `fatal`); README 704-748; reviewer's probe numbers | Accepted. CORE-1a (native `fromBase64` reaches vats) and CORE-1 (native UTF-8 decode and encode, honouring `fatal`) are both in M0, not deferred; crank budget chosen by S1 as configuration; every bound is now in bytes (`frameBytes`, default 24,576 until S1); M0 acceptance no longer asks for 256 k. Architecture fact 2, section 1.1, section 9. |
| F B-2 protocol messages exceed any feasible inbound bound | architecture section 4.1 (old roundFinal, submission, tool output) | Accepted. Anything over `inlineBytes` is staged as a manager-minted Blob with a preview (D-10, D-15): submissions through the gateway Composer, model messages, tool arguments and results, native context; progress carries a Blob that replaces one partial record. Tool output stays R4-100's 32,768 units because the model reads it from the blob in the adapter. M1a refuses oversize output safely; M1b stages it. |
| F B-3 outbound frames halt the sending vat | reviewer's probe (60 k ok, 250 k killed); `polyfills.js:22-70` | Accepted. `frameBytes` and `crankOutBytes` bound vat outbound too (rule 12.5); records are small; exec results are written to a `BlobWriter` in pieces; history, context and list pages are bounded by bytes. |
| F B-4 viewer fan-out from durable vats | `pkg/src/net/hub.js:1917-1931` (silent breaks) | Accepted. D-8: no durable vat holds a viewer; the factory and sessions publish once per crank to adapter channels; the gateway fans out and drops closed sockets (rule 12.7). |
| F B-5 startup wakes workers with an unsnapshotted journal | `pkg/src/core/daemon.js:826-847`; `supervisor.js:141` (`idleSleepMs` option) | Accepted. Restart tests use `idleSleepMs: 2000`, wait for checkpoint and `pool.whenSettled()` before SIGKILL; "0 idle vats woken" is a gate counting checkpointed vats only. |
| F B-6 1 s `sleep` exec acceptance impossible | native.md:39-40 (`clock.after(0n)` 989 ms) | Accepted. M1a acceptance 3 uses the adapter `echo` tool with `delayMs` and asserts overlap (< 1.6 x one call). Interactive timers are adapter timers (architecture section 8). |
| F B-7 `exec.sends100 <= 2 s` ignores answer deliveries | tooling.md 4.5; J-0017 | Accepted. Budget split: 100 answered <= 8 s, 100 `sendOnly` <= 1 s (M1b). |
| F B-8 parallel groups not disjoint; no run lock | old ownership lists | Accepted. Hook tables (`runtime-parts.js`, `holds-table.js`, `session-options.js`, `services.js`, `projection-hooks.js`, `channel-taps.js`, the gateway route table, `provision-steps.js`, `features.js`), sequential ownership transfers (`prompt.js`, `provision.mjs`), W3.0 merged before M4/M5 UI units, PM-merged files with pre-allocated journal number ranges, and the run lock. |
| C queue entry lifecycle can post twice | SPEC:1619-1620 (A.4 `dispatching` row); R4-54 SPEC:527 | Accepted. Atomic claim: the entry is removed in the crank that records `TurnStarted`; a never-dispatched turn is closed with the R4-66 text and not re-queued (architecture 4.3-4.4). Test: M1a acceptance 6. Journal: atomic claim is a good fit. |
| C cancel retires the exec vat | R4-49 SPEC:519 | Accepted. Cancel abandons the answer by generation; the vat is retired only on the exec deadline, a MeterAbort, or when still busy at the next call, always with a stated scope loss (architecture section 6). Test: M1b acceptance 3. |
| C more than about 200 tool calls in one round quarantine the session | baseline (e) 500 sends MeterAbort | Accepted. `maxCallsPerRound` 64 with an error result for extras, `callWindow` 16 in flight; probe of 300 calls in M1b. Open decision 11. |
| C oversize inbound frames have only a cap | old architecture section 9 | Accepted; same fix as F B-2 (blob staging keeps R4-31 and R4-64). Probes: 1 MiB reply, 300 KiB exec body (M1b). |
| C `services` and `factoryInternal` over-grant | old `setServices({host,...})` | Accepted. `AgentHostAdmin` is held only by the factory; sessions get an attenuated `SessionServices` (their Backend, a per-session `SessionHostFacet`, workspace/shell, an `ExecHandle`) and a per-session `RowReporter`. Reachability test from session and exec vats: M4 acceptance 5. |
| C W-8 limiter behind the proxy | SPEC:1236 (W-1, W-8); spec-digest 4.1 | Accepted. `trustedProxies` with right-most untrusted `X-Forwarded-For`, plus a global ceiling; test with two forwarded addresses (M3 acceptance 2). |
| C G-19 reproduced | old architecture section 6 | Accepted. Per-field budgets so results stay valid JSON under the tool limit (runCommand, readSources, askSubagent); M6 acceptance 3 and too-big probe. |
| C voice stream timeouts missing | SPEC:1240; R5-67 SPEC:716 | Accepted. M11 W11.1, W11.2, W11.4a timeouts and acceptance 10. |
| C J-0004 hides the restore incompatibility | native.md:177-178, 288-289; `manager-kit.js:148-160` | Accepted. D-16 lazy desired state for containers; J-0004 regraded awkward; restart perf check with 20 environment sessions (M6). |
| C no multi-session performance check | single-session budgets only | Accepted. `concurrency.10` (M1b), `throughput` (M2), `hub.growth` (M1b, M3, M13); row changes only on visible transitions. |

Advisory points applied: M1 split into M1a/M1b; oversized work units split (W1a.2-W1a.5, W2.1a/b,
W3.0-W3.3c, W6.3a/b, W11.4a/b, W12.4a-c); integration "per file" with a state template (S8);
restart-race handling by lease and retired-break classification (D-5); thin installed modules with a
run-time implementation directory (D-14); data-only export/import in M2; explicit retirement of
quarantined exec vats; adapter-owned projection and archive deferred behind a measurement (D-9, D-10);
manager-minted, fsynced blobs (D-15); `fatal` decoding; progress as one replaced partial record;
adapter timers instead of clock alarms; per-connection error isolation and supervised speech engines;
`modelId` option and stored resolved model; rewritten persistent-scope prompt; recovery cancels child
asks; reuse.md:353 warning; compaction decided and recorded by the vat; single label map with a live
`powers` facet; last-served records keyed by Session; SecretWriter by amplification; publisher and
subscriber facets; `full-control` behind decision 5; G-05 retry and G-31 improvement; collection on
delete in M2; tests restated as behaviour; new tests for R4-10, R4-56, R4-22, R4-6, R4-9, R4-32, R4-31,
R4-57, R4-62, R4-83, P-04, P-29, P-35, P-45, P-49, P-52/P-54 mapping; spec-digest test texts copied
into M9-M12; backlog heading states that parity is incomplete until decision 7; new open decisions
10-15 and the G items raised.

---

## Changes after M0 and M1a

Decisions, settings and budgets that M0, the PR 1667 integration, M1a and its hardening, M1b and
the core work after M1b (C-7, C-2 and their integration, J-9300..J-9399) changed.
"Was" is the plan before the change; the evidence is in `JOURNAL.md` and `m0-results.md`.

| what | was | now | evidence |
|---|---|---|---|
| `frameBytes` | 24,576 until S1, then half the halt point, target >= 196,608 | 24,576, settled; the target is dropped while `harden` costs per byte (C-5) | halt above 94,208 at 50 M; 24,576 inbound in 312 ms against a 357 ms budget (J-0193, J-0194) |
| `crankOutBytes` | 2 x `frameBytes` | 196,608 (8 frames) | 8 x 64 KiB in one crank 553-576 ms (J-0142) |
| Crank budget | planning value 50 M, S1 to choose | 50 M (`config/defaults.js`); open decision 15 settled | runaway 242-271 ms; 100 M buys nothing (J-0143) |
| `execSourceBytes` | 262,144 in one message | 262,144 **staged** in `frameBytes` pages, evaluated in one crank (architecture 6, rule 12.11) | one message of 150 k halts; 262 k staged 3.9 s (J-0146, J-0195) |
| Record keys into vats | not constrained | rule 12.10: fixed key vocabulary, data-keyed collections as pair arrays or in-vat Maps, model JSON as text; gateway key guard (architecture 7, M3 W3.2) | permanent name table of about 57,000 per vat (J-0191) |
| Where limits live | section 9 named no file | `config/defaults.js`; guest copy `guest/lib/limits.js` (M1a W1a.0); core copy `STAGING_FRAME_BYTES` | J-0144, J-0122 |
| Crash bound | not in the plan | `maxDeliveryAttempts` 5 (D-17, open decision 16) | J-9046, J-9051 |
| Restart budget | "restart to serving, 50 idle sessions <= 15 s" | split: healthy restart <= 15 s (gate); restart with a vat crashing on every replay recorded against 15 s, depends on C-8, C-9 | healthy 4.4-5.8 s; crashing 36-69 s at bound 5 (J-9045, J-9046, J-9050) |
| Session create with spare pool | <= 1.5 s | <= 750 ms | spare take 157-176 ms (J-9045) |
| `exec.first` (spare exec vat) | <= 1.5 s | <= 750 ms | same mechanism as a spare take (J-9045) |
| Factory install of the bundle | <= 30 s | <= 15 s for up to 300 k characters | 11.6 s ASCII, 14.0 s mixed (J-0193) |
| `template.start` | <= 20 s | <= 10 s | 5.6 s (J-9045) |
| Session create without pool | <= 6 s | <= 6 s kept, marked depends on C-5; new bound: session program <= 200 KB (`session.program`) | 6.4 s for a 246 KB program (J-9045) |
| `vat.evaluateProgram` 150 k | <= 2 s | kept, marked depends on C-5 | 2.2-2.3 s, staging 95 % (J-0193) |
| `exec.sends` 100 answered | <= 8 s | kept, marked depends on C-7 | 9.4-10.6 s from a probe vat before CORE-4 (J-0143) |
| Guest rule 12.4 | no suspended async generators across deliveries | allowed, bounded like retained state; SIGKILL replay untested | S5 (J-0147) |
| Meaning of the retired break | always "restart" on the turn path | from an adapter object: restart; from a guest vat: that vat is lost; recovery never waits for a guest call (D-5, D-17, section 4.4, rule 12.8) | J-9048, J-9049, J-9051 |
| Exec scope-loss text | "exceeded the per-step compute budget" | neutral text naming both causes (a halt and a crash give-up look the same from inside) | J-9040, J-9051 |
| Lost session vat | not in the plan | row `lost`, kept listed; `deleteSession` retires it (M2 W2.7); reinstate asked of core (open decision 17, C-11) | J-9049 |
| Browser during startup | reconnect overlay | a refused connection shows "Server starting..." and keeps retrying (architecture 7, M3 W3.3c) | J-9051 |
| Spare pool details | 2 spares, refilled in the background | refilled with up to 4 creations in parallel; ASCII bundles staged in `frameBytes` chunks | J-0183, J-0186, J-9045 |
| Core changes (architecture 1.1) | CORE-1a in `boot.rs`; CORE-1; CORE-1b; CORE-2/3 conditional | CORE-1a landed in `@endo/immutable-arraybuffer`; CORE-4..CORE-7 added; CORE-2/3 not needed | J-0100, J-0190..J-0192, J-9022 |
| Integration test method | template "if path-independent"; run lock by pid | template helper API and supervisor child as built; run lock by generation with workload tracking (architecture 10) | J-0180, J-9020, J-9021 |
| M1a | 7 work units, 8 acceptance tests | W1a.0 interface contract first, then W1a.1-W1a.3 and W1a.4-W1a.6 in parallel; acceptance 8 (frame limit) widened, 9 (record keys) and 10 (crashing session at restart) added; perf `session.program`, `session.createCold`, `install.factory`, `restart.crashingSession` | this table |
| M1b | 9 acceptance tests | 10 (exec call across a restart is not awaited) and 11 (exec worker crash give-up) added; exec staging and pool refill specified | J-9048, J-9051 |
| Turn start ports | `Backend.open` per turn through the manager vat (M1a contract) | ports (`TurnPorts`, with `since`) opened once in `make`, held per adapter incarnation, dropped when proved dead; a turn start is one crank; the settle crank starts the next queued turn (architecture 4.1, contract 6.1) | turn start 573 -> 255 ms (J-0272, J-9151, J-9191) |
| Restart before `Dispatched` | recovered in the crank of the lease break | the session reopens and compares `TurnStarted.at` with the fresh ports' `since`: earlier -> `interrupted`; later -> round 0 again on fresh ports (contract 7.1; a typed notice is C-19) | J-9154, J-9190 |
| Settled turns | a `Turn` exo per turn for the session's life | records; `Turn` minted when handed out, 32 kept (`retainedTurnHandles`); compare turns by `turnId`; receipts: 4,096, 24 h, no exo | 1,000 -> 32 live `Turn`s (J-9152) |
| History page guard | strict `M.or` of every record shape | structural (`M.key()` per record; records were checked at append) | 18.0 -> 0.77 ms per page in Node (J-9153, J-9156); vat row is M1b |
| `createdAt` | stamped from the factory's known time (always 0) | `CreateOptions.at`, the caller's clock | J-9150, J-9193 |
| Blank submissions | not refused | refused with `texts.blankSubmission` (Fae's text; the spec has none: PM decision) | J-9150 |
| OCapN GC frames | one vat delivery each; woke sleeping vats | held in the journal, delivered with the next ordinary crank or after 64; never wake a vat (CORE-9, architecture 4.6) | J-9120..J-9125 |
| Woken-vat checks | "journal grew" | the worker row's `wakes`; `journalLength` is the delivery frontier, `heldFrames` separate | J-9122, J-9193 |
| Live channel | arrival order, deliveries-only drop bound | rev order with a reorder window; 4,096 deliveries or 2 MiB per subscriber; 32 subscribers; envelope-only return guard | J-9170..J-9172 |
| `turn.delta` measurement | control client through the hub | in-process subscriber in the adapter (where the gateway subscribes); the client path is `turn.delta.client`, no budget | J-0274, J-9173 |
| Guest bundles | non-ASCII hidden names (U+034F) from `@endo/module-source` | escaped as `\uXXXX`; guest lint refuses non-ASCII outside comments and SES-rejected source text | J-9174 |
| C-16 workarounds | the `Set`-based queue and no in-place array moves (J-0271, J-0292) | kept; no longer needed for correctness after the engine fix (`9828522485`) | J-9101 |
| Integration runs | one file per invocation | also `corepack yarn test:integration` (serial, one lock); `M1A_KILL_DELAYS_MS` repeats the SIGKILL cases | J-9174, J-9193 |
| M1b | 6 work units, 11 acceptance tests | W1b.0 contract step first (with the carried M1a items); acceptance 8 extended to a session idle across the restart, 12 (spare take and its open) added; perf `history.page`, `hub.gcBurst`, the M1a turn rows re-run | this table |
| Slot ceiling (`THIXOTROPE_SLOT_CEILING`) | not set by the harness (Thixotrope's 1,000,000) | 4,000,000, set by `scripts/serve.mjs` from `config/defaults.js` `slotCeiling` (M1b QC); a host value wins; it bounds live heap plus one crank (C-7, C-21) | a 100-call round halted a session vat at 1,000,000, passes at 4,000,000; 256-call rounds pass (J-0362, J-0392) |
| Exec cancel | abandoned by generation, nothing sent to the exec vat; an exec arriving while the cancelled call still ran got busy, a reset and a fresh scope | `ExecScope.abandon()` (sendOnly, before any later `run`; also from recovery): the next exec runs at once in the same scope; acceptance 3 holds as written (contract 8.3) | J-0307, J-0391 |
| Exec call lifetime | a call ended when the wrapper's promise settled; work it started kept running | a call's `sleep` dies with the call, so model code cannot outlive its call or keep the vat cranking (architecture 6; M5's `powers` must follow) | QC finding 4, J-0391 |
| Exec name-table flood | "halts only the exec vat, which is retired" | the engine's RangeError is catchable: the exec vat answers `exhausted`, the session records `texts.execExhausted` and retires it; an engine halt is C-6 | J-0333, J-0390 |
| `TurnSink.progress` | sendOnly, a checkpoint every 16 KiB or 10 s, never deleted | answered (`-> boolean`, kept); skipped while the round's checkpoints staged more than 2 x the text so far (`progressWriteFactor` 3); superseded files deleted; a streamed round ends on a checkpoint of its whole text, which the reply reuses | 1 MiB reply: 34 MB -> 3.8 MB written, 1 file left (J-0313, J-0393) |
| Guest bundles | comments included | comments stripped by `bundle-guest.mjs` (line numbers kept) | session program 198,438 -> 130,061 bytes, exec 92,917 -> 61,035, factory 141,845 -> 93,009 (J-0394) |
| `ContextSource.page` | copied the log's tail per page | reads only its own records (`RecordLog.at`); page bound unchanged (`contextPageBytes`, 512 records) | QC finding 2, J-0392 |
| M1b acceptance 9 "delete" | M1b | M2 (W2.7, acceptance 13): it needs `deleteSession`; `m1b-live` keeps it as a known failure | m1b-interfaces 16.6, J-0309 |
| M1b perf misses (QC findings 11-14) | budgets as listed | **kept**, not re-based; each names the core candidate it depends on, for the PM to rule: `session.create` with the pool (C-2, C-7: 7 serial cranks plus a wake), `concurrency.10` turn start and crank p95 (C-2), `history.page` (C-5, C-7; W2.5 record bound), `context.rebuild` (C-5; J-0322 (b)) | M1b outcome table, J-0396, J-0397 |
| M2 | 7 work units | W2.0 contract step first (folds the M1b tables, adds `blobPage`/`releaseBlobs`/`deleteSession`, record-bounded history pages, heaviest-crank column); the record archive is built in M2 (D-M2-1: W2.5 vat side, W2.8 adapter side; W2.9 integration), so 10 work units | this table, J-9400 |
| Garbage collection in a vat (CORE-11, C-7) | a full collection after every crank (17-126 ms per delivery, growing with the vat) | an allocation schedule: after 131,072 slots or 16 MiB of growth, every 32nd crank, and before the image at close (`THIXOTROPE_GC_POLICY` `allocation`, fixed per state directory); a trivial delivery 0.5-0.6 ms of worker time at any session length; finalizers and their `gc-*` frames leave up to 32 cranks later or in the first crank after a wake | J-9300..J-9307, J-9382 |
| Hub persistence (CORE-12, C-2) | whole-file `hub.json` rewrite, two fsyncs, 9.8-10.7 ms per commit | write-ahead log of deltas (`hub-image.json` + `hub-log.jsonl`, one append per commit, 5.5-6.8 ms); one-way migration; `THIXOTROPE_HUB_STORE=file` keeps the old store | J-9330..J-9337, J-9382 |
| Serve environment and template key | crank budget, attempt bound, slot ceiling | also `THIXOTROPE_GC_*` and `THIXOTROPE_HUB_STORE` pass through `scripts/serve.mjs`; templates key on them when set; perf rows name `gcPolicy` and `hubStore` | J-9380 |
| M1b SIGKILL cases | acceptance 10 checked outcome-unknown and the next exec only; fixed kill points for 8 and 10 | acceptance 10 also checks that the killed exec ran at most once and the provider got the turn once; `EXEC_KILL_DELAY_MS`, `CONTEXT_KILL_DELAYS_MS` (with `POOL_KILL_DELAYS_MS`, `M1A_KILL_DELAYS_MS`) vary the kill point | J-9380 |
| Scripted backend floods | flood text inside the script | `ScriptChunk.keys` / `ScriptToolCall.argsFreshKeys`: the adapter builds the keys; a script crosses the manager vat and must fit one frame (m1b-interfaces 17.6) | J-9381 |
| M1b perf misses after the core changes | `session.create` with the pool, `concurrency.10` turn start and crank p95, `history.page`, `context.rebuild`, `hub.growth` | `session.create` with the pool passes (864 ms, 1.15 x); the others still miss, now each with a measured cause: hub commits (`concurrency.10`, `hub.growth`: C-2's rest), page-crank marshalling (`history.page`, `context.rebuild`: C-5, M2 W2.5, J-0322 (b)) | J-9382, J-9386..J-9399 |
| Record archive (D-M2-1, architecture D-18) | "no archive in M2 unless the numbers say so"; R4-106 256 resident turns, 256-turn chunks | built: 128 kept turns, 32-turn segments, sealed in the settle crank, dropped on the adapter's durable answer; a session's vat, snapshot and hub row are flat from 200 to 5,000 turns | J-0461, J-9404 |
| Long-session fixtures | built by running every turn (2.5 h for 5,000) | `importState` (`perf/_long-session.mjs`): 5,000 tool turns in 11 min; the per-turn window runs with the scripted context digests off (`<logPath>.nodigest`) | J-0485, J-9404 |
| Turn deadline | armed in the turn's first crank (seam 4); the Endpoint dropped the arm | the Endpoint keeps an arm that arrives before the turn's first round and arms it when the round brings the sink | J-0475, J-9401 |
| Catalogue cache key | one owner per Backend presence in a WeakMap | held strongly, at most 64: a collected presence came back as a new object (C-23) | J-9403 |
| `checkpoint.stall`, `history.page`, `throughput`, `disk.session`, the 100 KiB client refusal | budgets as listed | **kept**, not re-based: `checkpoint.stall` fails (one 2-3 s turn per 100), `history.page` misses by 0-11 % at 1,000/5,000 turns (40 records per page would fit, J-0461), `throughput` 29/s at load 8, `disk.session` 41.5 MB for an imported session (C-22), the 100 KiB string reaches the vat | J-9405..J-9408, J-9412 |
| Acceptance 3 at 1,024 rounds; acceptance 6 "abort emitted" | in the 5-minute integration lane; `abort` on cancel | opt-in (about 280 s alone); a cancel ends `end { status: 'cancelled' }` as the event contract says; both for the PM | J-0471, J-0424 |
