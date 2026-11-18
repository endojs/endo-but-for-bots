// @ts-check
/**
 * Client endpointing, barge-in and meter constants (spec R5-19..R5-33;
 * `designs/m11-interfaces.md` section 9). Read by `ui/src/voice/` only.
 * Endpointing is the client's (R5-1): the server does no voice-activity
 * detection.
 */

export const endpointingDefaults = Object.freeze({
  /** R5-24: the first window only measures; the floor is its 75th percentile (R5-19). */
  calibrationMs: 1000,
  calibrationPercentile: 0.75,
  /** R5-25: threshold = max(minimum, floor x multiplier). */
  thresholdMultiplier: 2.5,
  thresholdMinimum: 0.01,
  /** R5-26: moving-average factor of the floor while quiet. */
  floorDrift: 0.01,
  /** R5-27: trailing silence that ends an utterance (END is sent). */
  trailingSilenceMs: 1200,
  /** R5-28: wait after the final before sending what the box holds. */
  graceMs: 800,
  /** R5-29: shorter utterances are aborted and nothing is sent. */
  minimumSpeechMs: 400,
  /** R5-30: blocks kept before onset and sent first (about 0.5 s). */
  preRollBlocks: 6,
  /** R5-31: onset threshold while a turn is busy: max(minimum, floor x multiplier). */
  bargeInMultiplier: 3,
  bargeInMinimum: 0.05,
  /** R5-32: a further factor while the page's own speech is audible. */
  echoBargeInFactor: 2,
  /** R5-33: the level meter's full scale (RMS). */
  meterFullScale: 0.1,
});

/**
 * R5-21: a final, lower-cased with trailing punctuation removed, shorter
 * than `junkMinLength` or equal to one of these, is discarded.
 */
export const junkFinals = Object.freeze([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thanks',
  'you',
  'bye',
  'okay',
  'ok',
  'um',
  'uh',
  '.',
]);
export const junkMinLength = 2;

/** Capture: the worklet posts one block per this many 16 kHz samples (about 85 ms, R5-3). */
export const captureBlockSamples = 1360;

/** Capture constraints (R5-3): echo cancellation, noise suppression, automatic gain. */
export const captureConstraints = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
});

/** R6-14 style backoff for re-opening the audio socket after it closed (ms). */
export const audioReconnectDelaysMs = Object.freeze([0, 1000, 2000, 5000]);
