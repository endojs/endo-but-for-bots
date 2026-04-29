// @ts-check

import test from '@endo/ses-ava/test.js';

import { makeRandom as makeRandomPure } from '../src/random-pure.js';
import { makeRandom as makeRandomNode } from '../src/random-node.js';

const seed = (() => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) s[i] = (i * 17 + 3) % 256;
  return s;
})();

const cloneSeed = () => Uint8Array.from(seed);

test('pure and Node-crypto random() outputs agree bit-for-bit', t => {
  const a = makeRandomPure(cloneSeed());
  const b = makeRandomNode(cloneSeed());
  for (let i = 0; i < 1000; i += 1) {
    t.is(a.random(), b.random(), `random[${i}]`);
  }
});

test('pure and Node-crypto int() outputs agree', t => {
  const a = makeRandomPure(cloneSeed());
  const b = makeRandomNode(cloneSeed());
  for (let i = 0; i < 1000; i += 1) {
    t.is(a.int(0, 1_000_000), b.int(0, 1_000_000), `int[${i}]`);
  }
});

test('pure and Node-crypto bytes() outputs agree across block boundaries', t => {
  // Span several block boundaries (block size is 64) at varied
  // offsets so we exercise both fast-path block-aligned reads and
  // partial-buffer carry-over.
  const sizes = [1, 7, 63, 64, 65, 127, 128, 200, 1024, 4096];
  const a = makeRandomPure(cloneSeed());
  const b = makeRandomNode(cloneSeed());
  for (const n of sizes) {
    const aa = a.bytes(n);
    const bb = b.bytes(n);
    t.deepEqual([...aa], [...bb], `bytes(${n})`);
  }
});

test('pure and Node-crypto fillBytes outputs agree', t => {
  const a = makeRandomPure(cloneSeed());
  const b = makeRandomNode(cloneSeed());
  const aBuf = new Uint8Array(256);
  const bBuf = new Uint8Array(256);
  a.fillBytes(aBuf);
  b.fillBytes(bBuf);
  t.deepEqual([...aBuf], [...bBuf]);
});
