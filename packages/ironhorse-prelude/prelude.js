// @ts-check

/**
 * The Ironhorse SES prologue: everything that must happen to an Ironhorse start
 * realm before the `ses` shim is evaluated, in one place.
 *
 * It belongs to the engine, not to any one embedder: every repair here
 * compensates for something `rust/engine/ironhorse-vm` does or does not do yet.
 * Both consumers import it, so there is one answer rather than two that drift:
 *
 * - `@endo/thixotrope`'s `scripts/bundle-ironhorse-worker.mjs` bundles it into
 *   `dist-ironhorse/boot.js`, the environment the Ironhorse worker ships.
 * - `@endo/test262-runner`'s `src/ironhorse-pre-shim.js` imports it, so the
 *   `ses-xs-parity` corpus measures that same environment rather than a
 *   look-alike.
 *
 * They had drifted on three points before this was extracted: the `Iterator`
 * repair was guarded in one and not the other, the `console` stub likewise, and
 * the `harden` decision differed outright -- which is what made `lockdown()`
 * fail on the corpus while succeeding in the worker.
 *
 * Every repair here is an ENGINE GAP rather than a convenience, and each should
 * disappear as the gap closes.
 *
 * Importing this module has side effects and returns nothing. Import it for
 * effect, before `ses`.
 *
 * # Engine floor
 *
 * This is consumed as a BUNDLE -- `@endo/thixotrope`'s
 * `scripts/bundle-ironhorse-worker.mjs` and `@endo/test262-runner`'s
 * `scripts/generate-preludes.js` both run it through
 * `@endo/compartment-mapper`'s `makeBundle` -- and every such bundle carries
 * the mapper's own runtime, whose cell constructor is an arrow with a
 * non-simple parameter list:
 *
 *     const cell = (name, value = undefined) => {
 *
 * Ironhorse mishandled that shape until `242b339b`
 * (`fix(ironhorse-compile)!: stop an arrow's parameter shape escaping the
 * arrow`), where an arrow's `NOT_SIMPLE_PARAMETERS` leaked into the enclosing
 * scope and made the NEXT `"use strict"` anywhere after it a spurious
 * `invalid directive`. The arrow itself was always accepted; it was the later
 * directive that failed. In `dist-ironhorse/boot.js` the two are two lines
 * apart -- this bundle ends `])();`, the `ses` bundle opens
 * `(functors => options => {`, and its `'use strict';` is the next line -- so
 * on a pre-fix engine a boot carrying this prologue dies at that seam.
 *
 * Nothing in this file's own source has that shape, and removing what did (the
 * `@endo/harden` import) does not lift the floor: the mapper's runtime is
 * unconditional. An artifact built with this prologue REQUIRES an engine at or
 * after that commit. A stale worker binary against a fresh
 * `dist-ironhorse/boot.js` fails as `boot ...: line NNN: invalid directive`,
 * pointing into a generated file tens of thousands of lines long with nothing
 * to suggest the binary is the problem. If you see that, check the binary's
 * date before anything else.
 */

