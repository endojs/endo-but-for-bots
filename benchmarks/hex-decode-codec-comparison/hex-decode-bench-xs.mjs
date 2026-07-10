/* eslint-disable */
/**
 * XS (xsnap) runner for the @endo/hex decode-codec comparison.
 *
 * Drives an XS worker through `@agoric/xsnap`'s `xsnap()` export (the
 * preferred form: it spawns and speaks to the prebuilt `xsnap-worker` for
 * you, and surfaces the metered `compute` per `evaluate`). It feeds the
 * worker the identical engine-agnostic core the Node runner uses, then
 * reports the XS metered `compute` per decode for each approach. On a
 * consensus engine the metered cost, not wall-clock, is what a contract
 * pays, so it is the number that decides which decoder wins on XS.
 *
 * `@agoric/xsnap` is NOT a dependency of @endo or of this benchmark;
 * install it alongside to run this file:
 *
 *   npm install @agoric/xsnap
 *   node hex-decode-bench-xs.mjs
 *
 * `@endo/init` is imported first so `@agoric/xsnap` (via `@endo/errors`)
 * finds `globalThis.assert` initialized. The report in REPORT.md was
 * produced with @agoric/xsnap 0.15.0 (xsnap-worker, release build).
 */

import '@endo/init';

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { type as osType } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { xsnap } from '@agoric/xsnap';

const here = fileURLToPath(new URL('.', import.meta.url));
const coreSrc = readFileSync(`${here}hex-decode-bench-core.js`, 'utf8');

const SIZES = [
  { name: 'short', bytes: 8, iters: 2000 },
  { name: 'medium', bytes: 256, iters: 400 },
  { name: 'large', bytes: 1024, iters: 150 },
  { name: 'xlarge', bytes: 16384, iters: 15 },
];
const MODE = 'mixed';
const SEED = 0x1234abcd;

const worker = await xsnap({
  os: osType(),
  spawn,
  fs,
  name: 'hexbench',
  meteringLimit: 2_000_000_000,
  stdout: 'inherit',
  stderr: 'inherit',
});

const computeOf = r => (r.meterUsage ? r.meterUsage.compute : null);

const build = await worker.evaluate(coreSrc);
const tableBuildCompute = computeOf(build);
// checkCorrectness/tableSize assertions throw inside XS on mismatch, so a
// non-throwing evaluate is the pass signal.
await worker.evaluate(
  'if (hexbench.tableSize !== 484) throw Error("table size " + hexbench.tableSize)',
);

for (const { name, bytes } of SIZES) {
  const key = `${name}-${MODE}`;
  await worker.evaluate(
    `hexbench.makeCorpus(${JSON.stringify(key)}, ${bytes}, ${JSON.stringify(MODE)}, ${SEED})`,
  );
  await worker.evaluate(
    `hexbench.checkCorrectness(${JSON.stringify(key)}, ${bytes}, ${SEED})`,
  );
}

const measure = async (approach, key, iters) => {
  const call = `hexbench.decodeLoop(${JSON.stringify(approach)}, ${JSON.stringify(key)}, ${iters})`;
  await worker.evaluate(call); // warmup
  const r = await worker.evaluate(call);
  return computeOf(r);
};

const results = [];
for (const { name, bytes, iters } of SIZES) {
  const key = `${name}-${MODE}`;
  const base = await measure('empty', key, iters);
  for (const approach of ['map', 'arith', 'lut']) {
    const compute = await measure(approach, key, iters);
    results.push({
      size: name,
      bytes,
      mode: MODE,
      approach,
      iters,
      computePerOp: Math.round((compute - base) / iters),
    });
  }
}

await worker.close();

const pad = (s, n) => String(s).padEnd(n);
const find = (size, approach) =>
  results.find(r => r.size === size && r.approach === approach);

console.log(
  `# XS (xsnap) hex decode, metered compute per decode (lower is better)\n`,
);
console.log(
  `metered compute to build the 484-entry Map at module load: ${tableBuildCompute}\n`,
);
const APPROACHES = ['map', 'arith', 'lut'];
console.log(`${pad('size', 8)}${APPROACHES.map(a => pad(a, 12)).join('')}`);
for (const { name } of SIZES) {
  const cells = APPROACHES.map(a =>
    pad(String(find(name, a).computePerOp), 12),
  ).join('');
  console.log(`${pad(name, 8)}${cells}`);
}
console.log(
  `\n#JSON ${JSON.stringify({ engine: 'xs', tableBuildCompute, results })}`,
);
