// Ironhorse-specific repairs the SES shim needs, evaluated before it.
//
// These mirror `packages/thixotrope/scripts/bundle-ironhorse-worker.mjs`,
// which is the configuration already shipping on Ironhorse. Each is an engine
// gap rather than a test-harness convenience, and each should disappear as the
// gap closes.

// Ironhorse's own `harden` (`create_hardened_globals`) is deliberately LEFT
// ALONE. `@endo/harden`'s selector takes `Object[Symbol.for('harden')]` first
// and `globalThis.harden` second, and installs its own only if neither
// exists -- and an installed `Object[@harden]` makes SES's `repairIntrinsics`
// refuse ("a prior harden implementation has been used and installed",
// `packages/ses/src/lockdown.js:393`). So deleting Ironhorse's native harden
// is what BREAKS lockdown here, not what enables it. XS relies on the same
// adoption: `xst` installs its native `harden` and the selector takes it.
//
// `packages/thixotrope/scripts/bundle-ironhorse-worker.mjs` does delete it,
// because there `polyfills.js` has already replaced it with a deep-freeze
// shim; this prelude omits that section of `polyfills.js` entirely.

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
