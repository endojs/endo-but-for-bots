// @ts-check
/**
 * Client endpointing (`designs/m11-interfaces.md` section 9; R5-19..R5-33,
 * R5-46): pure objects driven by the capture's blocks and a clock the
 * caller passes in. Nothing here touches the microphone, the socket or a
 * timer, so every rule is tested with synthetic level sequences.
 *
 * - `makeEndpointer` decides, per 85 ms block, whether an utterance opens,
 *   continues, ends (END) or is discarded (ABORT), from the block's RMS:
 *   calibration for `calibrationMs`, then a floor at its 75th percentile;
 *   threshold max(minimum, floor x multiplier); the floor drifts while
 *   quiet; while a turn is busy the onset must pass the barge-in threshold,
 *   and while the page's own speech is audible that times the echo factor.
 *   Invocation mode skips calibration and opens at once (R5-23). Speech is
 *   measured from the onset block to the last block above the threshold.
 * - `makePreRoll` keeps the last `preRollBlocks` blocks before an onset, so
 *   the word's start is sent first (R5-30).
 * - `keptFinal` is the junk filter (R5-21).
 * - `makeSpokenDraft` holds the kept text of a mic session and decides the
 *   grace send (R5-22): the box is the buffer, so edits are what is sent
 *   and clearing it cancels.
 */
import {
  endpointingDefaults,
  junkFinals,
  junkMinLength,
} from './endpointing-defaults.js';

/** Calibration levels kept at most (a 1 s window holds about 12 blocks). */
const CALIBRATION_SAMPLES = 1024;

/**
 * What to do with one block:
 * - `calibrating`, `quiet`, `paused`: nothing is open; keep the block in the
 *   pre-roll (`send` false);
 * - `onset`: open an utterance (cancel a pending grace send, stop playback),
 *   send the pre-roll, then this block; `bargeIn` when a turn was busy
 *   (R5-46: show "continuing in background…");
 * - `speech`: send this block to the open utterance;
 * - `end`: send this block, then END;
 * - `discard`: the utterance was shorter than `minimumSpeechMs`: ABORT it
 *   and send nothing.
 *
 * `level`, `floor` and `threshold` feed the meter's markers (R5-56).
 *
 * @typedef {object} EndpointDecision
 * @property {'calibrating' | 'quiet' | 'paused' | 'onset' | 'speech' | 'end' | 'discard'} action
 * @property {boolean} send whether this block belongs to the utterance
 * @property {boolean} bargeIn
 * @property {number} level
 * @property {number} floor
 * @property {number} threshold the speech threshold now
 */

/**
 * @typedef {object} Endpointer
 * @property {(rms: number, atMs: number) => EndpointDecision} block
 * @property {() => boolean} pause the page was hidden (R5-19): stop
 *   detecting; answers whether an utterance was open (the caller aborts it)
 * @property {() => void} resume detect again, after a new calibration
 * @property {() => boolean} speaking whether an utterance is open
 */

/**
 * @param {typeof endpointingDefaults} [defaults]
 * @param {object} [options]
 * @param {boolean} [options.immediate] invocation mode (R5-23)
 * @param {() => boolean} [options.busy] a turn of this session runs
 * @param {() => boolean} [options.audible] the page's own speech is audible
 * @returns {Endpointer}
 */
