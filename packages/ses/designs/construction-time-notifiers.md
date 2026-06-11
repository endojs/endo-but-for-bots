# Construction-time notifiers for SES module instances

## Context

This document responds to two threads of review feedback on the cyclic
star-export fix for the endojs/endo cyclic-star-export issue.

The first is naugtur's inline-comment ask on the upstream review (the
inline at `packages/ses/src/module-instance.js:367`):

> I know this is vague, but it'd feel nicer design-wise to create all
> notifiers ahead of time and give them an ability to forward to or pull
> from another notifier, in which case the reexport \* would be a matter of
> connecting notifiers in a loop.
>
> If we could use this as an opportunity to design a fancier notifier
> primitive to share between the two implementations `makeModuleInstance`
> and `makeVirtualModuleInstance` we'd avoid some of the risk of interop
> failure.

The second is kriskowal's follow-up to that comment, with a concrete
proposal:

> Please consider whether we can create all of the notifiers for a
> module instance at time of construction instead of time of link.
> This may require a more deliberate separation of the instantiation
> and link phases, but I suspect we already have a hard enough line.
> This would obviate deferred notifier linkage, since notifiers would
> always be available up front.
> If not, please explain why such an arrangement is not possible or
> how the calling convention for precompiled ModuleSource instances
> would need to change.
> It might be that the notifiers need to be partially applied before
> full initialization.

This document analyzes the redesign, identifies what it would and would
not buy, and explains why the present recommendation is to **document
the plan and defer implementation** rather than land the refactor in the
current PR.

## The current phases

The relevant code lives in `packages/ses/src/module-{link,instance}.js`.
The lifecycle of a module passes through four phases:

1. **Load** (`module-load.js`): walk the module graph asynchronously and
   acquire the module source for every node.
   Produces a `moduleRecord` per module with `{ compartment,
   moduleSource, moduleSpecifier, resolvedImports, importMeta }`.
   The record carries the full `moduleSource`, including
   `__fixedExportMap__`, `__liveExportMap__`, `__reexportMap__`, and
   the `reexports` (star-export specifiers) array.
