// @ts-check
/**
 * Speech in, `process` kind (`designs/m11-interfaces.md` 6.2; D-M11-10,
 * D-M11-11, D-M11-15; R5-12..R5-17): one resident engine child speaking
 * Endo's Moonshine JSON lines (`engine-protocol.js` `sttProcessMessages`),
 * shared by every utterance of the speech host until its settings change.
 *
 * - The engine starts on the first `open` (or `warm`), stays loaded across
 *   utterances, and after it died is respawned on the next `open` (R5-15),
 *   paced by `engineRestart` (`child-engine.js`). While the pacing holds, or
 *   when a start fails, the utterance aborts `engineUnavailable`; a speech-in
 *   failure never touches speech out (R5-58).
 * - Audio is forwarded as it arrives, one `stream_audio` line per frame,
 *   whole samples only (an odd byte is carried to the next frame and a
 *   trailing one dropped at END, R5-12). Lines written before the engine is
 *   ready wait in the pipe.
 * - Partials are the engine's cumulative text (replace, not append, R5-14),
 *   forwarded until END (a partial after END is dropped, as Endo's
 *   `finish` does); `listening` is the first sink call; the final is
 *   trimmed; an `error` reply aborts `engineFailed` (its text is
 *   never logged or shown).
 * - Bounds (each bounds retained state): `utteranceBytes` of audio per
 *   utterance, then the engine ends it itself (`tooLong()` answers true, the
 *   final follows); `sttBacklogBytes` of audio Node holds for an engine that
 *   does not read (the utterance aborts `backlog`); `engineLineBytes` per
 *   engine line (a longer one kills the engine, `child-engine.js`).
 * - Timeouts: `sttIdleMs` with no audio on an open utterance (abort
 *   `sttIdle`); `engineTimeoutMs` with no engine output for an utterance,
 *   counted while at least 1 s of audio was sent since its last output and
 *   from END until the final, only while the engine is ready (the engine is
 *   killed, its utterances abort `engineTimeout`, the next use respawns
 *   it); `engineLoadMs` to ready (`child-engine.js`).
 *
 * Engine stream ids are `u<k>` with `k` this engine's own counter, not the
 * audio socket's stream number: one engine serves every port of the
 * incarnation, and two ports both number their first utterance 1.
 *
 * Node only (adapter). Nothing of an utterance (audio, text) is logged.
 */
import { Buffer } from 'node:buffer';

import {
  audioLimits,
  audioTimeouts,
  speechTexts,
  sttFormat,
} from './audio-protocol.js';
import { STT_STREAM_PREFIX, sttProcessMessages } from './engine-protocol.js';
import { afterMs, makeChildEngine } from './child-engine.js';

/** @import { UtteranceSink, Utterance, SttEngine } from './engine-types.js' */
/** @import { EngineProcess } from './child-engine.js' */

/** Audio sent since an utterance's last engine output before its engine timer runs (1 s). */
const OUTPUT_WINDOW_BYTES = sttFormat.sampleRate * sttFormat.bytesPerSample;

/**
 * Base64 lines are 4/3 of the audio they carry.
 * @param {number} n line bytes
 */
const audioBytesOfLineBytes = n => Math.floor((n * 3) / 4);

const noop = () => {};

/**
 * @typedef {object} ProcessSttSettings the `process` record of
 *   `SpeechInSettings` (appendix A)
 * @property {'process'} kind
 * @property {readonly string[]} command the whole argv, used as given (the
 *   provisioning step's default carries `--lang <language>`)
 * @property {string} language
 * @property {boolean} [warm]
 */

/**
 * @typedef {object} ProcessSttOptions
 * @property {string} [cwd] the engine's working directory (the host passes
 *   the state directory's `agent-host/`)
 * @property {Record<string, string | undefined>} [environment] source of
 *   the `engineEnvironment` allowlist (default `process.env`)
 * @property {Partial<Record<keyof typeof audioTimeouts, number>>} [timeouts]
 * @property {Partial<Record<keyof typeof audioLimits, number>>} [limits]
 * @property {{ failuresInWindow: number, windowMs: number, backoffMs: number }} [restart]
 * @property {() => number} [now]
 * @property {(event: Record<string, unknown>) => void} [log]
 */

/**
 * An `Utterance` of this engine; `tooLong()` answers whether the engine
 * ended it at `utteranceBytes` (the route reports `utteranceTooLong` in the
 * `end` event).
 * @typedef {Utterance & { tooLong: () => boolean }} ProcessUtterance
 */

/**
 * An `SttEngine` whose `open` answers a `ProcessUtterance`.
 * @typedef {Omit<SttEngine, 'open'> & { open: (sink: UtteranceSink) => ProcessUtterance }} ProcessSttEngine
 */