// --- harden -----------------------------------------------------------------
//
// Remove Ironhorse's native `harden` so the `ses` shim builds its own.
//
// Leaving it in place is not the cheap win it looks like, because `ses` ADOPTS
// whatever it finds: `makeHardener()` returns `globalThis.harden` when one is
// already there (`packages/ses/src/make-hardener.js:142-147`), and
// `packages/ses/src/lockdown.js:85` calls that at MODULE SCOPE. So whatever is
// at `globalThis.harden` when the shim is EVALUATED -- not when `lockdown()` is
// called -- becomes the guest's `harden` for the life of the realm: it is what
// `tameHarden` wraps (`lockdown.js:354`), what `Object[Symbol.for('harden')]`
// is set to (`:398`), and what `lockdown()` puts back on `globalThis.harden`.
// `lockdown()` does not replace it.
//
// Two requirements follow, and they pull in opposite directions.
//
// 1. Whatever hardens BEFORE `lockdown()` must not freeze the intrinsics
//    lockdown still has to tame. Ironhorse's native `harden` is a faithful port
//    of XS's `fx_hardenFreezeAndTraverse` and walks prototype chains, so a
//    single `harden({})` leaves `Function.prototype.constructor`
//    `{writable: false, configurable: false}` where the spec says
//    `configurable: true`. `ses/src/tame-function-constructors.js` then cannot
//    install its inert constructor and `lockdown()` dies with `invalid
//    descriptor`. That rejection is spec-correct; the freeze is the problem.
// 2. Whatever hardens AFTER `lockdown()` must traverse prototypes, or `harden`
//    is not doing its job. A guest that hands out `harden(obj)` whose prototype
//    is still extensible has handed out an object whose methods anyone holding
//    that prototype can still replace.
//
// Deleting satisfies (2) -- the shim's own hardener traverses
// (`make-hardener.js`'s `baseFreezeAndTraverse` enqueues `getPrototypeOf(obj)`)
// -- and leaves (1) to the embedder, which is the right split: only the
// embedder knows whether anything of its own hardens before it locks down.
// Nothing in this realm does before `ses` is evaluated, and the worker's boot
// calls `lockdown()` on the line after the shim.
//
// An embedder that DOES harden before `lockdown()` -- anything loading
// `@endo/pass-style`, `@endo/bytes` or `@endo/immutable-arraybuffer` first,
// which all call `harden()` at module scope -- must install a NON-traversing
// hardener of its own, AFTER the shim is evaluated (so the shim keeps its own)
// and before that module loads. It cannot simply leave `globalThis.harden`
// absent: `@endo/harden`'s selector takes `Object[Symbol.for('harden')]`, then
// `globalThis.harden`, and installs its own into `Object[@harden]` if neither
// is there -- which makes `repairIntrinsics` refuse outright ("a prior harden
// implementation has been used and installed",
// `packages/ses/src/lockdown.js:395`). That is how the node host fails the
// `ses-xs-parity` corpus today, and how Ironhorse would fail it without
// `packages/test262-runner/src/install-pre-lockdown-harden.js`.
//
// XS escapes all of this by having a NATIVE `lockdown` -- `fx_lockdown`,
// `c/moddable/xs/sources/xsLockdown.c` -- which rewires those constructors with
// direct slot writes, beneath `[[DefineOwnProperty]]`, so a frozen
// `Function.prototype` never obstructs it. Ironhorse ported XS's `harden`
// first and its `lockdown` since -- `fx_lockdown` steps 1, 2 and 5 -- but not
// a guest `Compartment`, which the shim supplies alongside `lockdown`. So the
// shim route is still the SES profile and this prologue is its preparation.
//
// The cast is the assertion, as in the `Iterator` block below: `harden` is a
// HardenedJS convention rather than a global TypeScript knows about.
delete (/** @type {any} */ (globalThis).harden);

// --- Iterator ---------------------------------------------------------------
//
// Ironhorse advertises every `Iterator.prototype` helper, but the five lazy
// ones -- map, filter, take, drop, flatMap -- halt the machine with
// `NotImplemented("Iterator.helper")` when called, which `try`/`catch` cannot
// recover. Present the pre-helper iterator profile, including the shared
// prototype, rather than leave half the proposal reachable through iterator
// instances.
//
// Guarded, because a realm without `Iterator` is a realm this has nothing to do
// to; the unguarded form threw there.
if (globalThis.Iterator) {
  for (const key of Reflect.ownKeys(globalThis.Iterator.prototype)) {
    if (key !== Symbol.iterator) delete globalThis.Iterator.prototype[key];
  }
  // Removing the global is the point, so the cast is the assertion: tsc types
  // `globalThis.Iterator` as always-present.
  /** @type {any} */ (globalThis).Iterator = undefined;
}

// --- console ----------------------------------------------------------------
//
// The start realm has no host console. SES expects one even when reporting is
// disabled; diagnostics confer no external I/O capability.
//
// UNCONDITIONAL, deliberately. The guest must not reach a host console if one
// ever appears: installing only when absent would hand it straight through.
//
// The whole permitted surface rather than the handful SES is observed to call.
// SES WRAPS a base console rather than replacing it, so a missing method is a
// `TypeError` at the moment something reaches for it -- and not only when the
// guest asks. `packages/ses/src/error/console.js:434` calls
// `baseConsole.group(label)` UNGUARDED while rendering nested errors, which is
// any `console.error` on an error with a `cause`, on an `AggregateError`, or
// with two error arguments; `baseConsole.assert` (`:536`) and
// `baseConsole.timeLog` (`:550`) are likewise unguarded. `console.js:140`
// enumerates the surface as `consoleLevelMethods` (9) + `consoleSpecialMethods`
// (2) + `consoleOtherMethods` (11). These are all no-ops, so the extra names
// confer nothing; what they buy is that nothing here has to track which call
// sites inside SES happen to be guarded today.
const consoleNoop = () => {};
/** @type {any} */ (globalThis).console = {
  // consoleLevelMethods
  debug: consoleNoop,
  log: consoleNoop,
  info: consoleNoop,
  warn: consoleNoop,
  error: consoleNoop,
  trace: consoleNoop,
  dirxml: consoleNoop,
  group: consoleNoop,
  groupCollapsed: consoleNoop,
  // consoleSpecialMethods
  assert: consoleNoop,
  timeLog: consoleNoop,
  // consoleOtherMethods
  clear: consoleNoop,
  count: consoleNoop,
  countReset: consoleNoop,
  dir: consoleNoop,
  groupEnd: consoleNoop,
  table: consoleNoop,
  time: consoleNoop,
  timeEnd: consoleNoop,
  profile: consoleNoop,
  profileEnd: consoleNoop,
  timeStamp: consoleNoop,
};
