# Architecture review HR-GUEST: the vat programs (session, factory, exec, shared lib)

Unit HR-GUEST of the harness architecture review. Scope: `packages/thixotrope-harness/guest/**`
(`session/`, `session/tools/`, `factory/`, `exec/`, `lib/`; there is no `guest/tools/`). Read-only:
no source, test or config file was changed. Snapshot: branch `claude/thix-arch` at `bd9a8ec070`.
Paths below are relative to `packages/thixotrope-harness/` unless they start with `packages/`.
Evidence marks: **read** (I read the code), **measured** (a script counted it), **inferred**.
Vocabulary follows the core review's glossary (`designs/arch-review/core-ontology.md` section 5);
core findings are not repeated.

Started 2026-11-18T12:52:55Z; the end time is in journal entry J-9982.

---

## 1. Summary

The vat programs are sound in what matters most: crank discipline, durability order and the
restart rules are written down and followed, and the code is not copy-pasted. What costs is the
build process left in the code. Each milestone added its layer next to the last one: a new
version of an interface table, a new limits or texts file, a new seam or stub, a new extension
mechanism. The merge then kept all of them. The session program has 3,417 bytes of its
240,000-byte budget left (J-9933), so every leftover layer now limits what can be added.

**The three things most worth changing**

1. **Remove the contract scaffolding the merge left in place** (HR-GUEST-2, -3). The Session guard
   exists in three versions, there are M1b "views" and M5 "widenings" of tables that were already
   folded, the exec program carries a test-checked copy of the M5 guards, and ten `notBuilt` stubs
   cannot be reached from any vat program (the M5 contract said none would be left). The
   per-milestone layout of `lib/` (`limits-m5.js` exists only to avoid a merge conflict) should
   become a layout by vat. The split of `interfaces.js` per vat that the integration workflow is
   doing now is the right first step.
2. **Give the turn runner's parts their own owners** (HR-GUEST-1). `makeTurnRunner` is one
   1,560-line closure with 17 mutable bindings and 44 inner functions. It owns the ports and their
   restart state, the event outbox, usage totals, the archive, history, the context source,
   import, and the Turn and TurnSink classes. Other modules reach into it (`runner.archive`,
   `archive.unresolved` as a raw `Map`).
3. **Use one extension mechanism, not two** (HR-GUEST-4). The M1a hook tables are static module
   data, so per-session state reaches them through three module-level `WeakMap`s keyed by session
   objects. M5's runtime parts are per session. Four overlapping "context" bags (SessionCore,
   `runtime.session`, ToolContext, the hook context) carry the internals around.

**The three things most worth keeping**

1. **The crank discipline in `session/turn.js` and `session/recovery.js`** [read]. Intent comes
   before effect (`claim` runs `take` before any record or send, `turn.js:1296-1378`). There is one
   publish per crank through the outbox. `settle` keeps the settle batch and the lease release even
   when the next claim throws (`turn.js:512-529`). Recovery is synchronous and abandons work by
   generation (`recovery.js:15-19`). The archive drops records only after the durable answer
   (`archive.js:204-238`).
2. **Retired-break classification by call site, in one helper** [read]. `lib/retired.js` matches
   the hub text exactly, in one place, and imports it in 6 modules. The tool table's `site` field
   (`'adapter' | 'guest' | 'session'`) records at each call site whether a break means "restart" or
   "that vat is lost" (architecture rule 12.8).
3. **Dependency hygiene and the guest rules** [measured]. There are no import cycles among the 68
   guest modules. Vat code depends only on `lib/` and its own directory; the one exception is
   `factory/` importing `session/prompt.js` (HR-GUEST-9). There is no `Date`, `Math.random`,
   timer, `console`, dynamic `import` or `WeakRef` in guest code (rule 12.1). Only 2.6 % of the
   9,680 code lines sit in a repeated 6-line window, and most of those are the interface-helper
   preambles of HR-GUEST-2. `lib/tool-args.js` reads model JSON without ever creating a record key
   (rule 12.10).

---

## 2. Map of the area

Sizes are total lines (comments make up 36 %: 7,279 of 20,085 [measured]). Arrows show imports.
Reachability was computed from the three entry points [measured].

| vat program (entry) | modules reached | lines | bundle (J-9933) |
| --- | --- | --- | --- |
| session (`session/main.js`) | 37 | 11,827 | 236,583 B of 240,000 |
| factory (`factory/main.js`) | 26 | 8,522 | 178,390 B |
| exec (`exec/main.js`) | 9 | 5,124 | 105,414 B of 120,000 |
| in no vat program | 9 | 1,898 | (adapter, UI, tests) |

**Session vat** (`session/`, 6,000 lines with `tools/`):

