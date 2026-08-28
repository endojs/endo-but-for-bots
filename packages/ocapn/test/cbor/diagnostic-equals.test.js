// Regression coverage for `equals`/`diagnosticEquals` byte comparison against
// emulated frozen byteArray passables (issue #573 narrowing). An emulated
// `@endo/immutable-arraybuffer` wrapper is `instanceof Uint8Array` but reports
// `ArrayBuffer.isView === false` and reads `undefined` from `wrapper[i]`; a
// naive `actual instanceof Uint8Array ? actual : new Uint8Array(actual)` then
// integer-indexed comparison collapses distinct wrappers to equal
// (`undefined === undefined`). These tests only pass if the helper thaws the
// wrapper (via `ArrayBuffer.isView`) before comparing.

import test from '@endo/ses-ava/test.js';
import { frozenBytes } from '@endo/immutable-arraybuffer';
import { makeTagged } from '@endo/pass-style';
import { equals, diagnosticEquals } from '../../src/cbor/diagnostic/util.js';

test('equals: distinct emulated byteArrays with different bytes are unequal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const b = frozenBytes(new Uint8Array([1, 2, 4]));
  t.false(equals(a, b));
});

test('equals: distinct emulated byteArrays with equal bytes are equal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const aAgain = frozenBytes(new Uint8Array([1, 2, 3]));
  t.true(equals(a, aAgain));
});

test('equals: emulated byteArray vs genuine Uint8Array', t => {
  const emulated = frozenBytes(new Uint8Array([1, 2, 3]));
  const genuine = new Uint8Array([1, 2, 3]);
  t.true(equals(emulated, genuine));
  t.true(equals(genuine, emulated));
  t.false(equals(emulated, new Uint8Array([1, 2, 4])));
});

test('equals: emulated byteArrays of different lengths are unequal', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const abcd = frozenBytes(new Uint8Array([1, 2, 3, 4]));
  t.false(equals(a, abcd));
});

test('equals: bytes vs non-bytes is unequal, not a throw', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  t.false(equals(a, 3));
  t.false(equals(a, 'abc'));
});

test('equals: genuine ArrayBuffer inputs compare by bytes', t => {
  const a = new Uint8Array([1, 2, 3]).buffer;
  const b = new Uint8Array([1, 2, 3]).buffer;
  const c = new Uint8Array([1, 2, 4]).buffer;
  t.true(equals(a, b));
  t.false(equals(a, c));
});

test('diagnosticEquals alias resolves to the same comparison', t => {
  const a = frozenBytes(new Uint8Array([1, 2, 3]));
  const b = frozenBytes(new Uint8Array([1, 2, 4]));
  t.false(diagnosticEquals(a, b));
  t.true(diagnosticEquals(a, frozenBytes(new Uint8Array([1, 2, 3]))));
});

test('equals: pass-style tagged values compare their payloads', t => {
  const a = makeTagged('example', frozenBytes(new Uint8Array([1, 2, 3])));
  const aAgain = makeTagged('example', frozenBytes(new Uint8Array([1, 2, 3])));
  const differentPayload = makeTagged(
    'example',
    frozenBytes(new Uint8Array([1, 2, 4])),
  );
  t.true(equals(a, aAgain));
  t.false(equals(a, differentPayload));
});
