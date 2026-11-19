// @ts-check
/**
 * Gapless playback of a stream's PCM (`designs/m11-interfaces.md`
 * section 9; R5-43, R5-44, R5-48). Each PCM frame is decoded at its own
 * sample rate (0 means `defaultPlaybackSampleRate`) and scheduled at
 * max(now, end of the previous chunk), so chunks play back to back however
 * the server cut them. One track plays at a time: `begin()` stops the
 * previous one, as does `stop()` (mute, barge-in, Stop).
 *
 * `unlock()` creates or resumes the `AudioContext`; call it inside the
 * mic, speaker or Send tap (R5-44), since a reply starts later from a
 * timer, not a gesture. Without Web Audio (a stripped-down webview) the
 * player stays silent and replies stay text.
 *
 * `audible()` is true while scheduled audio extends past the present (the
 * endpointer's echo factor, R5-32); `onChange(playing)` fires when the
 * player starts or stops sounding (the wake lock, the speaker control).
 */
import { defaultPlaybackSampleRate } from '../../../resources/agent-host/impl/speech/audio-protocol.js';

/**
 * @typedef {object} Track
 * @property {(sampleRate: number, pcm: Uint8Array) => void} pcm one PCM
 *   frame's samples (s16le mono)
 * @property {() => boolean} current whether this is still the playing
 *   track
 */

/**
 * @typedef {object} Player
 * @property {() => Promise<void>} unlock
 * @property {() => Track} begin
 * @property {() => void} stop
 * @property {() => boolean} audible
 * @property {() => boolean} playing
 */

/**
 * s16le bytes to samples in [-1, 1).
 *
 * @param {Uint8Array} bytes an even length
 * @param {Float32Array} into
 */
export const decodePcm = (bytes, into) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const frames = Math.min(into.length, Math.floor(bytes.length / 2));
  for (let i = 0; i < frames; i += 1) {
    into[i] = view.getInt16(i * 2, true) / 32_768;
  }
  return frames;
};
harden(decodePcm);

/**
 * @param {object} [options]
 * @param {() => any} [options.makeContext] `() => new AudioContext()`
 * @param {(playing: boolean) => void} [options.onChange]
 * @returns {Player}
 */
export const makePlayer = ({
  makeContext = () => new /** @type {any} */ (globalThis).AudioContext(),
  onChange = () => {},
} = {}) => {
  /** @type {any} */
  let context;
  let unavailable = false;
  let generation = 0;
  let nextStart = 0;
  /** @type {Set<any>} */
  const sources = new Set();
  let sounding = false;

  /** @param {boolean} next */
  const setSounding = next => {
    if (sounding === next) return;
    sounding = next;
    onChange(next);
  };

  const ensure = () => {
    if (!context && !unavailable) {
      try {
        context = makeContext();
      } catch {
        unavailable = true;
      }
    }
    return context;
  };

  const stopSources = () => {
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    sources.clear();
    nextStart = 0;
    setSounding(false);
  };

  /**
   * @param {number} mine
   * @param {number} sampleRate
   * @param {Uint8Array} bytes whole samples
   */
  const schedule = (mine, sampleRate, bytes) => {
    const ctx = context;
    if (!ctx || mine !== generation) return;
    const frames = Math.floor(bytes.length / 2);
    if (frames === 0) return;
    const rate = sampleRate > 0 ? sampleRate : defaultPlaybackSampleRate;
    const buffer = ctx.createBuffer(1, frames, rate);
    decodePcm(bytes, buffer.getChannelData(0));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStart);
    source.start(startAt);
    nextStart = startAt + buffer.duration;
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      if (sources.size === 0) setSounding(false);
    };
    setSounding(true);
  };

  return harden({
    unlock() {
      const ctx = ensure();
      if (ctx && ctx.state === 'suspended') {
        return Promise.resolve(ctx.resume()).catch(() => {});
      }
      return Promise.resolve();
    },
    begin() {
      generation += 1;
      stopSources();
      ensure();
      const mine = generation;
      /** @type {Uint8Array | undefined} */
      let carry;
      return harden({
        pcm(sampleRate, pcm) {
          if (mine !== generation) return;
          let bytes = pcm;
          if (carry) {
            bytes = new Uint8Array(carry.length + pcm.length);
            bytes.set(carry);
            bytes.set(pcm, carry.length);
            carry = undefined;
          }
          if (bytes.length % 2 === 1) {
            carry = bytes.slice(bytes.length - 1);
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          schedule(mine, sampleRate, bytes);
        },
        current: () => mine === generation,
      });
    },
    stop() {
      generation += 1;
      stopSources();
    },
    audible: () => Boolean(context) && nextStart > Number(context.currentTime),
    playing: () => sounding,
  });
};
harden(makePlayer);
