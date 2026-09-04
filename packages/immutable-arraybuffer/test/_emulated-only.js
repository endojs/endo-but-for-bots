// Test helper: detect whether the freezable-TypedArray emulation is active.
//
// The shim installs under a stage-3 detect-then-skip policy (see
// `src/shim.js`): on an engine that already ships a native Immutable
// ArrayBuffer implementation — current XS does — `sliceToImmutable` is already
// present, the shim steps aside, and `new Uint8Array(iab)` is a GENUINE
// integer-indexed view rather than the emulated plain-object wrapper.
//
// On such a native engine the emulated-wrapper fidelity observations do NOT
// hold, because there is no emulated wrapper to observe:
//   - `ArrayBuffer.isView(view)` is `true`, not `false`;
//   - `view[i]` reads the underlying byte, not `undefined`;
//   - `Object.prototype.toString.call(view)` reads `'[object Uint8Array]'`,
//     and an immutable buffer reads `'[object ArrayBuffer]'`, not the shim's
//     `'[object Object]'` / `'[object emulated immutable ArrayBuffer]'` departures;
//   - an indexed assignment does not create an own OrdinarySet shadow.
//
// Tests that assert those emulated-only shapes therefore describe the shim
// path specifically and have nothing to check on a native engine. Gate them
// with `emulatedOnlyTest` so they run under the shim and skip under native,
// rather than baking in the (now obsolete) assumption that no engine ships
// native support. See endojs/endo-but-for-bots#475 (erights review).
//
// A file that uses this helper must `import '../src/shim.js'` first, so
// `sliceToImmutable` is guaranteed present (native or shim) before detection.
import test from 'ava';

/**
 * True when `@endo/immutable-arraybuffer` is providing the emulated
 * freezable-TypedArray wrapper (i.e. no native implementation is present).
 */
export const emulationActive = !ArrayBuffer.isView(
  new Uint8Array(new ArrayBuffer(0).sliceToImmutable()),
);

/**
 * `test` when the emulation is active, `test.skip` otherwise. Use for
 * assertions that describe the emulated plain-object wrapper specifically and
 * so have nothing to observe on a native immutable-ArrayBuffer engine.
 */
export const emulatedOnlyTest = emulationActive ? test : test.skip;
