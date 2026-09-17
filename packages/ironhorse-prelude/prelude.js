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
 * They had drifted on four points before this was extracted: the `Iterator`
 * repair was guarded in one and not the other, the `console` stub likewise, and
 * the `harden` decision differed outright -- which is what made `lockdown()`
 * fail on the corpus while succeeding in the worker.
 *
 * Every repair here is an ENGINE GAP rather than a convenience, and each should
 * disappear as the gap closes. The one that will outlive the others is
 * `harden`: see below.
 *
 * Importing this module has side effects and returns nothing. Import it for
 * effect, before `ses`.
 *
 * # Engine floor
 *
 * Bundling this pulls `@endo/harden` into whatever it is bundled into, and
 * `makeHardener`'s signature is an arrow with a non-simple parameter list:
 *
 *     export const makeHardener = ({ traversePrototypes = false } = {}) => {
 *
 * Ironhorse rejected that shape until `242b339b`
 * (`fix(ironhorse-compile)!: stop an arrow's parameter shape escaping the
 * arrow`), where an arrow's `NOT_SIMPLE_PARAMETERS` leaked into the enclosing
 * scope and made the NEXT `"use strict"` anywhere after it a spurious
 * `invalid directive`. The `ses` bundle opens its functor with `'use strict'`,
 * so on a pre-fix engine a boot carrying this prologue dies at that seam.
 *
 * So an artifact built with this prologue REQUIRES an engine at or after that
 * commit. A stale worker binary against a fresh `dist-ironhorse/boot.js` fails
 * as `boot ...: line NNN: invalid directive`, pointing into a generated file
 * tens of thousands of lines long with nothing to suggest the binary is the
 * problem. If you see that, check the binary's date before anything else.
 */

import { makeHardener } from '@endo/harden/make-hardener.js';

// --- harden -----------------------------------------------------------------
//
// Replace Ironhorse's native `harden` with one that does not traverse
// prototypes. Three constraints meet here and only this satisfies all three.
//
// 1. Something MAY harden before `lockdown()`. The worker happens not to, but
//    any embedder that loads `@endo/pass-style`, `@endo/bytes` or
//    `@endo/immutable-arraybuffer` first does -- they all call `harden()` at
//    module scope -- and the parity corpus is exactly that case.
// 2. `globalThis.harden` must EXIST when `@endo/harden`'s selector first runs.
//    It takes `Object[Symbol.for('harden')]`, then `globalThis.harden`, and
//    installs its own only if neither is there -- and an installed
//    `Object[@harden]` makes `repairIntrinsics` refuse outright ("a prior
//    harden implementation has been used and installed",
//    `packages/ses/src/lockdown.js:393`). Deleting Ironhorse's harden without
//    supplying a replacement reproduces that refusal exactly; it is how the
//    node host fails the same corpus today.
// 3. Whatever hardens must not FREEZE THE INTRINSICS lockdown still has to
//    tame. Ironhorse's native `harden` is a faithful port of XS's
//    `fx_hardenFreezeAndTraverse` and walks prototype chains, so a single
//    `harden({})` leaves `Function.prototype.constructor`
//    `{writable: false, configurable: false}` where the spec says
//    `configurable: true`. `ses/src/tame-function-constructors.js` then cannot
//    install its inert constructor and `lockdown()` dies with `invalid
//    descriptor`. That rejection is spec-correct; the freeze is the problem.
//
// XS escapes all of this by having a NATIVE `lockdown` -- `fx_lockdown`,
// `c/moddable/xs/sources/xsLockdown.c` -- which rewires those constructors with
// direct slot writes, beneath `[[DefineOwnProperty]]`, so a frozen
// `Function.prototype` never obstructs it. Ironhorse ported XS's `harden` and
// not its `lockdown`; a native `lockdown` is future work, and until it lands
// the shim route is the SES profile and this prologue is its preparation.
//
// `makeHardener` rather than `@endo/harden`'s default export: the default IS
// the selector, and assigning it to `globalThis.harden` would leave it finding
// itself -- the infinite recursion `rust/endo/xsnap/src/polyfills.js` warns
// about. Assign to `globalThis.harden` ONLY, never `Object[@harden]`, which is
// the slot that poisons lockdown by its mere presence.
//
// `lockdown()` replaces `globalThis.harden` with SES's own tamed harden, which
// does traverse prototypes. This one is only ever the PRE-lockdown harden.
globalThis.harden = makeHardener({ traversePrototypes: false });

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
