# Eventual-Send Race-to-Install Shim

| | |
|---|---|
| **Created** | 2026-05-10 |
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

This design proposes the same pattern for `HandledPromise`, anticipating
the TC39 `Promise.delegate` direction.
The chosen slot is `Promise[Symbol.for('delegate')]`.
The chosen ponyfill module is a sibling of the existing
`@endo/eventual-send/shim.js` that returns the registered delegate
regardless of who installed it.

## Background: how `@endo/harden` does this

`@endo/harden` is a useful reference because it is already doing in the
small what this design proposes for `HandledPromise`.

The library's selector ([`packages/harden/make-selector.js`](../packages/harden/make-selector.js))
first reads `Object[Symbol.for('harden')]`.
If a function is found there, it adopts that function as its own `harden`.
If the slot is empty, the selector also checks `globalThis.harden` for
backward compatibility with older SES versions, then falls back to
constructing a local hardener.
When it constructs the local hardener it races to install at the
registered-symbol slot:

```js
Object.defineProperty(Object, symbolForHarden, {
  value: harden,
  configurable: false,
  writable: false,
});
```

Two libraries that both initialize before lockdown each call the selector.
The first call defines the slot non-configurably.
The second call observes the existing function and adopts it.
Either way, every consumer of `@endo/harden` ends up calling the same
function on the same realm.

