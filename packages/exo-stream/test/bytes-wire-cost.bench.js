// @ts-nocheck
/**
 * Wire-cost + freeze/thaw round-trip harness for the direct-immutable-bytes
 * transport this package adopted (replacing the retired base64 framing).
 *
 * Not an ava test (the ava `files` glob is `test/**\/*.test.*`, which this file
 * deliberately does not match), so it never runs in CI. Run it directly:
 *
 *   node packages/exo-stream/test/bytes-wire-cost.bench.js
 *   CHUNK_BYTES=65536 ITER=2000 node packages/exo-stream/test/bytes-wire-cost.bench.js
 *
 * It reports two things, the pair DESIGN.md § Bytes Transport Decision and
 * BENCH.md quote:
 *
 *  1. Wire size. A passable `byteArray` marshals as hex (two wire characters
 *     per input byte); the retired transitional representation was base64 (four
 *     characters per three bytes). The ratio is exact and engine-independent, so
 *     it is computed analytically rather than measured.
 *  2. Freeze/thaw round-trip time. `frozenBytes()` on send and `thawedBytes()`
 *     on receive each copy the whole chunk; this is the per-chunk CPU cost the
 *     base64 path did not pay in the same shape. Timed over ITER iterations.
 */
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';

const CHUNK_BYTES = Number(process.env.CHUNK_BYTES || 65_536);
const ITER = Number(process.env.ITER || 2000);
const WARMUP = 50;

/** @param {number} n */
const hexWireChars = n => n * 2;
/** @param {number} n */
const base64WireChars = n => 4 * Math.ceil(n / 3);

/** @param {number} n */
const makeChunk = n => {
  const bytes = new Uint8Array(n);
  // A cheap deterministic fill; the codec cost is value-independent, so a plain
  // ramp over the byte range is sufficient (and avoids bitwise ops the lint bans).
  for (let i = 0; i < n; i += 1) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return bytes;
};

const roundTrip = bytes => thawedBytes(frozenBytes(bytes));

const main = () => {
  const chunk = makeChunk(CHUNK_BYTES);

  const hex = hexWireChars(CHUNK_BYTES);
  const b64 = base64WireChars(CHUNK_BYTES);

  for (let i = 0; i < WARMUP; i += 1) roundTrip(chunk);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITER; i += 1) roundTrip(chunk);
  const t1 = process.hrtime.bigint();

  const nsTotal = Number(t1 - t0);
  const nsPerOp = nsTotal / ITER;
  const mbPerSec = CHUNK_BYTES / (nsPerOp / 1e9) / (1024 * 1024);

  console.log(`chunk bytes       : ${CHUNK_BYTES}`);
  console.log(`iterations        : ${ITER}`);
  console.log(
    `wire chars (hex)  : ${hex}  (direct immutable byteArray, current)`,
  );
  console.log(`wire chars (base64): ${b64}  (retired transitional)`);
  console.log(`wire ratio        : ${(hex / b64).toFixed(3)}x`);
  console.log(`freeze+thaw / op  : ${nsPerOp.toFixed(0)} ns`);
  console.log(`freeze+thaw thru  : ${mbPerSec.toFixed(0)} MiB/s`);
};

main();
