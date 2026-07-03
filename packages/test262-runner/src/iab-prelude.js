/* global globalThis */
// Prelude for the immutable-arraybuffer property-assignment parity suite.
//
// It installs the @endo/immutable-arraybuffer shim (the shipped plain-object
// freezable-TypedArray emulation) and exposes the alternative Proxy-based
// emulation as a global factory, so a single test262 test source can compare
// the assignment surface of THREE views on the SAME platform (Node and XS):
//   - a genuine (non-emulated) TypedArray,
//   - the shipped plain-object emulated freezable view, and
//   - the Proxy-based emulated freezable view.
//
// No lockdown() here: these tests pin down the raw language-surface behavior of
// integer-indexed / property assignment, which is orthogonal to SES hardening
// and lets the same source run identically on Node and XS.
import '@endo/immutable-arraybuffer/shim.js';
import { makeFreezableIndexRejectingProxy } from '@endo/immutable-arraybuffer/proxy-lib.js';

// Build a Proxy-based emulated freezable view over an emulated immutable
// ArrayBuffer, mirroring what the Proxy pseudo-constructor does internally: the
// hidden genuine TypedArray is constructed over a genuine mutable COPY of the
// immutable buffer's bytes (`.slice(0)`), so the emulation never hands out a
// handle that can write to the caller's immutable buffer.
globalThis.makeFreezableProxyTypedArray = (Ctor, immutableBuffer) => {
  // eslint-disable-next-line no-restricted-globals
  const genuineTA = new Ctor(immutableBuffer.slice(0));
  return makeFreezableIndexRejectingProxy(
    genuineTA,
    immutableBuffer,
    Ctor.prototype,
  );
};