SES `lockdown()` plays the other side of the race
([`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
lines 369-391).
After collecting intrinsics it reads `Object[Symbol.for('harden')]`.
If a prior `harden` is present, lockdown throws.
The library's pre-installed `harden` carries a `lockdownError` property
(`packages/harden/noop.js` line 14) whose stack points to the first call
site, so the diagnostic blames the right module.
If the slot is empty, lockdown installs its own tamed hardener.

The success of the pattern depends on three properties:

1. The slot is on a primordial (`Object` or `Object.prototype`), which
   means every compartment created from the same realm sees the same slot.
2. The slot key is a `Symbol.for(...)` registered symbol, which the
   library and SES can both name without exchanging values.
3. The first writer wins; the second writer either yields (the library
   case) or aborts (the SES case).

## Design

### The slot: `Promise[Symbol.for('delegate')]`

The registered-symbol slot lives on the `Promise` constructor, not on
`Promise.prototype`.

The constructor is the surface the standard's `Promise.delegate`
proposal targets.
Naming the slot `Promise[Symbol.for('delegate')]` keeps the
forward-compatibility story as straightforward as a future migration:
`if (Promise.delegate) ... else ... Promise[Symbol.for('delegate')]`.

The constructor is also writable by user code on every host runtime
relevant to `@endo/eventual-send` (V8, JSC, SpiderMonkey, XS) before
lockdown.
After lockdown, SES freezes the `Promise` constructor along with the
rest of the permitted intrinsics.
A library that imports the ponyfill **after** lockdown cannot install
into the slot itself; it must rely on lockdown to have installed the
shim during the lockdown phase.
This constraint is symmetric with `@endo/harden` and is discussed under
"Boundary cases" below.

### The shape of the slot's value

`Promise[Symbol.for('delegate')]` holds a single function, the
`HandledPromise` constructor produced by `makeHandledPromise()` in
[`packages/eventual-send/src/handled-promise.js`](../packages/eventual-send/src/handled-promise.js).
That function is itself the carrier for the static methods
(`HandledPromise.applyMethod`, `HandledPromise.resolve`,
`HandledPromise.get`, etc.) that `E()` consumes.

Holding the constructor in the slot (rather than a record like
`{ HandledPromise, makeHandledPromise }`) keeps the migration to a
future `Promise.delegate` mechanical: the standard is expected to expose
a single object on `Promise`, and the ponyfill can detect either shape.

### The ponyfill module

A new module `packages/eventual-send/handled-promise.js` (sibling to
`packages/eventual-send/shim.js`, not the internal
`packages/eventual-send/src/handled-promise.js`) exports a single
function `getHandledPromise()`:

```js
// packages/eventual-send/handled-promise.js
import { makeHandledPromise } from './src/handled-promise.js';

const symbolForDelegate = Symbol.for('delegate');

let cached;

export const getHandledPromise = () => {
  if (cached) return cached;

  // Forward-compatibility hook for the standard Promise.delegate.
  const standardDelegate = Promise.delegate;
  if (typeof standardDelegate === 'function') {
    cached = standardDelegate;
    return cached;
  }

  const installed = Promise[symbolForDelegate];
  if (typeof installed === 'function') {
    cached = installed;
    return cached;
  }
  if (installed !== undefined) {
    throw new TypeError(
      '@endo/eventual-send expected Promise[@delegate] to be a function',
    );
  }

  const fresh = makeHandledPromise();
  // Race to install. defineProperty with configurable:false will throw
  // if a competing library wrote between our read and our write; the
  // catch path then re-reads and adopts the winner.
  try {
    Object.defineProperty(Promise, symbolForDelegate, {
      value: fresh,
      configurable: false,
      writable: false,
    });
    cached = fresh;
  } catch (err) {
    const winner = Promise[symbolForDelegate];
    if (typeof winner !== 'function') throw err;
    cached = winner;
  }
  return cached;
};
```

The cache is module-local so subsequent calls within the same library
instance avoid the property read.
Each module instance has its own cache; they all converge on the same
underlying function via the registered-symbol slot.

The existing `packages/eventual-send/src/E.js` and the static
`HandledPromise` reexport in `packages/eventual-send/index.js` move
behind this ponyfill:

```js
// proposed packages/eventual-send/index.js
import { getHandledPromise } from './handled-promise.js';
import makeE from './src/E.js';

export const HandledPromise = getHandledPromise();
export const E = makeE(HandledPromise);
export * from './src/exports.js';
```

The current `packages/eventual-send/src/no-shim.js`,
`packages/eventual-send/shim.js`, and the `globalThis.HandledPromise`
fallback all become migration aids on the path to retirement.
See "Migration path" below.

### Lockdown integration

SES `lockdown()` should run an analog of its existing `harden`
race-handler ([`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
lines 369-391) for `Promise[Symbol.for('delegate')]`.

Two policies are coherent and should be evaluated against
implementation cost:

**Policy A: yield to a pre-installed shim, freeze otherwise.**
After collecting intrinsics, lockdown reads
`Promise[Symbol.for('delegate')]`.
If a function is present, lockdown adopts it: the slot becomes part of
the frozen intrinsic graph and nothing further is done.
If the slot is empty, lockdown does **not** install a default; the
slot remains empty after lockdown.
Subsequent imports of `@endo/eventual-send` after lockdown will fail
because they cannot install into the now-frozen `Promise`.
This matches `@endo/harden`'s discipline: `harden` is mandatory for
SES, so SES installs it; `HandledPromise` is optional, so SES yields
to whoever wants it.

**Policy B: yield-or-install.**
After collecting intrinsics, lockdown either yields to a pre-installed
function (as in Policy A) or installs SES's own minimal stub.
The stub is just `makeHandledPromise()` from a vendored copy of the
`@endo/eventual-send` source.
This guarantees that post-lockdown imports of `@endo/eventual-send` see
a populated slot and avoid the failure mode in Policy A.
The cost is that SES grows a hard dependency on the eventual-send
implementation.

This design **recommends Policy A**.
`HandledPromise` is not used by SES itself; vendoring an eventual-send
implementation into SES inverts the package layering.
The failure mode in Policy A (a library that imports
`@endo/eventual-send` post-lockdown without anyone having installed
the shim) is loud and easy to diagnose.

The implementation hook in
[`packages/ses/src/lockdown.js`](../packages/ses/src/lockdown.js)
mirrors the harden block:

```js
const symbolForDelegate = symbolFor('delegate');
const priorDelegate = intrinsics.Promise[symbolForDelegate];
if (priorDelegate !== undefined) {
  if (typeof priorDelegate !== 'function') {
    throw new TypeError(
      'Promise[@delegate] must be a function',
    );
  }
  // The ponyfill installed it non-configurably; that's fine, it
  // becomes part of the hardened intrinsic graph.
}
```

The SES permits table in
[`packages/ses/src/permits.js`](../packages/ses/src/permits.js) (the
`Promise` block at lines 1663-1679) gets a new entry for the
registered-symbol slot:

```js
Promise: {
  // ... existing entries ...
  // Slot for the @endo/eventual-send race-installed HandledPromise,
  // anticipating the TC39 Promise.delegate proposal.
  'UniqueSymbol(delegate)': fn,
},
```

The existing `HandledPromise` global (permits.js lines 118 and
1612-1631) becomes deprecated but is not removed in this design.
A subsequent design can prune it once consumers migrate.

### Shared-intrinsic propagation to compartments

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

### Boundary cases

**Two libraries that ship competing implementations.**
First write wins, per the race-to-install discipline.
The second library's `defineProperty` throws because the existing
descriptor is `configurable: false`; the catch path re-reads and adopts
the winner.
Both libraries return the same `HandledPromise` from `getHandledPromise()`.
Identity is preserved.
This is identical to the `@endo/harden` story and inherits its
correctness argument.

**A library that imports the ponyfill before any other shim.**
The ponyfill installs immediately and the slot is taken.
SES `lockdown()` later observes a function in the slot and adopts it
as part of the intrinsic graph.

**A library that imports after lockdown but the slot was never installed.**
The slot lives on the `Promise` constructor, which lockdown has frozen.
The ponyfill's `defineProperty` call will throw `TypeError: Cannot
define property ... object is not extensible` (or the equivalent for a
frozen object).
The catch path re-reads the slot, finds it still empty, and propagates
the original failure to the caller wrapped in a clear error:

```js
catch (err) {
  const winner = Promise[symbolForDelegate];
  if (typeof winner === 'function') {
    cached = winner;
    return cached;
  }
  throw new TypeError(
    'Cannot install @endo/eventual-send: Promise is frozen and ' +
    'Promise[@delegate] was not pre-installed before lockdown. ' +
    'Import @endo/eventual-send (or @endo/init) before calling lockdown(), ' +
    'or use a SES build that installs a default delegate.',
  );
}
```

This is the failure mode Policy A accepts and Policy B rules out.

**A library that uses the existing `globalThis.HandledPromise` shim.**
Existing code that does `import '@endo/eventual-send/shim.js'` continues
to populate `globalThis.HandledPromise` for backward compatibility.
The ponyfill's `getHandledPromise()` does not consult the global; it
goes directly to `Promise[Symbol.for('delegate')]`.
A migration helper in `shim.js` calls `getHandledPromise()` and writes
the result to `globalThis.HandledPromise` so legacy consumers continue
to work.
See "Migration path" below.

**A library that loads from a different realm (iframe, vm.Script).**
The slot is per-realm, so cross-realm code does not share a
`HandledPromise`.
This matches the behavior of every other realm-scoped intrinsic and is
the only safe story; identity across realms is a general unsolved
problem.
`@endo/captp` continues to be the cross-realm bridge.

## Migration path

The migration is staged so existing consumers do not break.

**Stage 1: introduce the ponyfill.**
Add `packages/eventual-send/handled-promise.js` exporting
`getHandledPromise()`.
Existing code paths are untouched.
Existing imports of `@endo/eventual-send` continue to read
`globalThis.HandledPromise`.
Existing imports of `@endo/eventual-send/shim.js` continue to install
the global.
The ponyfill is a new opt-in surface.

**Stage 2: switch the default entry point.**
Change `packages/eventual-send/src/no-shim.js` (the `main` and `.`
export) to call `getHandledPromise()` instead of reading
`globalThis.HandledPromise`.
The `import { HandledPromise, E }` surface continues to work; the
implementation behind it is now the ponyfill.

**Stage 3: deprecate `shim.js`.**
Mark the `./shim.js` subpath export as deprecated in the README.
The shim module itself becomes a thin wrapper that calls
`getHandledPromise()` and additionally writes the result to
`globalThis.HandledPromise` for backward compatibility.

**Stage 4: SES integration.**
Land the lockdown-side hook described above, plus the permits entry
for `Promise[Symbol.for('delegate')]`.
At this point the `HandledPromise` global becomes a vestige; SES still
permits it (per existing permits.js) but does not require it.

**Stage 5: prune the `HandledPromise` global.**
After a deprecation window, remove the `HandledPromise` entry from
`packages/ses/src/permits.js` and remove `packages/eventual-send/shim.js`.
Out of scope for this design; deferred to a follow-up after consumer
migration is observed.

The current public `import { HandledPromise, E } from '@endo/eventual-send'`
surface does not change shape across any of these stages.
`HandledPromise` continues to be a constructor with the same static
methods.
The test suite at `packages/eventual-send/test/` should pass unmodified
through stages 1-3, with a small test addition for the ponyfill's race
behavior.

## Alternatives Considered

**Two separate packages: `@endo/handled-promise` plus `@endo/eventual-send`
consuming it.**
Splitting the ponyfill into its own package would mirror the
`@endo/harden` separation and arguably cleaner package layering.
The cost is an additional package boundary to maintain and version, and
a breaking change to the import surface for every existing consumer of
`@endo/eventual-send`.
Recommendation: defer.
A subpath module (`@endo/eventual-send/handled-promise.js`) gives the
same encapsulation without the package-split overhead, and a future
extraction is mechanical if it becomes valuable.

**An SES-only solution (no ponyfill, lockdown is required).**
SES could install `HandledPromise` unconditionally during lockdown and
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
`HandledPromise` instances since `HandledPromise.prototype ===
Promise.prototype`.
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

**Race-to-install is preferred for the same reasons it succeeds in
`@endo/harden`.**
It is the only pattern that covers all four loading orders
(library-only, lockdown-only, library-then-lockdown,
lockdown-then-library) without requiring application-level
coordination.

## Open Questions

**OQ1: Should `Promise.delegate` follow the standard's eventual shape
exactly, or is the registered-symbol slot a permanent commitment?**
The ponyfill's forward-compatibility check (`if (typeof
Promise.delegate === 'function')`) suggests the registered-symbol slot
is a transitional mechanism, but the design does not specify what
happens to existing `Promise[Symbol.for('delegate')]` consumers when
the standard ships.
A natural answer: the ponyfill prefers `Promise.delegate` if present,
and consumers that read the slot directly migrate when they update.
This is consistent with how `@endo/harden` could migrate to a future
standard `Object.harden` if one were proposed.

**OQ2: Should the ponyfill expose `makeHandledPromise()` in addition
to `getHandledPromise()`?**
Some consumers (notably tests) want a fresh, unregistered
`HandledPromise` for isolation.
The existing `packages/eventual-send/test/_get-hp.js` would benefit.
The ponyfill could re-export `makeHandledPromise` from the internal
module, but doing so muddies the "you always get the realm-shared
delegate" property the slot is supposed to provide.
A cleaner answer: keep `makeHandledPromise` private to the package and
expose a separate test-only `@endo/eventual-send/test-utils.js` (or
similar) for tests that need isolation.

**OQ3: Should SES install a default delegate (Policy B) for
diagnostic-friendliness?**
Policy A's failure mode (post-lockdown import without prior install)
yields a clear error, but the error happens at the call site of
`getHandledPromise()`, not at lockdown.
Policy B would shift the failure earlier and would let `E()` "just
work" in any post-lockdown program.
The cost is that SES grows a vendored `makeHandledPromise`
implementation.
A middle path: SES installs a stub that throws on use with a
diagnostic message pointing at the missing `@endo/eventual-send`
import, and the ponyfill replaces it (with a configurable=true
descriptor on the stub side and a mutual-knowledge convention).
Recommendation deferred to the builder phase, since the right answer
depends on how often the post-lockdown import order arises in
practice.

**OQ4: Can `subscribe` / `settle` (per PR #169 / #170) be added without
a second slot?**
The issue references new `HandledPromise.subscribe` / `settle`
machinery.
If those become additional static methods on the same constructor,
they ride for free.
If they require a separate registry (e.g., a per-handler subscribe
table), they may need their own slot.
This design treats them as "additional methods on the same
constructor" and defers any second-slot question.

**OQ5: Does the ponyfill need to defend against a non-function value
written into the slot by a hostile library?**
The current sketch throws a `TypeError` if `Promise[@delegate]` is
present and not a function.
This is a sufficient defense for the race-to-install discipline:
once installed `configurable: false, writable: false`, the value
cannot be replaced.
A library that writes a non-function before any other library reads
the slot would prevent eventual-send from working at all, but no
worse than today's `globalThis.HandledPromise = "definitely not a
constructor"` attack.

## Test plan

Tests live under `packages/eventual-send/test/` and would extend the
existing fixture set (`hp.test.js`, `e.test.js`, etc.).

**Race-to-install: library-first, then lockdown.**
A test imports `@endo/eventual-send` first (populating
`Promise[@delegate]`), then calls `lockdown()`, then verifies that
`HandledPromise` is the same function the library installed and is
frozen.

**Race-to-install: lockdown-first, then library.**
A test calls `lockdown()` (with a SES build that installs a default
delegate, per the chosen policy), then imports `@endo/eventual-send`,
then verifies that `HandledPromise` is the function lockdown
installed.
If Policy A is adopted instead, the test verifies that the import
fails with a diagnostic error.

**Two competing libraries.**
A test simulates two independent module instances of
`@endo/eventual-send` (via two separate `import()` calls in two
compartments before lockdown), exercises both, and verifies that both
return the same `HandledPromise` identity.

**Cross-compartment identity.**
A test verifies that
`startCompartment.evaluate('Promise[Symbol.for("delegate")]') ===
childCompartment.evaluate('Promise[Symbol.for("delegate")]')`
holds after lockdown.

**Forward-compat for standard `Promise.delegate`.**
A test stubs `Promise.delegate = someFunction` before importing the
ponyfill and verifies that `getHandledPromise()` returns
`someFunction` without consulting the registered-symbol slot.

**Backward-compat for legacy `globalThis.HandledPromise` consumers.**
A test imports `@endo/eventual-send/shim.js` (the deprecated entry
point) and verifies that `globalThis.HandledPromise` is populated and
identity-equal to `Promise[Symbol.for('delegate')]`.

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-text-codecs-shim](hardened-text-codecs-shim.md) | Sibling shim design.  Both add a vetted intrinsic that compartments share; no implementation overlap. |
| [hardened-url-shim](hardened-url-shim.md) | Sibling shim design.  Same mechanical pattern (taming a host-provided constructor), but distinct from the race-to-install pattern proposed here. |

