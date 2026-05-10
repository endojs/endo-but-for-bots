# Eventual-Send Eager-Shim, Lazy-Main Delegate Ponyfill

| | |
|---|---|
| **Created** | 2026-05-10 |
| **Updated** | 2026-05-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [endojs/endo-but-for-bots#172](https://github.com/endojs/endo-but-for-bots/issues/172) |

## What is the Problem Being Solved?

`@endo/eventual-send` currently lives in two postures and the user has to
pick the right one before importing.

The legacy posture is the entry point at `packages/eventual-send/src/no-shim.js`,
which is a passive stub.
A program wanting `HandledPromise` to actually work must additionally import
the side-effecting `packages/eventual-send/shim.js`, which writes
`globalThis.HandledPromise = makeHandledPromise()` exactly once.
Within Endo platforms this is already done by `@endo/init` (or by SES, which
permits a `HandledPromise` global on the start compartment).

This split has three consequences that the rest of the system has paid for
in workarounds.

First, a library that wants `HandledPromise` does not know whether the
embedding application has set it up.
The library has to either import the shim (and thereby commit the embedding
application to its choice of implementation) or assume the global is present
(and crash if it is not).

Second, when two libraries each ship their own `HandledPromise`, the second
one to load loses silently to the first because of the
`if (typeof globalThis.HandledPromise === 'undefined')` guard in
`shim.js`.
There is no realm-wide intrinsic that the loser can inspect to confirm it
has yielded to the winner.
The losing library's `HandledPromise` reference becomes `undefined` from
the perspective of code that imports through it, depending on import order.

Third, lockdown and the shim are coupled by convention and not by
mechanism.
SES `lockdown()` permits a `HandledPromise` global on the start compartment
(see `packages/ses/src/permits.js` line 118 and lines 1612-1631), but it
does not install one and it does not mediate between competing shims.
The permits comment is explicit:
`// TODO: Until Promise.delegate (see below).`

`@endo/harden` solved a structurally identical problem with a hybrid
"ponyfill plus race-to-install on a registered-symbol intrinsic" pattern,
documented in
[`packages/harden/README.md`](../packages/harden/README.md) and implemented
across
[`packages/harden/make-selector.js`](../packages/harden/make-selector.js),
[`packages/harden/hardened.js`](../packages/harden/hardened.js), and
[`packages/harden/noop.js`](../packages/harden/noop.js), with SES integration
at [`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
lines 369-391.

This design proposes an analogous (but simpler) pattern for `HandledPromise`,
anticipating the TC39 `Promise.delegate` direction.
The chosen slot is `Promise[Symbol.for('delegate')]`.

## Design

The architecture has two surfaces and one slot.

| Surface | Role | Side effect at import? |
|---|---|---|
| `@endo/eventual-send/shim.js` | **Eager installer.** Imports unconditionally write `Promise[Symbol.for('delegate')]` if the slot is empty. | Yes. |
| `@endo/eventual-send` (main entry) | **Lazy consumer.** First call into `E()` or `HandledPromise.*` reads `Promise[Symbol.for('delegate')]`; if the slot is empty, the call installs on demand. | No. |

The slot `Promise[Symbol.for('delegate')]` is shared across every instance
of `@endo/eventual-send` in the same realm, including instances loaded into
child compartments that share the realm's `Promise`.

There is exactly **one implementation** of the `delegate` function shipped by
the package; both surfaces install the same function via the same code path.
The two surfaces differ only in **when** they trigger the install.

### The slot: `Promise[Symbol.for('delegate')]`

The registered-symbol slot lives on the `Promise` constructor, not on
`Promise.prototype`.

The constructor is the surface the standard's `Promise.delegate`
proposal targets.
Naming the slot `Promise[Symbol.for('delegate')]` keeps the
forward-compatibility story simple: a future migration is
`Promise.delegate ?? Promise[Symbol.for('delegate')]`.

The constructor is also writable by user code on every host runtime
relevant to `@endo/eventual-send` (V8, JSC, SpiderMonkey, XS) before
lockdown.
After lockdown, SES freezes the `Promise` constructor along with the
rest of the permitted intrinsics.
A library that wants the slot installed therefore must arrange for
the install to happen before lockdown.
`@endo/eventual-send/shim.js` is the explicit hook for that, and is
the package surface that consumers opt into pre-lockdown (via
`@endo/init` or directly).

### The `delegate(handler)` function

The value at `Promise[Symbol.for('delegate')]` is a single function, called
`delegate` in this design.
It is **not** the `HandledPromise` constructor.

#### Signature

```js
/**
 * Create a new pending promise whose pending operations are routed to
 * the supplied handler.
 *
 * @template R
 * @param {Handler<Promise<R>>} handler - the handler invoked for `get`,
 *   `applyMethod`, `applyFunction`, and their `*SendOnly` variants while
 *   the promise is pending.
 * @returns {{
 *   promise: Promise<R>,
 *   resolve: (value: R | Promise<R>) => void,
 *   reject: (reason: unknown) => void,
 *   resolveWithPresence: (
 *     presenceHandler?: Handler<{}>,
 *     options?: ResolveWithPresenceOptionsBag<{}>,
 *   ) => object,
 * }}
 */
const delegate = handler => { /* ... */ };
```

The return value is a settler bag, the same shape `Promise.withResolvers()`
returns plus a `resolveWithPresence` for promises that resolve to a
remote-presence proxy.
The promise itself is an ordinary `Promise` instance: `instanceof Promise`
holds, `Promise.prototype.then` works, no subclass relationship is required.

#### Why a function, not a constructor

`new HandledPromise(executor, handler)` mixes two concerns: it is a
`Promise` subclass with `[[Construct]]` semantics AND it carries a
non-standard executor signature
(`(resolve, reject, resolveWithPresence) => void`).
The subclass relationship is load-bearing only because legacy code does
`HandledPromise.applyMethod(...)`, which would otherwise need its own
constructor.

`delegate(handler)` drops the subclass relationship entirely.
The returned promise is an ordinary `Promise` instance and the
non-standard `resolveWithPresence` lives on the settler bag rather than
on the executor's argument list.
This matches the direction the TC39 `Promise.delegate` proposal is
expected to take and lets the ponyfill swap to the standard mechanically.

#### The handler protocol

The `handler` parameter is the same `Handler<T>` already used by
`HandledPromise`.
Reproduced here for completeness:

```js
/**
 * @template T
 * @typedef {{
 *   get?(p: T, name: PropertyKey, returnedP?: Promise<unknown>): unknown;
 *   getSendOnly?(p: T, name: PropertyKey): void;
 *   applyFunction?(p: T, args: unknown[],
 *     returnedP?: Promise<unknown>): unknown;
 *   applyFunctionSendOnly?(p: T, args: unknown[]): void;
 *   applyMethod?(p: T, name: PropertyKey | undefined, args: unknown[],
 *     returnedP?: Promise<unknown>): unknown;
 *   applyMethodSendOnly?(p: T, name: PropertyKey | undefined,
 *     args: unknown[]): void;
 * }} Handler
 */
```

A handler with no method on it is permitted; the dispatcher composes
missing methods (`applyMethod` from `get` + `applyFunction`,
`applyFunction` from `applyMethod` with `name: undefined`).

#### How the existing HandledPromise machinery composes

The existing internal `makeHandledPromise()` in
[`packages/eventual-send/src/handled-promise.js`](../packages/eventual-send/src/handled-promise.js)
is retained as a private factory.
The exported `delegate(handler)` is implemented in terms of it:

```js
const HP = makeHandledPromise();

const delegate = handler => {
  let resolve, reject, resolveWithPresence;
  const promise = new HP(
    (rH, rJ, rWP) => {
      resolve = rH;
      reject = rJ;
      resolveWithPresence = rWP;
    },
    handler,
  );
  return harden({ promise, resolve, reject, resolveWithPresence });
};
```

The static methods `applyMethod`, `applyFunction`, `get`, `getSendOnly`,
`applyMethodSendOnly`, `applyFunctionSendOnly`, `resolve` continue to
exist for `E()` to call into.
They are accessed via a separate slot in the package's main entry; see
"Public surface" below.

### Public surface

The package's main entry exports the same names it exports today, with
one addition:

```js
// @endo/eventual-send (main entry)
import { E, HandledPromise } from '@endo/eventual-send';
// New:
import { delegate, makeDelegate } from '@endo/eventual-send';
```

- `E` is unchanged: `E(target).method(args)` returns a promise; `E.when`,
  `E.get`, etc. continue to work.
- `HandledPromise` is preserved as a backward-compatibility shim; reads
  go through the realm-shared delegate.
  See "Backward compatibility" below.
- `delegate(handler)` is the new primary surface, identical to
  `Promise[Symbol.for('delegate')]` (and to `Promise.delegate` once the
  standard ships).
- `makeDelegate()` is a test-only factory that returns an unregistered
  `delegate` function; tests that need an isolated handler graph use
  it instead of the realm-shared one.
  This is the answer to OQ2 from the prior revision.

The static methods (`applyMethod`, `applyFunction`, etc.) move to a
sibling export `dispatch` keyed by operation, since they are no longer
properties on a constructor:

```js
import { dispatch } from '@endo/eventual-send';
dispatch.applyMethod(target, prop, args);  // returns a promise
```

`HandledPromise.applyMethod(target, prop, args)` continues to work as a
deprecated alias that forwards to `dispatch.applyMethod(...)`.

### How the eager shim and lazy main share state

The two surfaces both call into the same install path:

```js
// packages/eventual-send/src/install-delegate.js (private)
import { makeDelegate } from './make-delegate.js';

const SLOT = Symbol.for('delegate');

let cached;

export const installOrAdoptDelegate = () => {
  if (cached) return cached;

  // Forward-compat: prefer the standard.
  if (typeof Promise.delegate === 'function') {
    cached = Promise.delegate;
    return cached;
  }

  // Adopt a previously-installed delegate.
  const present = Promise[SLOT];
  if (typeof present === 'function') {
    cached = present;
    return cached;
  }

  // Install. defineProperty with configurable:false will throw if a
  // racing writer or a frozen Promise prevents the write; the catch
  // path adopts the racing winner if there is one.
  const fresh = makeDelegate();
  try {
    Object.defineProperty(Promise, SLOT, {
      value: fresh,
      configurable: false,
      writable: false,
      enumerable: false,
    });
    cached = fresh;
  } catch (err) {
    const winner = Promise[SLOT];
    if (typeof winner === 'function') {
      cached = winner;
    } else {
      throw err;
    }
  }
  return cached;
};
```

The two surfaces differ only in when they call `installOrAdoptDelegate()`:

```js
// packages/eventual-send/shim.js  (eager: import has side effect)
import { installOrAdoptDelegate } from './src/install-delegate.js';
installOrAdoptDelegate();
```

```js
// packages/eventual-send/src/no-shim.js  (lazy: install on first use)
import { installOrAdoptDelegate } from './install-delegate.js';
import makeE from './E.js';

let cachedDelegate;
const getDelegate = () => {
  if (!cachedDelegate) {
    cachedDelegate = installOrAdoptDelegate();
  }
  return cachedDelegate;
};

export const delegate = handler => getDelegate()(handler);
export const E = makeE(getDelegate);
// ... HandledPromise back-compat re-export (see below) ...
```

Multiple import sites of `@endo/eventual-send` (the main entry) each
have their own `cachedDelegate` closure, but every one converges on
the same realm-shared function via the slot.
Identity is preserved: every call to `delegate(handler)` from any
instance of the package returns a settler tied to a `delegate` that
identifies as `Promise[Symbol.for('delegate')]`.

## How this is simpler than `@endo/harden`

`@endo/harden` and this design solve the same shape of problem (race a
shim-style implementation onto a realm-shared slot) with the same core
mechanism (`Object.defineProperty` with `configurable: false`).
The differences below are simplifications; nothing in this design is more
complicated than the harden equivalent.

| Concern | `@endo/harden` | This design |
|---|---|---|
| Number of code paths | Two: `hardened.js` (assumes pre-installed) and `noop.js` (installs a shallow-freeze fallback). | One. The eager-shim and lazy-main paths call the same `installOrAdoptDelegate()`. |
| Number of slots watched | Two: `Object[Symbol.for('harden')]` and `globalThis.harden` (legacy back-compat). | One: `Promise[Symbol.for('delegate')]`. The legacy `globalThis.HandledPromise` story is handled by Stage 4 of the migration (`shim.js` writes both), not by the selector. |
| SES integration | Mandatory: SES must install `harden` because every hardened module depends on it. | Optional: SES does not need to install a delegate; consumers that want one import `@endo/eventual-send/shim.js` (or `@endo/init`) before lockdown. |
| Diagnostic `lockdownError` | Required: harden carries a stack-trace error so SES lockdown can blame the right module if harden was used pre-lockdown without SES adoption. | Not required: a post-lockdown import of `@endo/eventual-send` that finds an empty slot fails at the call site of `delegate(...)`, not at lockdown. The error message names the loading-order constraint. |
| Build conditions | Two: `-C hardened` (assert preinstalled) and `-C harden:unsafe` (install a no-op). | One. The same module ships in both bundle modes; consumers that want to assert preinstall use `import '@endo/eventual-send/shim.js'` and inspect `Promise[Symbol.for('delegate')]`. |
| Permits change | Adds `Object[Symbol.for('harden')]` as a permitted intrinsic property. | Adds `Promise[Symbol.for('delegate')]` as a permitted intrinsic property. Strictly parallel; no extra permits machinery. |

The simplifications follow from one decision: SES does not need to install
`delegate` itself.
`harden` is mandatory for every Hardened JavaScript module to be safe;
`HandledPromise` is mandatory only for code that uses `E()`.
A program that does not use `E()` does not need a delegate.
The selector therefore does not need a fallback for "the slot is empty
and the consumer wants to be silently degraded"; it can fail loudly.

## Lockdown integration

SES `lockdown()` should run a small analog of its existing `harden`
race-handler ([`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
lines 369-391) for `Promise[Symbol.for('delegate')]`.

After collecting intrinsics, lockdown reads
`Promise[Symbol.for('delegate')]`.
If a function is present, lockdown adopts it: the slot becomes part of
the frozen intrinsic graph and nothing further is done.
If the slot is empty, lockdown does not install a default; the slot
remains empty after lockdown.
Subsequent imports of `@endo/eventual-send` after lockdown that call
`delegate(...)` (or `E(...)`) will fail at the call site because the
lazy install path cannot define a property on a frozen `Promise`.
This is the price of not vendoring an eventual-send implementation into
SES.

The implementation hook in
[`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
mirrors the harden block:

```js
const symbolForDelegate = symbolFor('delegate');
const priorDelegate = intrinsics.Promise[symbolForDelegate];
if (priorDelegate !== undefined && typeof priorDelegate !== 'function') {
  throw new TypeError('Promise[@delegate] must be a function');
}
// If a function is present, it stays put as part of the frozen
// intrinsic graph. If absent, the slot stays empty.
```

The SES permits table in
[`packages/ses/src/permits.js`](../packages/ses/src/permits.js) (the
`Promise` block at lines 1663-1679) gets a new entry for the
registered-symbol slot:

```js
Promise: {
  // ... existing entries ...
  // Slot for the @endo/eventual-send delegate function,
  // anticipating the TC39 Promise.delegate proposal.
  'UniqueSymbol(delegate)': fn,
},
```

The existing `HandledPromise` global (permits.js lines 118 and
1612-1631) becomes deprecated but is not removed in this design.
A subsequent design can prune it once consumers migrate.

## Shared-intrinsic propagation to compartments

A symbol-keyed property on `Promise` propagates to every compartment
that shares the same realm intrinsics.
Compartments created post-lockdown share the realm's `Promise`
constructor by default
(see `packages/ses/src/permits.js` `universalPropertyNames`).
Reading `Promise[Symbol.for('delegate')]` inside a compartment hits the
same property descriptor.

`Symbol.for(...)` is itself realm-wide: every compartment that calls
`Symbol.for('delegate')` gets the same symbol, because the registry is
keyed on the string and lives on the realm's `Symbol` intrinsic.
Two pieces of code in different compartments that name the slot agree
on the slot.

This is the same mechanism that
[`packages/harden/make-selector.js`](../packages/harden/make-selector.js)
relies on for `Object[Symbol.for('harden')]`.

## Backward compatibility

Existing `import { HandledPromise } from '@endo/eventual-send'` consumers
continue to receive a constructor-shaped object whose static methods
(`applyMethod`, `applyFunction`, `get`, etc.) work exactly as today.
The constructor form `new HandledPromise(executor, handler)` is preserved
as a deprecated alias around `delegate(handler)`:

```js
const HandledPromise = function (executor, handler) {
  const { promise, resolve, reject, resolveWithPresence } =
    delegate(handler);
  executor(resolve, reject, resolveWithPresence);
  return promise;
};
HandledPromise.applyMethod = dispatch.applyMethod;
// ... etc ...
```

Existing `import '@endo/eventual-send/shim.js'` consumers continue to
populate `globalThis.HandledPromise` for backward compatibility:
the eager shim writes both the registered-symbol slot AND the legacy
global, with the global pointing at the same back-compat `HandledPromise`
re-export.

Existing `globalThis.HandledPromise` consumers (libraries that have not
yet migrated) continue to work because lockdown's permits still allow the
global; until those libraries migrate, the global remains populated.

## Boundary cases

**Two libraries that ship competing implementations.**
First write wins, per the race-to-install discipline.
The second library's `defineProperty` throws because the existing
descriptor is `configurable: false`; the catch path re-reads and adopts
the winner.
Both libraries return delegate functions whose identities are equal.
This is identical to the `@endo/harden` story and inherits its
correctness argument.

**A library that imports the eager shim before any other shim.**
The shim installs immediately and the slot is taken.
SES `lockdown()` later observes a function in the slot and adopts it
as part of the intrinsic graph.

**A library that imports the lazy main entry pre-lockdown without
importing the shim.**
The lazy install fires on first call to `delegate(...)` (or `E(...)`)
and the slot is taken.
SES `lockdown()` later observes a function in the slot and adopts it.

**A library that imports the lazy main entry post-lockdown without any
prior install.**
The slot lives on the `Promise` constructor, which lockdown has frozen.
The lazy install path's `defineProperty` call throws; the catch path
re-reads the slot, finds it still empty, and propagates a clear error
to the caller:

```js
throw new TypeError(
  'Cannot install @endo/eventual-send: Promise is frozen and ' +
  'Promise[@delegate] was not pre-installed before lockdown. ' +
  'Import @endo/eventual-send/shim.js (or @endo/init) before calling ' +
  'lockdown().',
);
```

**A library that loads from a different realm (iframe, vm.Script).**
The slot is per-realm, so cross-realm code does not share a delegate.
This matches the behavior of every other realm-scoped intrinsic and is
the only safe story; identity across realms is a general unsolved
problem.
`@endo/captp` continues to be the cross-realm bridge.

## Migration path

The migration is staged so existing consumers do not break.

**Stage 1: introduce the install path.**
Add `packages/eventual-send/src/install-delegate.js` exporting
`installOrAdoptDelegate()`.
Add `packages/eventual-send/src/make-delegate.js` exporting
`makeDelegate()`.
Existing code paths are untouched.

**Stage 2: switch the lazy main entry.**
Update `packages/eventual-send/src/no-shim.js` to call
`installOrAdoptDelegate()` lazily on first use of `E` or `delegate`.
Add the new `delegate`, `makeDelegate`, and `dispatch` exports.
Preserve the `HandledPromise` export as a deprecated back-compat alias.
The `import { HandledPromise, E } from '@endo/eventual-send'` surface
continues to work.

**Stage 3: rewrite the eager shim.**
Update `packages/eventual-send/shim.js` to call
`installOrAdoptDelegate()` at module load (eagerly), and additionally
write `globalThis.HandledPromise` for legacy back-compat.

**Stage 4: SES integration.**
Land the lockdown-side hook described above, plus the permits entry
for `Promise[Symbol.for('delegate')]`.
At this point the `HandledPromise` global becomes vestigial; SES still
permits it (per existing permits.js) but does not require it.

**Stage 5: prune the `HandledPromise` global.**
After a deprecation window, remove the `HandledPromise` entry from
`packages/ses/src/permits.js` and remove the `globalThis.HandledPromise`
write from `packages/eventual-send/shim.js`.
Out of scope for this design; deferred to a follow-up after consumer
migration is observed.

The current public `import { HandledPromise, E } from '@endo/eventual-send'`
surface does not change shape across any of these stages.
The test suite at `packages/eventual-send/test/` should pass unmodified
through stages 1-4, with new tests for the eager-shim install behavior,
the lazy-main install behavior, and the `delegate(handler)` settler API.

## Alternatives Considered

**A single bi-modal entry point with a runtime lockdown check.**
The prior revision of this design proposed a "race-to-install ponyfill"
where the same module body adapted its behavior to whether lockdown
had run.
This required the entry module to consult three slots
(`Promise.delegate`, `Promise[Symbol.for('delegate')]`, and
`globalThis.HandledPromise`) and to handle a frozen `Promise` failure
mode at the lazy-install site.
The eager-shim plus lazy-main split eliminates the third slot
(`globalThis.HandledPromise` is handled by stage 4's shim rewrite, not
by the selector) and makes the install timing the consumer's explicit
choice rather than a runtime guess.
Recommendation: rejected in favor of the current design.

**Two separate packages: `@endo/handled-promise` plus `@endo/eventual-send`
consuming it.**
Splitting the install path into its own package would mirror the
`@endo/harden` separation and arguably cleaner package layering.
The cost is an additional package boundary to maintain and version, and
a breaking change to the import surface for every existing consumer of
`@endo/eventual-send`.
Recommendation: defer.
A subpath module gives the same encapsulation without the package-split
overhead, and a future extraction is mechanical if it becomes valuable.

**An SES-only solution (no shim, lockdown is required).**
SES could install a delegate unconditionally during lockdown and
require all consumers to call `lockdown()` first.
This eliminates the race entirely.
The cost is that `@endo/eventual-send` becomes unusable in non-SES
environments, breaking every consumer that uses `E()` for its async
semantics in a vanilla Node.js or browser process (testing,
prototyping, embedding in non-Endo applications).
Recommendation: rejected.
The bi-modal usability is the user-visible value of the change.

**Mutate `Promise.prototype` rather than `Promise`.**
The slot could live on `Promise.prototype` instead of `Promise`.
Prototype slots propagate to all `Promise` instances, including
delegated promises since they have `Promise.prototype` as their
prototype.
However, the standard's `Promise.delegate` direction targets the
constructor, so naming the slot on the constructor matches the
forward-compat story.
Recommendation: rejected.

**Use a non-symbol property name like `Promise.__delegate__` or
`Promise._endoHandledPromise`.**
A string property is permissible and avoids any symbol-vs-property
confusion.
The standard's eventual `Promise.delegate` will be a string property,
so a string-named ponyfill slot would put the ponyfill into a
namespace clash with the standard.
The registered-symbol slot is name-scoped under the symbol registry
and cannot collide with future standard properties.
Recommendation: rejected.

**Keep `HandledPromise` as the value at the slot rather than a
`delegate(handler)` function.**
The slot could hold the constructor itself, preserving the existing
shape.
The cost is that the constructor's executor signature
`(resolve, reject, resolveWithPresence) => void` is non-standard, and
the `[[Construct]]` semantics complicate the migration to a future
standard `Promise.delegate`.
Recommendation: rejected.
The function shape at the slot is the same shape the standard is
expected to take.

## Decisions

1. **Slot lives on `Promise`, not `Promise.prototype`.**
   The standard's `Promise.delegate` direction targets the constructor.
   Naming the slot on the constructor preserves forward-compatibility.

2. **Slot is keyed by registered symbol `Symbol.for('delegate')`.**
   The registered-symbol registry is realm-wide and cannot collide
   with future standard property names.
   This matches `@endo/harden`'s discipline.

3. **Slot value is a `delegate(handler)` function, not a constructor.**
   The function shape matches the expected TC39 standard and lets the
   ponyfill swap to the standard mechanically.
   The constructor-shaped `HandledPromise` is preserved as a
   back-compat alias around `delegate(handler)`.

4. **First writer wins; subsequent writers yield.**
   The slot is installed `configurable: false, writable: false`.
   Competing libraries observe the existing function and adopt it.
   This matches `@endo/harden`'s discipline.

5. **The shim is eager; the main entry is lazy.**
   `@endo/eventual-send/shim.js` installs at import.
   `@endo/eventual-send` (main entry) installs on first use.
   Both call the same `installOrAdoptDelegate()` function.

6. **SES yields to a pre-installed delegate and does not install a
   default.**
   Vendoring eventual-send into SES would invert package layering.
   The post-lockdown failure mode is loud and easy to diagnose
   (call site of `delegate(...)`, not lockdown).

7. **There is one implementation, not two.**
   The same install path runs whether the consumer imported the eager
   shim or only the lazy main entry; the timing differs but the code
   is shared.

8. **`makeDelegate()` is exposed for tests that need an isolated
   delegate** (resolves prior OQ2).
   Production code uses the realm-shared `delegate`; tests that need
   handler-graph isolation use `makeDelegate()` to get an unregistered
   delegate function.

9. **Existing `HandledPromise` global remains permitted during
   migration.**
   The legacy `import '@endo/eventual-send/shim.js'` continues to
   populate `globalThis.HandledPromise` so legacy consumers do not
   break.
   A subsequent design can prune the global once consumers migrate.

## Test plan

Tests live under `packages/eventual-send/test/` and would extend the
existing fixture set (`hp.test.js`, `e.test.js`, etc.).

**Eager shim installs at import.**
A test imports `@endo/eventual-send/shim.js` and verifies that
`Promise[Symbol.for('delegate')]` is populated with a function before
any other code runs.

**Lazy main installs on first use.**
A test imports `@endo/eventual-send` (main entry) without the shim,
verifies the slot is empty before any call, calls `delegate(handler)`,
and verifies the slot is now populated and the returned settler bag
works.

**Eager shim and lazy main converge on the same delegate.**
A test imports the shim first, then imports the main entry, then
verifies that the main entry's `delegate` and `Promise[@delegate]`
are the same function.

**Adopt a pre-installed delegate.**
A test installs a stand-in function at `Promise[Symbol.for('delegate')]`
before importing either surface, then imports the main entry, then
verifies that `delegate` is the pre-installed stand-in (not a fresh
implementation).

**Lost race recovery.**
A test simulates a competing writer that installs at the slot between
the install path's read and its `defineProperty` call, then verifies
that the install path's catch branch returns the racing winner.

**Cross-compartment identity.**
A test verifies that
`startCompartment.evaluate('Promise[Symbol.for("delegate")]') ===
childCompartment.evaluate('Promise[Symbol.for("delegate")]')`
holds after lockdown.

**Forward-compat for standard `Promise.delegate`.**
A test stubs `Promise.delegate = someFunction` before importing the
main entry and verifies that the install path returns `someFunction`
without consulting the registered-symbol slot.

**Backward-compat for legacy `globalThis.HandledPromise` consumers.**
A test imports `@endo/eventual-send/shim.js` and verifies that
`globalThis.HandledPromise` is populated and that
`new globalThis.HandledPromise(executor, handler)` produces a working
promise whose `applyMethod`-style operations dispatch through the
handler.

**Post-lockdown lazy install fails loudly.**
A test calls `lockdown()` first, then imports the main entry without
the shim, then calls `delegate(handler)`, and verifies the call throws
a `TypeError` whose message names the loading-order constraint.

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-text-codecs-shim](hardened-text-codecs-shim.md) | Sibling shim design.  Both add a vetted intrinsic that compartments share; no implementation overlap. |
| [hardened-url-shim](hardened-url-shim.md) | Sibling shim design.  Same mechanical pattern (taming a host-provided constructor), but distinct from the eager-shim/lazy-main pattern proposed here. |

`@endo/harden` is the existing reference implementation of the
race-to-install pattern; it is not a design dependency, but the
implementation will follow its module shape closely (with the
simplifications enumerated under "How this is simpler than
`@endo/harden`").

## Phased implementation

### Phase 1: install path and main entry (S)

- Add `packages/eventual-send/src/install-delegate.js` exporting
  `installOrAdoptDelegate()`.
- Add `packages/eventual-send/src/make-delegate.js` exporting
  `makeDelegate()` (the function-shaped delegate factory built on the
  existing `makeHandledPromise()`).
- Update `packages/eventual-send/src/no-shim.js` to call
  `installOrAdoptDelegate()` lazily and export the new `delegate`,
  `makeDelegate`, and `dispatch` surfaces.
- Preserve `HandledPromise` as a back-compat alias.
- Add unit tests for the lazy install, adoption, lost race,
  cross-compartment identity, and forward-compat hook.

### Phase 2: rewrite the eager shim (S)

- Update `packages/eventual-send/shim.js` to call
  `installOrAdoptDelegate()` at module load and additionally write
  `globalThis.HandledPromise` for back-compat.
- Add unit tests for the eager install behavior and the convergence
  with the lazy main entry.

### Phase 3: SES integration (M)

- Add the lockdown-side hook in
  `packages/ses/src/lockdown.js` mirroring the existing harden block.
- Add the permits entry for `Promise[Symbol.for('delegate')]`.
- Add a SES-side test verifying that lockdown adopts a pre-installed
  delegate and freezes it.

### Phase 4: deprecation (S)

- Update `packages/eventual-send/README.md` to document `delegate`
  as the recommended primary surface and `HandledPromise` as a
  back-compat alias.
- Add a changeset describing the new module.
- The `HandledPromise` global remains permitted but documented as
  vestigial.

The first builder dispatch on this design is expected to land Phases 1
and 2 as a single PR, surface any further design gaps, and leave Phases
3 and 4 for a follow-on.

## Open Questions

**OQ1: Should `Promise.delegate` follow the standard's eventual shape
exactly, or is the registered-symbol slot a permanent commitment?**
The forward-compat check (`if (typeof Promise.delegate === 'function')`)
suggests the registered-symbol slot is a transitional mechanism, but
the design does not specify what happens to existing
`Promise[Symbol.for('delegate')]` consumers when the standard ships.
A natural answer: the install path prefers `Promise.delegate` if
present, and consumers that read the slot directly migrate when they
update.
This is consistent with how `@endo/harden` could migrate to a future
standard `Object.harden` if one were proposed.

**OQ2: Can `subscribe` / `settle` (per PR #169 / #170) be added without
a second slot?**
The issue references new `HandledPromise.subscribe` / `settle`
machinery.
If those become additional methods on the same `delegate` function (as
named properties on the function object), they ride for free.
If they require a separate registry (e.g., a per-handler subscribe
table), they may need their own slot.
This design treats them as "additional methods on the same delegate"
and defers any second-slot question.

**OQ3: Should the back-compat `HandledPromise` constructor preserve
`instanceof HandledPromise` checks?**
The proposed back-compat shim returns a plain `Promise` (not a
`HandledPromise` instance) from its constructor body, which would
break `(p instanceof HandledPromise)` checks in legacy code.
A faithful subclass-preserving alternative is more code but smaller
behavioral change.
Recommendation deferred to the builder phase, since the right answer
depends on whether any in-tree consumer uses `instanceof HandledPromise`.

## Prompt

```
Please propose a design for the next generation eventual-send, such
that @endo/eventual-send can be imported before or after lockdown and
work equally well, racing to install the handled promise shim as
described above. Then, hand that design off to a builder to propose a
preliminary implementation PR. I expect the implementation to provide
insight into gaps in the design.

(kriskowal on endojs/endo-but-for-bots#172, 2026-05-10T06:17:57Z)

This has provided useful feedback for the level of detail in the design.
We need to go back to the design and fully specify the proposed
delegate(handler) function as it is different than the HandledPromise
constructor and we also need to review the ways in which this ponyfill
is simpler than harden. We do not need different implementations of
handled promises based on whether we run before or after lockdown. We
need @endo/eventual-send/shim.js to eagerly install
Promise[Symbol.for('delegate')] and for @endo/eventual-send to *lazily*
install the shim, such @endo/eventual-send will respect the delegate
function that was previously installed, or install one itself on
demand, such that all instances of eventual-send share state.

(kriskowal on endojs/endo-but-for-bots#177, 2026-05-10T14:29:23Z)
```