- `main.js` (29): the SpareMaker.
- `session.js` (316): composition root and the Session and SessionInternal exos.
- `turn.js` (1,756): the turn runner. It owns ports, outbox, settle, tool calls, rounds, the Sink
  and Turn classes, claim, cancel, handles, import, and it creates the archive, history and
  context source.
- `archive.js` (294): seal protocol and segment index.
- `history.js` (257) and `context-source.js` (75): paged views of the records.
- `records.js` (246): the RecordLog.
- The queue: `queue.js` (303) over `lib/pending-queue.js` (424), `submissions.js` (128),
  `holds.js` (59) and `holds-table.js` (66).
- `recovery.js` (193): restart recovery. `live.js` (270): outside publishing. `export.js` (295):
  delete fence, blob pages, export and import. `staging.js` (78).
- M5 additions: `labels.js` (154), `label-seeds.js` (47), `packages.js` (156), `powers-source.js`
  (71) and `m5-parts.js` (116, the runtime-part table).
- Extension tables: `tool-table.js` (204) and `turn-hooks.js` (52).
- `tools/` (1,755): `exec.js`, `inspect-client.js`, `inspection.js`, `objects.js`, `mentions.js`
  and `granted.js`.
- Imports: `session.js` imports 13 modules. `turn.js` imports 7 session modules and 5 lib modules.
  `tool-table.js` imports every tool. `turn-hooks.js` imports `tools/exec.js` and
  `tools/mentions.js`. `recovery.js` imports `turn-hooks.js`.

**Factory vat** (`factory/`, 3,630 lines):

- `main.js` (112): wiring.
- `factory.js` (570): creation, the start listener, the Operator.
- `pool.js` (574): spare session and exec vats and ExecHandle. `rows.js` (346) and
  `list-feed.js` (178): the row table and its publisher.
- `root.js` (259): HarnessRoot, the program stores and settings. `delete.js` (212) and
  `export.js` (103).
- `presets.js` (392), `preset-templates.js` (125) and `inventory.js` (175): M5.
- `services.js` (99) and `session-options.js` (186): hook tables. `subscription-options.js` (48):
  M4.
- `standin-session.js` and `standin-exec.js` (144): test fixtures, bundled on their own.

**Exec vat** (`exec/`, 1,707 lines): `main.js` (376, ExecScope), `render.js` (453: rendering,
staging, and a copy of the M5 guards and texts), `membrane.js` (367), `powers.js` (109) and
`inspect.js` (502).

**Shared lib** (`lib/`, 8,100 lines):

- `interfaces.js` (2,621): M1a, M1b and M2 guards, texts and method names, with `m1b*` views and
  `m2Interfaces`. It is in every vat program: 47.8 KB of the session program and of the exec
  program.
- `interfaces-m5.js` (603) and `interfaces-m5-factory.js` (322).
- Not imported by any vat program: `interfaces-m3.js` (329) and `interfaces-m4.js` (537).
- `limits.js` (248), `limits-m4.js` (87) and `limits-m5.js` (139). `texts-m4.js` (150).
- `bounded.js` (309), `pending-queue.js` (424), `tool-args.js` (408), `turn-engine.js` (106),
  `retired.js` (49), `prompt-sections.js` (224), `system-prompt-base.js` (81) and
  `preset-catalog.js` (296).
- Adapter or UI only: `reply-fold.js` (228), `token-usage.js` (151) and `transcript-records.js`
  (330). Tests only: `journal-usage.js` (92).
- Fan-in: `interfaces.js` 38 importers, `limits.js` 34, `bounded.js` 20, `limits-m5.js` 14,
  `interfaces-m5.js` 13.

**Exports** [measured, over guest, resources, ui, scripts, perf and test]: 276 exports. 26 have no
user anywhere (mostly text constants and `*Descriptions` tables). 58 are used only by tests. Most
of those are texts exported so tests can compare them, which is reasonable. The rest are listed
under HR-GUEST-3.

---

## 3. Findings, in severity order

| id | sev | Q | one line |
| --- | --- | --- | --- |
| HR-GUEST-1 | major | 1, 5 | the turn runner is one closure that owns eight jobs; others reach into it |
| HR-GUEST-2 | major | 3, 4 | interface tables in up to four versions, with copies and views kept equal by tests |
| HR-GUEST-3 | moderate | 3 | ten unreachable `notBuilt` stubs and the M2 seams still guard paths that always exist |
| HR-GUEST-4 | moderate | 1, 4, 5 | two extension mechanisms; module-level WeakMaps; four context bags |
| HR-GUEST-5 | moderate | 2, 4 | usage arithmetic written three times with two context rules |
| HR-GUEST-6 | moderate | 2 | `enqueueMessageOnce` re-implements `enqueueOnce` |
| HR-GUEST-7 | moderate | 2, 4 | the factory counts daemon starts in three places |
| HR-GUEST-8 | moderate | 2 | small helpers repeated (`messageOf` 7x, outcomes, pagers 6x, one text twice) |
| HR-GUEST-9 | moderate | 1 | `lib/` holds 1,754 lines no vat runs; the layout is by milestone, not by vat |
| HR-GUEST-10 | minor | 3, 4 | five hold reasons, one produced; the deletion fallback misuses `stopped` |
| HR-GUEST-11 | minor | 4 | the turn and the session core are typed twice; the delete fence is held in three flags |
| HR-GUEST-12 | minor | 5 | a start-listener registration failure is swallowed |
| HR-GUEST-13 | minor | 4 | "epoch", "generation" and "powers" each name several things |
| HR-GUEST-14 | minor | 4 | event and record spellings differ for the same concept |
| HR-GUEST-15 | minor | 5 | the archive index cap turns retained growth back on after 4,096 segments |
| HR-GUEST-16 | minor | 5 | comments narrate milestones and some are stale |