`@endo/harden` is the existing reference implementation of the
race-to-install pattern; it is not a design dependency, but the
implementation will follow its module shape closely.

## Phased implementation

### Phase 1: ponyfill module (S)

- Add `packages/eventual-send/handled-promise.js` exporting
  `getHandledPromise()`.
- Add the `./handled-promise.js` subpath to
  `packages/eventual-send/package.json`'s `exports` field.
- Add unit tests covering the race, the cross-compartment identity,
  and the forward-compat hook.

### Phase 2: switch the default entry (S)

- Update `packages/eventual-send/src/no-shim.js` to call
  `getHandledPromise()`.
- Update `packages/eventual-send/index.js` to consume the ponyfill
  rather than reading `globalThis.HandledPromise`.
- Verify the existing `packages/eventual-send/test/` suite passes
  unmodified.

### Phase 3: SES integration (M)

- Add the lockdown-side hook in
  `packages/ses/src/lockdown.js` mirroring the existing harden block.
- Add the permits entry for `Promise[Symbol.for('delegate')]`.
- Add a SES-side test verifying that lockdown adopts a pre-installed
  delegate and freezes it.

### Phase 4: deprecation (S)

- Update `packages/eventual-send/README.md` to document the ponyfill
  as the recommended entry point and `shim.js` as deprecated.
