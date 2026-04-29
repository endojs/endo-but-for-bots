/* eslint-disable no-bitwise, @endo/restrict-comparison-operands */
/* global globalThis */

// Benchmark: comparison of two seedable PRNGs across three workloads:
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
//   B. `@endo/random` — pure-JavaScript ChaCha20 keystream.
//
// A `node:crypto`-backed third implementation was prototyped but
// dropped: at ChaCha20's 64-byte block size the per-call JS↔native
// FFI cost of `cipher.update()` exceeds the inlined pure-JS quarter
// rounds, so the Node path is slower, not faster.
//
// Run from `packages/random/`:
//   node test/random.bench.js
//
// The bench file is named `*.bench.js` (not `*.test.js`) so the
// ses-ava test runner ignores it, matching the convention in
// `packages/hex/`.

import { makeRandom } from '../index.js';
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
    const r = makeRandom(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random', ITERS_BYTES, () => r.bytes(N)),
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
    const r = makeRandom(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random', 1, () => {
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
    const r = makeRandom(Uint8Array.from(seedBytes));
    printRow(
      time('@endo/random', 1, () => {
        for (let i = 0; i < ITERS_INT; i += 1) r.int(0, 99);
      }),
    );
  }
  console.log('');
};

runBench();
