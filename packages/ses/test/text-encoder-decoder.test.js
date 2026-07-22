/* eslint-disable no-restricted-globals */
/* global globalThis */
import test from 'ava';
import '../index.js';

// Ensure TextEncoder/TextDecoder are available on the global (Node.js host).
const hasTextCodecs =
  typeof TextEncoder === 'function' && typeof TextDecoder === 'function';

lockdown();

// ---------------------------------------------------------------------------
// 1. Presence on universals
// ---------------------------------------------------------------------------

test('TextEncoder is present in post-lockdown compartments', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate('typeof TextEncoder'),
    'function',
    'TextEncoder is a function',
  );
});

test('TextDecoder is present in post-lockdown compartments', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate('typeof TextDecoder'),
    'function',
    'TextDecoder is a function',
  );
});

// ---------------------------------------------------------------------------
// 2. Identity across compartments
// ---------------------------------------------------------------------------

test('TextEncoder identity matches across compartments', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const startTE = globalThis.TextEncoder;
  const c = new Compartment();
  const compartmentTE = c.evaluate('TextEncoder');
  t.is(
    compartmentTE,
    startTE,
    'TextEncoder is identity-equal across compartments',
  );
});

test('TextDecoder identity matches across compartments', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const startTD = globalThis.TextDecoder;
  const c = new Compartment();
  const compartmentTD = c.evaluate('TextDecoder');
  t.is(
    compartmentTD,
    startTD,
    'TextDecoder is identity-equal across compartments',
  );
});

// ---------------------------------------------------------------------------
// 3. Frozen
// ---------------------------------------------------------------------------

test('TextEncoder constructor is frozen', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  t.truthy(Object.isFrozen(TextEncoder), 'TextEncoder itself is frozen');
});

test('TextEncoder.prototype is frozen', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  t.truthy(
    Object.isFrozen(TextEncoder.prototype),
    'TextEncoder.prototype is frozen',
  );
});

test('TextDecoder constructor is frozen', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  t.truthy(Object.isFrozen(TextDecoder), 'TextDecoder itself is frozen');
});

test('TextDecoder.prototype is frozen', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  t.truthy(
    Object.isFrozen(TextDecoder.prototype),
    'TextDecoder.prototype is frozen',
  );
});

// ---------------------------------------------------------------------------
// 4. Round-trip semantics preserved
// ---------------------------------------------------------------------------

test('encode then decode round-trips correctly', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode('hello world');
  t.is(typeof bytes, 'object', 'encode returns an object (Uint8Array)');
  t.is(decoder.decode(bytes), 'hello world', 'round-trip preserves text');
});

test('TextEncoder.encoding is utf-8', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const encoder = new TextEncoder();
  t.is(encoder.encoding, 'utf-8', 'TextEncoder.encoding is always utf-8');
});

test('encodeInto works correctly', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const encoder = new TextEncoder();
  const str = 'hello';
  const buffer = new Uint8Array(str.length);
  const result = encoder.encodeInto(str, buffer);
  t.is(result.read, str.length, 'encodeInto reads all characters');
  t.is(result.written, str.length, 'encodeInto writes all bytes');
});

test('TextDecoder with default options works', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const decoder = new TextDecoder();
  t.is(decoder.encoding, 'utf-8', 'default encoding is utf-8');
  t.false(decoder.fatal, 'default fatal is false');
  t.false(decoder.ignoreBOM, 'default ignoreBOM is false');
});

test('TextDecoder with explicit options works', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  t.is(decoder.encoding, 'utf-8', 'encoding is utf-8');
  t.truthy(decoder.fatal, 'fatal is true when specified');
  t.false(decoder.ignoreBOM, 'ignoreBOM is false');
});

// ---------------------------------------------------------------------------
// 5. Degradation: host without the codecs
// ---------------------------------------------------------------------------
//
// The degradation path — a host that never provided TextEncoder/TextDecoder,
// so lockdown's intrinsics-collection pass never sampled them — cannot be
// simulated from a post-lockdown Compartment: universal intrinsics are added
// to every compartment regardless of its `globalNames`. It is exercised in a
// dedicated worker that deletes the globals before `lockdown()`, in
// text-encoder-decoder-missing.test.js (mirroring url-shim-missing.test.js).

// ---------------------------------------------------------------------------
// 6. No prototype pollution — ensure codecs are not iterable
// ---------------------------------------------------------------------------

test('TextEncoder has no iterator prototype exposed', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate('typeof TextEncoder[Symbol.iterator]'),
    'undefined',
    'TextEncoder has no Symbol.iterator',
  );
});

test('TextDecoder has no iterator prototype exposed', t => {
  if (!hasTextCodecs) {
    t.pass('skipped: host does not provide TextEncoder/TextDecoder');
    return;
  }
  const c = new Compartment();
  t.is(
    c.evaluate('typeof TextDecoder[Symbol.iterator]'),
    'undefined',
    'TextDecoder has no Symbol.iterator',
  );
});