### HR-GUEST-1 (major, questions 1 and 5) The turn runner is one closure that owns eight jobs, and other modules reach into it

- **Where** [read and measured]
  - `session/turn.js:197-1755`: `makeTurnRunner` is one closure. It has 1,124 code lines, 44
    inner functions, 17 mutable `let` bindings (`turn.js:218-333`), two exo classes (TurnSink
    `:1002`, Turn `:1460`) and a 29-member return record (`:1644-1755`). It does these jobs:
    1. The ports of the adapter incarnation and their restart state: `held`, `opening`,
       `reopens`, `brokenSince`, `openPorts`, `onOpened`, `onOpenFailed`, `onLeaseBroken`,
       `dropHeld` (`:291-306`, `:1119-1292`).
    2. The event outbox and row patch: `emit`, `takeEvents`, `flushRow`, `flushTo`, `flush`,
       `scheduleFlush`, `report` (`:319-399`).
    3. Usage totals (`:107-113`, `:310-317`, `:965-994`, `:1703-1712`).
    4. Settle (`:446-530`), tool calls (`:544-814`) and rounds (`:816-994`).
    5. The archive, history and context source, which it creates (`:258-289`).
    6. Claim and cancel (`:1309-1451`).
    7. Turn handles and lookup (`:1512-1565`).
    8. Import (`:1575-1640`) and the delete fence (`:1690-1699`).
  - Reach-ins:
    - `archive.unresolved` is a raw `Map` that `turn.js` reads and deletes directly
      (`:1497`, `:1507`, `:1547`, `:1594`, `:1611`; exported at `archive.js:280`).
    - `export.js` reaches the archive through `runner.archive` (`export.js:83`, `:161`).
    - `export.js` reaches the delete fence through `runner.beginDelete` (`export.js:91`).
    - `session.js:122-132` builds a `core` from runner members and hands it back with
      `runner.attach` (late wiring: the queue needs the runner and the runner needs the queue).
  - Return members that no other module uses: `deleting` (one test only), `turnHandle` and
    `isLive` (`turn.js:1676`, `:1700`, `:1753`).
- **Evidence.** The jobs share only `current`, `records`, `emit` and `flush`. The ports state
  machine (job 1) is the hardest part to reason about (reopen, `since` against `brokenSince`, the
  bounded retry), and it is mixed in with tool scheduling. The design names the archive as its own
  unit (W2.5), yet it lives inside the runner. The queue (`queue.js`) is a clean counterexample:
  it has a narrow interface and does not know the runner.
- **Fix, smallest step.**
  1. Move the ports state machine into `session/ports.js` as
     `makePorts({ backend, host, onOpened, onDead })`. It is about 170 lines and keeps `held`,
     `opening`, `reopens` and `brokenSince` private.
  2. Move the outbox (`emit`, `flush*`, `report`) into a small record made in `session.js` and
     passed in.
  3. Create the archive in `session.js` and pass it in. Make `unresolved` private behind
     `keepUnresolved`, `unresolvedInfo(turnId)` and `resolve(turnId)`.
  4. Delete the three unused return members.
- **Size** [inferred]. About 400 lines moved, 2 new modules and about 40 lines changed in
  `session.js` and `export.js`.
- **Risk.** Crank boundaries: a moved `flush` must still run where it runs today, and a publish
  must not move into another crank. `test/unit/m1a-session*.test.js`, the `m1b-qc` worst-case
  tests and `test/unit/m2-w25-archive.test.js` cover the order. **Bundle**: each new module costs
  about 1.2 KB of wrapper (J-9933) against 3.4 KB of margin, so this must land with HR-GUEST-2 and
  HR-GUEST-3, which free far more.

### HR-GUEST-2 (major, questions 3 and 4) Interface tables exist in up to four versions, with copies and views kept equal by tests

