# SES top-level await

| | |
|---|---|
| **Created** | 2026-05-14 |
| **Updated** | 2026-10-10 |
| **Author** | Designer (prompted) |
| **Status** | Proposed |

## Problem statement

SES today loads modules synchronously. Each module's body runs to
completion before any importer reads its exports, and the linker is
free to assume that "the body has run" and "the exports are settled"
are the same fact. Top-level `await` (TLA) makes a module's body
asynchronous: the body suspends across microtasks while awaiting a
promise, so "the body has run" is no longer synchronous with
"exports are settled." Three things break in SES under that change;
the design below addresses each.

The SES module loader executes modules synchronously, bottom up, cycle
tolerant ([packages/ses/src/module-instance.js line 401](../packages/ses/src/module-instance.js#L401)).
A module's `execute()` returns `undefined`; the linker assumes
that when `execute()` returns, the module's bindings are settled. Top-level
`await` at module scope (henceforth TLA) violates this assumption: a module
that awaits is, by construction, *suspended* across microtasks, and its
exports do not settle until the awaited promise resolves and execution
resumes.

Three observable problems follow.

1. **Source rejection.** The module-source transform parses with
   `sourceType: 'module'` ([packages/module-source/src/transform-analyze.js line 89](../packages/module-source/src/transform-analyze.js#L89)),
   so `@babel/parser` accepts the `await` token at module top
   level. `buildFunctorSource` then wraps the body in an arrow IIFE
   ([packages/module-source/src/functor.js line 79](../packages/module-source/src/functor.js#L79)):
   `({imports,liveVar,onceVar,import,importMeta})=>(function(){'use
   strict'; ... })()`. This wrapper is the module's *functor*: the
   per-module function `ModuleSource` emits, which the linker invokes to run
   the module body with its imports/exports plumbing bound. The inner IIFE
   is **not async**, so the parser later refuses the `await` inside it. SES
   users today see a syntax error from the second-pass evaluation of the
   functor, not from the user's source.
2. **No execute contract for async modules.** Even if the functor were
   async, `makeModuleInstance` returns `execute` that ignores its return
   value. The linker would treat the still-pending promise as "done" and
   surface uninitialized bindings to downstream importers.
3. **No cycle invariant.** 262's cyclic-module-records algorithm names a
   distinct `[[CycleRoot]]` — the module whose evaluation is the entry
   point into a strongly-connected component of the module graph — for an
   importer that reaches a member of an async cycle. SES has no such
   bookkeeping today; the present linker memoizes by full specifier and
   trusts the depth-first walk to settle exports before any importer reads
   them. That trust fails when any member of the cycle is async. (This
   design deliberately does **not** reintroduce a `[[CycleRoot]]` field;
   [Module-instance contract](#module-instance-contract) shows why the same
   disambiguation falls out of two simpler invariants.)

The aim of this design is to support TLA per the 262 cyclic-module-records
algorithm across every Endo module host: the SES shim, the module-source
precompilation pipeline, `@endo/compartment-mapper` (and the bundle and
archive formats built on it), and the IronHorse engine's native
`Compartment`. A module that does not itself use `await` and does not
import an async dependency transitively keeps its synchronous semantics on
every host.

Two maintainer directions on the calling convention shape the design
([review 5095793109](https://github.com/endojs/endo-but-for-bots/pull/249#pullrequestreview-5095793109)):

- `compartment.importNow(specifier)` returns after the **first turn** of a
  module graph's initialization; `compartment.import(specifier)` returns a
  promise for the exports once asynchronous initialization has completed.
  See [`importNow` returns after the first turn](#importnow-returns-after-the-first-turn).
- Virtual module instances are constructed by passing a virtual module
  source to `compartment.import` (and `importNow`). The source carries
  `isAsync` and an `initialize(environment, { import, importNow,
  importMeta })` function, so one calling convention covers synchronous and
  asynchronous modules. See
  [Virtual module sources and the import calling convention](#virtual-module-sources-and-the-import-calling-convention).

## Scope

In scope:

- **Flag.** An `isAsync` flag, derived statically at module-analyze time
  and carried on the module source. It is the 262 `[[HasTLA]]` field.
  Precompiled records carry it as `__isAsync__`, next to `__needsImport__`
  and `__needsImportMeta__`. `ModuleSource.prototype` exposes it as an
  `isAsync` getter, next to `needsImport` and `needsImportMeta`. Virtual
  module sources declare it as an own `isAsync` property. The naming
  rationale is in [Naming](#naming-isasync-and-initialize).
- **Instance state.** An `[[AsyncEvaluation]]` boolean and a
  `[[PendingAsyncDependencies]]` count on the module instance.
- **Asynchronous `execute()`.** An asynchronous `execute()` path on
  `makeModuleInstance`. Its returned promise settles when, and only when,
  the module's body has completed: immediately in the sync case, and when
  the body's implicit promise resolves in the async case.
- **Linker bookkeeping.** Bookkeeping for `[[AsyncParentModules]]` and the
  `gatherAsyncParentCompletions` walk. SES deliberately omits 262's
  `[[CycleRoot]]` selection; see
  [Module-instance contract](#module-instance-contract) for why the same
  disambiguation falls out of simpler invariants. IronHorse, a native
  engine gated on test262 conformance, follows the spec fields verbatim
  ([IronHorse engine](#ironhorse-engine)).
- **The `compartment.import(...)` contract.** Today the public method
  ([packages/ses/src/compartment.js line 180](../packages/ses/src/compartment.js#L180))
  has no deferred-capability object: its promise is an ordinary `async`
  function's return value, chained through `load`+`execute`. (The
  `[[TopLevelCapability]]`-shaped object at
  [compartment.js line 439](../packages/ses/src/compartment.js#L439) is the
  separate `compartmentImport` endowment that gates a module body's
  *dynamic* `import()`, not the public method.) This design adds a
  `[[TopLevelCapability]]`, and the returned promise settles *after* TLA in
  the imported subgraph resolves. Today it settles right after a
  `link`+`execute` round-trip.
- **The `compartment.importNow(...)` contract.** It stays synchronous. It
  loads and links the graph, runs every synchronous step of evaluation, and
  starts each asynchronous body. Then it returns the namespace, whose
  bindings may still be in their temporal dead zone. It does **not** reject
  async graphs; an earlier draft did.
- **Virtual module sources.** Synchronous and asynchronous virtual module
  sources under one calling convention, accepted directly by
  `compartment.import` and `compartment.importNow`.
- **`@endo/compartment-mapper` ramifications.** The archive language
  designator, the synchronous script-bundle runtime, the CommonJS `require`
  path through `importNow`, and the policy and attenuator virtual sources.
- **IronHorse engine.** Native async module evaluation, native
  `Compartment.prototype.import`/`importNow` with the same contract, and the
  virtual-source calling convention.
- **Hardened test262 cases.** New hardened262 cases, authored in the design
  phase, that run on every agent: SES-on-Node, SES-on-XS, bare XS,
  IronHorse, and SES-on-IronHorse.

Out of scope:

- `await using` (explicit-resource-management). That is a sibling proposal
  whose grammar interacts with TLA but whose lifetime semantics are
  separate.
- Changing the native XS `Compartment`. XS is the reference
  implementation hardened262 compares against. Where XS diverges from this
  contract, the baseline records the divergence as a finding; this design
  does not patch XS.
- Import attributes and deferred import (`import defer`) evaluation.
  test262's `import-defer/evaluation-top-level-await/` cases are sorted
  into the IronHorse expectations, but deferred evaluation is its own
  design.

## Test suite

The test suite leads because the spec for TLA *is* a finite set of
observable shapes. Each shape names one fixture pattern and one
assertion. The SES implementation must pass every shape; absent fixtures
are absent capabilities.

The suite has two layers. The ava suite below tests SES-shim internals:
`asyncEvaluation`, the archive round trip, the mapper's `require` guard.
The [hardened test262 cases](#hardened-test262-cases) test the
user-visible `Compartment`/`ModuleSource` contract on every engine agent.
The hardened cases are authored in the design phase, before any
implementation, so each agent's baseline records today's failures as the
starting line.

The fixtures live in [packages/ses/test/module-top-level-await/](../packages/ses/test/module-top-level-await/)
and are loaded through ava-driven harnesses that build a Compartment with
an `importHook` returning a `ModuleSource` for each fixture key.

### Shape table

The table is grouped to match test262's
[language/module-code/top-level-await/](https://github.com/tc39/test262/tree/main/test/language/module-code/top-level-await)
directory, which is the canonical reference for what "TLA conformance"
means at the spec level. Each row's *Equivalent* names the matching
test262 fixture; the SES test transliterates the spec scenario into the
shim's `Compartment` + `importHook` shape.

A handful of design terms appear in the row cells before the Design
section defines them; reading the next paragraph first or skimming
the Design section before returning to this table is fine. The terms:

- `__isAsync__` is a static boolean on the precompiled module
  record, set by the analyzer when the body contains a top-level
  `AwaitExpression`. See [Static analysis](#static-analysis-detect-async-at-parse-time).
- `[[AsyncEvaluation]]` is the spec field that distinguishes a
  module whose evaluation is asynchronous (because the module itself
  is async or it transitively depends on one) from a fully-sync
  module. On the instance side this is the `asyncEvaluation` field.
  See [Module-instance contract](#module-instance-contract).
- `[[PendingAsyncDependencies]]` counts the async deps that have not
  yet fulfilled; on the instance, `pendingAsyncDependencies`. See
  the same section.
- `[[TopLevelCapability]]` is the deferred-promise pair the
  `compartment.import` promise resolves through when the async body
  completes; on the instance, `topLevelCapability`. Same section.
- `DFS` is depth-first search/order — the traversal order the linker
  walks the module graph in (rows 7 and 9).
- `SCC` is a strongly-connected component — a maximal set of modules
  mutually reachable through import cycles (row 10). Expanded again at
  first Design use in [Module-instance contract](#module-instance-contract).
- `TDZ` is the temporal dead zone — the window in which a binding is
  declared but not yet initialized, so an access throws a `ReferenceError`
  (row 11).

The rows below (1–25 plus the inserted sub-rows `12a` and `13a`–`13c`) are
framed as the implementation's acceptance criteria. Rows 1–17 are the
SES-shim transliteration of test262's TLA directory. Rows 18–25 cover the
virtual-source calling convention and the compartment-mapper
ramifications. Every row that does not depend on SES internals is also
authored as a hardened test262 case
([Hardened test262 cases](#hardened-test262-cases)), so the same behavior
is checked on XS and IronHorse too. test262's TLA directory is the canonical
upstream; if a future test262 addition catches a regression these
rows do not, a follow-up adds the row (or imports the test262
fixture directly through the shim's transliteration harness).

| # | Shape | Equivalent test262 fixture | What it asserts |
|---|-------|---------------------------|-----------------|
| 1 | `await 42` resolves to `42` at module scope | `await-expr-resolution.js` | The await operator forwards primitive, thenable, and Promise operands per the standard |
| 2 | `await Promise.reject(e)` rethrows `e` | `await-expr-reject-throws.js` | A rejected awaited promise becomes a module-evaluation rejection |
| 3 | `await { then: 'not-callable' }` resolves to the object | `await-awaits-thenable-not-callable.js` | Non-callable `then` falls back to value coercion |
| 4 | Module with `export const x = await 1; export default await 2;` is importable | `module-import-resolution.js` + `..._FIXTURE.js` | The importer sees settled exports after the importer's own `[[TopLevelCapability]]` resolves |
| 5 | Module whose body rejects causes downstream `import` to reject | `module-import-rejection.js` + `..._FIXTURE.js` | The rejection propagates through `[[AsyncParentModules]]` to the top-level capability |
| 6 | Sync importer of async dep: the importer is itself `[[HasTLA]] === false`, but `[[PendingAsyncDependencies]] > 0` flips `[[AsyncEvaluation]]` to true | `module-sync-import-async-resolution-ticks.js` | A purely-sync module that imports an async dep is still evaluated after the dep settles |
| 7 | Async importer of async dep: chained ticks observed in DFS post-order | `module-async-import-async-resolution-ticks.js` | Tick ordering matches the spec's queue discipline |
| 8 | `await 1; await 2; tick 1...tick 4` interleaving | `top-level-ticks.js` | Microtask interleaving matches the spec; promise-then ticks ordered against await ticks |
| 9 | DFS-invariant under diamond async deps | `dfs-invariant.js` | Two paths to one async leaf produce one execution; parents complete in DFS post-order |
| 10 | Cycle containing an async member: a leaf-importer's namespace is observable only after every async member of the cycle its imports reach has fulfilled | `pending-async-dep-from-cycle.js` | `pendingAsyncDependencies` is non-zero on the importer until the SCC drains; no member's exports are read out of order |
| 11 | Self-import of an async module: ReferenceError on access during cycle, resolved post-await | `module-self-import-async-resolution-ticks.js` | Self-import's TDZ behavior holds across the await suspension |
| 12 | `await import(specifier)` from a sync module: dynamic import resolves to the namespace, sync module remains sync | `dynamic-import-resolution.js` | Dynamic import is *not* TLA; it uses the existing `compartmentImport` path |
| 12a | Dynamic import of a still-suspended async module from inside another async module's await window | `dynamic-import-of-waiting-module.js` (test262) | The dynamic-import promise settles on the target's `topLevelCapability`, not eagerly; the caller resumes after the target's body completes |
| 13 | `compartment.importNow` of an async module returns synchronously after the first initialization turn | new, SES-only | The namespace is returned before the body's first `await` resumes; a hoisted `export function` is callable, while an `export const` assigned after the `await` throws `ReferenceError` (TDZ) until the body resumes |
| 13a | `compartment.importNow` of a *purely-sync* root that transitively imports an async dep | new, SES-only | The root's body has **not** run when `importNow` returns, because its `pendingAsyncDependencies` is non-zero (row 6). Its namespace is returned and its body-assigned bindings are uninitialized. The case asserts only that the body has not run, not whether hoisted functions are callable, because the shim and 262 differ there (see [`importNow` returns after the first turn](#importnow-returns-after-the-first-turn)) |
| 13b | `compartment.import` after `compartment.importNow` of the same async specifier | new, SES-only | The later `import` resolves on the *same* `topLevelCapability` the first-turn evaluation started; the body runs once, never twice |
| 13c | `compartment.importNow` of an async module whose body later rejects | new, SES-only | `importNow` does not throw. A later `compartment.import` of the same specifier rejects with the body's error, and repeated imports reject with the same error identity |
| 14 | Pre-compiled module source with `__isAsync__: true` round-trips through an `endoZipBase64` archive and `importBundle`, executing with the same TLA semantics | new, SES-only | The async flag and the `pre-mjs-async-json` language survive the archive round trip; see [Compartment-mapper ramifications](#compartment-mapper-ramifications) |
| 15 | Pre-compiled module source with no TLA stays synchronous | new, SES-only regression | `[[AsyncEvaluation]]` never flips to true; `importNow` returns a fully initialized namespace and `import` resolves as today. No regression for the 99%-of-modules-are-sync case |
| 16 | Syntax: `await` at module top level outside any function is accepted | test262 `syntax/` directory (sampled: `if-block-await-expr-identifier.js` and siblings) | The module-source transform accepts the source; the functor is async |
| 17 | Syntax: `await` is still rejected inside a non-async function nested in a module | test262 `early-errors-await-not-simple-assignment-target.js` and surrounding | The transform's nested-function check is unchanged; only the module-scope IIFE is async |
| 18 | `new ModuleSource(text).isAsync` is `true` for module-scope `await` and `false` for `await` inside a nested `async function` | new; hardened262 `ModuleSource/isAsync/` | The reflected flag is the static `[[HasTLA]]`, not "evaluates asynchronously" |
| 19 | Virtual source `{ isAsync: true, initialize: async (environment) => { await p; environment.x = 1; } }` passed to `compartment.import` | new; hardened262 `VirtualModuleSource/isAsync/` | The import resolves after `initialize`'s promise fulfills, and `x` is `1` |
| 20 | Virtual source with `isAsync` absent or `false` whose `initialize` returns a thenable | new; hardened262 `VirtualModuleSource/isAsync/` | Rejects (or, through `importNow`, throws) a `TypeError` naming the module; a synchronous source may not complete asynchronously |
| 21 | Virtual source's `initialize` receives `{ import, importNow, importMeta }` only as declared | new; hardened262 `VirtualModuleSource/initialize/` | `import` and `importNow` are present iff `needsImport`; `importMeta` is present iff `needsImportMeta`; `environment` is sealed, export properties writable, import properties read-only |
| 22 | Sync module importing an async virtual source | new; hardened262 `VirtualModuleSource/isAsync/` | The row-6 propagation applies to virtual sources: the importer's body runs after `initialize`'s promise fulfills |
| 23 | `compartment.import(virtualSource)` and `compartment.import(new ModuleSource(text))` without a specifier | new; hardened262 `prototype/import/source-argument-*` | Each call constructs a fresh, unmemoized instance; the source's `bindings` imports resolve through the compartment's hooks |
| 24 | CommonJS `require()` of an ESM whose static closure contains an `isAsync` source, through compartment-mapper | new, mapper-only | Throws `ERR_REQUIRE_ASYNC_MODULE`-shaped `Error`, matching Node's `require(esm)`; see [Compartment-mapper ramifications](#compartment-mapper-ramifications) |
| 25 | Script-format bundle (`endoScript`, `getExport`, `nestedEvaluate`) of a graph containing TLA | new, mapper-only | Bundling throws naming the async module; the synchronous bundle runtime never sees an async functor |

### Implementation of the harness

Each test is a single ava test case that:

1. Constructs a `Compartment` with an `importHook` that maps a static map
   of `specifier -> ModuleSource`. The source records come from the
   module-source analyzer applied to the fixture text inline; for
   regression-grade tests, the precompiled functor is captured to a
   golden file (`__isAsync__` and `__syncModuleProgram__` are
   asserted by string match).
2. Injects one or more resolver pairs into the fixture's evaluation
   environment. The fixture body awaits a named pair's `promise`; the
   harness drives the pair by calling `resolve(value)` (or `reject(e)`)
   at a known point in the test, then awaits the importer's
   `compartment.import` result. The pair is created by
   `Promise.withResolvers()` (or the equivalent helper) and lives in
   the harness; the fixture receives the `promise` half via an import
   binding or a designated global slot. This makes asynchrony in the
   fixture deterministically *driven by the test*, not by an opaque
   microtask scheduler. The pattern subsumes the test262 idiom of
   `await 42` / `await Promise.resolve(...)` because the resolver-pair
   shape lets a single test express both "fulfill after N ticks of
   harness-driven control" and "reject after M ticks."
3. Invokes `await compartment.import(rootSpecifier)`.
4. Asserts on (a) the resolved namespace, (b) the order of tick
   markers (recorded as side effects of the resolver-pair drives, or
   pushed onto a harness-local array passed in via an import binding),
   and (c) the rejection identity where the test expects rejection.

The resolver-pair injection replaces the test262 "globalThis log
array" idiom for the DFS-invariant case (row 9) and the cycle case
(row 10): each fixture awaits a named pair whose resolution order the
harness controls, and the test asserts on the order of `resolve` calls
the harness issued plus the order the importer observed namespace
settlement. A harness-local array (passed in via the import binding,
not via `globalThis`) collects tick markers when a row's assertion is
about microtask interleaving and not solely about settlement order;
this keeps the fixtures free of shared-global state and lets two ava
tests run in parallel without cross-talk.

### Test fixtures that do not translate

A small subset of test262 TLA fixtures depend on host-driven
`$DONE`/`Test262Error` infrastructure that does not have a direct
ava analogue. Those are recast as direct ava `t.is` / `t.throws`
calls; the spec assertion is preserved, the harness is rewritten.

### Hardened test262 cases

[`@endo/hardened262`](../packages/hardened262/README.md) runs test262-style
cases against every Hardened JavaScript agent: bare XS (`xs`), SES on XS
(`sesXs`), SES on Node (`sesNode`), bare IronHorse (`ironhorse`), and SES on
IronHorse (`sesIronhorse`). Its stated purpose is to show that the shim and
native implementations behave the same, which makes it the acceptance
surface for a contract this design defines on three engines at once. The
cases below are part of the design phase. They land with the design (or
in the first implementation PR, ahead of any source change) and are
recorded in each agent's `baseline/<agent>/<scenario>/` as failing. Each
implementation phase then moves its rows from `failed` to `passed`, and
`yarn test262:baseline` keeps the movement monotonic.

Conventions, following the existing `test/Compartment/` tree:

- The YAML header carries `flags: [async, onlyStrict]` and
  `features: [Compartment, top-level-await]`. Cases whose *module text*
  uses `await` are built from `new ModuleSource(text)` strings, so the test
  file itself is strict script code. It therefore runs in the scenarios
  each agent executes today
  ([`agentRunsScenario`](../packages/hardened262/scripts/test.js#L309)):
  `module`/`lockdownModule` on XS and Node, and `strict`/`lockdownStrict`
  on IronHorse.
- Completion is reported through `$DONE` and `harness/doneprintHandle.js`,
  as `VirtualModuleSource/needsImportMeta/test.js` does.
- Asynchrony is driven deterministically by resolver pairs, not by counting
  microtask ticks against an opaque scheduler (the maintainer's direction on
  the [earlier review](https://github.com/endojs/endo-but-for-bots/pull/249#discussion_r3244019807)).
  A new include, `harness/moduleResolverPairs.js`, exports
  `makeGate(name)`. It returns `{ promise, resolve, reject }` and a virtual
  module source whose async `initialize` awaits the gate's promise. A test
  composes gates into a module graph through `modules: { ... }` and opens
  them in a chosen order.
- Per-agent opt-outs (`noXs`, `noSesXs`, `noSesNode`) are **not** used to
  hide divergence. A case that XS fails because XS's native behavior
  differs from this contract stays enabled, and the `xs` baseline records
  the failure as a finding.

| Path under `packages/hardened262/test/Compartment/` | Asserts | Shim rows |
|---|---|---|
| `ModuleSource/isAsync/name.js`, `ModuleSource/isAsync/prop-desc.js` | `isAsync` is an accessor on `ModuleSource.prototype`, like `needsImport`, with the standard getter name and descriptor | 18 |
| `ModuleSource/isAsync/module-scope-await.js` | `new ModuleSource('await 0;').isAsync === true`; also for `await` in a block, in a `for await` head, and in an `export const` initializer | 16, 18 |
| `ModuleSource/isAsync/nested-await.js` | `false` for `await` only inside an `async function`, an async arrow, or an async method; `false` for a module with no `await` | 17, 18 |
| `prototype/import/top-level-await/resolves-after-body.js` | `import` resolves only after a gate-driven body completes; exports read through the namespace are the post-`await` values | 1, 4 |
| `prototype/import/top-level-await/rejection-propagates.js` | A body rejection rejects the importer's `import`, with the same error identity on a repeated `import` | 2, 5 |
| `prototype/import/top-level-await/sync-importer-of-async-dep.js` | A non-`await` importer's body runs after its async dependency's gate opens | 6 |
| `prototype/import/top-level-await/diamond-order.js` | Two paths to one async leaf run it once; parents complete in post-order, recorded in a log array passed through a gate module | 7, 9 |
| `prototype/import/top-level-await/cycle-with-async-member.js` | In a cycle with one async member, the importer's namespace settles only after that member's gate opens | 10 |
| `prototype/import/top-level-await/self-import-tdz.js` | A self-importing async module observes TDZ before its `await` and the value after | 11 |
| `prototype/import/top-level-await/dynamic-import-waiting-module.js` | A dynamic `import()` of a still-suspended module settles on that module's completion, not eagerly | 12a |
| `prototype/importNow/top-level-await/returns-after-first-turn.js` | `importNow` returns before the gate opens; a hoisted `export function` is callable; an `export const` initialized after `await` throws `ReferenceError` | 13 |
| `prototype/importNow/top-level-await/sync-root-of-async-dep.js` | A non-`await` root's body has not run when `importNow` returns | 13a |
| `prototype/importNow/top-level-await/import-after-importNow.js` | A subsequent `import` of the same specifier shares the evaluation (the body runs once) and resolves when the gate opens | 13b |
| `prototype/importNow/top-level-await/rejection-after-first-turn.js` | `importNow` does not throw; a later `import` rejects with the body's error | 13c |
| `VirtualModuleSource/isAsync/initialize-awaited.js` | `{ isAsync: true, initialize: async (environment) => ... }` resolves after `initialize`'s promise | 19 |
| `VirtualModuleSource/isAsync/sync-source-returns-thenable.js` | `isAsync` absent or `false` with a thenable-returning `initialize` is a `TypeError` | 20 |
| `VirtualModuleSource/isAsync/sync-importer.js` | A non-`await` importer of an async virtual source waits for it | 22 |
| `VirtualModuleSource/initialize/context.js` | The second argument carries `import` and `importNow` iff `needsImport`, and `importMeta` iff `needsImportMeta` | 21 |
| `VirtualModuleSource/initialize/environment-sealed.js` | `environment` is sealed: exports writable, imports read-only, no reexport properties; the seal holds across an `await` | 21 |
| `prototype/import/source-argument-virtual.js`, `prototype/import/source-argument-module-source.js` | `import(source)` without a specifier builds a fresh instance per call | 23 |

The test262 TLA directory itself (`language/module-code/top-level-await/`,
about 250 files with its `syntax/` subdirectory) is not copied into
hardened262. IronHorse already runs it through `ironhorse-262` with
per-file expectations ([IronHorse engine](#ironhorse-engine)), and the
`test262-runner` package runs it on Node and XS. hardened262 covers only
what test262 cannot express: the `Compartment` and `ModuleSource` surface,
under `lockdown`.

## Design

> **A note on the implementation citations below.** The Prompt asks for
> a design implementable on `actual/master` (upstream endo's master
> branch). Paths and line numbers below are against the frozen base this
> revision is pinned to (`llm-7d2eb30`). Since the 2026-10 refresh, the
> bots-fork `module-source` package has the same layout as master: the
> functor template lives in `functor.js` (`buildFunctorSource`) and the
> analyzer visitors in `babel-plugin.js`. The SES citations
> (`module-load.js`, `module-link.js`, `module-instance.js`,
> `compartment.js`) port to master directly. The compartment-mapper and
> IronHorse sections apply only to the bots fork, where those packages
> and the `rust/engine` tree exist in the cited form.

### Implementation map

| Surface | Files | Change |
|---|---|---|
| Analyzer | [`module-source/src/babel-plugin.js`](../packages/module-source/src/babel-plugin.js) | Detect module-scope `await` and `for await`; set `isAsync` |
| Functor | [`module-source/src/functor.js`](../packages/module-source/src/functor.js#L79) | Emit `async function` for the inner IIFE when `isAsync` |
| Record | [`module-source/src/functor.js`](../packages/module-source/src/functor.js#L103) (`buildModuleRecord`), [`module-source.js`](../packages/module-source/src/module-source.js#L49) | Carry `__isAsync__`; add the `isAsync` getter |
| Permits | [`ses/src/permits.js`](../packages/ses/src/permits.js#L1758) | Add `isAsync: getter` to `%ModuleSourcePrototype%`, next to `needsImport` |
| Link | [`ses/src/module-link.js`](../packages/ses/src/module-link.js#L56) | Recognize `__isAsync__`; recognize the `initialize`-shaped virtual source; build the async bookkeeping ([Linker bookkeeping](#linker-bookkeeping)) |
| Instance | [`ses/src/module-instance.js`](../packages/ses/src/module-instance.js#L118) | Async `execute()`, capability, parent walk; `makeVirtualModuleInstance` gains the `initialize` path |
| Compartment | [`ses/src/compartment.js`](../packages/ses/src/compartment.js#L130) | `import` awaits the root capability; `importNow` returns after the first turn; both accept a module source in place of a specifier |
| Mapper | `compartment-mapper/src/` | See [Compartment-mapper ramifications](#compartment-mapper-ramifications) |
| Engine | `rust/engine/ironhorse-vm/src/` | See [IronHorse engine](#ironhorse-engine) |

### Static analysis: detect async at parse time

The Babel analyzer plugin gains two visitors. A module-scope `for await`
is TLA too, but Babel represents it as a `ForOfStatement` with `await:
true`, not as an `AwaitExpression`:

```js
AwaitExpression(path) {
  // Only flag await whose enclosing function-or-program scope is the
  // module program itself, i.e. there is no Function ancestor between
  // path and Program.
  if (!path.getFunctionParent()) {
    sourceOptions.isAsync = true;
  }
},
ForOfStatement(path) {
  if (path.node.await && !path.getFunctionParent()) {
    sourceOptions.isAsync = true;
  }
},
```

The module analysis record gains one new field:

```js
{
  ...
  __isAsync__: boolean,
}
```

The transform then emits the IIFE wrapper as `async` when the flag is
set; the outer arrow stays sync (it merely *returns* the async IIFE's
promise to the linker):

```js
// Sync module (today):
({imports,liveVar,onceVar,import:_,importMeta}) =>
  (function(){'use strict'; ...})();

// Async module (new):
({imports,liveVar,onceVar,import:_,importMeta}) =>
  (async function(){'use strict'; ...})();
```

Pre-existing modules that do not use `await` produce byte-identical
output. The flag travels in the precompiled record alongside
`__syncModuleProgram__` (renamed conceptually: the field still carries
the program source; the *Async* dimension is the new
`__isAsync__` boolean).

A note on class static blocks. The `path.getFunctionParent()` check
treats a class static block as a non-function scope: `await` is a
syntax error inside a static block per the current 262 grammar (the
static block is not an async-function body), so the
`AwaitExpression` visitor never fires inside one. If a future
proposal lifts that restriction (e.g. an `async` static block, or a
`top-level-await-in-static-block` grammar variant), the visitor will
need a static-block check parallel to the function-parent check. Out
of scope for this design; flagged so the next analyzer revision
recognizes it as an explicit decision.

### Module-instance contract

The shape below tracks the SES-shim's existing `makeModuleInstance`
return shape and adds the new fields that the 262 async-module
evaluation algorithm requires. TC39's
[proposal-compartments](https://github.com/tc39/proposal-compartments)
sketches a host-API shape that lets a host pass a `ModuleSource` to a
Compartment for evaluation, and (informatively for this design) names
the same async-evaluation fields the 262 algorithm names. The
shim-side fields here are deliberately named to match the
proposal's user-visible vocabulary (`asyncEvaluation`,
`asyncParentModules`, `pendingAsyncDependencies`) so that a future
proposal-compartments-conformant native Compartment and the SES shim
share a single mental model for the data dependency graph. Where this
design diverges from the proposal it is for SES-specific reasons
documented inline (the `requireSync` opt-in on `importNow` and the
archive language designator are Endo-specific).

`makeModuleInstance` returns an object with:

```ts
{
  exportsProxy,         // unchanged
  notifiers,            // unchanged
  execute: () => undefined | Promise<undefined>,
  asyncEvaluation: boolean,   // new; the [[AsyncEvaluation]] field.
                              // STATIC identity: set once at link time and
                              // never cleared — "this module's evaluation
                              // is asynchronous", not "still running".
  evaluationFulfilled: boolean, // new; TIME-varying: false until this
                              // module's body has completed and its
                              // topLevelCapability has settled, then true.
                              // Distinguished from asyncEvaluation on
                              // purpose (see re-link note below).
  topLevelCapability:         // new; settled by ExecuteAsyncModule
    | undefined
    | { promise: Promise<undefined>, resolve, reject },
  asyncParentModules: Array<ModuleInstance>, // new; reverse edges
  pendingAsyncDependencies: number,          // new; counts only deps whose
                              // evaluationFulfilled is still false
}
```

The split between `asyncEvaluation` (static identity, set once) and
`evaluationFulfilled` (time-varying, flips when the body completes) is
load-bearing, not cosmetic: `pendingAsyncDependencies` counts only deps
that are *still pending* (`evaluationFulfilled === false`). Keying the
count on the static flag alone would mis-count a shared async dep that has
already fulfilled — see [Linker bookkeeping](#linker-bookkeeping) step 2
and [open question 4](#open-questions) for the re-link case this prevents.

This omits 262's `[[CycleRoot]]` field on purpose. The 262 algorithm
names a per-module `[[CycleRoot]]` to disambiguate which
`[[TopLevelCapability]]` to settle when any member of an asynchronous
strongly-connected component (SCC) fulfills. The same disambiguation
falls out of two simpler invariants here:

1. Every member of an async SCC, by the rules above, has
   `asyncEvaluation === true`, so each member already owns its own
   `topLevelCapability`.
2. `asyncParentModules` is the reverse-edge set; cyclic edges are
   present in that set just like non-cyclic edges. When any member of
   the SCC fulfills, `AsyncModuleExecutionFulfilled` sets that member's
   `evaluationFulfilled = true`, walks the reverse edges, decrements
   `pendingAsyncDependencies` on each reached parent, and settles the
   parent's capability when its pending count reaches zero. The
   `evaluationFulfilled` marker is what lets a *later* re-link
   distinguish an already-settled shared dep from a still-pending one
   (Linker bookkeeping step 2). The walk is correct on cyclic graphs
   without a named SCC root because the only piece of state that
   needs to be uniform across the SCC is "did this member's body
   fulfill," which is observable on the member directly.

If a follow-up analysis surfaces an observable difference that turns
on cycle-root identity (a case where two SCC members must settle
*together* under a single capability rather than each under its own),
the design will need to reintroduce a named root or an SCC-level
capability. Rows 10 and 11 do not require this: row 10 asserts that a
leaf-importer sees the cycle-root's body complete before any
cycle-member's exports are read by the importer, which the
`pendingAsyncDependencies` invariant already enforces (the importer's
pending count is non-zero until every member of the SCC its imports
reach has fulfilled); row 11's self-import TDZ behavior is a within-
single-module property and does not depend on root selection.

`asyncEvaluation` is true iff the module is `[[HasTLA]]` itself OR its
`[[PendingAsyncDependencies]] > 0`. The latter is the case for a
purely-sync module that imports an async dep transitively; row 6 of the
test table.

The synchronous-fast-path is preserved: when a module's
`asyncEvaluation` is false at link time, its `execute()` is the same
function as today, returning `undefined`. The `Promise<undefined>` shape
only materializes when the linker has actually walked across an async
boundary.

`asyncEvaluation` is the single source of truth for "is this execution
synchronous"; `execute()`'s `undefined | Promise<undefined>` return shape
is a *derived* consequence of it, not a second independent signal. Every
call site that decides whether to `await` `execute()`'s result gates on
`asyncEvaluation` (the linker is the sole caller today); nothing should
re-derive syncness from the return type, so the two can never drift.

### Linker bookkeeping

`link()` ([packages/ses/src/module-link.js](../packages/ses/src/module-link.js)) gains a second pass that walks the linked instance graph in DFS
post-order. For each instance:

1. If its source has `__isAsync__: true`, set `asyncEvaluation =
   true` and allocate `topLevelCapability`.
2. For each linked import target, if the target's `asyncEvaluation` is
   true **and the target has not already fulfilled**
   (`target.evaluationFulfilled === false`), push `this` onto the target's
   `asyncParentModules` and increment `this.pendingAsyncDependencies`. An
   async target that has *already* fulfilled on a prior evaluation
   contributes no pending edge: its exports are settled, so it links as an
   ordinary settled dependency and never has cause to decrement a counter
   again. (Gating on the static `asyncEvaluation` alone would be the re-link
   deadlock of [open question 4](#open-questions): the new parent would
   increment for a dep whose one fulfillment event already fired, so the
   decrement never comes and the parent's capability hangs forever.) Each
   `link()` pass **rebuilds** `pendingAsyncDependencies` from the freshly
   walked dependency set and appends only the reverse edges for this pass's
   still-pending deps, rather than monotonically accumulating across
   re-links.
3. After the pass: if `pendingAsyncDependencies > 0` and the instance
   itself is not `[[HasTLA]]`, set `asyncEvaluation = true` and allocate
   the capability anyway. This is the row-6 case.

Cycles are not a special case for the bookkeeping. A back-edge
discovered during the DFS sets up the same `asyncParentModules`
reverse edge and the same `pendingAsyncDependencies` increment as a
non-cycle edge. The linker does not need to compute SCCs at link
time; the fulfillment walk in `AsyncModuleExecutionFulfilled` settles
capabilities in the order the bodies complete, which is the order the
spec requires.

### Evaluation procedure (the InnerModuleEvaluation analogue)

In the sequence below, **Root** is the importer the user named in
`compartment.import(spec)`, and **Async dep** (**Dep**) is any
transitively-reached module whose `asyncEvaluation` is true. Reading those
two labels first keeps the diagram legible.

```mermaid
sequenceDiagram
  participant User as User code
  participant Compartment
  participant Linker
  participant Root as Root module
  participant Dep as Async dep

  User->>Compartment: compartment.import(spec)
  Compartment->>Linker: load + link spec
  Linker-->>Compartment: rootInstance (with caps)
  Compartment->>Root: execute()
  Note over Root: walks resolvedImports bottom-up
  Root->>Dep: execute()
  Dep-->>Root: Promise<undefined>
  Note over Root: pendingAsyncDependencies > 0;<br/>register completion handler
  Root-->>Compartment: topLevelCapability.promise
  Note over Dep: awaited promise resolves
  Dep->>Dep: AsyncModuleExecutionFulfilled
  Dep->>Root: notify parent (decrement pending)
  Note over Root: pending==0; if [[HasTLA]],<br/>start async body; else resolve capability
  Root-->>User: resolved namespace
```

The `topLevelCapability.promise` is the same promise the user holds via
`compartment.import`; its resolution is what the User actor observes
as "the import resolved." The `pendingAsyncDependencies` field on Root
is non-zero between the dep registering and `AsyncModuleExecutionFulfilled`
walking the parent edges; the field reaching zero is what gates the
Root's own body (if Root is `[[HasTLA]]`) or the Root's capability
resolution (if Root is purely-sync importing async).

The recursive `instance.execute()` in `module-instance.js` line 401 has
to change shape:

- If `mapGet(importedInstances, specifier).asyncEvaluation` is true, the
  parent does NOT call `instance.execute()` synchronously. Instead, it
  registers a completion handler on the dep's
  `topLevelCapability.promise` and increments a local pending count.
- Once all sync deps are settled and pending count is zero, the parent's
  own body executes. If the parent is `[[HasTLA]]`, the body is the async
  IIFE; the body's returned promise is the parent's
  `topLevelCapability`.
- Rejection: `AsyncModuleExecutionRejected` walks
  `asyncParentModules` and rejects each parent's capability with the
  same error. test262's `module-import-rejection.js` covers this.

### `importNow` returns after the first turn

`compartment.importNow(specifier)` and `compartment.import(specifier)`
share one evaluation. They differ only in what they return and when.

- `import` loads asynchronously, links, starts evaluation, and returns a
  promise for the namespace. The promise settles on the root's
  `topLevelCapability`: once every asynchronous body in the root's graph
  has completed, or with the first rejection.
- `importNow` loads synchronously (through `importNowHook`, as today),
  links, starts the same evaluation, and returns the namespace **when the
  first turn of initialization ends**.

"The first turn" is everything evaluation does synchronously before it
first yields. It is exactly the synchronous prefix of 262's `Evaluate()`,
which runs as much of the graph as it can and then returns a promise.
`importNow` runs that prefix and returns the namespace in place of the
promise. Concretely, within the first turn:

- Every module whose `asyncEvaluation` is false runs to completion, as
  today.
- Every `[[HasTLA]]` module with no pending async dependencies starts its
  body. The async functor runs its preamble, which initializes hoisted
  `function` declarations, and then its statements up to the first
  `await`.
- A module with `pendingAsyncDependencies > 0` does not start. Its
  namespace exists, but its `let`/`const`/`class` bindings remain in
  their temporal dead zone (row 13a). In 262, and in IronHorse, its
  hoisted `function` declarations are already initialized, because
  `InitializeEnvironment` runs at link time. The shim initializes hoisted
  functions in the functor preamble, so in the shim they stay
  uninitialized until the body starts. Moving the preamble to link time is
  a separate conformance fix. The hardened262 case for row 13a therefore
  asserts only that the body has not run.

The capability allocated during the first turn is stored on the root
instance. A later `import` of the same specifier, or a dynamic `import()`
from another module, awaits that same capability, so the body never runs
twice (row 13b). An error thrown synchronously during the first turn, by
a fully synchronous module, still throws from `importNow`, as today. An
error raised after the first turn rejects the capability. `importNow`
cannot report it; a later `import` observes it (row 13c). If nothing ever
observes it, the host's unhandled-rejection tracking reports it, which is
correct: the failure is genuinely unobserved.

For a graph with no TLA, the first turn is the whole evaluation and
`importNow` behaves exactly as it does today (row 15).

This replaces the earlier draft's guard, which made `importNow` throw a
`TypeError` when any reachable module had `asyncEvaluation === true`. The
guard survives only as an opt-in, `importNow(specifier, { requireSync:
true })`. With the option, after linking and before evaluation,
`importNow` throws when the root's `asyncEvaluation` is true:

```js
throw makeError(
  X`Cannot importNow ${q(specifier)} synchronously because module ${q(asyncSpecifier)} uses top-level await`,
);
```

`asyncSpecifier` is the first async module in DFS order. The specifier
is attacker-influenced content, so the message is built with SES's
`assert` machinery and `q()`, like the `importHook`-needed message in
`module-load.js`. The compartment-mapper's CommonJS `require` is the
option's first consumer ([Compartment-mapper ramifications](#compartment-mapper-ramifications)).

Why first-turn rather than reject:

- It is what the spec already does. A host that drops `Evaluate()`'s
  promise observes exactly this state. The shim stays a faithful model of
  the native algorithm rather than adding a shim-only restriction.
- Hoisted `export function` bindings are usable right away. That is the
  part of an async module a synchronous host can safely consume, for
  example a plugin registry that only needs callable entry points.
- IronHorse's module envelope already separates hoisting from body
  execution: [`exec_module`](../rust/engine/ironhorse-vm/src/interp/dispatch.rs#L4686)
  receives an `initialize` and an `execute` function. "Return after the
  first turn" maps onto that split without a second code path.

### Virtual module sources and the import calling convention

A virtual module source is an ordinary object that provides a module's
bindings and its initialization as a function, with no source text. Under
this design, `compartment.import` and `compartment.importNow` accept one
directly, in place of a specifier, as the maintainer proposed:

```js
const { namespace } = await compartment.import({
  bindings: [
    { import: 'connect', from: 'net' },
    { export: 'client' },
  ],
  needsImport: true,
  needsImportMeta: true,
  isAsync: true,
  initialize: async (environment, { import: dynamicImport, importNow, importMeta }) => {
    environment.client = await environment.connect(importMeta.url);
  },
});
```

The same object is also accepted wherever a module source is accepted
today: as the `source` of a `modules` descriptor, and as an `importHook`
or `importNowHook` result. A `ModuleSource` instance may be passed to
`import` and `importNow` the same way. Its `isAsync` getter plays the role
of the virtual source's own property.

The protocol:

| Property | Type | Meaning |
|---|---|---|
| `bindings` | `Array<Binding>`, default `[]` | Import and export declarations in the proposal-compartments `Binding` shape (`{ import, as?, from }`, `{ importAllFrom, as }`, `{ export, as?, from? }`, `{ exportAllFrom, as? }`), as XS and hardened262's `VirtualModuleSource/bindings` cases use them. The linker checks them and throws `SyntaxError` for duplicate or unresolvable exports. |
| `needsImport` | boolean, default `false` | When true, the context carries `import` and `importNow`. |
| `needsImportMeta` | boolean, default `false` | When true, the context carries `importMeta`, filled by `importMetaHook` as for a precompiled source. |
| `isAsync` | boolean, default `false` | The `[[HasTLA]]` bit. When true, `initialize` may return a promise and the module completes when that promise fulfills. When false, `initialize` must complete synchronously. |
| `initialize` | `(environment, context) => void \| Promise<void>` | The module body. |

`initialize` is called once, when evaluation reaches the module. Its
arguments:

- `environment` is the module environment record, sealed. Export names
  are writable properties: a write updates the live binding and notifies
  importers. Import names are read-only properties that read the live
  binding of the imported module. There are no reexport properties. The
  seal and the live-binding behavior hold across an `await`.
- `context` is a frozen object with `import(specifier)` (the module's
  dynamic `import`, resolved against this module), `importNow(specifier)`
  (its synchronous counterpart, with the first-turn semantics above), and
  `importMeta`. Each property is present only when the corresponding
  `needs*` flag is set.

Synchronous and asynchronous modules share the convention. The linker
reads `isAsync` at link time, before calling anything. It needs the bit
early: the bit sets `asyncEvaluation`, contributes to importers'
`pendingAsyncDependencies`, and decides what `importNow`'s first turn
covers. For a source with `isAsync: true`, the result of `initialize` is
passed through `Promise.resolve` and the module completes on it, like an
async functor. For a source without it, a thenable result is a
`TypeError` naming the module (row 20). Allowing a synchronous source to
finish asynchronously would let its importers read exports that are not
yet settled, which is the bug this design exists to prevent.

`compartment.import(source)` without a specifier creates a fresh module
instance on every call. The instance is not memoized in the compartment's
module map, because it has no specifier to memoize under (row 23); this
matches proposal-compartments, where a module instance is distinct from
its source. The `from` specifiers in its `bindings` are full specifiers,
handed to `importHook` without a `resolveHook` call, because there is no
referrer to resolve against (see [open question 5](#open-questions)).

The legacy shapes stay accepted unchanged, and stay synchronous:

- the SES shape, with `imports`/`exports`/`reexports` arrays and
  `execute(exportsTarget, compartment, resolvedImports)`
  ([module-link.js line 72](../packages/ses/src/module-link.js#L72));
- the XS shape, `execute($, Import, ImportMeta)` with `bindings`.

The linker tells them apart by which function property is present:
`initialize` selects the new convention, and `execute` selects a legacy
one. An object with both is a `TypeError`. The new name keeps the linker
from sniffing arity or function kind to decide between conventions.

### Naming: `isAsync` and `initialize`

The maintainer asked that the flag reuse the property names already used
or proposed on module sources ("isAsync?, please check proposals").
Findings:

- **ECMA-262** names the Cyclic Module Record field `[[HasTLA]]`. It is
  internal, with no user-visible spelling.
- **proposal-compartments** reflects static analysis on `ModuleSource`
  instances as `bindings` and `needsImportMeta`, and leaves the async bit
  as an explicit design question: "Do we also need to reflect `isAsync`?"
  ([1-static-analysis.md](https://github.com/tc39/proposal-compartments/blob/master/1-static-analysis.md)).
  The SES permits already list the proposal's getters (`bindings`,
  `needsImport`, `needsImportMeta`) on `%ModuleSourcePrototype%`
  ([permits.js line 1758](../packages/ses/src/permits.js#L1758)).
- **XS** virtual module sources use `execute($, Import, ImportMeta)` with
  `bindings`, `needsImport`, and `needsImportMeta`. They carry no async
  flag: "Like a module body, the `execute` function can be asynchronous"
  (Moddable's *XS Compartment* documentation). XS infers asynchrony from
  the function.
- No other Endo code uses `isAsync`, `hasTLA`, or `hasTopLevelAwait` for
  a module source.

This design adopts **`isAsync`**, the name the proposal has under
consideration. It is used on `ModuleSource.prototype`, on virtual
sources, and as `__isAsync__` in precompiled records (parallel to
`__needsImport__` and `__needsImportMeta__`). An earlier draft used
`__moduleIsAsync__`; it is renamed here so that one name covers all three
surfaces. The flag is explicit rather than inferred as XS infers it.
Inference by function kind cannot see through bound functions, proxies, or
ordinary functions that return promises, and the linker needs the bit
before it calls the function.

**`initialize`** follows the maintainer's sketch. Using a distinct name
also gives the linker an unambiguous discriminator from both legacy
`execute` shapes. One caution: IronHorse (following XS) uses `initialize`
internally for the hoisting half of a compiled module envelope. A virtual
source's `initialize` is the whole body. The two never meet in user code,
but the IronHorse section uses "envelope initializer" for the internal
one to keep them apart.

### Bundle-source coupling

`bundle-source` emits four formats, which reach two runtimes
([bundle-source.js line 27](../packages/bundle-source/src/bundle-source.js#L27)):

- **`endoZipBase64`** is a compartment-mapper archive of per-module
  precompiled records. `importBundle` loads it through `parseArchive` and
  `await archive.import(...)`, which calls `compartment.import`, an
  asynchronous path. TLA works: each record carries `__isAsync__`, and the
  archive names it with the new language designator (next section).
- **`endoScript`, `getExport`, and `nestedEvaluate`** are all produced by
  `bundleScript`, which calls compartment-mapper's `makeFunctor`
  ([script.js line 11](../packages/bundle-source/src/script.js#L11)). That
  inlines every functor into one script whose runtime calls them in
  topological order as plain synchronous calls
  ([compartment-mapper/src/bundle.js line 556](../packages/compartment-mapper/src/bundle.js#L556)).
  There is no place in that runtime for a suspension, so all three script
  formats reject TLA at bundle time, naming the module (row 25). An earlier
  draft claimed that `getExport` and `nestedEvaluate` would work through
  `compartmentImport`. They share the synchronous runtime with
  `endoScript`, so that claim was wrong.

### Compartment-mapper ramifications

1. **Archive language designator.** Today a precompiled ESM record is
   language `pre-mjs-json`
   ([archive-parsers.js line 19](../packages/compartment-mapper/src/archive-parsers.js#L19),
   [import-archive-parsers.js line 19](../packages/compartment-mapper/src/import-archive-parsers.js#L19),
   [import-archive-all-parsers.js line 21](../packages/compartment-mapper/src/import-archive-all-parsers.js#L21);
   parsers in `parse-pre-mjs.js` and `parse-archive-mjs.js`; the language
   union in `types/compartment-map-schema.ts`). The archiver writes
   `pre-mjs-async-json` for a record whose `__isAsync__` is true. That
   parser is `pre-mjs-json`'s parser plus one check: the record must carry
   `__isAsync__: true`. Conversely, `pre-mjs-json` rejects a record that
   carries it, so the designator and the flag cannot disagree. An archive
   with no TLA is byte-identical to today's.
2. **Upgrade gate.** An unmodified compartment-mapper looks up
   `parserForLanguage[module.parser]` and rejects the unknown
   `pre-mjs-async-json`. A host that has not been upgraded, such as an
   Agoric chain, refuses TLA-bearing bundles at load time, whether or not
   its SES is TLA-capable. `@endo/check-bundle` needs no change: it checks
   only the top-level `moduleFormat` and delegates archive hashing to
   `parseArchive`
   ([check-bundle/lite.js line 56](../packages/check-bundle/lite.js#L56)).
3. **Script bundlers.** `bundlerSupportForLanguage`
   ([bundle.js line 274](../packages/compartment-mapper/src/bundle.js#L274),
   [bundle-lite.js line 270](../packages/compartment-mapper/src/bundle-lite.js#L270))
   gets no `pre-mjs-async-json` entry, so `makeFunctorFromMap` and `makeScriptFromMap`
   throw on an async module with a message naming it (row 25).
4. **Live loading.** The `mjs` language
   ([parse-mjs.js line 26](../packages/compartment-mapper/src/parse-mjs.js#L26))
   builds a `ModuleSource`, so `isAsync` arrives with no new language.
   `importLocation` and `loadLocation(...).import()` already end in
   `compartment.import`, so a TLA entry module works once SES supports it.
5. **CommonJS `require` of an async ESM.** The CommonJS wrapper's
   `require` calls `compartment.importNow`
   ([parse-cjs-shared-export-wrapper.js line 196](../packages/compartment-mapper/src/parse-cjs-shared-export-wrapper.js#L196)
   and line 204). Under the first-turn semantics, a plain `importNow` would
   hand CommonJS a namespace whose bindings are still in their dead zone.
   Node refuses that case: `require(esm)` of a graph containing TLA throws
   `ERR_REQUIRE_ASYNC_MODULE`. The wrapper matches Node. It passes
   `{ requireSync: true }`, catches SES's `TypeError`, and rethrows an
   `Error` with `code: 'ERR_REQUIRE_ASYNC_MODULE'` (row 24).
6. **Policy attenuators and exit modules.** These are legacy-shape
   synchronous virtual sources (`policy.js` line 529, `link.js` line 178,
   the `execute(){}` placeholder in `import-hook.js` line 759). They are
   unchanged and stay synchronous.

### IronHorse engine

IronHorse is the bots fork's Rust JavaScript engine
([ironhorse-engine.md](ironhorse-engine.md)). It must give native modules
the same observable contract the shim gives emulated ones, because
hardened262 runs every row on `ironhorse` and `sesIronhorse` next to XS
and Node.

Where it stands today:

- The module graph models `ModuleRecord` and `ModuleStatus`, and
  `ModuleStatus` stops at `Evaluated`; "`EvaluatingAsync` is not reachable
  in the static half"
  ([module.rs line 174](../rust/engine/ironhorse-vm/src/module.rs#L174)).
  `link`/`evaluate` (`ModuleGraph::instantiate`, `inner_link`, `evaluate`,
  `inner_eval`) are ported at the level of results. They are not yet
  driven from module bytecode.
- `exec_module`
  ([dispatch.rs line 4686](../rust/engine/ironhorse-vm/src/interp/dispatch.rs#L4686))
  halts with a named not-implemented label for each unsupported surface:
  `module:dynamic-import`, `module:import-meta`, `module:static-linking`,
  and, when the envelope's execute function is an async function,
  `module:top-level-await` (line 4721).
- The guest `Compartment` covers construction, `evaluate`, and
  `globalThis`. `import`, `importNow`, and callable hooks are its phase 2
  ([natives/compartment.rs](../rust/engine/ironhorse-vm/src/interp/natives/compartment.rs));
  the host-side `Compartment::import` always returns
  `Err(DynamicImport)`
  ([compartment.rs line 579](../rust/engine/ironhorse-vm/src/compartment.rs#L579)).
  Virtual module sources are not handled anywhere.
  [ironhorse-guest-compartment.md](ironhorse-guest-compartment.md) plans
  `ModuleSource` and `VirtualModuleSource` for the same phase 2.
- In `rust/engine/ironhorse-262/expectations/whole-tree/`, test262's
  `language/module-code/top-level-await/` tree records 197 cases skipped
  under `module:top-level-await`. Another 11 are skipped under
  `module:static-linking` and 11 under `module:dynamic-import`.

The design for IronHorse:

1. **Spec fields, verbatim.** `ModuleRecord` gains `has_tla`, the
   `[[AsyncEvaluation]]` ordering stamp, `pending_async_dependencies`,
   `async_parent_modules`, `top_level_capability`, `cycle_root`, and
   `evaluation_error`. `ModuleStatus` gains `EvaluatingAsync`.
   `inner_eval` follows 262's `InnerModuleEvaluation`,
   `ExecuteAsyncModule`, `AsyncModuleExecutionFulfilled`,
   `AsyncModuleExecutionRejected`, and `GatherAvailableAncestors` step for
   step, including `[[CycleRoot]]`. The shim omits `[[CycleRoot]]` because
   the maintainer judged it unnecessary for observable behavior
   ([Module-instance contract](#module-instance-contract)). A native engine
   whose acceptance gate is test262 convergence follows the spec text
   instead. hardened262 is where the two are checked for observable
   agreement.
2. **Envelope execution.** The `module:top-level-await` halt is replaced
   by running the envelope's execute function as an async function. Its
   promise gets the fulfilled and rejected reactions above, queued through
   the ordinary FIFO job queue (`queue_promise_job`,
   [promise.rs line 804](../rust/engine/ironhorse-vm/src/interp/natives/promise.rs#L804)),
   so module completions interleave with other promise jobs exactly as the
   spec's tick-ordering cases (test262 `top-level-ticks.js`,
   `module-*-resolution-ticks.js`) require. The envelope initializer (the
   hoisting half) still runs at link time, which gives the first-turn
   semantics their 262 meaning.
3. **Prerequisites.** Async evaluation needs real static linking and
   dynamic import from bytecode. The `module:static-linking` and
   `module:dynamic-import` halts are cleared first, under
   [ironhorse-test262-convergence](ironhorse-test262-convergence.md). TLA
   is the next module surface after them.
4. **Native `Compartment`.** Phase 2 of the guest `Compartment` adopts
   this design's contract: `import` returns the root capability's promise;
   `importNow` runs the first turn and returns the namespace;
   `importNow(specifier, { requireSync: true })` throws the same
   `TypeError`; `ModuleSource.prototype.isAsync` is a getter; and
   `import`/`importNow` accept a virtual source in the `initialize`
   convention, with the legacy XS `execute` shape kept synchronous.
5. **Metering and snapshots.** An async module's resumption is a promise
   job, so the existing metered drain (`run_promise_jobs_with_meter` in
   `compartment.rs`) meters it with no new mechanism. A machine can be
   snapshotted while a graph is `EvaluatingAsync`. The new record fields,
   which are a capability's promise and resolving functions, counters, and
   parent edge lists, are added to the snapshot schema
   ([ironhorse-snapshot-schema.md](ironhorse-snapshot-schema.md)) so a
   restored machine resumes the graph.
6. **Acceptance.** The 197 `module:top-level-await` expectations move to
   `pass` (the 24 `module:compiler-byte-divergence` entries in `syntax/`
   are compiler-oracle comparisons and are tracked separately), and the
   hardened262 rows pass on `ironhorse`. The `sesIronhorse` agent runs the
   *shim's* async machinery on IronHorse. That needs only async functions
   and the job queue, not native module TLA, so `sesIronhorse` can pass
   the hardened rows before step 2 lands. It is the earliest cross-engine
   signal.

### Backward compatibility

- A pre-existing precompiled record without `__isAsync__` is
  treated as `false`. No round-trip breakage.
- A sync module re-precompiled with the new analyzer emits byte-identical
  output until the source actually contains top-level `await`.
- `compartment.import` already returns a promise; the only behavior
  change is *what it resolves to* in the presence of TLA (it resolves
  later, not sooner). Callers who today rely on
  `compartment.import(spec).then(ns => ...)` continue to work.
- `compartment.importNow` keeps today's behavior for every graph without
  TLA. Today an async graph cannot load at all (the functor fails to
  evaluate), so the first-turn semantics change no working program.
- The legacy SES and XS virtual-source shapes keep their synchronous
  `execute` contract. The `initialize` convention is additive.
- An archive with no TLA uses only `pre-mjs-json` and is byte-identical
  to today's. A TLA-bearing archive is refused by an un-upgraded
  compartment-mapper rather than misexecuted.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-guest-compartment](ironhorse-guest-compartment.md) | Its phase 2 (`import`, `importNow`, `ModuleSource`, `VirtualModuleSource`) adopts this contract |
| [ironhorse-test262-convergence](ironhorse-test262-convergence.md) | Clears the `module:static-linking` and `module:dynamic-import` halts that IronHorse TLA builds on; owns the TLA expectations |
| [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) | Its hook-equivalence table gains the `import`/`importNow` async rows |
| [ironhorse-snapshot-schema](ironhorse-snapshot-schema.md) | Gains the async module-record fields |
| [ses-import-attributes](ses-import-attributes.md) | Sibling SES module-loader design; both extend the module-source record and the linker |

## Phased implementation

Each phase lands with the hardened262 baseline movement it causes, so
progress is visible as rows moving from `failed` to `passed`.

0. **Hardened test262 cases (design phase).** Add the
   [hardened262 cases](#hardened-test262-cases) and
   `harness/moduleResolverPairs.js`, and record them as failing on every
   agent. No source change.
1. **module-source.** The `isAsync` analyzer visitors, the async functor,
   `__isAsync__` in the record, the `ModuleSource.prototype.isAsync`
   getter, and the permit. Until phase 2 lands, the SES linker rejects a
   record with `__isAsync__: true` with an explicit `SyntaxError` rather
   than running an async functor unawaited. The `ModuleSource/isAsync`
   rows pass.
2. **SES evaluation.** Module-instance and linker bookkeeping,
   `import` on the root capability, `importNow` first-turn semantics, and
   `requireSync`. Shim rows 1–17 pass, as do the hardened `import`/`importNow`
   rows on `sesNode`, `sesXs`, and `sesIronhorse`.
3. **SES virtual sources.** The `initialize` convention and
   `import(source)`/`importNow(source)`. Rows 19–23 pass.
4. **compartment-mapper.** `pre-mjs-async-json`, the script-bundler
   rejection, and the `require` guard. Rows 14, 24, and 25 pass.
5. **IronHorse.** After the static-linking and dynamic-import halts are
   cleared: native async evaluation (the test262 TLA expectations move to
   `pass`), then the guest `Compartment` phase 2 with this contract (the
   hardened rows pass on `ironhorse`).

Phases 1–3 port to `actual/master`. Phases 4 and 5 apply to the bots
fork's compartment-mapper and engine.

## Alternatives considered

- **Reject TLA outright at parse time.** Today's de-facto behavior, but
  by-accident rather than by-design, and produces a confusing error
  ("await is only valid in async function") from the second-pass functor
  evaluator. Considered and rejected: SES is the platform that runs
  modules from npm; npm modules increasingly use TLA; the platform
  needs to support what JavaScript supports.
- **Transform TLA away by hoisting awaits into an async wrapper that
  the linker invokes.** Implementable, but it loses observable
  semantics: tick ordering (rows 8 and 9) requires that the awaited
  microtask interleave with module-graph microtasks the spec's queue
  defines, which the spec-conformant async-parent walk handles
  directly.
- **Synchronously block in `execute()` via a polling SAB loop.**
  Considered and rejected. SES runs in browsers without SharedArrayBuffer
  guarantees and the contract would change the JS-event-loop semantics
  for all consumers of the compartment.

## Open questions

1. **Virtual module sources: resolved.** An earlier draft deferred
   asynchronous virtual sources. The maintainer asked to design them now
   ([review comment](https://github.com/endojs/endo-but-for-bots/pull/249#discussion_r3919279323)),
   and [Virtual module sources and the import calling convention](#virtual-module-sources-and-the-import-calling-convention)
   does so.
2. **`importNow` on an async graph: resolved.** The maintainer's
   direction
   ([review comment](https://github.com/endojs/endo-but-for-bots/pull/249#discussion_r3919243561))
   replaces the earlier `TypeError` guard with first-turn semantics
   ([`importNow` returns after the first turn](#importnow-returns-after-the-first-turn)).
   The `TypeError` survives only behind `{ requireSync: true }`. If
   tc39/proposal-import-sync advances and defines a user-visible error for
   synchronously importing an async graph, the opt-in adopts its shape.
3. **Script-format bundles.** All three script formats (`endoScript`,
   `getExport`, `nestedEvaluate`) reject TLA at bundle time, because they
   share compartment-mapper's synchronous bundle runtime. The open choice:
   should a later change add an asynchronous variant of that runtime, or
   should `bundle-source` instead fall back to `endoZipBase64` when TLA is
   present? The draft prefers neither for now. An explicit error keeps
   build manifests reproducible, and `endoZipBase64` is already the
   default format.
4. **Re-link with new edges — resolved at design level, not left to
   implementation.** A `compartment.import` call that re-enters the same
   compartment for a fresh root specifier reuses memoized instances. An
   earlier draft treated the re-link bookkeeping as a one-shot per
   instance whose accumulation discipline was "worth pinning in the
   implementation" — but that framing hides a deadlock. If a *second*
   root shares an async dep that has **already fulfilled** on the first
   import, keying Linker step 2 on the static `asyncEvaluation` flag alone
   would increment the new parent's `pendingAsyncDependencies` for that
   dep, yet the matching decrement event (`AsyncModuleExecutionFulfilled`
   walking `asyncParentModules`) fired in the past — before this parent
   existed — and never fires again. The new parent's `topLevelCapability`
   would then hang forever: a permanent deadlock, not a bookkeeping nicety.
   The module-instance state model therefore distinguishes **identity**
   (`asyncEvaluation`, static, set once) from **time**
   (`evaluationFulfilled`, flipped when the body completes). Linker step 2
   increments only for a dep that is async **and still pending**
   (`evaluationFulfilled === false`); an already-fulfilled shared dep links
   as a settled ordinary dependency and adds no phantom edge. Each
   `link()` pass rebuilds `pendingAsyncDependencies` from the freshly
   walked dependency set and appends only this pass's still-pending reverse
   edges (rebuild, not monotonic append), so stale edges from a prior link
   cannot leak in either. What remains genuinely open is narrower: whether
   to garbage-collect `asyncParentModules` entries for parents that have
   themselves been discarded between imports (a memory-hygiene question,
   not a correctness one).
5. **Referrer for `import(source)`.** A virtual source passed to
   `import` without a specifier has no referrer, so this design treats
   its `bindings` `from` strings as full specifiers. An alternative is an
   options bag, `compartment.import(source, { specifier })`. The
   specifier would name the referrer for `resolveHook` and might also name
   the module in diagnostics, without memoizing the instance under it.
   The design defers the options bag until a caller needs relative
   imports from a virtual source.
6. **Convergence with XS.** XS infers asynchrony from `execute` and has
   no `initialize` convention or `requireSync` option. Until Moddable
   adopts (or rejects) `isAsync` and `initialize`, hardened262's `xs`
   baseline records those rows as failing, and the `sesXs` agent covers
   XS hosts through the shim. Raising the naming with Moddable and the
   proposal-compartments champions is a follow-up to this design, not a
   prerequisite.

## Prompt

> Design a solution for **top-level-await (TLA)** in SES and
> `@endo/module-source`. The design should be implementable on
> `actual/master` (upstream endo's master branch, not the bots-fork
> `llm`). The maintainer's framing:
>
> - **Lead with the test suite.** TDD shape: spec out what tests would
>   cover the feature before sketching the implementation. The proposal's
>   organizing principle should be: "here are the tests that an
>   implementation must pass; here is the implementation strategy that
>   makes them pass."
> - **Babel's TLA test suite is a useful reference.** They have an
>   extensive suite that exercises top-level-await across many module
>   shapes. Reading those test fixtures tells the designer how the spec's
>   edge cases (await on a rejected promise at top level; await + cyclic
>   imports; await + dynamic import; etc.) get exercised.
> - **Backward compatibility on serialized ModuleSource bundles.** A
>   `ModuleSource` captured in an `@endo/bundle-source` bundle today is a
>   serialized form with a specific shape (the functor is synchronous;
>   the imports / exports / metadata layout is fixed). Adding TLA must
>   preserve the existing shape for synchronous modules; only the new
>   async-module case introduces new fields or a new variant.
> - **The functor is synchronous by convention; augment SES with an
>   async-module convention.** Today `ModuleSource`'s functor signature
>   is synchronous. The TLA design introduces a new convention that SES
>   recognizes and routes through a different initialization path.
> - **Read 262 background on module initialization synchronization.**
>   The ECMAScript spec has a precise account of how TLA composes with
>   the module-graph evaluation order ([Cyclic Module Records, evaluation
>   phase](https://tc39.es/ecma262/#sec-cyclic-module-records)). The
>   design's evaluation algorithm should compose with that spec, not
>   invent a separate model.
> - **Look for inspiration in test262 fixtures.** The test262 test suite
>   has a `language/module-code/top-level-await/` directory exercising
>   TLA in a fixture-shaped way.
>
> Lead with the test suite. Sections (adapt to local convention): status
> table; problem statement; scope and non-goals; **test suite** (first
> class); backward compatibility for serialized ModuleSource bundles;
> SES augmentation; ModuleSource augmentation; alternatives considered;
> open questions.
>
> Revision prompt (2026-10-10), from the maintainer's
> [CHANGES_REQUESTED review](https://github.com/endojs/endo-but-for-bots/pull/249#pullrequestreview-5095793109):
>
> Let's advance and pin the merge base to current llm branch with hash and
> refresh. In particular, I want to expand the scope of this design to
> cover implementation in both the shim, ramifications for compartment
> mapper, and also the new IronHorse engine. We'll need hardened test262
> cases in the design phase.
>
> Inline: I think a likely acceptable direction for this is that
> `importNow` returns after the first turn of the initialization of the
> module, whereas `import` returns a promise for the eventually completed
> exports, when the async module initialization has completed.
>
> Inline: Let's get ambitious and design this out as well. I think it
> likely that virtual module instances will be constructed by calling
> `import` with a virtual module source, where a virtual module source is a
> protocol of the `ModuleSource` constructor or `import` syntax and methods
> of compartments. I'm inclined to use the `import` because it will be
> harder to shim the native behavior on the `ModuleSource` package. So, we
> would simply expose a calling convention for both synchronous and
> asynchronous modules, reusing the property names we already use or have
> proposed on module sources instances to reflect whether the module uses
> top level await (isAsync?, please check proposals).
>
> Consider `import({ needsImport: true, needsImportMeta: true, isAsync: true, initialize: async(environment, {import, importNow, importMeta}) {}, bindings: []})`.
