// @ts-check

// `@endo/sha256/async` is the asynchronous analogue of `@endo/sha256`. Its
// browser arm may reach for WebCrypto (`crypto.subtle.digest`, which is async
// and so cannot back the synchronous package); its node and Endor arms wrap
// their synchronous builds. Every arm must still produce the exact bytes
// `node:crypto` produces, or an async content address stops naming the same
// blob a synchronous one does.

import { createHash, randomBytes } from 'node:crypto';

import test from 'ava';
import { fc } from '@fast-check/ava';

import {
  sha256Async as nodeSha256Async,
  sha256IntoAsync as nodeSha256IntoAsync,
} from '../src/sha256-node-async.js';
import {
  sha256Async as browserSha256Async,
  sha256IntoAsync as browserSha256IntoAsync,
} from '../src/sha256-browser-async.js';
import { DIGEST_LENGTH } from '../src/shared.js';

const encoder = new TextEncoder();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const nodeHex = bytes => createHash('sha256').update(bytes).digest('hex');

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

/** @type {[string, (bytes: Uint8Array) => Promise<Uint8Array>][]} */
const implementations = [
  ['node', nodeSha256Async],
  ['browser', browserSha256Async],
];

/** @type {[string, (out: Uint8Array, bytes: Uint8Array, offset?: number) => Promise<number>][]} */
const intoImplementations = [
  ['node', nodeSha256IntoAsync],
  ['browser', browserSha256IntoAsync],
];

for (const [name, sha256Async] of implementations) {
  for (const vector of vectors) {
    test(`${name}: ${vector.label}`, async t => {
      const digest = await sha256Async(encoder.encode(vector.input));
      t.is(hex(digest), vector.hex);
    });
  }

  test(`${name}: resolves to a plain Uint8Array of 32 bytes`, async t => {
    const digest = await sha256Async(new Uint8Array(0));
    t.is(digest.length, DIGEST_LENGTH);
    t.is(Object.getPrototypeOf(digest), Uint8Array.prototype);
  });

  test(`${name}: agrees with node:crypto across block boundaries`, async t => {
    await null;
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = new Uint8Array(randomBytes(length));
      // eslint-disable-next-line no-await-in-loop
      const digest = await sha256Async(bytes);
      t.is(hex(digest), nodeHex(bytes), `length ${length}`);
    }
  });

  test(`${name}: hashes bytes above 0x7f without transcoding`, async t => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xc0, 0xff, 0xfe]);
    const digest = await sha256Async(bytes);
    t.is(hex(digest), nodeHex(bytes));
  });

  test(`${name}: hashes a view into a larger buffer`, async t => {
    const backing = new Uint8Array(randomBytes(64));
    const view = backing.subarray(8, 40);
    const digest = await sha256Async(view);
    t.is(hex(digest), nodeHex(view));
  });

  test(`${name}: rejects non-Uint8Array input`, async t => {
    await null;
    for (const bad of ['abc', 42, null, undefined, [1, 2, 3], {}]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => sha256Async(/** @type {any} */ (bad)), {
        instanceOf: TypeError,
      });
    }
  });

  test(`${name}: does not accept an ArrayBuffer`, async t => {
    await t.throwsAsync(
      () => sha256Async(/** @type {any} */ (new ArrayBuffer(8))),
      { instanceOf: TypeError },
    );
  });
}

for (const [name, sha256IntoAsync] of intoImplementations) {
  test(`${name}: sha256IntoAsync writes 32 bytes and reports the count`, async t => {
    const out = new Uint8Array(DIGEST_LENGTH);
    const written = await sha256IntoAsync(out, encoder.encode('abc'));
    t.is(written, DIGEST_LENGTH);
    t.is(hex(out), vectors[1].hex);
  });

  test(`${name}: sha256IntoAsync honors the offset and leaves the rest alone`, async t => {
    const out = new Uint8Array(DIGEST_LENGTH + 8).fill(0xaa);
    const written = await sha256IntoAsync(out, encoder.encode('abc'), 5);
    t.is(written, DIGEST_LENGTH);
    t.is(hex(out.subarray(5, 5 + DIGEST_LENGTH)), vectors[1].hex);
    t.deepEqual(out.subarray(0, 5), new Uint8Array(5).fill(0xaa));
    t.deepEqual(out.subarray(5 + DIGEST_LENGTH), new Uint8Array(3).fill(0xaa));
  });

  test(`${name}: sha256IntoAsync writes into a view of a larger buffer`, async t => {
    const backing = new Uint8Array(64).fill(0xaa);
    const out = backing.subarray(16, 16 + DIGEST_LENGTH);
    const written = await sha256IntoAsync(out, encoder.encode('abc'));
    t.is(written, DIGEST_LENGTH);
    t.is(hex(backing.subarray(16, 16 + DIGEST_LENGTH)), vectors[1].hex);
    t.deepEqual(backing.subarray(0, 16), new Uint8Array(16).fill(0xaa));
  });

  test(`${name}: sha256IntoAsync refuses an undersized destination`, async t => {
    const bytes = encoder.encode('abc');
    await t.throwsAsync(() => sha256IntoAsync(new Uint8Array(31), bytes), {
      instanceOf: RangeError,
    });
    await t.throwsAsync(
      () => sha256IntoAsync(new Uint8Array(DIGEST_LENGTH), bytes, 1),
      { instanceOf: RangeError },
    );
  });

  test(`${name}: sha256IntoAsync rejects a negative or fractional offset`, async t => {
    const out = new Uint8Array(64);
    const bytes = encoder.encode('abc');
    await t.throwsAsync(() => sha256IntoAsync(out, bytes, -1), {
      instanceOf: RangeError,
    });
    await t.throwsAsync(() => sha256IntoAsync(out, bytes, 1.5), {
      instanceOf: RangeError,
    });
  });

  test(`${name}: sha256IntoAsync rejects a non-Uint8Array destination`, async t => {
    await t.throwsAsync(
      () => sha256IntoAsync(/** @type {any} */ ([]), encoder.encode('abc')),
      { instanceOf: TypeError },
    );
  });

  test(`${name}: sha256IntoAsync agrees with node:crypto`, async t => {
    await null;
    for (const length of [0, 1, 55, 56, 64, 65, 1000]) {
      const bytes = new Uint8Array(randomBytes(length));
      const out = new Uint8Array(DIGEST_LENGTH);
      // eslint-disable-next-line no-await-in-loop
      await sha256IntoAsync(out, bytes);
      t.is(hex(out), nodeHex(bytes), `length ${length}`);
    }
  });
}