/**
 * @typedef {object} OpenUtterance
 * @property {string} id
 * @property {EngineProcess} proc
 * @property {UtteranceSink} sink
 * @property {number} sent audio bytes forwarded
 * @property {number} sinceOutput audio bytes since the engine's last output
 * @property {boolean} ended
 * @property {boolean} tooLong
 * @property {number | undefined} carry an odd byte held for the next frame
 * @property {() => void} cancelIdle
 * @property {() => void} cancelEngine
 */

/**
 * @param {ProcessSttSettings} settings
 * @param {ProcessSttOptions} [options]
 * @returns {ProcessSttEngine}
 */
export const makeProcessSttEngine = (settings, options = {}) => {
  const timeouts = { ...audioTimeouts, ...options.timeouts };
  const limits = { ...audioLimits, ...options.limits };
  const log = options.log ?? noop;
  const logAs = harden({ direction: 'speech-in', kind: 'process' });

  /** @type {Map<string, OpenUtterance>} */
  const open = new Map();
  let counter = 0;
  let stopped = false;

  const nextId = () => {
    for (;;) {
      counter = counter >= 0x7fff_ffff ? 1 : counter + 1;
      const id = `${STT_STREAM_PREFIX}${counter}`;
      if (!open.has(id)) return id;
    }
  };

  /**
   * The utterance is over: clear its timers and forget it. Answers whether
   * it was still open (so a sink is called at most once).
   * @param {OpenUtterance} u
   */
  const close = u => {
    if (open.get(u.id) !== u) return false;
    open.delete(u.id);
    u.cancelIdle();
    u.cancelEngine();
    return true;
  };

  /**
   * @param {OpenUtterance} u
   * @param {string} reason
   * @param {boolean} tellEngine
   */
  const abortWith = (u, reason, tellEngine) => {
    if (!close(u)) return;
    if (tellEngine)
      u.proc.writeLine({ type: sttProcessMessages.abort, stream: u.id });
    u.sink.abort(reason);
  };

  /** @param {EngineProcess} proc */
  const utterancesOf = proc => [...open.values()].filter(u => u.proc === proc);

  /** @param {EngineProcess} proc */
  const engineTimedOut = proc => {
    log({ event: 'speech-engine-timeout', ...logAs, pid: proc.pid });
    for (const u of utterancesOf(proc))
      abortWith(u, speechTexts.engineTimeout, false);
    void proc.terminate();
  };

  /**
   * Run the utterance's engine timer when it should run (D-M11-10).
   * @param {OpenUtterance} u
   * @param {boolean} fresh restart it from now
   */
  const armEngineTimer = (u, fresh) => {
    if (fresh) {
      u.cancelEngine();
      u.cancelEngine = noop;
    }
    if (u.cancelEngine !== noop || !u.proc.isReady()) return;
    if (!u.ended && u.sinceOutput < OUTPUT_WINDOW_BYTES) return;
    const { proc } = u;
    u.cancelEngine = afterMs(timeouts.engineTimeoutMs, () =>
      engineTimedOut(proc),
    );
  };

  /** @param {OpenUtterance} u */
  const engineOutput = u => {
    u.sinceOutput = 0;
    u.cancelEngine();
    u.cancelEngine = noop;
    armEngineTimer(u, false);
  };

  const engine = makeChildEngine(
    {
      command: settings.command,
      cwd: options.cwd,
      environment: options.environment,
      output: 'lines',
      readyEvent: sttProcessMessages.ready,
      lineBytes: limits.engineLineBytes,
      loadMs: timeouts.engineLoadMs,
      killGraceMs: timeouts.killGraceMs,
      restart: options.restart,
      now: options.now,
      log,
      logAs,
    },
    {
      onLine: (record, proc) => {
        const { stream } = record;
        if (typeof stream !== 'string') return;
        const u = open.get(stream);
        if (u === undefined || u.proc !== proc) return;
        if ('partial' in record) {
          engineOutput(u);
          if (!u.ended) u.sink.partial(String(record.partial ?? ''));
        } else if ('error' in record) {
          log({
            event: 'speech-engine-failed',
            ...logAs,
            pid: proc.pid,
            reason: 'error-reply',
          });
          abortWith(u, speechTexts.engineFailed, false);
        } else if ('text' in record) {
          if (close(u)) u.sink.final(String(record.text ?? '').trim());
        }
      },
      onReady: proc => {
        for (const u of utterancesOf(proc)) armEngineTimer(u, false);
      },
      onExit: (exit, proc) => {
        const reason = exit.wasReady
          ? speechTexts.engineFailed
          : speechTexts.engineUnavailable;
        for (const u of utterancesOf(proc)) abortWith(u, reason, false);
      },
    },
  );

  /**
   * An utterance that is over before it starts: the sink hears `reason`
   * once, after `open` returned.
   * @param {UtteranceSink} sink
   * @param {string} reason
   * @returns {ProcessUtterance}
   */
  const refused = (sink, reason) => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) sink.abort(reason);
      live = false;
    });
    return harden({
      audio: noop,
      end: noop,
      abort: () => {
        live = false;
      },
      tooLong: () => false,
    });
  };

  /**
   * @param {OpenUtterance} u
   * @param {boolean} tooLong
   */
  const endUtterance = (u, tooLong) => {
    if (open.get(u.id) !== u || u.ended) return;
    u.ended = true;
    u.tooLong = tooLong;
    u.carry = undefined;
    u.cancelIdle();
    u.cancelIdle = noop;
    u.sink.phase('transcribing');
    u.proc.writeLine({ type: sttProcessMessages.stop, stream: u.id });
    armEngineTimer(u, true);
  };

  /**
   * @param {UtteranceSink} sink
   * @returns {ProcessUtterance}
   */
  const openUtterance = sink => {
    if (stopped) return refused(sink, speechTexts.serviceStopped);
    const proc = engine.start();
    if (proc === undefined) return refused(sink, speechTexts.engineUnavailable);
    const id = nextId();
    // `listening` goes first, once: after `open` returned (so the caller has
    // registered its stream), or before any earlier sink call.
    let listening = false;
    const listen = () => {
      if (listening) return;
      listening = true;
      sink.phase('listening');
    };
    /** @type {UtteranceSink} */
    const ordered = harden({
      phase: phase => {
        listen();
        if (phase !== 'listening') sink.phase(phase);
      },
      partial: text => {
        listen();
        sink.partial(text);
      },
      final: text => {
        listen();
        sink.final(text);
      },
      abort: reason => {
        listen();
        sink.abort(reason);
      },
    });
    /** @type {OpenUtterance} */
    const u = {
      id,
      proc,
      sink: ordered,
      sent: 0,
      sinceOutput: 0,
      ended: false,
      tooLong: false,
      carry: undefined,
      cancelIdle: noop,
      cancelEngine: noop,
    };
    const armIdle = () => {
      u.cancelIdle();
      u.cancelIdle = afterMs(timeouts.sttIdleMs, () =>
        abortWith(u, speechTexts.sttIdle, true),
      );
    };
    open.set(id, u);
    proc.writeLine({ type: sttProcessMessages.start, stream: id });
    armIdle();
    void Promise.resolve().then(() => {
      if (open.get(id) === u) listen();
    });

    /** @param {Uint8Array} pcm */
    const audio = pcm => {
      if (open.get(id) !== u || u.ended || pcm.length === 0) return;
      armIdle();
      let bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      if (u.carry !== undefined) {
        bytes = Buffer.concat([Buffer.of(u.carry), bytes]);
        u.carry = undefined;
      }
      const room = limits.utteranceBytes - u.sent;
      const atLimit = bytes.length >= room;
      if (atLimit) bytes = bytes.subarray(0, room - (room % 2));
      else if (bytes.length % 2) {
        u.carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length > 0) {
        if (
          audioBytesOfLineBytes(proc.queuedBytes()) + bytes.length >
          limits.sttBacklogBytes
        ) {
          abortWith(u, speechTexts.backlog, true);
          return;
        }
        proc.writeLine({
          type: sttProcessMessages.audio,
          stream: id,
          pcm: bytes.toString('base64'),
        });
        u.sent += bytes.length;
        u.sinceOutput += bytes.length;
        armEngineTimer(u, false);
      }
      if (atLimit) endUtterance(u, true);
    };

    return harden({
      audio,
      end: () => endUtterance(u, false),
      abort: () => {
        // `close` first: no sink call follows an abort from the caller.
        if (close(u))
          proc.writeLine({ type: sttProcessMessages.abort, stream: id });
      },
      tooLong: () => u.tooLong,
    });
  };

  /** @returns {Promise<void>} */
  const warm = () => {
    const proc = stopped ? undefined : engine.start();
    return proc === undefined ? Promise.resolve() : proc.ready.then(noop);
  };

  const stop = async () => {
    stopped = true;
    for (const u of [...open.values()])
      abortWith(u, speechTexts.serviceStopped, false);
    await engine.stop();
  };

  return harden({
    state: () => engine.state(),
    open: openUtterance,
    warm,
    stop,
  });
};
harden(makeProcessSttEngine);