- **Where** [read and measured]
  - The Session guard exists three times:
    - `interfaces.Session` (the M1b version), used by `factory/standin-session.js:58`;
    - `m2Interfaces.Session` (`interfaces.js:2443`);
    - `m5Interfaces.Session` (`interfaces-m5.js:525`), the one the real exo uses
      (`session/session.js:188`).

    SessionInternal, QueueEntry, ContextSource, SessionFactory, HarnessRoot, Operator,
    AgentHostAdmin, Backend and Composer each exist in an M1a/M1b version and an M2 version
    (`interfaces.js:2441-2529`).
  - M1b "views of the folded tables, for modules written against them" (`interfaces.js:2613-2621`)
    are still used at 6 exo sites: `turn.js:1004` and `:1462`, `factory.js:535`, `pool.js:524`,
    `standin-exec.js:26`, plus `m1bShapes` in 4 places.
  - `m5Widenings` (`interfaces-m5.js:444-492`) is a second copy of four shapes that W5.3 has
    already pasted into `interfaces.js`. `test/unit/m5-interfaces.test.js:304` keeps the two equal.
  - The exec program carries a copy of the M5 ExecScope guard and texts (`exec/render.js:366-440`).
    It was made to save 13.7 KB of `interfaces-m5.js` (`render.js:15-26`), and
    `m5-w54-exec.test.js` keeps it equal. Yet the same program carries all 47.8 KB of
    `interfaces.js` (J-9933).
  - Method names are hand lists parallel to the guards (`interfaces.js:1625`, `:2031`, `:2559-2614`;
    `m3MethodNames`, `m4MethodNames`, `m5MethodNames`, `m5FactoryMethodNames`).
  - The guard helpers `text`, `list`, `record`, `count`, `done`, `R` and `lazyTable` are defined
    in 4 or 5 files each (`interfaces*.js`). These are most of the duplicate windows the
    duplicate finder reports.
  - The Operator guard is built twice the same way: inline at `factory.js:428-432`, and as
    `m5FactoryInterfaces.Operator` (`interfaces-m5-factory.js:255-260`), which nothing uses.
- **Evidence.** These layers were the parallel-lane contract mechanism (m5-interfaces.md D-M5-5:
  "M5 adds no interface to `interfaces.js`"). After the merge, a reader has to know which of three
  Session guards is live. The exec program pays twice: once for a whole table it barely uses and
  once for a copy it keeps to save bytes.
- **In hand.** The integration workflow is splitting `interfaces.js` per vat. This finding is the
  list of what that split can drop at the same time.
- **Fix.**
  1. Make one table per vat program (session, factory, exec) and one shared table. Each holds
     only the latest version of each guard, under its plain name.
  2. Delete the `m1b*` views, `m2Interfaces`, `m5Widenings`, `m5FactoryInterfaces.Operator`
     (or use it at `factory.js:428`) and the exec copy (import from the exec table instead).
  3. Put the guard helpers in one module.
  4. Derive method-name lists from the builder records where the prelude allows. Otherwise keep
     one list per interface next to its guard.
- **Size** [inferred]. About 600 lines deleted and about 50 import sites changed.
- **Risk.** The contract tests (`test/unit/m1a-`, `m1b-`, `m2-`, `m5-interfaces.test.js`) assert
  the old views and need rewriting. The gateway key guard reads `vocabularyShapes()` from each
  `interfaces-m*.js` (an M3 registry): keep that export per table. A guard narrowed by mistake
  refuses calls, and the integration suites would show it.

### HR-GUEST-3 (moderate, question 3) Ten unreachable `notBuilt` stubs, and the M2 seams still guard paths that always exist

- **Where** [read]
  - `textOf.notBuilt` sites: `session.js:273` and `:283`; `tools/objects.js:158`, `:194` and
    `:205`; `tools/inspection.js:148`; `tools/mentions.js:135` and `:177`; `session/prompt.js:97`.
    All runtime parts are registered (`m5-parts.js:65-70`) and the factory always passes `admin`
    (`factory.js:247`), so no vat program reaches any of these. Only tests reach them, by passing
    `parts`. The M5 contract's own W5.9 criterion was "no `notBuilt` stub left"
    (`designs/m5-interfaces.md:771`).
  - M2 seams checked with `typeof`: `export.js:85-86` (`records.base`) and `:91-96`
    (`runner.beginDelete`, with a fallback that holds the queue `stopped` and cancels). Both
    members always exist (`records.js:193`, `turn.js:1690`).
  - `context-source.js:72` (`archive === undefined`) and `:29` (`boundary`, an M8 placeholder that
    is never passed).
  - `epoch: 0` sent in every round request and seal (`turn.js:867`, `archive.js:176`).
  - The option `contextSource: _ignoredContextSource` (`turn.js:190-192`, `:208`).
  - `export { plainBytes }` "kept for existing importers" (`turn.js:101-102`), which has no
    importer [measured].
  - `site ?? 'adapter'` (`turn.js:724`; documented at `tool-table.js:14`), although every one of
    the 13 entries names its `site` [measured].
  - Test-only paths: `queue.release` (`queue.js:296`, one test) and `assertNoActiveTurn`
    (`queue.js:99`), whose check `turn.js:1735` writes again inline.
  - `exec/main.js:65` re-exports "M1b's exports, kept for its tests".
  - In the factory, `pool`, `settings`, `listFeed` and `harnessSettings` are optional
    (`factory.js:113-120`, about 12 `?.` branches), but `main.js:78-87` always passes them. The
    "without a pool (M1a)" mode exists only for tests.
