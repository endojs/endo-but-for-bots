/* global globalThis */

import '../index.js';
import './_lockdown-safe.js';
import test from 'ava';

// These tests exercise the vetted-shim treatment of the WHATWG Encoding
// Standard `TextEncoder` and `TextDecoder` constructors on hosts that
// provide them. See designs/hardened-text-codecs-shim.md.

test('TextEncoder and TextDecoder are present on universals', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof TextEncoder'), 'function');
  t.is(c.evaluate('typeof TextDecoder'), 'function');
});

test('text codecs have a single identity across compartments', t => {
  const c = new Compartment();
  t.is(c.globalThis.TextEncoder, globalThis.TextEncoder);
  t.is(c.globalThis.TextDecoder, globalThis.TextDecoder);
  // And the constructor is identical between two post-lockdown compartments.
  const d = new Compartment();
  t.is(c.globalThis.TextEncoder, d.globalThis.TextEncoder);
  t.is(c.globalThis.TextDecoder, d.globalThis.TextDecoder);
});

test('text codecs and their prototypes are frozen', t => {
  t.true(Object.isFrozen(globalThis.TextEncoder));
  t.true(Object.isFrozen(globalThis.TextEncoder.prototype));
  t.true(Object.isFrozen(globalThis.TextDecoder));
  t.true(Object.isFrozen(globalThis.TextDecoder.prototype));
});

test('text codecs round-trip UTF-8 inside a compartment', t => {
  const c = new Compartment();
  t.is(
    c.evaluate(
      'new TextDecoder().decode(new TextEncoder().encode("hello")) === "hello"',
    ),
    true,
  );
  // Multi-byte code points survive the round trip.
  t.is(
    c.evaluate('new TextDecoder().decode(new TextEncoder().encode("☃é한"))'),
    '☃é한',
  );
});

test('text codecs retain their permitted prototype members', t => {
  const c = new Compartment();
  t.is(c.evaluate('typeof TextEncoder.prototype.encode'), 'function');
  t.is(c.evaluate('typeof TextEncoder.prototype.encodeInto'), 'function');
  t.is(c.evaluate('new TextEncoder().encoding'), 'utf-8');
  t.is(c.evaluate('typeof TextDecoder.prototype.decode'), 'function');
  t.is(c.evaluate('new TextDecoder().encoding'), 'utf-8');
  t.is(c.evaluate('new TextDecoder("utf-8", { fatal: true }).fatal'), true);
});
