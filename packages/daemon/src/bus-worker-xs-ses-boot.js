// @ts-nocheck — XS-bundled boot script, no type-check needed.

// Entry point for the ses_boot.js bundle that the Rust XS runtime
// evaluates after polyfills and before either the daemon or the
// worker bootstrap.  Brings in the SES-adjacent runtime shims that
// the daemon/worker rely on but that XS does not ship natively:
//
//   - `@endo/harden` installs `globalThis.harden`.
//   - `@endo/eventual-send/shim.js` installs `globalThis.HandledPromise`
//     (and registers the eventual-send handler API that `E(...)` uses).
//
// `ses` itself is not bundled here — the Rust supervisor evaluates a
// separate SES lockdown bundle at startup.  Anything ses-shaped that
// must run *after* lockdown but *before* the bootstrap modules goes
// in here.

import '@endo/harden';
import '@endo/eventual-send/shim.js';

// Install HandledPromise shim needed by E() and CapTP.
// This MUST come after assert and harden are on globalThis.