- **Evidence.** All of these are compatibility paths for states that the merged product cannot
  reach. With 3.4 KB of session budget left they cost bytes as well as reading time [inferred].
- **Fix.** Delete the stubs. A missing part should be a construction error in `makeRuntime`, not
  a model-visible failure. Delete the `typeof` fallbacks, the ignored option and the re-export.
  Pass `boundary` and `epoch` only when M8 builds compaction. Make `site` required. Make the
  factory's pool and settings required, and give tests a small fake.
- **Size** [inferred]. About 120 lines deleted in 10 files.
- **Risk.** Tests that build a session without parts, or a factory without a pool
  (`test/unit/m1a-factory.test.js`, `m5-w53-*.test.js`), need a fixture. No behaviour of a vat
  program changes.

### HR-GUEST-4 (moderate, questions 1, 4 and 5) Two extension mechanisms, module-level WeakMaps, and four context bags

- **Where** [read and measured]
  - **Generation one: static hook tables.** There are 13 append-only lists:
    - `turn-hooks.js:39-52`: six lists;
    - `tool-table.js:90-108`: `toolTable` and `toolSources`;
    - `holds-table.js:37`, `services.js:77`, `session-options.js:156`, `label-seeds.js:22` and
      `lib/prompt-sections.js`.

    They are module data, so a hook has no per-session closure. Per-session state therefore lives
    in module-level `WeakMap`s keyed by a session's objects:
    - `recovery.js:83` (recovered generation per core);
    - `packages.js:121` (`partOf(core)`, "rights amplification");
    - `tools/exec.js:62` (exec state per ExecHandle, shared with `inspect-client.js` through
      exported `execStateOf`, `takeScope` and `retireScope`).
  - **Generation two: M5 runtime parts** (`m5-parts.js`). These are per session and reach each
    other at run time (`runtime.grants`).
  - **Four context bags carry the internals:**
    - `SessionCore` (`session.js:122-131`) has 8 members; guest code uses 4 of them (`records`,
      `queue`, `current`, `settle`) [measured].
    - `runtime.session` (`session.js:182`): `{ core, queue, runner, inCrank, refuseIfDeleting }`,
      used only by `packages.js:140` and `:152`.
    - ToolContext (`turn.js:578-587`).
    - The hook context `{ core, active, round }`.
- **Evidence.** The append-only rule was a merge rule for parallel builders
  (`milestones.md:19-28`). It does not describe the product. The WeakMaps are hidden global state:
  they work, but a reader cannot see from `makeSession` what state a session has.
- **Fix.**
  1. Make exec state and the package table runtime parts (`exec` and `packages`).
  2. Pass `runtime` to hooks in place of `core`, and drop the three WeakMaps and `partOf`.
  3. Replace `runtime.session` by the two functions packages needs (an `enqueue` with attachments;
     see HR-GUEST-6).
  4. Keep static tables where the entries really are static: holds, prompt sections and option
     resolvers.
- **Size** [inferred]. About 150 lines in 8 files.
- **Risk.** The exec tool's serial queue and the inspector share state today through the
  WeakMap. Making it a part must keep "one scope per session, taken once". Covered by
  `test/unit/m1b-exec*.test.js` and `m5-w54/w55-*.test.js`.

### HR-GUEST-5 (moderate, questions 2 and 4) Usage arithmetic is written three times, with two context rules

- **Where** [read]
  1. `turn.js:107-113`, `:965-994` and `:1703-1712`: the five counts are listed field by field
     three times. The newest `context` reading replaces the old one whole, then
     `config.contextLength` overrides `windowTokens`.
  2. `lib/journal-usage.js:37-92`: the same tally over records. Its only importers are tests
     [measured], used as an oracle ("equals what `Session.getUsage()` answers", `:11-13`).
  3. `lib/token-usage.js:127-151` `addUsage`, used by the adapter: counts clamp at
     `MAX_COUNT`, and the newer context wins field by field, with 0 never replacing a known figure.
- **Evidence.** The adapter and the vat merge a context reading by different rules, and the
  oracle is a third copy of the vat's rule rather than the vat's code.
