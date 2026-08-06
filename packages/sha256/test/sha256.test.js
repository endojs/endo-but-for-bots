// @ts-nocheck

import 'ses';

import { createHash } from 'node:crypto';

import test from 'ava';

import { sha256, sha256Into } from '../src/sha256-node.js';
import * as browser from '../src/sha256-browser.js';
import { sha256Vectors } from './_vectors.js';

const bytes = text => new TextEncoder().encode(text);
const expected = value =>
  new Uint8Array(createHash('sha256').update(value).digest());
const fromHex = hex =>
  Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));

// Cross-check the Node and browser paths against the shared known-answer
// fixture that the XS spot check (test/_xs.js) also consumes, so all three
// implementations are held to one canonical set of vectors.
for (const [text, want] of sha256Vectors) {
  test(`node and browser match the shared vector for ${JSON.stringify(text)}`, t => {
    const wantBytes = fromHex(want);
    t.deepEqual(sha256(bytes(text)), wantBytes);
    t.deepEqual(browser.sha256(bytes(text)), wantBytes);
  });
}

for (const value of [
  new Uint8Array(),
  bytes('abc'),
  ...[55, 56, 63, 64, 65].map(length =>
    Uint8Array.from({ length }, (_, index) => index),
  ),
  Uint8Array.from({ length: 256 }, (_, i) => i),
]) {
  test(`node and browser match node:crypto for ${value.length} bytes`, t => {
    t.deepEqual(sha256(value), expected(value));
    t.deepEqual(browser.sha256(value), expected(value));
  });
}

test('node and browser sha256Into write at their requested offsets', t => {
  for (const implementation of [
    { name: 'node', sha256Into },
    { name: 'browser', sha256Into: browser.sha256Into },
  ]) {
    const output = new Uint8Array(40).fill(0xff);
    t.is(implementation.sha256Into(output, bytes('abc'), 4), 32);
    t.deepEqual(output.slice(4, 36), expected(bytes('abc')));
    t.deepEqual(output.slice(0, 4), new Uint8Array(4).fill(0xff));
    t.deepEqual(output.slice(36), new Uint8Array(4).fill(0xff));
  }
});

test('sha256Into ignores an output buffer’s own set property', t => {
  for (const implementation of [
    { name: 'node', sha256Into },
    { name: 'browser', sha256Into: browser.sha256Into },
  ]) {
    const output = new Uint8Array(32);
    output.set = () => {
      throw Error('caller-controlled set was invoked');
    };
    t.is(implementation.sha256Into(output, bytes('abc')), 32);
    t.deepEqual(output.slice(), expected(bytes('abc')));
  }
});

test('node and browser validate byte arguments and output capacity', t => {
  for (const implementation of [
    { name: 'node', sha256, sha256Into },
    { name: 'browser', ...browser },
  ]) {
    // @ts-expect-error exercising the runtime contract
    t.throws(() => implementation.sha256('abc'), { instanceOf: TypeError });
    // @ts-expect-error exercising the runtime contract
    t.throws(() => implementation.sha256Into([], bytes('abc')), {
      instanceOf: TypeError,
    });
    t.throws(
      () => implementation.sha256Into(new Uint8Array(31), bytes('abc')),
      {
        instanceOf: RangeError,
      },
    );
    for (const offset of [-1, 0.5, NaN, Infinity]) {
      t.throws(
        () =>
          implementation.sha256Into(new Uint8Array(32), bytes('abc'), offset),
        { instanceOf: RangeError },
      );
    }
  }
});

test.serial(
  'XS implementation composes binary-safe streaming host calls',
  async t => {
    let nextHandle = 0;
    /** @type {Map<number, Uint8Array[]>} */
    const chunks = new Map();
    globalThis.hostSha256Init = () => {
      nextHandle += 1;
      chunks.set(nextHandle, []);
      return nextHandle;
    };
    globalThis.hostSha256UpdateBytes = (handle, value) =>
      chunks.get(handle).push(value);
    globalThis.hostSha256Finish = handle => {
      const values = chunks.get(handle);
      const length = values.reduce((total, value) => total + value.length, 0);
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const value of values) {
        joined.set(value, offset);
        offset += value.length;
      }
      return Buffer.from(expected(joined)).toString('hex');
    };
    const xs = await import(
      new URL('../src/sha256-xs.js', import.meta.url).href
    );
    const value = Uint8Array.of(0, 0x80, 0xff);
    t.deepEqual(xs.sha256(value), expected(value));
    t.deepEqual(chunks.get(1), [value]);
    const output = new Uint8Array(40).fill(0xff);
    t.is(xs.sha256Into(output, value, 4), 32);
    t.deepEqual(output.slice(4, 36), expected(value));
    t.deepEqual(output.slice(0, 4), new Uint8Array(4).fill(0xff));
    t.deepEqual(output.slice(36), new Uint8Array(4).fill(0xff));
    // @ts-expect-error exercising the runtime contract
    t.throws(() => xs.sha256('abc'), { instanceOf: TypeError });
    // @ts-expect-error exercising the runtime contract
    t.throws(() => xs.sha256Into([], value), { instanceOf: TypeError });
    t.throws(() => xs.sha256Into(new Uint8Array(31), value), {
      instanceOf: RangeError,
    });
    for (const offset of [-1, 0.5, NaN, Infinity]) {
      t.throws(() => xs.sha256Into(new Uint8Array(32), value, offset), {
        instanceOf: RangeError,
      });
    }
  },
);

test.serial(
  'XS implementation falls back to the browser path without host hooks',
  async t => {
    delete globalThis.hostSha256Init;
    delete globalThis.hostSha256UpdateBytes;
    delete globalThis.hostSha256Finish;
    const xs = await import(
      `${new URL('../src/sha256-xs.js', import.meta.url).href}?legacy`
    );
    const value = bytes('abc');
    t.deepEqual(xs.sha256(value), expected(value));
  },
);
