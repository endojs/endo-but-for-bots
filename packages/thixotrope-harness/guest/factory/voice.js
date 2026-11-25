// @ts-check
/**
 * The factory vat's `Voice` (`designs/m11-interfaces.md` sections 3.1, 5.1;
 * D-M11-8, D-M11-9, D-M11-19, D-M11-21, D-M11-25; spec R5-53, R5-54,
 * R6-60, G-11): the shared voice preferences, the voice shortcut's preset,
 * the launch claims and the speech settings.
 *
 * `makeVoice` is called once by `makeFactoryKit` and answers `{ facet,
 * configureSpeech }`: `Operator.getVoice()` answers `facet` (pages and the
 * speech host reach it through the gateway); `HarnessRoot.configureSpeech`
 * calls `configureSpeech` (the provisioning path only, never a page:
 * D-M11-21). Audio, transcripts and engines never come here (D-M11-1).
 *
 * Everything kept is bounded: five preference fields, one preset
 * reference, at most `voiceLimits.invocationClaims` launch claims (the
 * oldest forgotten first), two speech direction records and a revision.
 * Each write is one crank, so a SIGKILL leaves the old or the new record.
 *
 * Guest rules: prelude globals only; no clock (a claim is stamped with the
 * daemon start count, `starts.js`).
 */
import { interfaces, texts } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';
import {
  ttsRanges,
  voiceLimits,
  voiceShortcutDefaultLabel,
  voiceTextOf,
  voiceTexts,
} from '../lib/voice-preferences.js';
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { PresetCatalogKit } from './presets.js' */
/** @import { RowTable } from './rows.js' */
/** @import { HarnessSettings } from './root.js' */
/** @import { StartCount } from './starts.js' */
/** @import { PinnedBackend } from './session-options.js' */
const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The largest estimated size (string units x 3) of the speech settings
 * `configureSpeech` keeps, so `Voice.speechSettings()` always fits one
 * frame with room for its envelope (section 1.4).
 */
export const speechSettingsBytes = limits.frameBytes - 2048;

/** The settings of a harness nobody configured: both directions off. */
const SPEECH_OFF = harden({
  speechIn: { kind: 'off' },
  speechOut: { kind: 'off' },
  revision: 0,
});

/**
 * String units of a plain record of the speech settings shape (strings,
 * lists of strings and nested records; objects such as a `ReadGrant` count
 * nothing).
 * @param {unknown} value
 * @returns {number}
 */
const unitsOf = value => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + unitsOf(v), 0);
  if (typeof value !== 'object' || value === null) return 0;
  if (Object.getPrototypeOf(value) !== Object.prototype) return 0;
  return Object.values(value).reduce((n, v) => n + unitsOf(v), 0);
};

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [range]
 */
const finiteIn = (value, { min = 0, max = Infinity } = {}) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

/**
 * Per kind beyond the guard's shape: a process engine has a program to
 * run; a default speed is a finite number in range (R5-42).
 * @param {any} direction a `SpeechInSettings` or `SpeechOutSettings`
 */
const directionValid = direction => {
  if (direction.kind === 'off') return true;
  if (direction.kind === 'process' && direction.command.length === 0)
    return false;
  if (direction.kind === 'openai-audio' && direction.baseUrl === '')
    return false;
  if (direction.defaultSpeed !== undefined)
    return finiteIn(direction.defaultSpeed, ttsRanges.speed);
  return true;
};

/**
 * @param {object} powers
 * @param {PresetCatalogKit} powers.catalog M5's preset catalogue kit
 * @param {(options: Record<string, any>, pinned?: PinnedBackend) => Promise<any>} powers.create the
 *   kit's local `createSession` (a local call: answers the `Session`)
 * @param {RowTable} powers.rows `ofSession(session).key`
 * @param {HarnessSettings} [powers.settings] the default backend and model
 *   (G-11's fallback)
 * @param {StartCount} powers.starts the factory's one count of daemon
 *   starts (read only: `current()`)
 */