2. **Instantiate** (`module-link.js`'s `instantiate`): for one module,
   call `makeModuleInstance` (or `makeVirtualModuleInstance`), memoize
   the result, and then recursively `link` each dependency.
3. **Construct** (the body of `makeModuleInstance`): build the local
   binding state for the module's own exports (fixed plus live),
   populate `notifiers` for those exports, and define a closure named
   `imports` that the moduleFunctor will invoke during execute.
   The construct phase runs synchronously inside `instantiate` and
   returns the instance object `{ notifiers, exportsProxy, execute }`.
4. **Link** (the body of the `imports(updateRecord)` closure, invoked
   from inside `execute`): walk the `updateRecord` (the imports the
   functor declared), look up each upstream module instance, register
   each updater on the upstream's notifier, and wire reexport notifiers
   via `wireUpExportNotifier` for star-reexported names
   (`reexports`/`exportAlls`) and renamed reexports (`__reexportMap__`).

Today, **own** notifiers (for `__fixedExportMap__` and
`__liveExportMap__` entries, plus the `'*'` notifier) are created in
phase 3, the construct phase.
**Reexport** notifiers (for `__reexportMap__` entries and for star
reexports) are created in phase 4, the link phase, inside `imports`.

The endo cyclic-star-export fix added `makeNotifierWithResolver` to make
a single reexport notifier tolerate the case where the upstream's
notifier was not yet present when the reexport was wired.
The deferred resolver settles on the first call where
`upstreamInstance.notifiers[deferredImportName]` is defined and
forwards queued and subsequent updaters through to it.

## What the maintainer's proposal would change

The proposal moves **all** notifier creation, including reexport
notifiers, into phase 3 (construction).
After the move, the `notifiers` map for every module instance is
complete by the time `instantiate` returns.
The link phase becomes pure wiring: it would still walk the
`updateRecord` and register updaters on upstream notifiers, but every
notifier it touches already exists.

This is the maintainer's "obviate deferred notifier linkage" outcome.
`makeNotifierWithResolver` would lose its present sole caller and could
be deleted (or kept as the general primitive naugtur describes, used
internally by every notifier whose value is forwarded from another
notifier).

The maintainer flagged a concrete risk: "notifiers may need to be
partially applied before full initialization."
This is the calling-convention question for precompiled `ModuleSource`
instances and is examined below.

## What is actually available at construction time

A module's `moduleSource` carries, at the moment `makeModuleInstance` is
called, the following enumeration of every export name and its origin:

- `moduleSource.__fixedExportMap__`: own fixed bindings (`export const`,
  `export function`, `export class`).
  Local binding state is known.
- `moduleSource.__liveExportMap__`: own live bindings (`export let`,
  `export var`, plus the reexport-as-live shape `export { y as x } from
  './u.js'`).
  Local binding state is known.
- `moduleSource.__reexportMap__`: renamed reexports from specific
  specifiers.
  The map's keys are upstream specifiers and the values are
  `[[localName, exportedName], ...]` pairs.
  The exported names are known.
- `moduleSource.reexports` (the `exportAlls` array): star reexports.
  The list of upstream specifiers is known.

The `resolvedImports` map on the `moduleRecord` is also available; for
every upstream specifier the resolved key is known.
What is **not** available at construction time:

- The upstream module instance's own `notifiers` object.
  The upstream has not yet been instantiated when the current module is
  constructed; in cycles, by definition the upstream's construction is
  in progress on the same call stack.
- For star reexports, the **set of names** the upstream re-exports.
  Star reexport (`export *`) is a name-set inheritance whose membership
  depends on the upstream's own exports plus its own transitive star
  reexports.
  Resolving the set requires walking the upstream's
  `moduleSource.exports` (a flat list of all export names the upstream
  declares, sorted and known at construction time per
  `module-source.js`).

The first gap is the cycle structural property that `instantiate` was
designed to break by memoizing the instance after `makeModuleInstance`
returns and before recursing into dependencies.
The second gap is a graph traversal that, today, is performed implicitly
by the link phase's `entries(importNotifiers)` walk and the
`candidateAll` map.

## A redesign sketch

Move construction into a two-pass shape inside `instantiate`:

1. **Pass 1 (construct and name-claim)**: For every module in the
   closure of `resolvedImports`, call `makeModuleInstance` to allocate
   the binding state for own exports and create a stub for every
   reexport notifier the module declares (the union of
   `__reexportMap__`'s `exportedName`s and the star-reexport names
   enumerated by walking each upstream's `moduleSource.exports`).
   The stub is a forwarder built from a primitive of naugtur's shape:
   a notifier that holds a reference (initially undefined) to a target
   notifier and queues subscribers and updates until the target lands.
   Each stub records its `(upstreamSpecifier, upstreamName)` link
   target metadata.
   The instance is memoized; recursion proceeds.
2. **Pass 2 (wire)**: For every module, walk the recorded link targets
   and resolve each stub against
   `upstreamInstance.notifiers[upstreamName]`.
   By this point every instance has been constructed and every own
   notifier exists.
   Every stub finds a real notifier; deferred queueing is unused.
   The pass folds into the present `imports(updateRecord)` body.

Star reexports become an enumeration step in pass 1: walk
`upstreamModuleSource.exports` and create a forwarder stub for each
non-`default` name not already claimed by an own export or a renamed
reexport.
Ambiguity (a name reachable via two different star reexports) is
detected during pass 1 by tracking which star reexport claimed each
name, with the second claim demoting the stub to a no-op and surfacing
a syntax error on access; this mirrors the present `candidateAll[name]
= false` discipline.

The `imports(updateRecord)` closure is retained but trimmed: its only
remaining work is registering the moduleFunctor's `updaters` on the
upstream notifiers it already located in pass 1.
The `wireUpExportNotifier` helper is no longer reached with `notify ===
undefined` and its `makeNotifierWithResolver` branch can be removed.

## Hard-enough line between instantiate and link?

The maintainer asked whether the present code already has a hard line
between instantiate and link.
"I suspect we already have a hard enough line."
The answer in the present code is "almost, but not quite."

`makeModuleInstance` returns an instance that exposes `notifiers`,
`exportsProxy`, and `execute`.
The first two are populated by the construction body; the third is the
moduleFunctor wrapper, which, when invoked, runs the functor which
calls `imports(updateRecord)` to wire itself to its upstreams.
Today **the wiring is a side effect of execute**, not of instantiate.
That is the line the redesign needs to shift: pass-1 (wire stubs)
belongs to instantiate; pass-2 (register moduleFunctor updaters on
upstream notifiers) can remain in execute.

The line is concrete enough that the move is mechanical.
The risk is not architectural; it is two surfaces touched at once
(`makeModuleInstance` and `makeVirtualModuleInstance`) and a
calling-convention question for precompiled module sources.

## Precompiled ModuleSource calling convention

The maintainer's "calling convention for precompiled ModuleSource
instances" caveat refers to the contract between the SES linker and the
moduleFunctor that a precompiled `__syncModuleProgram__` (or
`__syncModuleFunctor__`) embodies.
The functor's signature today is:

```js
functor({ imports, onceVar, liveVar, import, importMeta });
```

where `imports(updateRecord)` is the link-time hook that registers the
functor's import updaters on the upstream notifiers and processes star
reexports.
The functor calls `imports(updateRecord)` once, early in execution,
before any code that reads an import binding runs.

Two facets of the calling convention come under scrutiny in the
redesign:

1. **`imports` becomes wire-only.**
   With reexport notifiers already created in pass 1, the
   `imports(updateRecord)` closure no longer needs `__reexportMap__`,
   `exportAlls`, or `wireUpExportNotifier` logic; it only needs to
   register the functor's own updaters on upstream notifiers it can
   look up directly.
   The functor's call shape is unchanged; the internal body of
   `imports` shrinks.
   No change to precompiled output is required.
2. **The "partially applied notifiers" question.**
   A precompiled module source whose moduleFunctor has not yet been
   instantiated (because the functor is created lazily in `execute`)
   still needs its reexport notifiers wired in pass 1, before the
   functor exists.
   This is fine for the own-export side because pass 1 does not need
   the functor; the binding state for own exports is allocated as
   inert state and the functor sets the initial value when it runs.
   But pass 1 needs to know the **set** of own exports and their
   shape (fixed against live), which is what `__fixedExportMap__` and
   `__liveExportMap__` already provide.
   So pass 1's information needs are met by the existing
   precompiled-source contract; no change to the precompiled-source
   schema is required.

There is one edge case where the maintainer's "partial application"
phrasing applies.
The renamer's local binding state (the `update` freezer in the present
`liveExportMap` walk, named with the "reexporting creates a tree of
bindings" comment) needs to participate in the chain of stub-resolution
in pass 1.
The present code already does this by storing the same `notify` in both
`localGetNotify` and `notifiers`, and by having the live binding's
`notify` accept a register-and-defer subscription whether or not the
binding has left TDZ.
The redesign preserves that property; the reexport stub's target
becomes the upstream's own-binding notifier, and the upstream's
own-binding notifier is the same object whether stubbed at pass 1 or
referenced lazily today.

## Will the redesign close the TDZ gap?

The companion observation from this PR is that SES previously did not
enforce ECMA-262 temporal dead zone semantics for cross-module reads
through a namespace import during a cycle.
The renamer-first plus const, the renamer-first plus let, and the
named-reexport plus renamer-first plus const cases all returned
`undefined` rather than raising `ReferenceError` (3 of the 7 cells in
the [`import-gauntlet.test.js`](../test/import-gauntlet.test.js)
matrix).

The gap actually had two causes:

- The cross-module read through the namespace import (`*` notifier)
  propagated the **raw `exportsTarget`** object rather than the
  `exportsProxy`.
  `exportsTarget` had **no property defined for the binding** until the
  late `defineProperty` pass at the end of `imports()`.
  A missing property reads as `undefined` rather than throwing.
- Where a property was defined, the `wireUpExportNotifier` helper
  installed an exported getter that returned the last propagated value
  (initially `undefined`) with no TDZ tracking.
  Even after the property landed it would mask the upstream's TDZ
  state.

The gap is closed by two targeted fixes that do not require the
construction-time-notifiers redesign:

- `module-instance.js` defines the `exportsTarget` property for each own
  fixed and live export **at construction time** using the TDZ-aware
  getter from `localGetNotify`.
  The late `arrayForEach(arraySort, defineProperty)` pass at the end of
  `imports()` redefines the same descriptor as a no-op, preserving the
  ECMA-262 sorted enumeration order without changing the eager
  TDZ-aware behavior.
- `wireUpExportNotifier` (which handles both star reexports and
  `__reexportMap__`-driven named reexports) tracks its own TDZ state.
  The downstream's exported getter throws `ReferenceError` until the
  upstream binding propagates a value through the notifier chain.
  The helper also defines the property on `exportsTarget` eagerly.
- `module-source/src/transform-analyze.js` reorders the preamble so
  hoisted declarations (function declarations and `var` initializers)
  run **before** the imports call.
  This matches the ECMA-262 model: function/var bindings are created
  and initialized to undefined during `InitializeEnvironment`, which
  precedes dependency evaluation in `Module.Evaluate`.
  Without this reorder, a hoisted `var y` in an upstream module would
  still be in the live-binding TDZ when a downstream's body read
  `r.y`, and the eager TDZ-aware getter would throw `ReferenceError`
  instead of returning `undefined`.

The construction-time-notifiers redesign is orthogonal to the TDZ fix.
The redesign is about the notifier-graph topology; the TDZ fix is
about when and how the namespace's exported getter consults the
upstream's binding state.
Either change can land independently.
The redesign makes a future TDZ-aware getter easier to compose (every
reexport already has a direct reference to its upstream's notifier
object, which could carry a TDZ predicate alongside its `notify`),
but the present TDZ fix did not require it.

## Notifier-primitive sharing with `makeVirtualModuleInstance`

The second half of naugtur's comment asks whether the redesign could
share a notifier primitive between `makeModuleInstance` (used for
precompiled and natively-imported ESM) and `makeVirtualModuleInstance`
(used for the `{ exports, execute }` virtual-source shape).
The two implementations have notifier shapes that today diverge:

- `makeModuleInstance` notifiers accept an `update(newValue)` callback
  and store it in an `updaters` array, then invoke each updater on
  each binding change.
  The update is push-style; the upstream's binding state pushes to
  subscribers.
- `makeVirtualModuleInstance` notifiers do the same shape (the
  `notifiers[name]` closure pushes through the `updaters` array), so
  the surface contract is already the same: a notifier is
  `(update) => void` where `update` is registered for future binding
  changes and invoked immediately with the current value when
  available.

A shared primitive would name this contract and remove the duplication
between the two construction bodies.
The primitive looks like:

```js
const makeBindingNotifier = (initialValue) => {
  const updaters = [];
  let value = initialValue;
  const get = () => value;
  const notify = updater => {
    arrayPush(updaters, updater);
    updater(value);
  };
  const update = newValue => {
    value = newValue;
    for (const u of updaters) u(newValue);
  };
  return { get, notify, update };
};
```

A reexport stub would be a different primitive that holds a reference
to a target `notify` (initially undefined) and queues subscribers
until the target is set:

```js
const makeForwarderNotifier = () => {
  const pending = [];
  let target;
  const notify = updater => {
    if (target !== undefined) {
      target(updater);
      return;
    }
    arrayPush(pending, updater);
  };
  const resolve = targetNotify => {
    target = targetNotify;
    for (const p of pending) targetNotify(p);
    pending.length = 0;
  };
  return { notify, resolve };
};
```

The second is `makeNotifierWithResolver` already in `packages/ses/src/
notifier-with-resolver.js`.
The first is a generalization of the ad-hoc inline shape inside both
`makeModuleInstance` and `makeVirtualModuleInstance`.
With both primitives extracted, both module-instance implementations
become smaller and the redesign's pass 1 walks a uniform notifier
graph.

## Recommendation

Land the redesign as a follow-up PR, not in this one.
The current PR's scope is the regression fix and its parity tests.
The redesign touches two large surfaces (`makeModuleInstance` and
`makeVirtualModuleInstance`), shifts the instantiate/link line, and
benefits from being reviewed against the parity baseline (the matrix
in [`import-gauntlet.test.js`](../test/import-gauntlet.test.js) plus
the compartment-mapper companion tests) that the current PR
establishes.

Concretely, the follow-up steps are:

- Extract `makeBindingNotifier` and confirm
  `makeNotifierWithResolver` covers the forwarder primitive (the
  present implementation is the right shape; only the consumer site
  changes).
- Refactor `makeModuleInstance` to construct reexport stubs in the
  construction body, recording link metadata and registering each
  stub in `notifiers`.
- Add a pass-2 step to `instantiate` that resolves the stubs of the
  just-constructed instance against the upstream instances' own
  notifiers, removing `wireUpExportNotifier`'s deferred-resolver
  branch.
  The `imports(updateRecord)` closure shrinks to updater registration
  only.
- Mirror the changes in `makeVirtualModuleInstance` using the same
  primitives.
- Re-run the [`import-gauntlet.test.js`](../test/import-gauntlet.test.js)
  matrix and the compartment-mapper cycle suites.
  The 6 plus 1 `.failing` cells stay `.failing` (the redesign does
  not close the TDZ gap), but the four converging cells stay
  converging and the original regression test stays green.
- Separately, consider a TDZ-aware exported-getter pass that
  consults the upstream's own-binding getter instead of caching the
  propagated value, which would close the SES-against-Node
  divergence the matrix pins.

The recommendation to defer rests on the fact that the redesign is a
scope-widening refactor with no behavior change visible to consumers
(it does not close the TDZ gap by itself, and the regression fix is
already in place), so landing it as a separate PR preserves the
present PR's reviewable surface and lets the redesign's diff be
measured against the post-fix baseline.
