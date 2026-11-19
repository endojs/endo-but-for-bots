// @ts-check
/**
 * The speech engine kinds of the speech host (`designs/m11-interfaces.md`
 * 6.1, D-M11-5): per kind of `engine-protocol.js` `speechEngineKinds`, the
 * maker of each direction's engine. The host calls a maker with the
 * direction's settings record (appendix A `SpeechInSettings` /
 * `SpeechOutSettings`, as `Voice.speechSettings()` answered it) and the
 * host's `EngineContext`; a maker that throws (a refused base URL, a
 * command it cannot use) leaves that direction `failed` with the reason in
 * `Speech.status().error`.
 *
 * `makeSpeechKinds(table)` checks a table (only the known kinds, each
 * maker a function) and hardens it; `speechKinds` is the incarnation's
 * table. A kind listed without a maker for a direction is `failed` for that
 * direction (`speechTexts.engineUnavailable`), never a silent `off`.
 *
 * This module is the one place the speech host names engine modules
 * (`host.js` and `route.js` take engines as objects): the adapters below
 * turn the host's `EngineContext` into each engine module's own options.
 *
 * Node only (agent-host adapter).
 */
import { speechEngineKinds } from './engine-protocol.js';
import { openAiAudioKind } from './openai-audio.js';
import { makeProcessSttEngine } from './stt-process.js';

/** @import { SttEngine, TtsEngine } from './engine-types.js' */

/**
 * What the host gives an engine maker.
 * @typedef {object} EngineContext
 * @property {(event: Record<string, unknown>) => void} log
 * @property {((grant: any) => Promise<string>) | undefined} readGrant the
 *   speech extension's key reader (D-M11-22)
 * @property {string | undefined} cwd the state directory's `agent-host/`
 *   (a process engine's working directory)
 * @property {Partial<typeof import('./audio-protocol.js').audioTimeouts>} timeouts
 * @property {Partial<typeof import('./audio-protocol.js').audioLimits>} limits
 */

/**
 * One kind: the maker of each direction it serves.
 * @typedef {object} SpeechKind
 * @property {(settings: any, context: EngineContext) => SttEngine} [speechIn]
 * @property {(settings: any, context: EngineContext) => TtsEngine} [speechOut]
 */

/**
 * @param {Record<string, SpeechKind>} table
 * @returns {Readonly<Record<string, SpeechKind>>}
 */
export const makeSpeechKinds = table => {
  for (const [kind, entry] of Object.entries(table)) {
    if (!speechEngineKinds.includes(kind)) {
      throw Error(`unknown speech engine kind ${kind}`);
    }
    for (const direction of ['speechIn', 'speechOut']) {
      const maker = /** @type {any} */ (entry)[direction];
      if (maker !== undefined && typeof maker !== 'function') {
        throw Error(`the ${kind} ${direction} maker is not a function`);
      }
    }
  }
  return harden({ ...table });
};
harden(makeSpeechKinds);

/**
 * `openai-audio`: the maker takes one options record
 * (`openai-audio.js` `OpenAiAudioOptions`).
 * @type {SpeechKind}
 */
const openAiAudio = harden({
  speechIn: (settings, { log, readGrant, timeouts, limits }) =>
    openAiAudioKind.speechIn({
      settings,
      readGrant: readGrant ?? notGiven,
      log,
      timeouts,
      limits,
    }),
  speechOut: (settings, { log, readGrant, timeouts, limits }) =>
    openAiAudioKind.speechOut({
      settings,
      readGrant: readGrant ?? notGiven,
      log,
      timeouts,
      limits,
    }),
});

/**
 * A key reader for a context without one: every read fails.
 * @param {any} _grant
 * @returns {Promise<string>}
 */
async function notGiven(_grant) {
  throw Error('no key reader');
}

/**
 * `process`: the makers take the settings and their own options
 * (`stt-process.js` `ProcessSttOptions`).
 * @type {SpeechKind}
 */
const processKind = harden({
  speechIn: (settings, { log, cwd, timeouts, limits }) =>
    makeProcessSttEngine(settings, {
      log,
      timeouts,
      limits,
      ...(cwd === undefined ? {} : { cwd }),
    }),
});

/**
 * The incarnation's kinds. The `process` speech-out maker
 * (`tts-process.js`) joins `processKind` when it is committed (contract
 * 12: the wiring of the last engine is the integration unit's).
 */
export const speechKinds = makeSpeechKinds({
  off: {},
  process: processKind,
  'openai-audio': openAiAudio,
});