export const makeVoice = ({ catalog, create, rows, settings, starts }) => {
  /** @type {Record<string, any>} R5-54: at most the five fields */
  let preferences = harden({});
  /** The shortcut's preset (R5-53), until one is chosen the built-in. */
  /** @type {any} */
  let shortcut;
  /**
   * R6-60: launch claims by invocation id, oldest first (a `Map` keeps
   * insertion order). A claim is replaced, never mutated, so a creation
   * that finishes after its claim was re-run or forgotten writes nothing.
   * @type {Map<string, { state: 'creating', start: number } | { state: 'made', session: any, key: string }>}
   */
  const claims = new Map();
  /** @type {any} */
  let speech = SPEECH_OFF;

  /** @param {any} preset */
  const usable = preset => {
    try {
      catalog.recordOf(preset);
      return true;
    } catch {
      return false;
    }
  };

  /** The chosen preset while it is live, else the built-in `voice`. */
  const shortcutPreset = () =>
    shortcut !== undefined && usable(shortcut)
      ? shortcut
      : catalog.builtIn(voiceShortcutDefaultLabel);

  /** @param {string} id */
  const forgetOldest = id => {
    while (claims.size > voiceLimits.invocationClaims) {
      const [oldest] = claims.keys();
      if (oldest === id) break;
      claims.delete(oldest);
    }
  };

  /**
   * Section 3.1 step 2: the creation options from the shortcut preset; a
   * pinned model its backend refuses falls back to the factory default
   * with a warning (G-11, D-M11-9: by asking, never by reading a text).
   * @param {{ title?: string, at?: number }} request
   */
  const creationOf = async ({ title, at }) => {
    const preset = shortcutPreset();
    const record = catalog.recordOf(preset);
    /** @type {Record<string, any>} */
    // No `spoken` flag since M11 9.1: a Talk session gets the plain system
    // prompt; spoken mode is the page's, carried per message.
    const options = { preset };
    if (title !== undefined) options.title = title;
    if (at !== undefined) options.at = at;
    /** @type {string | undefined} */
    let warning;
    const { backend, modelId } = record;
    if (backend !== undefined && modelId !== undefined) {
      // Fetch both current catalogue answers for this invocation. A fallback
      // or a concurrent preset edit can make the description unnecessary.
      const model = E(backend).resolveModel(modelId);
      const description = E(backend).describe();
      void description.catch(() => undefined);
      try {
        const pinned = { backend, modelId, model: await model, description };
        return { options: harden(options), pinned, warning };
      } catch {
        const fallback = settings?.defaultBackend();
        const fallbackModel = settings?.defaultModelId();
        if (fallback !== undefined) options.backend = fallback;
        if (fallbackModel !== undefined) options.modelId = fallbackModel;
        warning = voiceTextOf.voiceModelUnavailable(modelId);
      }
    }
    return { options: harden(options), warning, pinned: undefined };
  };

  /**
   * @param {{ invocationId?: string, title?: string, at?: number }} [request]
   * @returns {Promise<{ session: any, key: string, duplicate: boolean, warning?: string }>}
   */
  const startVoiceSession = async (request = {}) => {
    const { invocationId } = request;
    /** @type {any} */
    let claim;
    if (invocationId !== undefined) {
      const held = claims.get(invocationId);
      if (held?.state === 'made')
        return harden({
          session: held.session,
          key: held.key,
          duplicate: true,
        });
      if (held?.state === 'creating' && held.start === starts.current())
        throw Error(voiceTexts.launchInProgress);
      // New, or cut off by a restart (an older start): claimed afresh.
      claim = harden({ state: 'creating', start: starts.current() });
      claims.delete(invocationId);
      claims.set(invocationId, claim);
      forgetOldest(invocationId);
    }
    const ours = () =>
      invocationId !== undefined && claims.get(invocationId) === claim;
    try {
      const { options, warning, pinned } = await creationOf(request);
      const session = await create(options, pinned);
      const key = /** @type {any} */ (rows.ofSession(session)).key;
      if (ours())
        claims.set(
          /** @type {string} */ (invocationId),
          harden({ state: 'made', session, key }),
        );
      return harden({
        session,
        key,
        duplicate: false,
        ...(warning === undefined ? {} : { warning }),
      });
    } catch (error) {
      if (ours()) claims.delete(/** @type {string} */ (invocationId));
      throw error;
    }
  };

  const facet = makeExo('Voice', interfaces.Voice, {
    getPreferences: () => preferences,
    /** @param {Record<string, any>} patch `shapes.VoicePreferencesPatch` */
    setPreferences: patch => {
      for (const [field, range] of Object.entries(ttsRanges)) {
        if (patch[field] !== undefined && !finiteIn(patch[field], range))
          throw Error(voiceTexts.preferenceOutOfRange);
      }
      preferences = harden({ ...preferences, ...patch });
      return preferences;
    },
    getVoicePreset: () => shortcutPreset(),
    /**
     * @param {any} preset
     * @param {number} expectedRevision the catalogue revision the caller saw
     */
    setVoicePreset: (preset, expectedRevision) => {
      if (expectedRevision !== catalog.facet.configuration().revision)
        throw Error(texts.presetStale);
      if (!usable(preset)) throw Error(voiceTexts.presetNotUsable);
      shortcut = preset;
      return preset;
    },
    startVoiceSession,
    speechSettings: () => speech,
  });

  /**
   * `HarnessRoot.configureSpeech` (D-M11-21): valid per kind and within
   * one frame, then kept with the next revision (a given `revision` is
   * ignored: the factory numbers its settings).
   * @param {any} given `shapes.SpeechSettings` (checked by the root's guard)
   */
  const configureSpeech = given => {
    const { speechIn, speechOut } = given;
    if (
      !directionValid(speechIn) ||
      !directionValid(speechOut) ||
      unitsOf({ speechIn, speechOut }) * 3 > speechSettingsBytes
    )
      throw Error(voiceTexts.speechSettingsInvalid);
    speech = harden({ speechIn, speechOut, revision: speech.revision + 1 });
    return speech;
  };

  return harden({ facet, configureSpeech });
};
harden(makeVoice);

/** @typedef {ReturnType<typeof makeVoice>} VoiceKit */
