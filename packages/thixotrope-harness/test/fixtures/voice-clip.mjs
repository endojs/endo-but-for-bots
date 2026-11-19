// @ts-check
/**
 * A synthetic 16 kHz mono s16le clip (`designs/m11-interfaces.md`
 * appendix B), for transport, endpointing and perf tests: tone bursts where
 * someone speaks, a low noise floor elsewhere. Deterministic (a fixed
 * pseudo-random noise), so a test can compare byte counts and levels.
 *
 *   makeClip({ seconds, speechAtMs, silenceAtMs }) -> Uint8Array
 *   levelsOf(clip) -> number[]   the RMS (0..1) of each 85 ms block
 *   blocksOf(clip) -> Uint8Array[]   the clip cut into 85 ms blocks
 *
 * `speechAtMs` lists the start of each burst and `silenceAtMs` the end of
 * each, pairwise (a burst without an end runs to the clip's end). Plain
 * data; no SES needed.
 */

/** The speech-in sample rate (`audio-protocol.js` `sttFormat`). */
export const CLIP_RATE = 16_000;
/** Samples of one 85 ms capture block (R5-3). */
export const BLOCK_SAMPLES = 1360;
/** Bytes of one block. */
export const BLOCK_BYTES = BLOCK_SAMPLES * 2;

/** Peak of a burst (about -12 dBFS) and of the noise floor (about -60 dBFS). */
const TONE_PEAK = 8000;
const NOISE_PEAK = 30;

/**
 * @param {object} [options]
 * @param {number} [options.seconds] default 3
 * @param {number[]} [options.speechAtMs] burst starts (default [500])
 * @param {number[]} [options.silenceAtMs] burst ends (default [2000])
 * @param {number} [options.toneHz] default 220
 * @returns {Uint8Array}
 */
export const makeClip = ({
  seconds = 3,
  speechAtMs = [500],
  silenceAtMs = [2000],
  toneHz = 220,
} = {}) => {
  const samples = Math.round(seconds * CLIP_RATE);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  const bursts = speechAtMs.map((start, i) => [
    Math.round((start * CLIP_RATE) / 1000),
    Math.round(((silenceAtMs[i] ?? seconds * 1000) * CLIP_RATE) / 1000),
  ]);
  let seed = 12_345;
  for (let n = 0; n < samples; n += 1) {
    // A linear congruential generator: a fixed noise floor.
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const noise = (seed / 2_147_483_648 - 0.5) * 2 * NOISE_PEAK;
    const speaking = bursts.some(([from, to]) => n >= from && n < to);
    const tone = speaking
      ? Math.sin((2 * Math.PI * toneHz * n) / CLIP_RATE) * TONE_PEAK
      : 0;
    view.setInt16(n * 2, Math.round(tone + noise), true);
  }
  return bytes;
};

/**
 * The clip cut into 85 ms blocks (the last one may be shorter).
 * @param {Uint8Array} clip
 * @returns {Uint8Array[]}
 */
export const blocksOf = clip => {
  /** @type {Uint8Array[]} */
  const blocks = [];
  for (let at = 0; at < clip.length; at += BLOCK_BYTES) {
    blocks.push(clip.subarray(at, Math.min(clip.length, at + BLOCK_BYTES)));
  }
  return blocks;
};

/**
 * The RMS level (0..1 of full scale) of each 85 ms block.
 * @param {Uint8Array} clip
 * @returns {number[]}
 */
export const levelsOf = clip =>
  blocksOf(clip).map(block => {
    const view = new DataView(block.buffer, block.byteOffset, block.length);
    const n = Math.floor(block.length / 2);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = view.getInt16(i * 2, true) / 32_768;
      sum += v * v;
    }
    return n === 0 ? 0 : Math.sqrt(sum / n);
  });