// Up to two blocks past the 56-byte padding boundary, where a padding
// mistake shows up.
const arbBytes = fc.uint8Array({ maxLength: 200 });

for (const [name, sha256Async] of implementations) {
  test(`${name}: agrees with node:crypto for every input`, async t => {
    await fc.assert(
      fc.asyncProperty(arbBytes, async bytes => {
        const digest = await sha256Async(bytes);
        t.is(hex(digest), nodeHex(bytes));
      }),
    );
  });
}

test('both async builds agree byte for byte', async t => {
  await null;
  for (const length of [0, 1, 32, 55, 56, 64, 100, 4096]) {
    const bytes = new Uint8Array(randomBytes(length));
    const expected = nodeHex(bytes);
    for (const [name, sha256Async] of implementations) {
      // eslint-disable-next-line no-await-in-loop
      const digest = await sha256Async(bytes);
      t.is(hex(digest), expected, `${name} at length ${length}`);
    }
  }
});

// The browser arm's reason to exist is that it reaches WebCrypto where the
// synchronous package cannot. These tests pin both that it goes through
// `crypto.subtle.digest` when present and that it falls back to the pure-JS
// digest when it is absent (an insecure `http://` context, or a `default`-arm
// environment with no WebCrypto), never throwing and never diverging.

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
// Capture the realm's real WebCrypto before any test swaps `globalThis.crypto`.
const realSubtle = /** @type {any} */ (globalThis).crypto.subtle;

/** @param {unknown} value */
const setCrypto = value => {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
};

test.afterEach.always(() => {
  if (originalCrypto === undefined) {
    delete (/** @type {any} */ (globalThis).crypto);
  } else {
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  }
});

test.serial(
  'browser: routes through crypto.subtle.digest when present',
  async t => {
    const abc = encoder.encode('abc');
    /** @type {{ algorithm: string, byteLength: number }[]} */
    const calls = [];
    setCrypto({
      subtle: {
        /**
         * @param {string} algorithm
         * @param {BufferSource} data
         */
        digest: (algorithm, data) => {
          calls.push({ algorithm, byteLength: data.byteLength });
          return realSubtle.digest(algorithm, data);
        },
      },
    });
    const digest = await browserSha256Async(abc);
    t.is(hex(digest), vectors[1].hex);
    t.deepEqual(calls, [{ algorithm: 'SHA-256', byteLength: 3 }]);
  },
);

test.serial(
  'browser: falls back to the pure-JS digest with no WebCrypto',
  async t => {
    await null;
    setCrypto(undefined);
    for (const vector of vectors) {
      const bytes = encoder.encode(vector.input);
      // eslint-disable-next-line no-await-in-loop
      const digest = await browserSha256Async(bytes);
      t.is(hex(digest), vector.hex, vector.label);
    }
    // A `crypto` without a `subtle.digest` (an old or partial polyfill) is the
    // same case as no `crypto` at all.
    setCrypto({ subtle: {} });
    const bytes = new Uint8Array(randomBytes(100));
    const digest = await browserSha256Async(bytes);
    t.is(hex(digest), nodeHex(bytes));
  },
);

test.serial(
  'browser: the WebCrypto choice is per call, never memoized',
  async t => {
    // A first digest taken before a secure context exists must not pin the
    // pure-JS path for later calls once WebCrypto appears.
    setCrypto(undefined);
    const early = new Uint8Array(randomBytes(64));
    const earlyDigest = await browserSha256Async(early);
    t.is(hex(earlyDigest), nodeHex(early));

    let used = false;
    setCrypto({
      subtle: {
        /**
         * @param {string} algorithm
         * @param {BufferSource} data
         */
        digest: (algorithm, data) => {
          used = true;
          return realSubtle.digest(algorithm, data);
        },
      },
    });
    const later = new Uint8Array(randomBytes(64));
    const laterDigest = await browserSha256Async(later);
    t.is(hex(laterDigest), nodeHex(later));
    t.true(used, 'the second call reached the now-present WebCrypto');
  },
);
