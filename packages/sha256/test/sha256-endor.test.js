// @ts-check

// The Endor build depends only on the host contract, so these tests exercise
// the same module instance that Endor/XS and Endor/IronHorse load. The host
// function remains replaceable here so failure cases do not require distinct
// module instances or import-query cache busting.

import { createHash, randomBytes } from 'node:crypto';

import test from 'ava';

import { sha256, sha256Into } from '../src/sha256-endor.js';

const originalHostSha256Bytes = Object.getOwnPropertyDescriptor(
  globalThis,
  'hostSha256Bytes',
);

/** @type {(bytes: Uint8Array) => unknown} */
const workingHostSha256BytesImplementation = bytes =>
  createHash('sha256').update(bytes).digest();
/** @type {(bytes: Uint8Array) => unknown} */
let hostSha256BytesImplementation = workingHostSha256BytesImplementation;

Object.defineProperty(globalThis, 'hostSha256Bytes', {
  value: (/** @type {Uint8Array} */ bytes) =>
    hostSha256BytesImplementation(bytes),
  configurable: true,
});

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

const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 1000];

test.serial('agrees with node:crypto through the Endor host contract', t => {
  for (const length of lengths) {
    const bytes = new Uint8Array(randomBytes(length));
    t.is(
      hex(sha256(bytes)),
      createHash('sha256').update(bytes).digest('hex'),
      `length ${length}`,
    );
  }

  const high = new Uint8Array([0x80, 0xc0, 0xff]);
  const highHex = createHash('sha256').update(high).digest('hex');
  t.is(hex(sha256(high)), highHex);

  const out = new Uint8Array(40).fill(0xaa);
  t.is(sha256Into(out, high, 4), 32);
  t.is(hex(out.subarray(4, 36)), highHex);
});

test.serial('accepts ArrayBuffer and Uint8Array host digests', t => {
  const bytes = new Uint8Array(randomBytes(100));
  const expected = createHash('sha256').update(bytes).digest();

  hostSha256BytesImplementation = input => {
    const digest = createHash('sha256').update(input).digest();
    return digest.buffer.slice(
      digest.byteOffset,
      digest.byteOffset + digest.byteLength,
    );
  };
  t.is(hex(sha256(bytes)), expected.toString('hex'));

  hostSha256BytesImplementation = input =>
    createHash('sha256').update(input).digest();
  t.is(hex(sha256(bytes)), expected.toString('hex'));
});

test.serial('copies the host digest before returning it', t => {
  const scratch = new Uint8Array(32).fill(0x11);
  hostSha256BytesImplementation = () => scratch;
  const digest = sha256(new Uint8Array());
  scratch.fill(0x22);
  t.true(digest.every(byte => byte === 0x11));
});

test.serial('rejects non-Uint8Array input', t => {
  t.throws(() => sha256(/** @type {any} */ ('abc')), {
    instanceOf: TypeError,
  });
});

test.serial('rejects a wrong-sized or non-buffer host digest', t => {
  /** @type {[string, () => unknown][]} */
  const bad = [
    ['short buffer', () => new ArrayBuffer(16)],
    ['long buffer', () => new ArrayBuffer(64)],
    ['number', () => 32],
    ['string', () => 'deadbeef'],
  ];
  for (const [label, implementation] of bad) {
    hostSha256BytesImplementation = implementation;
    t.throws(() => sha256(new Uint8Array(3)), {
      message:
        /expected an ArrayBuffer or Uint8Array|expected a 32-byte digest/,
    });
    t.pass(label);
  }
});

test.serial('fails when the Endor host contract is unavailable', t => {
  delete (/** @type {any} */ (globalThis).hostSha256Bytes);
  t.throws(() => sha256(new Uint8Array()), {
    message: '@endo/sha256: Endor hostSha256Bytes is unavailable',
  });
});
