// @ts-check
/* eslint-disable import/order */

/**
 * Cross-platform SHA-256 verification: each implementation's output is compared
 * against `node:crypto` (the ground truth) for a suite of vectors.
 */

import '@endo/init/debug.js';

import test from 'ses-ava';
import { createHash } from 'node:crypto';

// Import all three platform entry points to verify them side-by-side.
import { sha256 as sha256Node, sha256Into as sha256IntoNode } from '../sha256-node.js';
import { sha256 as sha256Browser, sha256Into as sha256IntoBrowser } from '../sha256-browser.js';

// Known SHA-256 test vectors (input → hex digest)
const VECTORS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'the quick brown fox jumps over the lazy dog',
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  ],
];

/** Encode a string to Uint8Array */
const encode = (s) => new TextEncoder().encode(s);

/** Decode hex to Uint8Array */
const fromHex = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

/** Convert Uint8Array to hex */
const toHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
};

/** Get the node:crypto ground truth */
const refSha256 = (bytes) => createHash('sha256').update(bytes).digest();

// Pre-compute reference digests for each vector
const REF_BYTES = VECTORS.map(([, hex]) => fromHex(hex));

// Also compute a non-trivial large-input test: repeat 'abc' 1000 times
const LARGE_INPUT = encode('abc'.repeat(1000));
const LARGE_REF = refSha256(LARGE_INPUT);

/** Compare two Uint8Arrays */
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- sha256 (one-shot) tests ----

for (let vi = 0; vi < VECTORS.length; vi += 1) {
  const [inputStr, expectedHex] = VECTORS[vi];
  const inputBytes = encode(inputStr);
  const nodeRef = REF_BYTES[vi];

  test(`sha256 (node): "${inputStr.slice(0, 30)}${inputStr.length > 30 ? '…' : ''}" matches crypto`, (t) => {
    t.true(eq(sha256Node(inputBytes), nodeRef), `expected ${toHex(nodeRef)}, got ${toHex(sha256Node(inputBytes))}`);
  });

  test(`sha256 (browser): "${inputStr.slice(0, 30)}${inputStr.length > 30 ? '…' : ''}" matches crypto`, (t) => {
    t.true(eq(sha256Browser(inputBytes), nodeRef), `expected ${toHex(nodeRef)}, got ${toHex(sha256Browser(inputBytes))}`);
  });

  test(`sha256 (browser): hex for "${expectedHex.slice(0, 20)}…"` , (t) => {
    t.is(toHex(sha256Browser(inputBytes)), expectedHex);
  });
}

test('sha256: large input matches crypto', (t) => {
  t.true(eq(sha256Node(LARGE_INPUT), LARGE_REF));
  t.true(eq(sha256Browser(LARGE_INPUT), LARGE_REF));
});

test('sha256: empty input is the known SHA-256 of ""', (t) => {
  const empty = encode('');
  t.is(toHex(sha256Node(empty)), VECTORS[0][1]);
  t.is(toHex(sha256Browser(empty)), VECTORS[0][1]);
});

test('sha256: single byte', (t) => {
  const single = encode('A'); // just the character 'A' (0x41)
  // Use a known vector: SHA-256 of byte 0x41
  const nodeRefSingle = refSha256(single);
  t.true(eq(sha256Node(single), nodeRefSingle));
  t.true(eq(sha256Browser(single), nodeRefSingle));
});

// ---- sha256Into tests ----

test('sha256Into (node): writes into provided buffer', (t) => {
  const input = encode('abc');
  const out = new Uint8Array(32);
  const n = sha256IntoNode(out, input);
  t.is(n, 32);
  t.true(eq(out, REF_BYTES[1]));
});

test('sha256Into (browser): writes into provided buffer', (t) => {
  const input = encode('abc');
  const out = new Uint8Array(32);
  const n = sha256IntoBrowser(out, input);
  t.is(n, 32);
  t.true(eq(out, REF_BYTES[1]));
});

test('sha256Into: with offset', (t) => {
  const input = encode('abc');
  const out = new Uint8Array(40); // 32 digest + 8 padding
  const n = sha256IntoNode(out, input, 4);
  t.is(n, 32);
  t.true(eq(out.slice(4, 36), REF_BYTES[1]));
});

test('sha256Into: throws on too-small buffer', (t) => {
  const small = new Uint8Array(31);
  t.throws(() => sha256IntoNode(small, encode('abc'), 0), { message: /too small/ });
  t.throws(() => sha256IntoBrowser(small, encode('abc'), 0), { message: /too small/ });
});

test('sha256Into: large input', (t) => {
  const out = new Uint8Array(32);
  sha256IntoNode(out, LARGE_INPUT);
  t.true(eq(out, LARGE_REF));
  const out2 = new Uint8Array(32);
  sha256IntoBrowser(out2, LARGE_INPUT);
  t.true(eq(out2, LARGE_REF));
});

// ---- Byte-for-byte equivalence with node:crypto ----

test('sha256: many random-looking inputs match node:crypto', (t) => {
  // Build a set of diverse test inputs
  const inputs = [
    encode(''),
    encode('a'),
    encode('ab'),
    encode('abc'),
    encode('abcd'),
    encode('abcde'),
    new Uint8Array([0x00]),
    new Uint8Array([0xff]),
    new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)), // all byte values
    encode('repeated-'.repeat(100)),
  ];

  for (const input of inputs) {
    const node = refSha256(input);
    t.true(eq(sha256Node(input), node), `node sha256 mismatch on ${input.length}-byte input`);
    t.true(eq(sha256Browser(input), node), `browser sha256 mismatch on ${input.length}-byte input`);
  }
});

