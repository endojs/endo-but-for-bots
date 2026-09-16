// Ironhorse-specific repairs the SES shim needs, evaluated before it.
//
// These mirror `packages/thixotrope/scripts/bundle-ironhorse-worker.mjs`,
// which is the configuration already shipping on Ironhorse. Each is an engine
// gap rather than a test-harness convenience, and each should disappear as the
// gap closes.

import { makeHardener } from '@endo/harden/make-hardener.js';

// Replace Ironhorse's native `harden` with `@endo/harden`'s, which does not
// traverse prototypes.
//
// Three constraints meet here, and only this arrangement satisfies all three.
//
// 1. Something WILL harden before `lockdown()`. `expose-pass-style-bytes-globals.js`
//    pulls `@endo/pass-style`, `@endo/bytes` and `@endo/immutable-arraybuffer`,
//    all of which call `harden()` at module scope. Six of the corpus's eight
//    cases need those globals and never call `lockdown()`, so the prelude
//    cannot defer them behind it.
// 2. `globalThis.harden` must EXIST when the selector first runs. It takes
//    `Object[Symbol.for('harden')]`, then `globalThis.harden`, and installs its
//    own only if neither is there -- and an installed `Object[@harden]` makes
//    `repairIntrinsics` refuse outright ("a prior harden implementation has
//    been used and installed", `packages/ses/src/lockdown.js:393`). That is how
//    the node host fails this corpus today, and deleting Ironhorse's harden
//    without supplying a replacement reproduces it exactly.
// 3. Whatever hardens must not FREEZE THE INTRINSICS lockdown still has to
//    tame. Ironhorse's native `harden` is a faithful port of XS's
//    `fx_hardenFreezeAndTraverse` and walks prototype chains, so a single
//    `harden({})` leaves `Function.prototype.constructor`
//    `{writable: false, configurable: false}` where the spec says
//    `configurable: true`. `tame-function-constructors.js` then cannot install
//    its inert constructor and `lockdown()` dies with `invalid descriptor`.
//    The rejection is spec-correct; the freeze is the problem.
//
// XS escapes all of this by having a NATIVE `lockdown` (`fx_lockdown`,
// `c/moddable/xs/sources/xsLockdown.c`) that rewires those constructors with
// direct slot writes, below `[[DefineOwnProperty]]`. Ironhorse ported XS's
// harden and not XS's lockdown, so on the shim route the pre-lockdown harden
// has to be the gentler one.
//
// `makeHardener` rather than the package default: the default export is the
// SELECTOR, and assigning it to `globalThis.harden` would leave it finding
// itself -- the infinite recursion `rust/endo/xsnap/src/polyfills.js` warns
// about. Assign to `globalThis.harden` ONLY, never `Object[@harden]`, which is
// the slot that poisons lockdown by its mere presence.
//
// `lockdown()` overwrites `globalThis.harden` with SES's own tamed harden, so
// this one is only ever the PRE-lockdown harden; nothing that runs after a
// case calls `lockdown()` sees it.
globalThis.harden = makeHardener({ traversePrototypes: false });

// Ironhorse advertises every `Iterator.prototype` helper, but the five lazy
// ones — map, filter, take, drop, flatMap — halt the machine with
// `NotImplemented("Iterator.helper")` when called, which `try`/`catch` cannot
// recover. Present the pre-helper iterator profile rather than leave half the
// proposal reachable.
if (globalThis.Iterator) {
  for (const key of Reflect.ownKeys(globalThis.Iterator.prototype)) {
    if (key !== Symbol.iterator) delete globalThis.Iterator.prototype[key];
  }
  // Removing the global is the point, so the cast is the assertion: tsc types
  // `globalThis.Iterator` as always-present.
  /** @type {any} */ (globalThis).Iterator = undefined;
}

// The start realm has no host console. SES expects one even when reporting is
// disabled; diagnostics confer no external I/O capability.
if (!globalThis.console) {
  // A deliberate stub, not a `Console`: SES reads only these six, and
  // supplying the other seventeen would confer diagnostics we do not implement.
  /** @type {any} */ (globalThis).console = {
    log() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
  };
}
