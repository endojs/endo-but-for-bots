// @ts-check

// `sha256.test.js` states the package's contract as a universal — every
// condition build produces the bytes `node:crypto` produces, for every
// input — and then checks it at hand-picked lengths. These properties
// check the same claim over generated input, with a seed in the failure
// report and a shrinker to report the smallest input that breaks it.

import { createHash } from 'node:crypto';

import test from 'ava';
import { fc } from '@fast-check/ava';

import { sha256 as nodeSha256 } from '../src/sha256-node.js';
import { sha256 as browserSha256 } from '../src/sha256-browser.js';
import { jsSha256, jsSha256Into } from '../src/sha256-js.js';
import { DIGEST_LENGTH } from '../src/shared.js';

/** @type {[string, (bytes: Uint8Array) => Uint8Array][]} */
const implementations = [
  ['node', nodeSha256],
  ['browser', browserSha256],
  ['js', jsSha256],
];

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

// Up to two blocks past the 56-byte padding boundary, which is where a
// padding mistake shows up.
const arbBytes = fc.uint8Array({ maxLength: 200 });

for (const [name, sha256] of implementations) {
  test(`${name}: agrees with node:crypto for every input`, async t => {
    await fc.assert(
      fc.property(arbBytes, bytes => {
        t.is(
          hex(sha256(bytes)),
          createHash('sha256').update(bytes).digest('hex'),
        );
      }),
    );
  });
}

test('the digest is always 32 bytes', async t => {
  await fc.assert(
    fc.property(arbBytes, bytes => {
      for (const [, sha256] of implementations) {
        t.is(sha256(bytes).length, DIGEST_LENGTH);
      }
    }),
  );
});

test('hashing a view equals hashing its copy', async t => {
  // `makeBlobRefExo` hands this package a view over captured bytes, so
  // a byteOffset-sensitive implementation would corrupt content
  // addresses only for sliced input.
  await fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 1, maxLength: 200 }),
      fc.nat(64),
      fc.nat(64),
      (bytes, front, back) => {
        const start = Math.min(front, bytes.length);
        const end = Math.max(
          start,
          bytes.length - Math.min(back, bytes.length),
        );
        const view = bytes.subarray(start, end);
        for (const [, sha256] of implementations) {
          t.is(hex(sha256(view)), hex(sha256(view.slice())));
        }
      },
    ),
  );
});

test('sha256Into at any offset writes the digest and disturbs nothing else', async t => {
  await fc.assert(
    fc.property(arbBytes, fc.nat(16), (bytes, offset) => {
      const out = new Uint8Array(DIGEST_LENGTH + 16).fill(0xaa);
      t.is(jsSha256Into(out, bytes, offset), DIGEST_LENGTH);
      t.is(
        hex(out.subarray(offset, offset + DIGEST_LENGTH)),
        createHash('sha256').update(bytes).digest('hex'),
      );
      t.deepEqual(out.subarray(0, offset), new Uint8Array(offset).fill(0xaa));
      t.deepEqual(
        out.subarray(offset + DIGEST_LENGTH),
        new Uint8Array(16 - offset).fill(0xaa),
      );
    }),
  );
});

test('sha256Into tolerates a destination aliasing the input', async t => {
  // Nothing forbids it, so pin that it behaves as if the input were
  // read first rather than clobbered mid-digest.
  await fc.assert(
    fc.property(fc.uint8Array({ minLength: 32, maxLength: 200 }), bytes => {
      const expected = createHash('sha256').update(bytes).digest('hex');
      const scratch = bytes.slice();
      t.is(jsSha256Into(scratch, scratch), DIGEST_LENGTH);
      t.is(hex(scratch.subarray(0, DIGEST_LENGTH)), expected);
    }),
  );
});