- **Fix.** Put one `addCounts(sum, next)` and one named context rule in `lib/token-usage.js`, and
  use them from `turn.js`. Move `journal-usage.js` to `test/` or build it on the same functions.
  Decide whether the vat's "whole reading" rule or the adapter's "field by field" rule is the
  model, and write it down in m2-interfaces.md 12.
- **Size.** About 60 lines, 3 files.
- **Risk.** R4-33 acceptance (`test/adapter/m2-w26-turns.test.js:601`, `m2-turns.test.js:402`).

### HR-GUEST-6 (moderate, question 2) `enqueueMessageOnce` re-implements `enqueueOnce`

- **Where** [read]. `session.js:217-225` and `packages.js:138-150` run the same five steps:
  `see(at)`, `queue.enqueueOnce`, return if not added, `claimNext`, re-read the receipt. The
  second adds the attachments argument. The second is also why `runtime.session` exposes the
  runner and the queue (HR-GUEST-4).
- **Fix.** One `enqueue(submission, requestId, at, attachments?)` in `session.js`. Both exo
  methods call it; packages contributes only `checkAttachments`.
- **Size.** About 20 lines. **Risk.** Low: `test/unit/m5-w57-*.test.js` and `m2-queue*.test.js`.

### HR-GUEST-7 (moderate, questions 2 and 4) The factory counts daemon starts in three places

- **Where** [read]. There are three separate `epoch` counters, each incremented once per start by
  the same start listener:
  - `factory.js:142` and `:495` (`recover`);
  - `delete.js:71` and `:193` (`resume`);
  - `pool.js:179` and `:461` (`onStart`).

  Each tags in-flight work with "the start it began in".
- **Evidence.** One fact, the factory's start count, is kept three times and named "epoch",
  "start epoch" and `startedAt`. "Epoch" already means three other things in the core
  (AR-ONTO-2) and a fourth in the round request (HR-GUEST-13).
- **Fix.** Keep one `starts` counter in the start listener (`factory.js` `recover`). Pass a
  `currentStart()` function to `makeDeletions` and `makePool`. Rename `epoch` to `start` on the
  creation and delete records.
- **Size.** About 20 lines, 3 files.
- **Risk.** `pool.onStart` and `deletions.resume` are called directly by
  `test/unit/m1b-pool*.test.js` and `m2-w27-delete*.test.js`. These are heap fields, not
  persisted text, so no migration is needed.

### HR-GUEST-8 (moderate, question 2) Small helpers are repeated

- **Where** [measured]
  - `messageOf` has seven copies in guest: `turn.js:89`, `exec/render.js:163`, and
    `tools/exec.js:126`, `granted.js:68`, `inspect-client.js:55`, `mentions.js:46` and
    `objects.js:41`. It has two behaviours: `render.js` also guards `String(error)` and the others
    do not. The core has `describe-error.js`.
  - `failed` and `ok` outcome builders: 6 and 3 copies.
  - `readArgs`: `objects.js:125`, `inspection.js:125`, and inline in `mentions.js:119`.
  - Byte-bounded page loops, `if (page.length > 0 && used + size > budget) break`: 6 in guest
    (`factory/export.js:80`, `rows.js:302`, `session/export.js:182` and `:206`,
    `context-source.js:61`, `history.js:244`) and one more in the adapter.
  - Eight ad hoc cursor grammars: `p<i>`, `p<i>.<k>`, `a<n>`, `r<n>`, `q<n>`, `e`, `s<n>` and
    `t<n>`.
  - One text twice: `turn.js:85` `CANCELLED_BEFORE_RUN` and `tools/exec.js:35` `NOT_RUN_TEXT`.
- **Fix.**
  - Put `messageOf`, `ok` and `failed` in `lib/bounded.js` or the per-vat interfaces module. A new
    module would cost 1.2 KB of wrapper.
  - Add `pageWithin({ count, at, from, maxItems, budget, sizeOf })` once to `bounded.js`.
  - Have `tools/exec.js` import the turn's text.
- **Size.** About 120 lines removed and 40 added, 10 files.
- **Risk.** Low. The `${error}` copies can throw on a hostile `toString` outside their `try`
  [inferred; the errors reaching them are passable errors, so unlikely]. Unifying on the
  guarded version removes that case.

### HR-GUEST-9 (moderate, question 1) `lib/` holds 1,754 lines that no vat runs, and the layout is by milestone, not by vat

