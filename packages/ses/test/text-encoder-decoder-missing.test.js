// @ts-nocheck
/* global globalThis */

// Exercises the degradation path: when the host does not provide `TextEncoder`
// and `TextDecoder`, `lockdown()` must proceed without them and post-lockdown
// compartments must observe their absence. This mirrors the behavior on XS,
// where neither is part of the host realm.
//
// This must live in its own test file (AVA runs each file in its own worker)
// because the absence has to be established *before* `lockdown()` samples the
// host intrinsics — it cannot be simulated from a post-lockdown compartment,
// since universal intrinsics are installed on every compartment regardless of
// its `globalNames`.

import '../index.js';
import test from 'ava';

const savedTextEncoder = globalThis.TextEncoder;
const savedTextDecoder = globalThis.TextDecoder;

// Delete before lockdown so the intrinsics-collection pass sees a host without
// them.
delete globalThis.TextEncoder;
delete globalThis.TextDecoder;

lockdown();

test('lockdown succeeds on a host without TextEncoder/TextDecoder', t => {
  t.is(globalThis.TextEncoder, undefined);
  t.is(globalThis.TextDecoder, undefined);
});

test('compartments observe the absence after lockdown', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof TextEncoder'), 'undefined');
  t.is(c.evaluate('typeof TextDecoder'), 'undefined');
});

test.after.always(() => {
  // Restore for any subsequent in-process work (defensive; AVA runs each
  // test file in its own worker so this is belt-and-suspenders).
  if (savedTextEncoder) {
    Object.defineProperty(globalThis, 'TextEncoder', {
      value: savedTextEncoder,
      writable: true,
      configurable: true,
    });
  }
  if (savedTextDecoder) {
    Object.defineProperty(globalThis, 'TextDecoder', {
      value: savedTextDecoder,
      writable: true,
      configurable: true,
    });
  }
});
