# SES top-level await

| | |
|---|---|
| **Created** | 2026-05-14 |
| **Updated** | 2026-05-15 |
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
   `sourceType: 'module'` ([packages/module-source/src/transform-source.js line 26](../packages/module-source/src/transform-source.js#L26)),
   so `@babel/parser` accepts the `await` token at module top
   level. The transform then wraps the body in an arrow IIFE
   ([packages/module-source/src/transform-analyze.js line 100](../packages/module-source/src/transform-analyze.js#L100)):
   `({imports,liveVar,onceVar,import,importMeta})=>(function(){'use
   strict'; ... })()`. The inner IIFE is **not async**, so the parser later
   refuses the `await` inside it. SES users today see a syntax error from
   the second-pass evaluation of the functor, not from the user's source.
2. **No execute contract for async modules.** Even if the functor were
   async, `makeModuleInstance` returns `execute` that ignores its return
   value. The linker would treat the still-pending promise as "done" and
   surface uninitialized bindings to downstream importers.
3. **No cycle invariant.** 262's cyclic-module-records algorithm names a
   distinct `[[CycleRoot]]` for an importer that reaches a member of an
   async cycle. SES has no such bookkeeping today; the present linker
   memoizes by full specifier and trusts the depth-first walk to settle
   exports before any importer reads them. That trust fails when any
   member of the cycle is async.

The aim of this design is to support TLA per the 262 cyclic-module-records
algorithm in the SES shim *and* in the module-source precompilation pipeline,
without changing the synchronous semantics of any module that does not
itself use `await` and does not import an async dep transitively.

## Scope

In scope:

- A new `[[Async]]` flag derived statically at module-analyze time and
  carried on the module source.
- A new `[[AsyncEvaluation]]` boolean and `[[PendingAsyncDependencies]]`
  count on the module instance.
- An asynchronous `execute()` path on `makeModuleInstance` whose returned
  promise settles when, and only when, the module's body has completed (in
  the sync case, immediately; in the async case, when the body's implicit
  promise resolves).
- Linker bookkeeping for `[[AsyncParentModules]]`, the
  `gatherAsyncParentCompletions` walk, and `[[CycleRoot]]` selection.
- `compartment.import(...)` returns the existing
  `[[TopLevelCapability]]`-shaped promise that already gates dynamic import
  ([packages/ses/src/compartment.js line 435](../packages/ses/src/compartment.js#L435));
  the contract becomes: the promise settles *after* TLA in the
  imported subgraph resolves, where today it settles synchronously after a
  `link`+`execute` round-trip.
- `compartment.importNow(...)` stays synchronous and **rejects any module
  reachable from the importNow root whose `[[Async]]` is true**, with a
  diagnostic naming the offending specifier.
- A module-source-level signal: the analyzer flags `__moduleIsAsync__:
  true` on the source record when the body contains a top-level
  `AwaitExpression` outside any nested function or class.

Out of scope:

- Asynchronous *virtual* module sources. Virtual sources stay sync; their
  `execute(env, ...)` returns nothing today and that contract is
  preserved. (See [Open questions](#open-questions) on whether a future
  virtual-async shape is worth a separate design.)
- Native Compartment passthrough. When a host XS or browser implementation
  supports a native ModuleSource, that path inherits the host's TLA
  behavior unchanged; this design touches the shim path only.
- `await using` (explicit-resource-management). That is a sibling proposal
  whose grammar interacts with TLA but whose lifetime semantics are
  separate; out of this design.

## Test suite

The test suite leads because the spec for TLA *is* a finite set of
observable shapes. Each shape names one fixture pattern and one
assertion. The SES implementation must pass every shape; absent fixtures
are absent capabilities.

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

- `__moduleIsAsync__` is a static boolean on the precompiled module
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

The seventeen rows below are framed as the implementation's
acceptance criteria. test262's TLA directory is the canonical
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
| 6 | Sync importer of async dep: the importer is itself `[[Async]] === false`, but `[[PendingAsyncDependencies]] > 0` flips `[[AsyncEvaluation]]` to true | `module-sync-import-async-resolution-ticks.js` | A purely-sync module that imports an async dep is still evaluated after the dep settles |
| 7 | Async importer of async dep: chained ticks observed in DFS post-order | `module-async-import-async-resolution-ticks.js` | Tick ordering matches the spec's queue discipline |
| 8 | `await 1; await 2; tick 1...tick 4` interleaving | `top-level-ticks.js` | Microtask interleaving matches the spec; promise-then ticks ordered against await ticks |
| 9 | DFS-invariant under diamond async deps | `dfs-invariant.js` | Two paths to one async leaf produce one execution; parents complete in DFS post-order |
| 10 | Cycle containing an async member: a leaf-importer's namespace is observable only after every async member of the cycle its imports reach has fulfilled | `pending-async-dep-from-cycle.js` | `pendingAsyncDependencies` is non-zero on the importer until the SCC drains; no member's exports are read out of order |
| 11 | Self-import of an async module: ReferenceError on access during cycle, resolved post-await | `module-self-import-async-resolution-ticks.js` | Self-import's TDZ behavior holds across the await suspension |
| 12 | `await import(specifier)` from a sync module: dynamic import resolves to the namespace, sync module remains sync | `dynamic-import-resolution.js` | Dynamic import is *not* TLA; it uses the existing `compartmentImport` path |
| 12a | Dynamic import of a still-suspended async module from inside another async module's await window | `dynamic-import-of-waiting-module.js` (test262) | The dynamic-import promise settles on the target's `topLevelCapability`, not eagerly; the caller resumes after the target's body completes |
| 13 | `compartment.importNow` of an async module: synchronous rejection | new, SES-only | The shim guards importNow against async deps reachable through static or live `import` |
| 14 | Pre-compiled module source with `__moduleIsAsync__: true` round-trips through bundle-source and import-bundle, executing with the same TLA semantics | new, SES-only | The async flag survives the bundle/extract round trip; see [Bundle-source coupling](#bundle-source-coupling) |
| 15 | Pre-compiled non-async module with no TLA stays synchronous: `[[AsyncEvaluation]]` never flips to true; the `compartment.import` promise still resolves, but the import-now path works | new, SES-only regression | No regression for the 99%-of-modules-are-sync case |
| 16 | Syntax: `await` at module top level outside any function is accepted | test262 `syntax/` directory (sampled: `if-block-await-expr-identifier.js` and siblings) | The module-source transform accepts the source; the functor is async |
| 17 | Syntax: `await` is still rejected inside a non-async function nested in a module | test262 `early-errors-await-not-simple-assignment-target.js` and surrounding | The transform's nested-function check is unchanged; only the module-scope IIFE is async |

### Implementation of the harness

Each test is a single ava test case that:

1. Constructs a `Compartment` with an `importHook` that maps a static map
   of `specifier -> ModuleSource`. The source records come from the
   module-source analyzer applied to the fixture text inline; for
   regression-grade tests, the precompiled functor is captured to a
   golden file (`__moduleIsAsync__` and `__syncModuleProgram__` are
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

## Design

### Static analysis: detect async at parse time

The Babel analyzer plugin gains a single visitor:

```js
AwaitExpression(path) {
  // Only flag await whose enclosing function-or-program scope is the
  // module program itself, i.e. there is no Function ancestor between
  // path and Program.
  if (!path.getFunctionParent()) {
    options.moduleIsAsync = true;
  }
}
```

The module analysis record gains one new field:

```js
{
  ...
  __moduleIsAsync__: boolean,
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
`__moduleIsAsync__` boolean).

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
documented inline (the `importNow` guard and the bundle-source
coupling are SES-only).

`makeModuleInstance` returns an object with:

```ts
{
  exportsProxy,         // unchanged
  notifiers,            // unchanged
  execute: () => undefined | Promise<undefined>,
  asyncEvaluation: boolean,   // new; the [[AsyncEvaluation]] field
  topLevelCapability:         // new; settled by ExecuteAsyncModule
    | undefined
    | { promise: Promise<undefined>, resolve, reject },
  asyncParentModules: Array<ModuleInstance>, // new; reverse edges
  pendingAsyncDependencies: number,          // new
}
```

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
   the SCC fulfills, `AsyncModuleExecutionFulfilled` walks the
   reverse edges, decrements `pendingAsyncDependencies` on each
   reached parent, and settles the parent's capability when its
   pending count reaches zero. The walk is correct on cyclic graphs
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

`asyncEvaluation` is true iff the module is `[[Async]]` itself OR its
`[[PendingAsyncDependencies]] > 0`. The latter is the case for a
purely-sync module that imports an async dep transitively; row 6 of the
test table.

The synchronous-fast-path is preserved: when a module's
`asyncEvaluation` is false at link time, its `execute()` is the same
function as today, returning `undefined`. The `Promise<undefined>` shape
only materializes when the linker has actually walked across an async
boundary.

### Linker bookkeeping

`link()` ([packages/ses/src/module-link.js](../packages/ses/src/module-link.js)) gains a second pass that walks the linked instance graph in DFS
post-order. For each instance:

1. If its source has `__moduleIsAsync__: true`, set `asyncEvaluation =
   true` and allocate `topLevelCapability`.
2. For each linked import target, if the target's `asyncEvaluation` is
   true, push `this` onto the target's `asyncParentModules` and
   increment `this.pendingAsyncDependencies`.
3. After the pass: if `pendingAsyncDependencies > 0` and the instance
   itself is not `[[Async]]`, set `asyncEvaluation = true` and allocate
   the capability anyway. This is the row-6 case.

Cycles are not a special case for the bookkeeping. A back-edge
discovered during the DFS sets up the same `asyncParentModules`
reverse edge and the same `pendingAsyncDependencies` increment as a
non-cycle edge. The linker does not need to compute SCCs at link
time; the fulfillment walk in `AsyncModuleExecutionFulfilled` settles
capabilities in the order the bodies complete, which is the order the
spec requires.

### Evaluation procedure (the InnerModuleEvaluation analogue)

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
  Note over Root: pending==0; if [[Async]],<br/>start async body; else resolve capability
  Root-->>User: resolved namespace
```

The Root module is the importer the user named in
`compartment.import(spec)`; the Async dep is any transitively-reached
module whose `asyncEvaluation` is true. The
`topLevelCapability.promise` is the same promise the user holds via
`compartment.import`; its resolution is what the User actor observes
as "the import resolved." The `pendingAsyncDependencies` field on Root
is non-zero between the dep registering and `AsyncModuleExecutionFulfilled`
walking the parent edges; the field reaching zero is what gates the
Root's own body (if Root is `[[Async]]`) or the Root's capability
resolution (if Root is purely-sync importing async).

The recursive `instance.execute()` in `module-instance.js` line 401 has
to change shape:

- If `mapGet(importedInstances, specifier).asyncEvaluation` is true, the
  parent does NOT call `instance.execute()` synchronously. Instead, it
  registers a completion handler on the dep's
  `topLevelCapability.promise` and increments a local pending count.
- Once all sync deps are settled and pending count is zero, the parent's
  own body executes. If the parent is `[[Async]]`, the body is the async
  IIFE; the body's returned promise is the parent's
  `topLevelCapability`.
- Rejection: `AsyncModuleExecutionRejected` walks
  `asyncParentModules` and rejects each parent's capability with the
  same error. test262's `module-import-rejection.js` covers this.

### `compartment.importNow` guard

`importNow` walks the linked subgraph; if any reachable instance has
`asyncEvaluation === true`, throw synchronously with:

```text
TypeError: Cannot importNow because module <specifier> is async (top-level await)
```

This is a SES-shim-specific contract; XS / native Compartments may
expose a different shape. The diagnostic names the *first* async
specifier encountered in DFS order, not all of them; users iterate.

### Bundle-source coupling

`bundle-source` precompiles module sources into a static record at
build time. The `__moduleIsAsync__: true` flag must round-trip through:

- `endoZipBase64`: the bundle's per-module record JSON gains the field.
- `endoScript`: a single-script bundle whose root or any transitively
  embedded module is async fails to bundle in this format, because
  endoScript's runtime concatenates synchronous IIFEs into one
  evaluatable program with no place for an async suspension. The
  bundler errors with `TypeError: endoScript format does not support
  top-level await in <specifier>`.
- `nestedEvaluate` and `getExport`: these formats embed individual
  module functors; the async-IIFE shape works because each functor is
  invoked through `compartmentImport`'s async machinery at runtime.

Separately from the bundle-source emit path, the
[`@endo/check-bundle`](../packages/check-bundle) policy boundary is
the load-time gate. The bundle checker rejects any bundle whose
compartment-map carries an unrecognized property on the theory that
the property may imply different runtime semantics. A TLA-bearing
bundle is distinguished by a new module-language designator
(`pre-mjs-async-json` or similar, alongside today's
`pre-mjs-json`); an unmodified check-bundle on a host that has not
been upgraded for TLA support rejects such bundles by construction.
This composes cleanly with the Agoric chain's upgrade pattern: until
the chain's check-bundle is taught about the new language
designator, TLA-bearing bundles are refused at load time, regardless
of whether the SES shim on the chain is itself TLA-capable. The
sibling change to check-bundle (adding the designator to the
allowlist) is out of scope for this design but is the policy half of
the bundle-source coupling described above. See open question 3 for
the bundle-source-format alternative.

### Backward compatibility

- A pre-existing precompiled record without `__moduleIsAsync__` is
  treated as `false`. No round-trip breakage.
- A sync module re-precompiled with the new analyzer emits byte-identical
  output until the source actually contains top-level `await`.
- `compartment.import` already returns a promise; the only behavior
  change is *what it resolves to* in the presence of TLA (it resolves
  later, not sooner). Callers who today rely on
  `compartment.import(spec).then(ns => ...)` continue to work.

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

1. **Virtual module sources.** Deferred per maintainer. The design
   preserves the sync-only contract on virtual sources. If a use case
   arises where a virtual source must itself be async (e.g. a
   TLA-bearing source generated at import time from a remote tree),
   the contract on `makeVirtualModuleInstance` would need a parallel
   evolution. Surface to designer when the use case materializes.
2. **`importNow` diagnostic shape.** Confirmed by maintainer: a
   `TypeError` is right for now, with the caveat that the future
   sync-import proposals (e.g. tc39/proposal-import-sync) may force a
   more specific diagnostic if "sync import of an async-evaluating
   module" becomes a distinct user-visible condition rather than a
   shim-only restriction. Track when the proposal advances; revisit
   the diagnostic shape then.
3. **Bundle-source format coverage and check-bundle gating.** The
   `endoScript`-format error in the bundle-source-coupling section is
   the load-bearing rejection at bundle time. A second rejection
   surface lives in `@endo/check-bundle`: the bundle checker rejects
   any bundle whose compartment-map contains an unrecognized property
   on the theory that such a property may imply different runtime
   semantics. A new module-language designator (for example
   `pre-mjs-async-json` alongside today's `pre-mjs-json`) is the same
   kind of unrecognized property, so an unmodified check-bundle on an
   old Agoric chain rejects a TLA-bearing bundle by construction.
   This is the right composition point with the Agoric chain (and any
   other host that consumes endo bundles through check-bundle) and
   lets the chain upgrade in lockstep with TLA support: until a host's
   check-bundle is taught about the new language designator, it
   refuses to load such bundles. The design adopts this:
   bundle-source emits the new language designator only when the
   bundle actually contains TLA, and the design assumes a sibling
   change to check-bundle adds the designator to the allowlist when
   the host is upgraded. The bundle-source-coupling section above is
   the runtime-format surface; check-bundle is the policy surface.
   The remaining open question: should `bundle-source` silently fall
   back to `endoZipBase64` for sources that would otherwise be
   `endoScript`-bundled with TLA present, or surface the rejection at
   bundle time? The draft prefers the explicit error so the build
   manifests are reproducible.
4. **Re-link with new edges.** A `compartment.import` call that
   re-enters the same compartment for a fresh root specifier today
   reuses memoized instances. The bookkeeping above is one-shot per
   instance: `asyncParentModules` accumulates as new parents discover
   the instance via fresh import paths, and `pendingAsyncDependencies`
   counts re-derive on re-link from the freshly-walked dependency set.
   No spec-level invariant should be broken by re-link, but the
   accumulation discipline (clear or rebuild on re-link, vs. monotonic
   append) is worth pinning in the implementation.

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
