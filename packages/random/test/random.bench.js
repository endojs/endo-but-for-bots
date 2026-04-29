/* eslint-disable no-bitwise, @endo/restrict-comparison-operands */
/* global globalThis */

// Benchmark: comparison of three seedable PRNGs across three workloads:
//
//   1. Pulling 1 MiB of random bytes (`bytes(1024 * 1024)`).
//   2. 1 000 000 `random()` calls.
//   3. 1 000 000 `int(0, 99)` calls.
//
// Implementations:
//
//   A. xorshift128+ — the local copy in `_xorshift.js`, the same
//      PRNG as `packages/ocapn/test/_xorshift.js` and `packages/hex/`
//      benches.  `bytes(n)` is synthesized as `Math.floor(random()
//      * 256)` per byte.
//   B. `@endo/random` pure-JS — imported directly from
//      `../src/random-pure.js` so we measure the in-tree ChaCha20
//      keystream generator regardless of which export condition the
//      consumer's resolver picks.
//   C. `@endo/random` Node-crypto — imported from
//      `../src/random-node.js`, using `crypto.createCipheriv`.
//
// Run from `packages/random/`:
//   node test/random.bench.js
//
// The bench file is named `*.bench.js` (not `*.test.js`) so the
// ses-ava test runner ignores it, matching the convention in
// `packages/hex/`.

import { makeRandom as makeRandomPure } from '../src/random-pure.js';
import { makeRandom as makeRandomNode } from '../src/random-node.js';
import { XorShift } from './_xorshift.js';

// Engine-portable nanosecond timer.
const hasHrtime =
  typeof globalThis.process === 'object' &&
  globalThis.process !== null &&
  typeof globalThis.process.hrtime === 'function' &&
  typeof globalThis.process.hrtime.bigint === 'function';
const nowNs = hasHrtime
  ? () => Number(globalThis.process.hrtime.bigint())
  : () => Date.now() * 1_000_000;

const seedShort = [0xb0b5c0ff, 0xeefacade, 0xb0b5c0ff, 0xeefacade];
const seedBytes = (() => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) s[i] = i;
  return s;
})();

const makeXorShiftAdapter = () => {
  const x = new XorShift([...seedShort]);
  return {
    random: () => x.random(),
    int: (lo, hi) => lo + Math.floor(x.random() * (hi - lo + 1)),
    bytes: n => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = Math.floor(x.random() * 256);
      return out;
    },
  };
};

const time = (label, iters, fn) => {
  // Warm-up.
  fn();
  fn();
  const start = nowNs();
  for (let i = 0; i < iters; i += 1) fn();
  const elapsedNs = nowNs() - start;
  const totalSec = elapsedNs / 1e9;
  const perIterUs = elapsedNs / iters / 1_000;
  return { label, totalSec, perIterUs };
};

const pad = (s, w) => {
  let out = String(s);
  while (out.length < w) out = ` ${out}`;
  return out;
};

const printRow = ({ label, totalSec, perIterUs }, extra) => {
  console.log(
    `  ${label}${' '.repeat(Math.max(1, 32 - label.length))}${pad(
      perIterUs.toFixed(3),
      11,
    )} us/iter   total ${pad(totalSec.toFixed(3), 6)} s${extra ? `   ${extra}` : ''}`,
  );
};

const runBench = () => {
  console.log(
    `Node ${globalThis.process?.versions?.node || '?'} on ${
      globalThis.process?.platform || '?'
    } / ${globalThis.process?.arch || '?'}`,
  );
  console.log('');

  // 1. Bulk bytes — 1 MiB.
  console.log('Workload: bytes(1 MiB), 8 iterations');
  const N = 1 << 20;
  const ITERS_BYTES = 8;
  {
    const x = makeXorShiftAdapter();
    printRow(
      time('xorshift128+', ITERS_BYTES, () => x.bytes(N)),
      `${((ITERS_BYTES * N) / 1024 / 1024).toFixed(0)} MiB total`,
    );
  }
  {
    const r = makeRandomPure(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random pure-JS', ITERS_BYTES, () => r.bytes(N)),
      `${((ITERS_BYTES * N) / 1024 / 1024).toFixed(0)} MiB total`,
    );
  }
  {
    const r = makeRandomNode(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random Node-crypto', ITERS_BYTES, () => r.bytes(N)),
      `${((ITERS_BYTES * N) / 1024 / 1024).toFixed(0)} MiB total`,
    );
  }
  console.log('');

  // 2. random() — 1 000 000 calls.
  console.log('Workload: random() x 1 000 000');
  const ITERS_RANDOM = 1_000_000;
  {
    const x = makeXorShiftAdapter();
    printRow(
      time('xorshift128+', 1, () => {
        for (let i = 0; i < ITERS_RANDOM; i += 1) x.random();
      }),
    );
  }
  {
    const r = makeRandomPure(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random pure-JS', 1, () => {
        for (let i = 0; i < ITERS_RANDOM; i += 1) r.random();
      }),
    );
  }
  {
    const r = makeRandomNode(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random Node-crypto', 1, () => {
        for (let i = 0; i < ITERS_RANDOM; i += 1) r.random();
      }),
    );
  }
  console.log('');

  // 3. int(0, 99) — 1 000 000 calls.
  console.log('Workload: int(0, 99) x 1 000 000');
  const ITERS_INT = 1_000_000;
  {
    const x = makeXorShiftAdapter();
    printRow(
      time('xorshift128+', 1, () => {
        for (let i = 0; i < ITERS_INT; i += 1) x.int(0, 99);
      }),
    );
  }
  {
    const r = makeRandomPure(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random pure-JS', 1, () => {
        for (let i = 0; i < ITERS_INT; i += 1) r.int(0, 99);
      }),
    );
  }
  {
    const r = makeRandomNode(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random Node-crypto', 1, () => {
        for (let i = 0; i < ITERS_INT; i += 1) r.int(0, 99);
      }),
    );
  }
  console.log('');
};

runBench();
