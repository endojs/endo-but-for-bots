// @ts-nocheck
// Tests for the `frozenBytes` / `thawedBytes` byte utilities exported from
// the package's main entry point. They pair with the shim (which the module
// installs as a side effect of importing it).
import test from 'ava';
import { frozenBytes, thawedBytes } from '../index.js';

const { isFrozen } = Object;

test('frozenBytes: wraps a view in a frozen Uint8Array on an immutable buffer', t => {
  const view = new Uint8Array([1, 2, 3, 4, 5]);
  const frozen = frozenBytes(view);
  t.true(frozen instanceof Uint8Array);
  t.is(frozen.byteLength, 5);
  t.true(frozen.buffer instanceof ArrayBuffer);
  t.true(frozen.buffer.immutable);
  t.true(isFrozen(frozen));
  t.deepEqual([...thawedBytes(frozen)], [1, 2, 3, 4, 5]);
});

test('frozenBytes: honors subarray byteOffset and byteLength', t => {
  const full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const window = full.subarray(2, 6); // [2, 3, 4, 5]
  const frozen = frozenBytes(window);
  t.is(frozen.byteLength, 4);
  // The frozen wrapper spans its whole backing buffer one-to-one.
  t.is(frozen.byteOffset, 0);
  t.is(frozen.byteLength, frozen.buffer.byteLength);
  t.deepEqual([...thawedBytes(frozen)], [2, 3, 4, 5]);
});

test('frozenBytes: empty input', t => {
  const frozen = frozenBytes(new Uint8Array(0));
  t.is(frozen.byteLength, 0);
  t.true(frozen.buffer.immutable);
});

test('frozenBytes: isView distinguishes the emulated wrapper shape', t => {
  const frozen = frozenBytes(new Uint8Array([1]));
  t.false(ArrayBuffer.isView(frozen));
  t.true(ArrayBuffer.isView(new Uint8Array([1])));
});

test('thawedBytes: returns a fresh mutable copy of a frozen value', t => {
  const source = new Uint8Array([0, 1, 2, 0xff, 0x80, 0x00, 42, 100]);
  const frozen = frozenBytes(source);
  const mutable = thawedBytes(frozen);
  t.true(mutable instanceof Uint8Array);
  t.false(isFrozen(mutable));
  t.deepEqual([...mutable], [...source]);
  // Mutating the copy does not affect the frozen original.
  mutable[0] = 99;
  t.deepEqual([...thawedBytes(frozen)], [...source]);
});

test('thawedBytes: accepts a genuine mutable Uint8Array view', t => {
  const view = new Uint8Array([9, 8, 7]);
  const copy = thawedBytes(view);
  t.not(copy, view);
  t.deepEqual([...copy], [9, 8, 7]);
});

test('frozenBytes and thawedBytes are hardened', t => {
  t.true(isFrozen(frozenBytes));
  t.true(isFrozen(thawedBytes));
});
