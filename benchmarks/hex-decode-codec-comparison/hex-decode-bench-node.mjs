/* eslint-disable */
/**
 * Node.js (V8) runner for the @endo/hex decode-codec comparison.
 *
 * Loads the engine-agnostic core (the `map`, `arith`, and `lut`
 * decoders), asserts they decode identically across lower/UPPER/mixed
 * case, then times each across several input sizes. Also measures the two
 * Node-relevant strategies: `Buffer.from(hex,'hex')` and, where the
 * engine ships it, the native `Uint8Array.fromHex` intrinsic.
 *
 * Run:
 *   node hex-decode-bench-node.mjs
 * A longer, lower-noise run:
 *   HEX_BENCH_TARGET_MS=350 node hex-decode-bench-node.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const coreSrc = readFileSync(`${here}hex-decode-bench-core.js`, 'utf8');
(0, eval)(coreSrc); // installs globalThis.hexbench
const { hexbench } = globalThis;

const SIZES = [
  { name: 'short', bytes: 8 },
  { name: 'medium', bytes: 256 },
  { name: 'large', bytes: 1024 },
  { name: 'xlarge', bytes: 16384 },
];
const MODES = ['lower', 'upper', 'mixed'];
const SEED = 0x1234abcd;

for (const { name, bytes } of SIZES) {
  for (const mode of MODES) {
    const key = `${name}-${mode}`;
    hexbench.makeCorpus(key, bytes, mode, SEED);
    hexbench.checkCorrectness(key, bytes, SEED);
  }
}

const bufferDecodeHex = hex => {
  if (hex.length % 2 !== 0) throw new Error('odd length');
  const b = Buffer.from(hex, 'hex');
  if (b.byteLength !== hex.length / 2) throw new Error('invalid hex');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};
const nativeFromHex =
  typeof Uint8Array.fromHex === 'function'
    ? hex => Uint8Array.fromHex(hex)
    : undefined;

// Corpus mirror in this realm for the Buffer/native loops.
const localCorpus = Object.create(null);
{
  const makeBytes = (n, seed) => {
    const out = new Uint8Array(n);
    let s = seed >>> 0;
    for (let i = 0; i < n; i += 1) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      out[i] = (s >>> 16) & 0xff;
    }
    return out;
  };
  const enc = [];
  for (let b = 0; b < 256; b += 1) enc.push(b.toString(16).padStart(2, '0'));
  const caseVariant = (s, mode) => {
    if (mode === 'lower') return s;
    if (mode === 'upper') return s.toUpperCase();
    let out = '';
    for (let i = 0; i < s.length; i += 1)
      out += i % 2 === 0 ? s[i].toUpperCase() : s[i];
    return out;
  };
  for (const { name, bytes } of SIZES) {
    for (const mode of MODES) {
      const by = makeBytes(bytes, SEED);
      let hex = '';
      for (let i = 0; i < by.length; i += 1) hex += enc[by[i]];
      localCorpus[`${name}-${mode}`] = caseVariant(hex, mode);
    }
  }
}

const localLoop = (fn, key, iters) => {
  const hex = localCorpus[key];
  let sink = 0;
  for (let k = 0; k < iters; k += 1) {
    const out = fn(hex);
    sink = (sink + out[0] + out[out.length - 1]) & 0xffff;
  }
  return sink;
};

const now = () => Number(process.hrtime.bigint());
const TARGET_NS = Number(process.env.HEX_BENCH_TARGET_MS || 200) * 1e6;

const timeOp = run => {
  let iters = 64;
  for (;;) {
    const t0 = now();
    run(iters);
    const dt = now() - t0;
    if (dt >= TARGET_NS || iters >= 1 << 30) break;
    const scale = Math.max(2, Math.min(16, TARGET_NS / Math.max(dt, 1)));
    iters = Math.ceil(iters * scale);
  }
  run(iters);
  let best = Infinity;
  for (let rep = 0; rep < 5; rep += 1) {
    const t0 = now();
    run(iters);
    best = Math.min(best, (now() - t0) / iters);
  }
  return best;
};

const APPROACHES = [
  { key: 'native', run: (k, n) => localLoop(nativeFromHex, k, n) },
  { key: 'buffer', run: (k, n) => localLoop(bufferDecodeHex, k, n) },
  { key: 'map', run: (k, n) => hexbench.decodeLoop('map', k, n) },
  { key: 'arith', run: (k, n) => hexbench.decodeLoop('arith', k, n) },
  { key: 'lut', run: (k, n) => hexbench.decodeLoop('lut', k, n) },
].filter(a => a.key !== 'native' || nativeFromHex);

const results = [];
for (const { name, bytes } of SIZES) {
  for (const mode of MODES) {
    const key = `${name}-${mode}`;
    for (const a of APPROACHES) {
      const nsPerOp = timeOp(n => a.run(key, n));
      results.push({
        size: name,
        bytes,
        mode,
        approach: a.key,
        nsPerOp,
        mbPerSec: 1e3 / (nsPerOp / bytes),
      });
    }
  }
}

const pad = (s, w) => String(s).padEnd(w);
console.log('# Node hex decode throughput, MB/s (higher is better)\n');
console.log(
  `node ${process.version}, V8 ${process.versions.v8}; native Uint8Array.fromHex: ${!!nativeFromHex}\n`,
);
let header = `${pad('size', 8)}${pad('mode', 7)}`;
for (const a of APPROACHES) header += pad(a.key, 12);
console.log(header);
for (const { name } of SIZES) {
  for (const mode of MODES) {
    let row = `${pad(name, 8)}${pad(mode, 7)}`;
    for (const a of APPROACHES) {
      const r = results.find(
        x => x.size === name && x.mode === mode && x.approach === a.key,
      );
      row += pad(r.mbPerSec.toFixed(0), 12);
    }
    console.log(row);
  }
}
console.log(
  `\n#JSON ${JSON.stringify({ engine: 'node', version: process.version, native: !!nativeFromHex, tableSize: hexbench.tableSize, results })}`,
);
