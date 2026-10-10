// @ts-check

// The Endor async arm wraps the synchronous Endor build, so it is backed by
// the same `hostSha256Bytes` contract and must surface the same digests and
// the same failures — just through a promise.

import { createHash, randomBytes } from 'node:crypto';

import test from 'ava';

import { sha256Async, sha256IntoAsync } from '../src/sha256-endor-async.js';
import { DIGEST_LENGTH } from '../src/shared.js';

const originalHostSha256Bytes = Object.getOwnPropertyDescriptor(
  globalThis,
  'hostSha256Bytes',
);

/** @type {(bytes: Uint8Array) => unknown} */
const workingHostSha256BytesImplementation = bytes =>
  createHash('sha256').update(bytes).digest();
/** @type {(bytes: Uint8Array) => unknown} */
let hostSha256BytesImplementation = workingHostSha256BytesImplementation;

test.beforeEach(() => {
  hostSha256BytesImplementation = workingHostSha256BytesImplementation;
  Object.defineProperty(globalThis, 'hostSha256Bytes', {
    value: (/** @type {Uint8Array} */ bytes) =>
      hostSha256BytesImplementation(bytes),
    configurable: true,
  });
});

test.after.always(() => {
  if (originalHostSha256Bytes === undefined) {
    delete (/** @type {any} */ (globalThis).hostSha256Bytes);
  } else {
    Object.defineProperty(
      globalThis,
      'hostSha256Bytes',
      originalHostSha256Bytes,
    );
  }
});

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hex = bytes => Buffer.from(bytes).toString('hex');

test.serial('resolves the host digest across lengths', async t => {
  await null;
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 1000]) {
    const bytes = new Uint8Array(randomBytes(length));
    // eslint-disable-next-line no-await-in-loop
    const digest = await sha256Async(bytes);
    t.is(
      hex(digest),
      createHash('sha256').update(bytes).digest('hex'),
      `length ${length}`,
    );
  }
});

test.serial('sha256IntoAsync writes the host digest at an offset', async t => {
  const bytes = new TextEncoder().encode('abc');
  const out = new Uint8Array(DIGEST_LENGTH + 4).fill(0xaa);
  const written = await sha256IntoAsync(out, bytes, 4);
  t.is(written, DIGEST_LENGTH);
  t.is(
    hex(out.subarray(4, 4 + DIGEST_LENGTH)),
    createHash('sha256').update(bytes).digest('hex'),
  );
  t.deepEqual(out.subarray(0, 4), new Uint8Array(4).fill(0xaa));
});

test.serial('rejects when the host is unavailable', async t => {
  delete (/** @type {any} */ (globalThis).hostSha256Bytes);
  await t.throwsAsync(() => sha256Async(new Uint8Array(3)), {
    message: /hostSha256Bytes is unavailable/,
  });
});

test.serial(
  'rejects a wrong-sized host digest rather than mis-addressing',
  async t => {
    hostSha256BytesImplementation = () => new Uint8Array(31);
    await t.throwsAsync(() => sha256Async(new Uint8Array(3)), {
      message: /expected a 32-byte digest/,
    });
  },
);

test.serial('rejects a non-Uint8Array argument', async t => {
  await t.throwsAsync(() => sha256Async(/** @type {any} */ ('abc')), {
    instanceOf: TypeError,
  });
});