export const makeEndpointer = (
  defaults = endpointingDefaults,
  { immediate = false, busy = () => false, audible = () => false } = {},
) => {
  /** @type {'calibrating' | 'quiet' | 'speaking' | 'paused'} */
  let phase = immediate ? 'quiet' : 'calibrating';
  let openAtOnce = immediate;
  let floor = 0;
  /** @type {number | undefined} */
  let calibrationStart;
  /** @type {number[]} */
  let samples = [];
  let onsetAt = 0;
  let lastLoudAt = 0;
  /** @type {number | undefined} */
  let silenceSince;

  const speechThreshold = () =>
    Math.max(defaults.thresholdMinimum, floor * defaults.thresholdMultiplier);

  /**
   * @param {EndpointDecision['action']} action
   * @param {number} level
   * @param {{ send?: boolean, bargeIn?: boolean }} [extra]
   * @returns {EndpointDecision}
   */
  const decide = (action, level, { send = false, bargeIn = false } = {}) =>
    harden({
      action,
      send,
      bargeIn,
      level,
      floor,
      threshold:
        phase === 'calibrating' ? defaults.thresholdMinimum : speechThreshold(),
    });

  /**
   * @param {number} level
   * @param {number} atMs
   */
  const open = (level, atMs) => {
    const bargeIn = busy();
    phase = 'speaking';
    onsetAt = atMs;
    lastLoudAt = atMs;
    silenceSince = undefined;
    return decide('onset', level, { send: true, bargeIn });
  };

  /**
   * @param {number} rms
   * @param {number} atMs
   */
  const block = (rms, atMs) => {
    const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
    if (phase === 'paused') return decide('paused', level);
    if (phase === 'calibrating') {
      if (calibrationStart === undefined) calibrationStart = atMs;
      if (samples.length < CALIBRATION_SAMPLES) samples.push(level);
      if (atMs - calibrationStart < defaults.calibrationMs) {
        return decide('calibrating', level);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      floor =
        sorted[
          Math.min(
            sorted.length - 1,
            Math.floor(sorted.length * defaults.calibrationPercentile),
          )
        ] || 0;
      samples = [];
      calibrationStart = undefined;
      phase = 'quiet';
      return decide('quiet', level);
    }
    if (phase === 'quiet') {
      if (openAtOnce) {
        openAtOnce = false;
        return open(level, atMs);
      }
      const speech = speechThreshold();
      const barge = Math.max(
        defaults.bargeInMinimum,
        speech * defaults.bargeInMultiplier,
      );
      let onset = busy() ? barge : speech;
      if (audible())
        onset = Math.max(onset, barge * defaults.echoBargeInFactor);
      if (level > onset) return open(level, atMs);
      if (level < speech) {
        floor = (1 - defaults.floorDrift) * floor + defaults.floorDrift * level;
      }
      return decide('quiet', level);
    }
    // speaking
    if (level > speechThreshold()) {
      lastLoudAt = atMs;
      silenceSince = undefined;
      return decide('speech', level, { send: true });
    }
    if (silenceSince === undefined) silenceSince = atMs;
    if (atMs - silenceSince < defaults.trailingSilenceMs) {
      return decide('speech', level, { send: true });
    }
    phase = 'quiet';
    silenceSince = undefined;
    if (lastLoudAt - onsetAt < defaults.minimumSpeechMs) {
      return decide('discard', level);
    }
    return decide('end', level, { send: true });
  };

  return harden({
    block,
    pause() {
      const wasSpeaking = phase === 'speaking';
      phase = 'paused';
      silenceSince = undefined;
      return wasSpeaking;
    },
    resume() {
      if (phase !== 'paused') return;
      phase = 'calibrating';
      openAtOnce = false;
      calibrationStart = undefined;
      samples = [];
    },
    speaking: () => phase === 'speaking',
  });
};
harden(makeEndpointer);

/**
 * The blocks before an onset (R5-30): the last `blocks` pushed.
 *
 * @param {number} [blocks]
 */
export const makePreRoll = (blocks = endpointingDefaults.preRollBlocks) => {
  /** @type {Uint8Array[]} */
  let kept = [];
  return harden({
    /** @param {Uint8Array} pcm */
    push(pcm) {
      kept.push(pcm);
      if (kept.length > blocks) kept.shift();
    },
    /** The kept blocks, oldest first; the pre-roll is then empty. */
    take() {
      const taken = kept;
      kept = [];
      return taken;
    },
  });
};
harden(makePreRoll);

const junk = new Set(junkFinals);

/**
 * The junk filter (R5-21): the final's text, trimmed, or `''` when it is
 * junk (lower-cased with trailing punctuation removed: shorter than
 * `junkMinLength` or one of `junkFinals`).
 *
 * @param {string} text
 */
export const keptFinal = text => {
  const trimmed = String(text ?? '').trim();
  const norm = trimmed
    .toLowerCase()
    .replace(/[.!?,]+$/u, '')
    .trim();
  if (norm.length < junkMinLength || junk.has(norm)) {
    return '';
  }
  return trimmed;
};
harden(keptFinal);

/**
 * @param {string} before
 * @param {string} after
 */
const joined = (before, after) =>
  before && after ? `${before} ${after}` : before || after;

/**
 * The kept text of one mic session and its grace send (R5-20, R5-22).
 * Every method answers what the compose box shows now (`box`), so the
 * caller writes it with `controller.replaceInput`; `sendAt` is when to call
 * `due` (the caller's timer), absent when no send is armed. `mirrors`
 * answers whether a box still shows what dictation last wrote (M11 9.1:
 * such a text sent by hand is dictated text).
 *
 * @param {{ graceMs?: number }} [options]
 */
export const makeSpokenDraft = ({
  graceMs = endpointingDefaults.graceMs,
} = {}) => {
  let pending = '';
  /** What dictation last wrote to the box ('' once sent or discarded). */
  let shown = '';
  /** @type {number | undefined} */
  let sendAt;
  const state = () => {
    shown = pending;
    return harden({ box: pending, sendAt });
  };
  return harden({
    /** An utterance opened: a pending send waits for its final (R5-20). */
    onset() {
      sendAt = undefined;
      return state();
    },
    /**
     * A partial transcript (the whole utterance so far, R5-14).
     *
     * @param {string} text
     */
    partial(text) {
      shown = joined(pending, String(text ?? '').trim());
      return harden({ box: shown, sendAt });
    },
    /**
     * The utterance's final: kept text joins the pending text and the grace
     * starts.
     *
     * @param {string} text
     * @param {number} atMs
     */
    final(text, atMs) {
      pending = joined(pending, keptFinal(text));
      sendAt = pending ? atMs + graceMs : undefined;
      return state();
    },
    /**
     * The utterance was discarded or aborted: the pending text, if any, is
     * armed again.
     *
     * @param {number} atMs
     */
    dropped(atMs) {
      sendAt = pending ? atMs + graceMs : undefined;
      return state();
    },
    /**
     * The grace timer fired: the text to send, or undefined. What the box
     * holds is sent (edits kept); an empty box cancels; nothing is sent
     * when the mic is off or an utterance is open (R5-22).
     *
     * @param {number} atMs
     * @param {{ box: string, micOn: boolean, utteranceOpen: boolean }} now
     * @returns {string | undefined}
     */
    due(atMs, { box, micOn, utteranceOpen }) {
      if (sendAt === undefined || atMs < sendAt) return undefined;
      sendAt = undefined;
      const text = String(box ?? '').trim();
      if (!text || !micOn) {
        pending = '';
        shown = '';
        return undefined;
      }
      if (utteranceOpen) return undefined;
      pending = '';
      shown = '';
      return text;
    },
    /**
     * Whether `box` still shows exactly what dictation last wrote (trimmed).
     *
     * @param {string} box
     */
    mirrors(box) {
      return shown !== '' && String(box ?? '').trim() === shown.trim();
    },
    /**
     * The mic went off (R5-48): the unsent text is dropped. Answers whether
     * the box still shows only that text (the caller clears it then; a box
     * the user typed into is left alone).
     *
     * @param {string} box
     */
    discard(box) {
      const mirror = pending !== '' && String(box ?? '') === pending;
      pending = '';
      shown = '';
      sendAt = undefined;
      return mirror;
    },
  });
};
harden(makeSpokenDraft);

/**
 * The meter's fill for a level (R5-33), from 0 to 1.
 *
 * @param {number} level
 * @param {number} [fullScale]
 */
export const meterFraction = (
  level,
  fullScale = endpointingDefaults.meterFullScale,
) => (Number.isFinite(level) && level > 0 ? Math.min(1, level / fullScale) : 0);
harden(meterFraction);
