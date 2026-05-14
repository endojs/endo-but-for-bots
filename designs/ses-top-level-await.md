# SES top-level await

| Field | Value |
|------|------|
| Status | Draft |
| Author | designer |
| Created | 2026-05-14 |
| Updated | 2026-05-14 |

## Problem statement

The SES module loader executes modules synchronously, bottom up, cycle
tolerant ([packages/ses/src/module-instance.js](../packages/ses/src/module-instance.js)
line 401). A module's `execute()` returns `undefined`; the linker assumes
that when `execute()` returns, the module's bindings are settled. Top-level
`await` at module scope (henceforth TLA) violates this assumption: a module
that awaits is, by construction, *suspended* across microtasks, and its
exports do not settle until the awaited promise resolves and execution
resumes.

Three observable problems follow.

1. **Source rejection.** The module-source transform parses with
   `sourceType: 'module'` ([packages/module-source/src/transform-source.js](../packages/module-source/src/transform-source.js)
   line 26), so `@babel/parser` accepts the `await` token at module top
   level. The transform then wraps the body in an arrow IIFE
   ([packages/module-source/src/transform-analyze.js](../packages/module-source/src/transform-analyze.js)
   line 100): `({imports,liveVar,onceVar,import,importMeta})=>(function(){'use
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
  ([packages/ses/src/compartment.js](../packages/ses/src/compartment.js)
  line 435); the contract becomes: the promise settles *after* TLA in the
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
| 10 | Cycle containing an async member: a leaf-importer awaits the cycle's `[[CycleRoot]]`, not the directly-imported member | `pending-async-dep-from-cycle.js` | `[[CycleRoot]]` selection per spec; the importer does not see the cycle leaf complete before the root |
| 11 | Self-import of an async module: ReferenceError on access during cycle, resolved post-await | `module-self-import-async-resolution-ticks.js` | Self-import's TDZ behavior holds across the await suspension |
| 12 | `await import(specifier)` from a sync module: dynamic import resolves to the namespace, sync module remains sync | `dynamic-import-resolution.js` | Dynamic import is *not* TLA; it uses the existing `compartmentImport` path |
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
2. Invokes `await compartment.import(rootSpecifier)`.
3. Asserts on (a) the resolved namespace, (b) the order of tick markers
   pushed onto a shared array by the fixture body, and (c) the rejection
   identity where the test expects rejection.

The DFS-invariant case (row 9) and the cycle case (row 10) take the
"globalThis log array" idiom from test262 directly: each fixture pushes a
named tick onto a shared `globalThis.test262` array, and the test
asserts the concatenated string.

### Test fixtures that do NOT translate

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

### Module-instance contract

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
  cycleRoot: ModuleInstance | undefined,     // new
}
```

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

`link()` ([packages/ses/src/module-link.js](../packages/ses/src/module-link.js))
gains a second pass that walks the linked instance graph in DFS
post-order. For each instance:

1. If its source has `__moduleIsAsync__: true`, set `asyncEvaluation =
   true` and allocate `topLevelCapability`.
2. For each linked import target, if the target's `asyncEvaluation` is
   true, push `this` onto the target's `asyncParentModules` and
   increment `this.pendingAsyncDependencies`.
3. After the pass: if `pendingAsyncDependencies > 0` and the instance
   itself is not `[[Async]]`, set `asyncEvaluation = true` and allocate
   the capability anyway. This is the row-6 case.

The `[[CycleRoot]]` is the entry point of the strongly-connected
component the module belongs to in the import graph. For a module not in
any cycle, `cycleRoot === self`. The implementation can reuse the
existing DFS in `instantiate`'s recursive descent if we maintain the
discovery-time / low-link bookkeeping of Tarjan's SCC algorithm during
that walk; the alternative is a second SCC pass.

### Evaluation procedure (the InnerModuleEvaluation analogue)

```mermaid
sequenceDiagram
  participant U as User code
  participant C as Compartment
  participant L as Linker
  participant R as Root module
  participant D as Async dep

  U->>C: compartment.import(spec)
  C->>L: load + link spec
  L-->>C: rootInstance (with caps)
  C->>R: execute()
  Note over R: walks resolvedImports bottom-up
  R->>D: execute()
  D-->>R: Promise<undefined>
  Note over R: pendingAsyncDependencies > 0;<br/>register completion handler
  R-->>C: topLevelCapability.promise
  Note over D: awaited promise resolves
  D->>D: AsyncModuleExecutionFulfilled
  D->>R: notify parent (decrement pending)
  Note over R: pending==0; if [[Async]],<br/>start async body; else resolve capability
  R-->>U: resolved namespace
```

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
  defines, which the spec-conformant CycleRoot bookkeeping handles for
  free.
- **Synchronously block in `execute()` via a polling SAB loop.**
  Considered and rejected. SES runs in browsers without SharedArrayBuffer
  guarantees and the contract would change the JS-event-loop semantics
  for all consumers of the compartment.

## Open questions

1. **Native Compartment passthrough.** When a future host Compartment is
   passed `__moduleIsAsync__: true`, does the host honor it or does the
   shim wrap with extra machinery? The native path is documented to
   pass-through; the test plan covers the shim path only.
2. **Dynamic-import-during-suspension.** A TLA-suspended module may
   call `await import(spec2)` between two awaits. The existing
   `compartmentImport` is async-aware, so this *should* work; the test
   table's row 12 covers the simple case but a follow-up may need an
   adversarial test that the spec's
   `dynamic-import-of-waiting-module*.js` exercises.
3. **Virtual module sources.** The design preserves the sync-only
   contract on virtual sources. If a use case arises where a virtual
   source must itself be async (e.g. a TLA-bearing source generated at
   import time from a remote tree), the contract on
   `makeVirtualModuleInstance` would need a parallel evolution. Out of
   scope here; surface to designer when the use case materializes.
4. **`importNow` diagnostic shape.** Should `importNow` of an async
   subgraph throw a `TypeError` (chosen) or a new `SyntaxError`
   subclass that more closely mirrors how 262 reports
   "evaluating-async" in a sync context? The current draft picks
   `TypeError` to match the existing "Compartment does not support
   dynamic import" diagnostic at
   [packages/ses/src/compartment.js](../packages/ses/src/compartment.js)
   line 438; the maintainer's call.
5. **Bundle-source format coverage.** Is the `endoScript`-format error
   acceptable, or should `bundle-source` silently fall back to
   `endoZipBase64` when it detects an async source in the input
   tree? The draft prefers an explicit error so the build is
   reproducible; the alternative trades reproducibility for the convenience
   of "just bundle it." Maintainer's call.
6. **Cycle root rediscovery on re-link.** A `compartment.import`
   call that re-enters the same compartment for a fresh root specifier
   today reuses memoized instances; the `cycleRoot` field is set at
   first-link time and is correct as long as the import graph does not
   acquire new edges. Does any current use case re-link with new
   edges? If so, `cycleRoot` may need to be re-derived; today's draft
   assumes a one-shot link.
