// @ts-check

/**
 * A NON-traversing `harden` for the window between the `ses` shim's evaluation
 * and `lockdown()`, withdrawn again before `lockdown()` sees it.
 *
 * This corpus needs `passStyleOf` and the `@endo/bytes` helpers as globals, and
 * six of its eight cases never call `lockdown()` at all -- so those modules
 * have to load first. They all call `harden()` at module scope, which means
 * something hardens BEFORE `lockdown()`, and that is the one situation
 * `@endo/ironhorse-prelude` deliberately does not decide for its embedders.
 *
 * Three ways to get this wrong. The corpus has been red on all three.
 *
 * 1. Leave `globalThis.harden` ABSENT. `@endo/harden`'s selector takes
 *    `Object[Symbol.for('harden')]`, then `globalThis.harden`, and installs its
 *    own into `Object[@harden]` if neither is there. `repairIntrinsics` then
 *    refuses outright -- "a prior harden implementation has been used and
 *    installed" (`packages/ses/src/lockdown.js:395`). This is how the node host
 *    fails `Symbol.toStringTag-lockdown.js` today.
 * 2. Install a TRAVERSING one, or install one BEFORE the shim is evaluated.
 *    Either way the guest ends up with a hardener that does not traverse, or
 *    with no `lockdown()` at all. `packages/ses/src/make-hardener.js:142-147`
 *    ADOPTS an existing `globalThis.harden`, and `lockdown.js:85` calls that at
 *    MODULE SCOPE -- so an early install hands the shim a hardener it keeps for
 *    the life of the realm, and a traversing one walks from any hardened
 *    function to `Function.prototype`, leaving
 *    `Function.prototype.constructor` `{writable: false, configurable: false}`
 *    where the spec says `configurable: true`, after which
 *    `tame-function-constructors.js` cannot install its inert constructor and
 *    `lockdown()` dies with `invalid descriptor`.
 * 3. Leave it in place across `lockdown()`. The shim collects the start
 *    global's own `harden` as an intrinsic and separately adds its own
 *    (`lockdown.js:355`); `initProperty` (`packages/ses/src/intrinsics.js:39`)
 *    compares the two and throws `Conflicting definitions of harden`. The
 *    branch where this is NOT a conflict is precisely (2) -- where the shim
 *    adopted this very function, so the two are the same object.
 *
 * Hence: install after the shim, and take it back in a `lockdown` wrapper. What
 * the guest is left with afterwards is the shim's own hardener, which
 * traverses.
 *
 * The residue, stated because it is the reason this is a test-harness file and
 * not an engine one: `@endo/harden`'s selector CACHES its choice on first use
 * (`packages/harden/make-selector.js`), so the modules that hardened in this
 * window keep calling the non-traversing hardener afterwards. That is
 * acceptable for a corpus whose lockdown case asserts descriptors rather than
 * transitive freezing, and it is not something the shipped worker inherits --
 * `@endo/thixotrope`'s boot calls `lockdown()` on the line after the shim, with
 * nothing having hardened.
 *
 * Nothing Ironhorse-specific here -- this is the CORPUS's repair, which is why
 * it lives in the test harness rather than in `@endo/ironhorse-prelude`. It is
 * wired into `ironhorse-prelude.js` only; whether any other host wants it is
 * not a question this change answers.
 */

import { makeHardener } from '@endo/harden/make-hardener.js';

// `globalThis` with the HardenedJS conventions TypeScript does not model.
const g = /** @type {any} */ (globalThis);

// `makeHardener` rather than `@endo/harden`'s default export: the default IS
// the selector, and assigning it to `globalThis.harden` would leave it finding
// itself -- the infinite recursion `rust/endo/xsnap/src/polyfills.js:245-247`
// warns about. Assign to `globalThis.harden` ONLY, never `Object[@harden]`,
// which is the slot that poisons `lockdown()` by its mere presence.
const preLockdownHarden = makeHardener({ traversePrototypes: false });
g.harden = preLockdownHarden;

const sesLockdown = g.lockdown;
g.lockdown = (/** @type {unknown} */ options) => {
  // Only ever withdraw OUR stand-in. A case that installed its own `harden`,
  // or a second `lockdown()` call after the first replaced it, must see the
  // shim's own diagnostics rather than a global this file quietly removed.
  if (g.harden === preLockdownHarden) {
    delete g.harden;
  }
  return sesLockdown(options);
};
