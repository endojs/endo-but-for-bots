// @ts-check
/**
 * Speech out, `process` kind (`designs/m11-interfaces.md` 6.2; D-M11-10,
 * D-M11-11, D-M11-12, D-M11-15; R5-38..R5-43): Piper, one process per
 * playback, fed one sentence per standard-input line, its raw s16le output
 * forwarded as it is produced.
 *
 * - Catalogue: the settings' `voicesDir` read once per engine (one engine
 *   per settings revision) by `voice-catalogue.js`; the defaults are the
 *   settings' `defaultVoice` and `defaultSpeed` over `ttsDefaults`. A
 *   default voice that is not in the catalogue, or a default speed out of
 *   range, turns speech out off with a warning (R5-40, R5-58): `state()`
 *   answers `off` and every synthesis aborts `speechOutOff`.
 * - Synthesis: the process starts at the first sentence (R5-38), with
 *   `piperFlags` from the checked options (`--length-scale` is `1 /
 *   speed`). Sentences are written in lock step with the output: the next
 *   sentence is written as soon as the previous one's first PCM arrived, so
 *   Piper synthesizes it while the earlier audio plays (a sentence's audio
 *   comes out in one write after its synthesis), and each written sentence
 *   has a known start for its timeout. Output is forwarded in whole samples
 *   (an odd byte carried, Endo `takeWholeSamples`). At `end` standard input
 *   is closed and the process waited for.
 * - Timeout and failure: a written sentence with no PCM within
 *   `synthTimeoutMs` (counted only while the output is not paused for
 *   backpressure) kills the process; the sentence is reported
 *   `sentenceFailed(index)` and the next sentence starts a new process. A
 *   process that ends with a sentence written and no PCM for it does the
 *   same. Two failed sentences in a row, or a command that cannot be
 *   spawned, abort the playback `synthFailed`.
 * - Backpressure: after each PCM chunk the process's output is paused
 *   until `PlaybackSink.drained()` resolves (R5-68 fixed): Piper then
 *   blocks on its full pipe instead of the adapter holding its audio.
 * - Bounds (retained state): the sentences not yet written stay under
 *   `sentenceBacklogUnits` (over it the playback aborts `textBacklog`).
 * - Warm spare (D-M11-12, O-6): with `spareSynth` (default on) the engine
 *   keeps one process started with no input for the options of the latest
 *   playback (or of `warm(options)`, at first the catalogue defaults, which
 *   are the shared preferences' fallbacks), so a reply's first sentence
 *   does not wait for a model load. A playback with the same options takes
 *   it and a new spare is started; a playback with other options drops it
 *   (the preferences changed) and the new spare follows those options.
 *
 * Node only (adapter). No sentence, PCM, argument or path is logged.
 */
import { join } from 'node:path';

import {
  audioLimits,
  audioTimeouts,
  speechTextOf,
  speechTexts,
} from './audio-protocol.js';
import { piperFlags, voiceFiles } from './engine-protocol.js';
import { afterMs, spawnEngineProcess } from './child-engine.js';
import { checkTtsOptions, readVoiceCatalogue } from './voice-catalogue.js';
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import {
  ttsDefaults,
  ttsRanges,
} from '../../../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */

/** @import { CheckedTtsOptions, DirectionState, PlaybackSink, Synthesis, TtsCatalogue, TtsEngine } from './engine-types.js' */
/** @import { EngineExit, EngineProcess } from './child-engine.js' */

/** Failed sentences in a row after which a playback gives up. */
export const sentenceFailuresInRow = 2;

const noop = () => {};

/**
 * @typedef {object} ProcessTtsSettings the `process` record of
 *   `SpeechOutSettings` (appendix A)
 * @property {'process'} kind
 * @property {readonly string[]} command the Piper argv prefix
 * @property {string} voicesDir
 * @property {string} [defaultVoice]
 * @property {number} [defaultSpeed]
 * @property {boolean} [spareSynth] default true
 */

/**
 * @typedef {object} ProcessTtsOptions
 * @property {string} [cwd] the processes' working directory (the host
 *   passes the state directory's `agent-host/`)
 * @property {Record<string, string | undefined>} [environment] source of
 *   the `engineEnvironment` allowlist (default `process.env`)
 * @property {Partial<Record<keyof typeof audioTimeouts, number>>} [timeouts]
 * @property {Partial<Record<keyof typeof audioLimits, number>>} [limits]
 * @property {(event: Record<string, unknown>) => void} [log]
 */

