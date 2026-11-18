// @ts-check
/**
 * Voice preferences and the voice shortcut: fields, defaults, ranges,
 * bounds and fixed texts (`designs/m11-interfaces.md` sections 3.1 and 15;
 * spec R5-41, R5-42, R5-50, R5-53, R5-54, R6-60, G-11).
 *
 * Read by the factory vat (`guest/factory/voice.js`), the adapter's speech
 * host (`AH/speech/`, which re-checks options at synthesis, R5-54) and the
 * browser (`ui/src/voice/`). Plain frozen data and pure text functions: no
 * prelude global, so every program and the browser bundle may import it.
 * The guards that use these values are in `guest/lib/guards/factory.js`
 * (`Voice`, `VoicePreferences`, ...) and `guest/lib/speech-guards.js`
 * (`TtsOptions`).
 */

/** The preference fields, in display order (R5-54). */
export const voicePreferenceFields = Object.freeze([
  'voice',
  'speed',
  'noiseScale',
  'noiseW',
  'sentenceSilence',
]);

/** The numeric options and their ranges (R5-42): min, max, step. */
export const ttsRanges = Object.freeze({
  speed: Object.freeze({ min: 0.25, max: 4, step: 0.05 }),
  noiseScale: Object.freeze({ min: 0, max: 2, step: 0.05 }),
  noiseW: Object.freeze({ min: 0, max: 2, step: 0.05 }),
  sentenceSilence: Object.freeze({ min: 0, max: 5, step: 0.05 }),
});

/** Built-in defaults (R5-42, R5-39); the configured service defaults come first (R5-55). */
export const ttsDefaults = Object.freeze({
  voice: 'en_US-amy-medium',
  speed: 1,
  noiseScale: 0.667,
  noiseW: 0.8,
  sentenceSilence: 0.2,
});

/** Bounds of the voice records (UTF-16 units unless stated). */
export const voiceLimits = Object.freeze({
  /** R5-54: a voice id. */
  voiceUnits: 128,
  /** R6-60: an invocation id (a client idempotency key, F.2 e). */
  invocationIdUnits: 128,
  /** R6-60: invocation claims kept, oldest forgotten first (Endo's bound of 32). */
  invocationClaims: 32,
  /** A speech setting text (a URL, a model name, a language). */
  settingUnits: 2048,
  /** One argument of a process engine command. */
  commandArgUnits: 4096,
  /** Arguments of a process engine command. */
  commandArgs: 32,
  /** Voices an `openai-audio` speech-out setting lists. */
  providerVoices: 64,
  /** R5-50: the client debounces a settings change this long (ms). */
  settingsDebounceMs: 300,
});

/** The built-in preset the voice shortcut uses until one is chosen (R5-53, R3-13). */
export const voiceShortcutDefaultLabel = 'voice';

/**
 * Fixed texts of the factory's `Voice` object. The factory throws them as
 * `Error(text)`; the page shows them as they are.
 */
export const voiceTexts = Object.freeze({
  /** setPreferences with a value that is not a finite number in range. */
  preferenceOutOfRange: 'Voice preference out of range',
  /** setVoicePreset with a preset of another catalogue, or deleted. */
  presetNotUsable: 'This preset cannot be used for the voice shortcut',
  /** R6-60: a launch with an invocation id whose session is still being created. */
  launchInProgress: 'This voice launch is already starting',
  /** configureSpeech with a direction whose settings do not fit its kind. */
  speechSettingsInvalid: 'Speech settings are not valid for their kind',
});

/** Templated texts of the factory's `Voice` object. */
export const voiceTextOf = Object.freeze({
  /**
   * G-11 (owner decision 14 default): the voice preset's pinned model left
   * its backend's catalogue; the session was made on the factory default.
   * @param {string} modelId
   */
  voiceModelUnavailable: modelId =>
    `The voice preset's model ${modelId} is not available; this session uses the default model instead`,
});