- Add a changeset describing the new module.
- The `HandledPromise` global remains permitted but documented as
  vestigial.

The builder dispatch on this design is expected to land Phases 1 and 2
as a single PR, surface design gaps, and leave Phases 3 and 4 for a
follow-on.

## Design Decisions

1. **Slot lives on `Promise`, not `Promise.prototype`.**
   The standard's `Promise.delegate` direction targets the constructor.
   Naming the ponyfill slot on the constructor preserves
   forward-compatibility.

2. **Slot is keyed by registered symbol `Symbol.for('delegate')`.**
   The registered-symbol registry is realm-wide and cannot collide
   with future standard property names.
   This matches `@endo/harden`'s discipline.

3. **First writer wins; subsequent writers yield.**
   The slot is installed `configurable: false, writable: false`.
   Competing libraries observe the existing function and adopt it.
   This matches `@endo/harden`'s discipline.

4. **SES yields to a pre-installed shim and does not install a
   default (Policy A).**
   Vendoring eventual-send into SES would invert package layering.
   The post-lockdown failure mode is loud and easy to diagnose.

5. **The ponyfill is a subpath of `@endo/eventual-send`, not a
   separate package.**
   A subpath gives the same encapsulation without the package-split
   overhead.
   A future extraction to `@endo/handled-promise` is mechanical if it
   becomes valuable.

6. **Existing `HandledPromise` global remains permitted during
   migration.**
   The legacy `import '@endo/eventual-send/shim.js'` continues to
   populate `globalThis.HandledPromise` so legacy consumers do not
   break.
   A subsequent design can prune the global once consumers migrate.

## Prompt

```
Please propose a design for the next generation eventual-send, such
that @endo/eventual-send can be imported before or after lockdown and
work equally well, racing to install the handled promise shim as
described above. Then, hand that design off to a builder to propose a
preliminary implementation PR. I expect the implementation to provide
insight into gaps in the design.

(kriskowal on endojs/endo-but-for-bots#172, 2026-05-10T06:17:57Z)
```