/**
 * A `TtsEngine` with the warm spare's lever: `warm(options?)` starts the
 * spare for `options` (checked against the catalogue; default the
 * catalogue's defaults) when `spareSynth` is on; it never rejects.
 * @typedef {TtsEngine & { warm: (options?: Record<string, unknown>) => Promise<void> }} ProcessTtsEngine
 */

/**
 * One engine process and the synthesis its output goes to (none for a
 * spare).
 * @typedef {object} Piper
 * @property {EngineProcess} proc
 * @property {string} key the options it was started with
 * @property {((bytes: Uint8Array) => void) | undefined} onData
 * @property {((exit: EngineExit) => void) | undefined} onExit
 */

/**
 * The options a process is started with, as one comparable key.
 * @param {CheckedTtsOptions} options
 */
const keyOf = ({ voice, speed, noiseScale, noiseW, sentenceSilence }) =>
  JSON.stringify([voice, speed, noiseScale, noiseW, sentenceSilence]);

/**
 * A sentence as one Piper line: no newline inside, no stray whitespace.
 * @param {string} text
 */
const lineOf = text => `${text}`.replace(/\s+/g, ' ').trim();

/**
 * @param {ProcessTtsSettings} settings
 * @param {ProcessTtsOptions} [options]
 * @returns {ProcessTtsEngine}
 */