- **Where** [measured]
  - Seven `lib/` modules are imported by no vat program: `interfaces-m3.js`, `interfaces-m4.js`,
    `limits-m4.js`, `reply-fold.js`, `token-usage.js` and `transcript-records.js` (adapter or UI),
    and `journal-usage.js` (tests). Together they are 1,754 lines.
  - `factory/standin-session.js` and `standin-exec.js` (144 lines) are test fixtures (provisioning
    templates) in the factory directory.
  - `session/prompt.js` runs only in the factory vat (`factory/session-options.js:16`; the session
    program never imports it).
  - Per-milestone files have two different reasons:
    - `limits-m4.js:9-13` and `texts-m4.js:5-7` stay out of the session bundle for size, which is
      a lasting reason;
    - `limits-m5.js:7-8` exists "so that M5 adds no line to `limits.js` ... which M3 and M4 may
      edit in parallel", which is a merge reason that no longer holds.
  - Naming follows no rule: `limitsM5` against `m4Limits` and `m3Limits`; `texts` and `textOf`
    exported by four modules (`interfaces.js`, `interfaces-m5.js`, `interfaces-m5-factory.js`,
    `exec/render.js`), imported under aliases 12 times (`textOfM5`, `m1Text`, `factoryTexts`).
- **Fix.**
  1. Lay `lib/` out by who loads it:
     - `lib/` for code in every vat;
     - `lib/session/`, `lib/factory/` and `lib/exec/` for one program;
     - `shared/` (or the adapter's own `lib`) for Node and UI code that is vat-safe but not vat
       code.
  2. Fold `limits-m5.js` into `limits.js`, or into per-vat limits if the split goes that way.
  3. Move `journal-usage.js` and the stand-ins under `test/` or `scripts/fixtures/`.
  4. Move `session/prompt.js` to `factory/`.
- **In hand.** Partly, through the per-vat interface split.
- **Size.** File moves plus about 120 import lines.
- **Risk.** `scripts/bundle-guest.mjs` and `scripts/provision-steps.js:83-95` name the stand-in
  paths. The adapter imports `guest/lib/...` in about 40 files.

### HR-GUEST-10 (minor, questions 3 and 4) Five hold reasons, one produced, and the deletion fallback misuses `stopped`

- **Where** [read]. `holds-table.js:16-20` says `interrupted` and `unavailable` cannot be reached
  and `refused` has no producer. The only producer is `recovery.js:181` (`restart`); an import can
  also carry a hold (`export.js:269-271`). The dead fallback in `export.js:94` holds `stopped`
  with the text `sessionDeleting`, so "stopped" (M6's emergency stop) would stand for deletion.
  The queue spans five modules (980 lines): `queue.js`, `submissions.js`, `holds.js`,
  `holds-table.js` and `lib/pending-queue.js`. Hold texts are reached two ways: `recovery.js:181`
  uses `texts.holdRestart` directly and `export.js:271` uses `holdText`.
- **Fix.** Keep the five reasons in the shape (spec A.4 names them). Fold `holds-table.js` into
  `holds.js` (the table indirection was the append-only seam). Have recovery use `holdText`. The
  fallback goes with HR-GUEST-3.
- **Size.** About 60 lines, 4 files. **Risk.** `test/unit/m2-queue-*.test.js`.

### HR-GUEST-11 (minor, question 4) The turn and the session core are typed twice, and the delete fence is held in three flags

- **Where** [read]
  - `ActiveTurn` is declared in `recovery.js:58-69` (9 properties) and `turn.js:144-176` (24).
  - `SessionCore` (`recovery.js:70-75`) declares 4 of the 8 members `session.js:122-131` builds.
  - The delete fence is held in three flags: `export.js:78` `deleting`, `turn.js:249` `deleting`
    and `archive.js:62` `fenced`. They are set together by `deleteSelf`, then read separately
    (`session.js:160`, `turn.js:1388` and `:1731`, `archive.js:134`).
- **Fix.** One typedef module for `ActiveTurn` and `SessionCore`. One fence owned by the runner
  (or by the lifecycle) and read through one function.
- **Size.** About 30 lines. **Risk.** None at run time.

### HR-GUEST-12 (minor, question 5) A start-listener registration failure is swallowed

- **Where** [read]. `factory/main.js:92-101`: `E(host).onStart(...)` rejects into
  `() => undefined`. `held.registration` is written and never read. The comment admits "A failure
  leaves the factory without restart recovery". Nothing in `HarnessRoot.status()` shows it.
- **Fix.** Record the failure and report it in `status()`, so the provisioning test and an
  operator can see it. Drop `held` if the registration need not be kept alive.
- **Size.** About 10 lines. **Risk.** None.

### HR-GUEST-13 (minor, question 4) "Epoch", "generation" and "powers" each name several things

- **Where** [read and measured]
  - **epoch**: the factory start count (HR-GUEST-7) and the context-cache epoch, which is always
    0 (`turn.js:867`, `archive.js:176`). This is in addition to the core's three (AR-ONTO-2).
  - **generation**: the turn generation that abandons late answers (`turn.js:233`), the seal
    intent's generation (`archive.js:58`) and the secret generation (`interfaces.js:2216`).
  - **powers**: four things:
    - the per-call model endowment (`exec/powers.js`);
    - the session's `ExecPowersSource` (`session/powers-source.js`);
    - the runtime part `powers`;
    - the JSDoc name of every constructor's argument bag (9 `@param {object} powers` in
      `factory/` and `session/export.js`).
  - Model-facing tool arguments say `petName` and `edgeName` (Fae's schema, fixed by the spec);
    the code says label (519 uses) and edge. This split is fine; the glossary should state it.
- **Fix.**
  - Add three entries to the core glossary: **start count** (factory), **turn generation**,
    **powers** (the model endowment only).
  - Rename the JSDoc bags to `options` or `deps`.
  - Drop `epoch: 0` until M8 (HR-GUEST-3).
- **Size.** About 20 lines of comments and 6 of code. **Risk.** None; nothing here is persisted
  text.

### HR-GUEST-14 (minor, question 4) Event and record spellings differ for the same concept

- **Where** [read].
  - Records use kebab case: `tool-intents`, `tool-result`, `turn-started` (`turn.js:551`,
    `:755`, `:1355`).
  - Live events mix two spellings: `tool_call` and `tool_result` (snake, from Fae's ReplyEvent),
    and `turn-start` (kebab) (`turn.js:559-566`, `:761-769`, `:1145`).
  - A turn settled `failed` is published as event `abort`, and every other status as `end`
    (`turn.js:479-487`).
- **Flag only.** The event names are the wire to the adapter channel fold and the browser
  (`lib/reply-fold.js`). Renaming them is a coordinated change across three packages. Record the
  mapping in the glossary instead.

### HR-GUEST-15 (minor, question 5) The archive index cap turns retained growth back on after 4,096 segments

- **Where** [read]. `archive.js:136`: at `archiveMaxSegments` (4,096, `limits.js:194`) sealing
  stops, and "the tail grows as before M2" (`designs/m2-interfaces.md:476`). This happens at
  131,072 turns.
- **Evidence.** A lifetime count switches off the bound on retained state. That is the pattern the
  owner's PR 1248 rule replaces: bound retained state, not lifetime counts.
- **Fix** [inferred]. Coalesce the oldest index entries into one, or page the index into the
  archive. Either way, sealing never stops.
- **Size.** About 40 lines plus the adapter's index reader. **Risk.** The archive's digest chain
  (`previous`); `test/unit/m2-w25-archive.test.js`. Not urgent.

### HR-GUEST-16 (minor, question 5) Comments narrate milestones, and some are stale

- **Where** [measured and read]
  - Guest code carries 949 milestone, work-unit or seam references (`M5 S3`, `W2.7`, `seam 4`,
    `H-4`).
  - Stale comments:
    - `session.js:19-24`: "throw `textOf.notBuilt` until W5.6 and W5.7 register them";
    - `recovery.js:37-40`: "(none in M1a)", "(empty in M1a; M9 adds child asks)", although two
      recovery steps are registered (`turn-hooks.js:49`);
    - `tool-table.js:20`: "M1a's only entry is `echo`";
    - `retired.js:8`: cites `hub.js:1522` and `:1947`, while the core review cites the same text at
      `hub.js:1842`, `2278` and `2306`.
- **Fix.** Write module comments in the present tense about the product, not the build history.
  Keep design-section references and drop work-unit numbers. Cite hub behaviour by function name,
  not line.
- **Size.** Comment-only, spread over about 30 files. **Risk.** None.

### Considered and left

- `lib/turn-engine.js` is a Fae port. Its one caller stubs half the callbacks (`turn.js:936-958`:
  `cursor ''`, empty context, identity `commitStep`), and its `answered: false` path cannot occur.
  It still states the turn invariant in 50 lines and keeps parity with Fae, so leave it.
- The test-injection options of `makeSession` (9) and `makeTurnRunner` (12) are used by about 11
  test files. Keep them, but delete the ignored `contextSource` option (HR-GUEST-3).
- The duplication between vat and adapter (records against the context cache, the segment index
  against the archive store) is the design (D-9: the vat is the system of record, the adapter
  caches). No finding.

---

## 4. Not covered

- `exec/membrane.js`, `exec/inspect.js`, `session/tools/granted.js` and `inspect-client.js` were
  read only for structure, not for the correctness of the membrane or the grant states.
- `factory/presets.js`, `preset-templates.js`, `inventory.js`, `rows.js`, `list-feed.js` and
  `root.js` were skimmed. They gave no structural finding beyond HR-GUEST-3, -7 and -8, but their
  logic was not reviewed.
- `lib/pending-queue.js`, `lib/tool-args.js` and `lib/bounded.js` were read for their interfaces
  and use, not line by line.
- Tests were opened only to check who uses an export. Whether each test tests what it names is
  left to the tests unit.
- No bundle was built. Byte figures come from J-9933, and byte savings are inferred.
- Nothing was run against a supervisor.
