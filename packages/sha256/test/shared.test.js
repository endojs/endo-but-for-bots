// @ts-check

// The guards in `shared.js` are what make one contract out of four
// implementations. Each is exercised here directly, because a guard
// only the happy path reaches is a guard that can be deleted without
// reddening anything.

import { createHash } from 'node:crypto';

import test from 'ava';

import {
  DIGEST_LENGTH,
  assertBytes,
  assertDigest,
  byteLengthOf,
  makeSha256Into,
} from '../src/shared.js';
import { jsSha256 } from '../src/sha256-js.js';
import { sha256 as nodeSha256 } from '../src/sha256-node.js';

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

test('makeSha256Into refuses a backing that returns a short digest', t => {
  // Without this check the caller gets 16 digest bytes followed by 16
  // stale ones, behind a return value of 32.
  const sha256Into = makeSha256Into(() => new Uint8Array(16));
  const out = new Uint8Array(DIGEST_LENGTH).fill(0xaa);
  t.throws(() => sha256Into(out, new Uint8Array(1)), {
    message: /expected a 32-byte digest/,
  });
  t.deepEqual(
    out,
    new Uint8Array(DIGEST_LENGTH).fill(0xaa),
    'the destination is untouched',
  );
});

test('makeSha256Into refuses a backing that returns a non-digest', t => {
  for (const bad of [new Uint8Array(64), 'abc', 32, undefined]) {
    const sha256Into = makeSha256Into(() => /** @type {any} */ (bad));
    t.throws(
      () => sha256Into(new Uint8Array(DIGEST_LENGTH), new Uint8Array(1)),
      {
        message: /expected a 32-byte digest/,
      },
    );
  }
});

test('assertDigest accepts exactly a 32-byte Uint8Array', t => {
  const digest = new Uint8Array(DIGEST_LENGTH);
  t.is(assertDigest(digest, 'test'), digest);
});

test('assertBytes rejects a Proxy over a Uint8Array', t => {
  // `instanceof` passes for a proxy, and a trap answering a different
  // length to each read would otherwise produce a wrong digest rather
  // than an error: an attacker-chosen content address.
  const target = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let reads = 0;
  const proxy = new Proxy(target, {
    get(t2, key, receiver) {
      if (key === 'length') {
        reads += 1;
        return reads === 1 ? 8 : 0;
      }
      return Reflect.get(t2, key, receiver);
    },
  });
  t.throws(() => assertBytes(proxy, 'bytes'), { instanceOf: TypeError });
  t.throws(() => jsSha256(/** @type {any} */ (proxy)), {
    instanceOf: TypeError,
  });
  t.throws(() => nodeSha256(/** @type {any} */ (proxy)), {
    instanceOf: TypeError,
  });
});

test('a subclass lying about its length digests its real bytes', t => {
  // `%TypedArray%.prototype.set` copies from the internal slot while a
  // subclass's own `length` says otherwise, so reading the length any
  // other way pads one length and hashes another.
  class Liar extends Uint8Array {
    // eslint-disable-next-line class-methods-use-this
    get length() {
      return 2;
    }
  }
  const bytes = new Liar([1, 2, 3, 4, 5, 6, 7, 8]);
  t.is(byteLengthOf(bytes), 8);
  const expected = createHash('sha256')
    .update(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    .digest('hex');
  t.is(hex(jsSha256(bytes)), expected);
  t.is(hex(nodeSha256(bytes)), expected);
});

test('a detached buffer digests as empty on every build', t => {
  // `node:crypto` treats a detached typed array as zero bytes. The
  // pure-JS build used to throw V8's own error here, which is the
  // cross-build divergence this package exists to prevent. Agreeing
  // with node is deliberate; pinned so it cannot drift back.
  const emptyHex = createHash('sha256').update(new Uint8Array(0)).digest('hex');
  const makeDetached = () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    return view;
  };
  t.is(hex(nodeSha256(makeDetached())), emptyHex);
  t.is(hex(jsSha256(makeDetached())), emptyHex);
});