export const makeProcessTtsEngine = (settings, options = {}) => {
  const timeouts = { ...audioTimeouts, ...options.timeouts };
  const limits = { ...audioLimits, ...options.limits };
  const log = options.log ?? noop;
  const logAs = harden({ direction: 'speech-out', kind: 'process' });
  const spareOn = settings.spareSynth !== false;

  /** @type {Promise<TtsCatalogue> | undefined} */
  let catalogueRead;
  /** @type {TtsCatalogue | undefined} */
  let known;
  let stopped = false;
  /** @type {Piper | undefined} */
  let spare;
  /** Every synthesis not yet over, as its `stop(reason)`. */
  /** @type {Set<(reason: string) => void>} */
  const live = new Set();
  /** Every process alive (spare and syntheses), for `state` and `stop`. */
  /** @type {Set<EngineProcess>} */
  const running = new Set();

  /** @returns {Promise<TtsCatalogue>} */
  const catalogue = () => {
    catalogueRead ??= readVoiceCatalogue(settings.voicesDir).then(
      ({ voices }) => {
        const defaults = harden({
          ...ttsDefaults,
          voice: settings.defaultVoice ?? ttsDefaults.voice,
          speed: settings.defaultSpeed ?? ttsDefaults.speed,
        });
        /** @type {string | undefined} */
        let warning;
        const { min, max } = ttsRanges.speed;
        if (!voices.some(entry => entry.id === defaults.voice)) {
          warning = `${speechTextOf.unknownVoice(defaults.voice)}. ${speechTexts.speechOutOff}`;
        } else if (
          !Number.isFinite(defaults.speed) ||
          defaults.speed < min ||
          defaults.speed > max
        ) {
          warning = `${speechTextOf.outOfRange('speed', min, max)}. ${speechTexts.speechOutOff}`;
        }
        known = harden({
          voices,
          defaults,
          ...(warning === undefined ? {} : { warning }),
        });
        return known;
      },
    );
    return catalogueRead;
  };

  /** @returns {DirectionState} */
  const state = () => {
    if (known?.warning !== undefined) return 'off';
    return running.size > 0 ? 'ready' : 'idle';
  };

  /**
   * Start a process for `checked`; its output goes where the answer's
   * handlers say.
   * @param {CheckedTtsOptions} checked
   * @returns {Piper}
   */
  const spawnFor = checked => {
    const command = [
      ...settings.command,
      piperFlags.model,
      join(settings.voicesDir, `${checked.voice}${voiceFiles.model}`),
      piperFlags.outputRaw,
      piperFlags.lengthScale,
      String(1 / checked.speed),
      piperFlags.noiseScale,
      String(checked.noiseScale),
      piperFlags.noiseW,
      String(checked.noiseW),
      piperFlags.sentenceSilence,
      String(checked.sentenceSilence),
    ];
    /** @type {Piper} */
    const piper = {
      proc: /** @type {any} */ (undefined),
      key: keyOf(checked),
      onData: undefined,
      onExit: undefined,
    };
    piper.proc = spawnEngineProcess(
      {
        command,
        cwd: options.cwd,
        environment: options.environment,
        output: 'bytes',
        killGraceMs: timeouts.killGraceMs,
        log,
        logAs,
      },
      {
        onData: bytes => piper.onData?.(bytes),
        onExit: exit => {
          running.delete(piper.proc);
          if (spare === piper) spare = undefined;
          piper.onExit?.(exit);
        },
      },
    );
    if (piper.proc.alive()) running.add(piper.proc);
    return piper;
  };

  /** @param {CheckedTtsOptions} checked */
  const startSpare = checked => {
    if (!spareOn || stopped || spare !== undefined) return;
    spare = spawnFor(checked);
  };

  const dropSpare = () => {
    const old = spare;
    spare = undefined;
    if (old !== undefined) void old.proc.terminate();
  };

  /**
   * A process for one synthesis: the spare when it was started with these
   * options, else a new one; either way the spare is then renewed for them.
   * @param {CheckedTtsOptions} checked
   * @returns {Piper}
   */
  const takePiper = checked => {
    const key = keyOf(checked);
    /** @type {Piper} */
    let piper;
    if (spare !== undefined && spare.key === key && spare.proc.alive()) {
      piper = spare;
      spare = undefined;
    } else {
      dropSpare();
      piper = spawnFor(checked);
    }
    startSpare(checked);
    return piper;
  };

  /**
   * @param {CheckedTtsOptions} checked
   * @param {PlaybackSink} sink
   * @returns {Synthesis}
   */
  const open = (checked, sink) => {
    /** @type {{ index: number, text: string }[]} sentences not yet written */
    const queue = [];
    let queuedUnits = 0;
    let nextIndex = 0;
    let ended = false;
    let over = false;
    let phaseSent = false;
    let failuresInRow = 0;
    /** @type {Piper | undefined} */
    let piper;
    /** @type {number | undefined} the written sentence awaiting its first PCM */
    let awaiting;
    let paused = false;
    let inputClosed = false;
    /** @type {number | undefined} an odd byte of the current process */
    let carry;
    /** The one timer of the synthesis (`armQuiet`). */
    let cancelQuiet = noop;
    /** @type {number} */
    let sampleRate = 0;
    /** @type {CheckedTtsOptions | undefined} */
    let usable;

    /**
     * The synthesis is over: no further sink call; the process is killed
     * unless it is ending on its own.
     * @param {(() => void) | undefined} last
     * @param {boolean} kill
     */
    const finish = (last, kill) => {
      if (over) return;
      over = true;
      live.delete(abortWith);
      cancelQuiet();
      queue.length = 0;
      const current = piper;
      piper = undefined;
      if (current !== undefined) {
        current.onData = undefined;
        current.onExit = undefined;
        if (kill) void current.proc.terminate();
      }
      last?.();
    };

    /** @param {string} reason */
    const abortWith = reason => finish(() => sink.abort(reason), true);
    live.add(abortWith);

    /** @param {string} reason */
    const failPlayback = reason => {
      log({ event: 'speech-engine-failed', ...logAs, reason: 'synthesis' });
      abortWith(reason);
    };

    /**
     * The awaited sentence failed: report it, drop its process (killed when
     * `kill`), and go on with the next on a new process.
     * @param {boolean} kill
     */
    const sentenceFailed = kill => {
      const index = /** @type {number} */ (awaiting);
      awaiting = undefined;
      cancelQuiet();
      const current = piper;
      piper = undefined;
      carry = undefined;
      inputClosed = false;
      if (current !== undefined) {
        current.onData = undefined;
        current.onExit = undefined;
        if (kill) void current.proc.terminate();
      }
      failuresInRow += 1;
      sink.sentenceFailed(index);
      if (over) return;
      if (failuresInRow >= sentenceFailuresInRow) {
        failPlayback(speechTexts.synthFailed);
        return;
      }
      advance();
    };

    /**
     * The quiet timer (D-M11-10), never while the output is paused for
     * backpressure: with a sentence awaiting its first PCM, the sentence
     * fails after `synthTimeoutMs`; with the input closed, a process that
     * has not exited after `synthTimeoutMs` is ended (every sentence
     * already produced audio).
     */
    const armQuiet = () => {
      cancelQuiet();
      cancelQuiet = noop;
      const current = piper;
      if (over || paused || current === undefined) return;
      if (awaiting !== undefined) {
        cancelQuiet = afterMs(timeouts.synthTimeoutMs, () => {
          if (over || awaiting === undefined || piper !== current) return;
          log({
            event: 'speech-engine-timeout',
            ...logAs,
            pid: current.proc.pid,
            reason: 'sentence',
          });
          sentenceFailed(true);
        });
      } else if (inputClosed) {
        cancelQuiet = afterMs(timeouts.synthTimeoutMs, () => {
          if (piper === current) void current.proc.terminate();
        });
      }
    };

    /** @param {Uint8Array} bytes */
    const onData = bytes => {
      if (over) return;
      let data = bytes;
      if (carry !== undefined) {
        const joined = new Uint8Array(data.byteLength + 1);
        joined[0] = carry;
        joined.set(data, 1);
        data = joined;
        carry = undefined;
      }
      if (data.byteLength % 2 === 1) {
        carry = data[data.byteLength - 1];
        data = data.subarray(0, data.byteLength - 1);
      }
      if (data.byteLength === 0) return;
      cancelQuiet();
      cancelQuiet = noop;
      if (awaiting !== undefined) {
        awaiting = undefined;
        failuresInRow = 0;
      }
      sink.pcm(data, sampleRate);
      if (over) return;
      const current = piper;
      if (current !== undefined) {
        paused = true;
        current.proc.pauseOutput();
        void sink.drained().then(() => {
          if (piper !== current) return;
          paused = false;
          current.proc.resumeOutput();
          armQuiet();
        });
      }
      advance();
    };

    /** @param {EngineExit} exit */
    const onExit = exit => {
      if (over) return;
      if (exit.reason === 'spawn-failed') {
        piper = undefined;
        failPlayback(speechTexts.synthFailed);
        return;
      }
      if (awaiting !== undefined) {
        sentenceFailed(false);
        return;
      }
      const wasClosing = inputClosed;
      piper = undefined;
      carry = undefined;
      inputClosed = false;
      paused = false;
      cancelQuiet();
      if (wasClosing && queue.length === 0) {
        finish(() => sink.end(), false);
        return;
      }
      // It died between sentences: the rest goes to a new process.
      advance();
    };

    /** Write the next sentence, or close the input when all are written. */
    const advance = () => {
      if (over || usable === undefined || awaiting !== undefined) return;
      if (queue.length === 0) {
        if (!ended) return;
        if (piper === undefined) {
          finish(() => sink.end(), false);
          return;
        }
        if (!inputClosed) {
          inputClosed = true;
          piper.proc.endInput();
          armQuiet();
        }
        return;
      }
      if (piper === undefined) {
        piper = takePiper(usable);
        piper.onData = onData;
        piper.onExit = onExit;
        carry = undefined;
        paused = false;
        if (!piper.proc.alive()) {
          // Spawned and already gone (no pid): its exit was reported.
          piper = undefined;
          failPlayback(speechTexts.synthFailed);
          return;
        }
      }
      const next = /** @type {{ index: number, text: string }} */ (
        queue.shift()
      );
      queuedUnits -= next.text.length;
      if (!phaseSent) {
        phaseSent = true;
        sink.phase('synthesizing');
        if (over) return;
      }
      awaiting = next.index;
      piper.proc.write(`${next.text}\n`);
      armQuiet();
    };

    // The catalogue is read before any process starts (the host read it to
    // check the options; a direct caller may not have).
    void catalogue().then(
      read => {
        if (over) return;
        if (read.warning !== undefined) {
          abortWith(speechTexts.speechOutOff);
          return;
        }
        const voice = read.voices.find(entry => entry.id === checked.voice);
        if (voice === undefined) {
          abortWith(speechTextOf.unknownVoice(checked.voice));
          return;
        }
        sampleRate = voice.sampleRate;
        usable = checked;
        advance();
      },
      () => abortWith(speechTexts.synthFailed),
    );

    if (stopped) {
      void Promise.resolve().then(() => abortWith(speechTexts.serviceStopped));
    }

    return harden({
      sentence: text => {
        if (over || ended) return;
        const index = nextIndex;
        nextIndex += 1;
        const line = lineOf(text);
        if (line === '') return;
        queue.push({ index, text: line });
        queuedUnits += line.length;
        if (queuedUnits > limits.sentenceBacklogUnits) {
          void Promise.resolve().then(() => abortWith(speechTexts.textBacklog));
          return;
        }
        advance();
      },
      end: () => {
        if (over || ended) return;
        ended = true;
        advance();
      },
      abort: () => finish(undefined, true),
    });
  };

  /** @param {Record<string, unknown>} [spareOptions] */
  const warm = async spareOptions => {
    if (!spareOn || stopped) return;
    try {
      const read = await catalogue();
      if (read.warning !== undefined || stopped) return;
      const checked = checkTtsOptions(spareOptions ?? {}, read);
      if (spare !== undefined && spare.key !== keyOf(checked)) dropSpare();
      startSpare(checked);
    } catch {
      // Options the catalogue refuses start no spare.
    }
  };

  const stop = async () => {
    stopped = true;
    for (const end of [...live]) end(speechTexts.serviceStopped);
    dropSpare();
    await Promise.all([...running].map(proc => proc.terminate()));
  };

  return harden({ state, catalogue, open, warm, stop });
};
harden(makeProcessTtsEngine);
