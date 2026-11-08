// @ts-check
import { E } from '@endo/eventual-send';

// Petname where whole-Floot voice/TTS preferences (voice, speed, expression…)
// are persisted. These are a property of the Floot instance — shared across
// every session and every device — not of any one session or browser.
const VOICE_PREFS_NAME = 'floot-voice-preferences';

// Only these keys are accepted from a client and mirrored to the petstore, each
// held to its expected type. Anything else is dropped, so a malformed client
// can't poison the stored preferences. The TTS capability still validates
// values against its own ranges at synthesis time.
const VOICE_PREF_NUMERIC_KEYS = harden([
  'speed',
  'noiseScale',
  'noiseW',
  'sentenceSilence',
]);
// Piper voice ids run to a few dozen characters; anything longer is not one.
const MAX_VOICE_ID_LENGTH = 128;

/**
 * A finite number, or a non-blank string that parses as one (a form control's
 * value); anything else is `undefined`. Not `Number()` alone: '' and null
 * would read as 0, true as 1, an array as its element, and a symbol throws.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
const finiteNumberOf = value => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/**
 * @param {unknown} input
 * @returns {Record<string, string | number>}
 */
const sanitizeVoicePrefs = input => {
  /** @type {Record<string, string | number>} */
  const clean = {};
  if (input && typeof input === 'object') {
    const prefs = /** @type {Record<string, unknown>} */ (input);
    if (
      typeof prefs.voice === 'string' &&
      prefs.voice.length <= MAX_VOICE_ID_LENGTH
    ) {
      clean.voice = prefs.voice;
    }
    for (const key of VOICE_PREF_NUMERIC_KEYS) {
      const value = finiteNumberOf(prefs[key]);
      if (value !== undefined) {
        clean[key] = value;
      }
    }
  }
  return clean;
};
harden(sanitizeVoicePrefs);

/** @param {any} powers */
export const makeVoicePreferences = powers => {
  // Whole-Floot voice/TTS preferences, kept in the factory's own petstore. A
  // single small record: `storeValue` overwrites a pet name in place, so a
  // write is one atomic store and needs none of the registry's journaling. The
  // load is memoized on its promise and every read-merge-write runs on one
  // chain, so two devices changing different knobs at once both land, and the
  // in-memory copy only ever reflects what the petstore holds.
  /** @type {Record<string, string | number> | undefined} */
  let voicePrefs;
  /** @type {Promise<Record<string, string | number>> | undefined} */
  let voicePrefsLoadP;
  const loadVoicePrefs = () => {
    if (voicePrefs) return Promise.resolve(voicePrefs);
    if (!voicePrefsLoadP) {
      voicePrefsLoadP = (async () => {
        const stored = await E(powers).has(VOICE_PREFS_NAME);
        if (!stored) {
          voicePrefs = {};
          return voicePrefs;
        }
        const record = await E(powers).lookup(VOICE_PREFS_NAME);
        voicePrefs = sanitizeVoicePrefs(record);
        return voicePrefs;
      })().catch(error => {
        voicePrefsLoadP = undefined;
        throw error;
      });
    }
    return voicePrefsLoadP;
  };
  /** @type {Promise<void>} */
  let voicePrefsWrite = Promise.resolve();
  /**
   * Merge an already-sanitized patch into the stored record and persist it.
   *
   * @param {Record<string, string | number>} patch
   * @returns {Promise<Record<string, string | number>>} the persisted record
   */
  const updateVoicePrefs = patch => {
    const result = voicePrefsWrite.then(async () => {
      const current = await loadVoicePrefs();
      const next = { ...current, ...patch };
      await E(powers).storeValue(harden({ ...next }), VOICE_PREFS_NAME);
      voicePrefs = next;
      return harden({ ...next });
    });
    // Preserve the rejection for the caller while keeping later writes possible.
    voicePrefsWrite = result.then(
      () => undefined,
      error => {
        console.error('[floot-factory] voice preferences save failed:', error);
      },
    );
    return result;
  };

  return harden({
    get: loadVoicePrefs,
    set: patch => updateVoicePrefs(sanitizeVoicePrefs(patch)),
    drain: () => voicePrefsWrite,
  });
};
harden(makeVoicePreferences);
