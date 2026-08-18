// @ts-check

// Every condition build must produce the same bytes `node:crypto`
// produces, for every input, or a content address computed on one
// platform stops naming the same blob on another.

import { createHash, randomBytes } from 'node:crypto';

import test from 'ava';

import {
  sha256 as nodeSha256,
  sha256Into as nodeSha256Into,
} from '../src/sha256-node.js';
import {
  sha256 as browserSha256,
  sha256Into as browserSha256Into,
} from '../src/sha256-browser.js';
import { jsSha256, jsSha256Into } from '../src/sha256-js.js';
import { DIGEST_LENGTH } from '../src/shared.js';

/** @type {[string, (bytes: Uint8Array) => Uint8Array][]} */
const implementations = [
  ['node', nodeSha256],
  ['browser', browserSha256],
  ['js', jsSha256],
];

/** @type {[string, (out: Uint8Array, bytes: Uint8Array, offset?: number) => number][]} */
const intoImplementations = [
  ['node', nodeSha256Into],
  ['browser', browserSha256Into],
  ['js', jsSha256Into],
];

const encoder = new TextEncoder();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

// FIPS 180-2 / FIPS 180-4 appendix B vectors, plus the well-known
// empty-input digest.
const vectors = [
  {
    label: 'empty input',
    input: '',
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    label: 'one-block message: "abc"',
    input: 'abc',
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    label: 'two-block message (56 bytes)',
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
];

for (const [name, sha256] of implementations) {
  for (const vector of vectors) {
    test(`${name}: ${vector.label}`, t => {
      t.is(hex(sha256(encoder.encode(vector.input))), vector.hex);
    });
  }

  test(`${name}: digest is a plain Uint8Array of 32 bytes`, t => {
    const digest = sha256(new Uint8Array(0));
    t.is(digest.length, DIGEST_LENGTH);
    t.is(Object.getPrototypeOf(digest), Uint8Array.prototype);
  });

  test(`${name}: agrees with node:crypto across block boundaries`, t => {
    // Lengths that straddle the 64-byte block and the 56-byte padding
    // boundary, where an off-by-one in padding shows up.
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = new Uint8Array(randomBytes(length));
      t.is(
        hex(sha256(bytes)),
        createHash('sha256').update(bytes).digest('hex'),
        `length ${length}`,
      );
    }
  });

  test(`${name}: hashes bytes above 0x7f without transcoding`, t => {
    // The XS host's one-shot `hostSha256` takes a UTF-8 string and so
    // mangles these; this asserts the package's contract is binary.
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xc0, 0xff, 0xfe]);
    t.is(hex(sha256(bytes)), createHash('sha256').update(bytes).digest('hex'));
  });

  test(`${name}: hashes a view into a larger buffer`, t => {
    const backing = new Uint8Array(randomBytes(64));
    const view = backing.subarray(8, 40);
    t.is(hex(sha256(view)), createHash('sha256').update(view).digest('hex'));
  });

  test(`${name}: rejects non-Uint8Array input`, t => {
    for (const bad of ['abc', 42, null, undefined, [1, 2, 3], {}]) {
      t.throws(() => sha256(/** @type {any} */ (bad)), {
        instanceOf: TypeError,
      });
    }
  });

  test(`${name}: does not accept an ArrayBuffer`, t => {
    t.throws(() => sha256(/** @type {any} */ (new ArrayBuffer(8))), {
      instanceOf: TypeError,
    });
  });
}

for (const [name, sha256Into] of intoImplementations) {
  test(`${name}: sha256Into writes 32 bytes and reports the count`, t => {
    const bytes = encoder.encode('abc');
    const out = new Uint8Array(DIGEST_LENGTH);
    t.is(sha256Into(out, bytes), DIGEST_LENGTH);
    t.is(hex(out), vectors[1].hex);
  });

  test(`${name}: sha256Into honors the offset and leaves the rest alone`, t => {
    const bytes = encoder.encode('abc');
    const out = new Uint8Array(DIGEST_LENGTH + 8).fill(0xaa);
    t.is(sha256Into(out, bytes, 5), DIGEST_LENGTH);
    t.is(hex(out.subarray(5, 5 + DIGEST_LENGTH)), vectors[1].hex);
    t.deepEqual(out.subarray(0, 5), new Uint8Array(5).fill(0xaa));
    t.deepEqual(out.subarray(5 + DIGEST_LENGTH), new Uint8Array(3).fill(0xaa));
  });

  test(`${name}: sha256Into writes into a view of a larger buffer`, t => {
    const bytes = encoder.encode('abc');
    const backing = new Uint8Array(64).fill(0xaa);
    const out = backing.subarray(16, 16 + DIGEST_LENGTH);
    t.is(sha256Into(out, bytes), DIGEST_LENGTH);
    t.is(hex(backing.subarray(16, 16 + DIGEST_LENGTH)), vectors[1].hex);
    t.deepEqual(backing.subarray(0, 16), new Uint8Array(16).fill(0xaa));
  });

  test(`${name}: sha256Into refuses an undersized destination`, t => {
    const bytes = encoder.encode('abc');
    t.throws(() => sha256Into(new Uint8Array(31), bytes), {
      instanceOf: RangeError,
    });
    t.throws(() => sha256Into(new Uint8Array(DIGEST_LENGTH), bytes, 1), {
      instanceOf: RangeError,
    });
  });

  test(`${name}: sha256Into rejects a negative or fractional offset`, t => {
    const bytes = encoder.encode('abc');
    const out = new Uint8Array(64);
    t.throws(() => sha256Into(out, bytes, -1), { instanceOf: RangeError });
    t.throws(() => sha256Into(out, bytes, 1.5), { instanceOf: RangeError });
  });

  test(`${name}: sha256Into rejects a non-Uint8Array destination`, t => {
    t.throws(() => sha256Into(/** @type {any} */ ([]), encoder.encode('abc')), {
      instanceOf: TypeError,
    });
  });

  test(`${name}: sha256Into agrees with node:crypto`, t => {
    for (const length of [0, 1, 55, 56, 64, 65, 1000]) {
      const bytes = new Uint8Array(randomBytes(length));
      const out = new Uint8Array(DIGEST_LENGTH);
      sha256Into(out, bytes);
      t.is(
        hex(out),
        createHash('sha256').update(bytes).digest('hex'),
        `length ${length}`,
      );
    }
  });
}

test('every build agrees byte for byte', t => {
  for (const length of [0, 1, 32, 55, 56, 64, 100, 4096]) {
    const bytes = new Uint8Array(randomBytes(length));
    const expected = hex(nodeSha256(bytes));
    for (const [name, sha256] of implementations) {
      t.is(hex(sha256(bytes)), expected, `${name} at length ${length}`);
    }
  }
});
