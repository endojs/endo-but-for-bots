// @ts-check
/**
 * The speech host of one agent-host adapter incarnation
 * (`designs/m11-interfaces.md` sections 3.2, 3.3, 4, 5, 6.1, 6.4): the
 * gateway-local `Speech` service a signed-in page finds in
 * `GatewayPowers.extras` under `speech`, the `AudioPort` it mints per page,
 * the ports' streams, the engines by kind and settings revision, and the
 * settings cache.
 *
 * `makeSpeechHost({ context, kinds, pipeline, options })` answers `{ speech,
 * timeouts, bind, stop }`: `speech` is the `Speech` exo; `timeouts` and
 * `bind(token, connection)` are what the `/audio` route (`route.js`) needs;
 * `stop()` closes every port (`serviceStopped`) and stops every engine.
 *
 * Settings (6.4): `{ settings, revision, readAt }`, read through the
 * gateway context's `operator()` (`E(E(operator).getVoice()).speechSettings()`,
 * the `Voice` presence kept for the incarnation) at the first `openAudio`,
 * `configuration` or `status`, and again at an `openAudio` when older than
 * `settingsMaxAgeMs`. A failed read makes both directions `failed` with the
 * reason in `status().error` and forgets the `Voice` presence; the next
 * `openAudio` retries. A new `revision` drops idle engines at once and busy
 * ones when their last stream ends; the next use makes the new one. When
 * speech in is configured with `warm: true`, its engine is warmed at the
 * read (R5-15, D-M11-23).
 *
 * Ports and tokens (4, 10): `openAudio` mints 32 random bytes; the host
 * keeps their SHA-256 digest only, compares a HELLO's digest in constant
 * time, binds one socket once and forgets the digest. A token not used
 * within `tokenMs` forgets its port. Stream numbers are server-chosen, odd
 * for utterances and even for playbacks, wrapping before
 * `streamNumbers.max` and skipping numbers still open or recently ended.
 * Frames crossing the server's end of a stream are not errors: after the
 * server aborted a stream, its late frames are ignored; after it ended one
 * normally (the final after the page's END, a playback's `end`), only a
 * late ABORT is. Any other frame for a stream that is not open is a
 * protocol error.
 *
 * Every rejection answers a fixed text of `audio-protocol.js` and opens no
 * stream. Nothing here logs a text, a transcript, a token, a key or a path:
 * log events are `engine-protocol.js` `speechLogEvents` with counts.
 *
 * Node only (agent-host adapter); the guest prelude is on `globalThis`.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { limits as guestLimits } from '../../../../guest/lib/limits.js';
import {
  speechGuardLimits,
  speechGuards,
} from '../../../../guest/lib/speech-guards.js';
import {
  ttsDefaults,
  ttsRanges,
} from '../../../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { markNeverLeaves } from '../gateway/powers.js';
import {
  audioCloseCodes,
  audioLimits,
  audioTimeouts,
  frameKinds,
  speechTextOf,
  speechTexts,
  streamNumbers,
  sttFormat,
} from './audio-protocol.js';
import { makePlayback } from './playback.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { GatewayContext } from '../gateway/protocol.js' */
/** @import { AudioBinding, AudioConnection } from './route.js' */
/** @import { CheckedTtsOptions, DirectionState, OpenTurnViewOptions, SpeechText, SttEngine, TtsCatalogue, TtsEngine, TurnSpeechView, Utterance } from './engine-types.js' */
/** @import { EngineContext, SpeechKind } from './kinds.js' */

const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/** The host's settings cache lives this long (contract 5.4). */
export const settingsMaxAgeMs = 60_000;

/** Stream numbers a port remembers as recently ended by the server. */
const RECENT_STREAMS = 8;

/** Longest status or warning line (`speech-guards.js` `noteUnits`). */
const NOTE_UNITS = 512;

/**
 * What the host needs of the speech text pipeline (W11.3's modules).
 * @typedef {object} SpeechPipeline
 * @property {(options: OpenTurnViewOptions & { limits?: Record<string, number> }) => Promise<TurnSpeechView>} openTurnView
 * @property {(options?: { sentenceUnits?: number }) => SpeechText} makeSpeechText
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/** @param {Uint8Array} bytes */
const digestOf = bytes => createHash('sha256').update(bytes).digest();

/**
 * R5-41, D-M11-19: every option finite and in `ttsRanges`, the voice one of
 * the catalogue's; a missing option takes the catalogue's default.
 * @param {Record<string, unknown>} options
 * @param {TtsCatalogue} catalogue
 * @returns {CheckedTtsOptions}
 */
const checkTtsOptions = (options, catalogue) => {
  const merged = { ...catalogue.defaults, ...options };
  for (const [option, range] of Object.entries(ttsRanges)) {
    const value = /** @type {any} */ (merged)[option];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      value > range.max
    ) {
      throw Error(speechTextOf.outOfRange(option, range.min, range.max));
    }
  }
  if (!catalogue.voices.some(entry => entry.id === merged.voice)) {
    throw Error(speechTextOf.unknownVoice(String(merged.voice)));
  }
  return harden(/** @type {CheckedTtsOptions} */ (merged));
};

/**
 * One direction of one settings revision.
 * @typedef {object} Slot
 * @property {'speechIn' | 'speechOut'} direction
 * @property {any} settings the direction's settings record
 * @property {any} engine made at first use (`undefined` before)
 * @property {string | undefined} error why the engine cannot be made
 * @property {number} busy open streams on the engine
 * @property {boolean} retired a newer revision replaced this one
 * @property {Promise<TtsCatalogue> | undefined} catalogue speech out only
 */

/**
 * A playback's text source: `close` releases it; `begin`, when present,
 * starts it once the playback has started.
 * @typedef {{ close: () => void, begin?: () => void }} PlaybackSource
 */

/**
 * One stream of a port.
 * @typedef {object} Stream
 * @property {'utterance' | 'playback'} kind
 * @property {(kind: number, payload: Buffer) => boolean} frame
 * @property {() => void} stop the page's ABORT or the socket closing
 */

/**
 * @typedef {object} PortState
 * @property {any} exo
 * @property {string | undefined} digest hex, until bound or forgotten
 * @property {ReturnType<typeof setTimeout> | undefined} tokenTimer
 * @property {AudioConnection | undefined} connection
 * @property {Map<number, Stream>} streams
 * @property {{ number: number, aborted: boolean }[]} recent streams the
 *   server ended lately (at most `RECENT_STREAMS`)
 * @property {number} nextOdd
 * @property {number} nextEven
 * @property {any} playback the current playback (R5-44)
 * @property {boolean} closed
 */

/**
 * @param {object} options
 * @param {GatewayContext} options.context the speech extension's context
 *   (with `readGrant`, D-M11-22)
 * @param {Readonly<Record<string, SpeechKind>>} options.kinds
 * @param {SpeechPipeline} options.pipeline
 * @param {{ timeouts?: Partial<Record<keyof typeof audioTimeouts, number>>, limits?: Partial<Record<keyof typeof audioLimits, number>>, settingsMaxAgeMs?: number }} [options.options]
 */
export const makeSpeechHost = ({ context, kinds, pipeline, options = {} }) => {
  const timeouts = harden({ ...audioTimeouts, ...options.timeouts });
  const limits = harden({ ...audioLimits, ...options.limits });
  const maxAgeMs = options.settingsMaxAgeMs ?? settingsMaxAgeMs;
  const { log } = context;
  const guards = speechGuards();

  let stopped = false;

  // ------------------------------------------------------------ settings

  /** @type {any} the `Voice` presence, kept for the incarnation */
  let voice;
  /** @type {{ settings: any, revision: number, readAt: number } | undefined} */
  let cached;
  /** @type {string | undefined} */
  let settingsError;
  /** @type {Promise<void> | undefined} */
  let reading;
  /** @type {{ speechIn: Slot, speechOut: Slot } | undefined} */
  let slots;

  /** @param {Slot} slot */
  const stopSlotEngine = slot => {
    const { engine } = slot;
    slot.engine = undefined;
    if (engine !== undefined) {
      void Promise.resolve()
        .then(() => engine.stop())
        .catch(() => {});
    }
  };

  /**
   * @param {'speechIn' | 'speechOut'} direction
   * @param {any} settings
   * @returns {Slot}
   */
  const makeSlot = (direction, settings) => ({
    direction,
    settings,
    engine: undefined,
    error: undefined,
    busy: 0,
    retired: false,
    catalogue: undefined,
  });

  /** @param {any} settings */
  const takeSettings = settings => {
    const revision = settings.revision ?? 0;
    const old = slots;
    if (old === undefined || cached?.revision !== revision) {
      slots = {
        speechIn: makeSlot('speechIn', settings.speechIn),
        speechOut: makeSlot('speechOut', settings.speechOut),
      };
      if (old !== undefined) {
        for (const slot of [old.speechIn, old.speechOut]) {
          slot.retired = true;
          if (slot.busy === 0) stopSlotEngine(slot);
        }
      }
    }
    cached = { settings, revision, readAt: Date.now() };
  };

  const readSettings = () => {
    reading ??= (async () => {
      await null;
      try {
        const operator = context.operator?.();
        if (operator === undefined) throw Error('the gateway is not bound');
        voice ??= await E(operator).getVoice();
        const settings = await E(voice).speechSettings();
        takeSettings(settings);
        settingsError = undefined;
        log({ event: 'speech-config-read', revision: cached?.revision });
        const inSlot = /** @type {{ speechIn: Slot }} */ (slots).speechIn;
        if (inSlot.settings.kind !== 'off' && inSlot.settings.warm === true) {
          const engine = engineOf(inSlot);
          if (engine !== undefined) void engine.warm().catch(() => {});
        }
      } catch (error) {
        voice = undefined;
        settingsError = messageOf(error).slice(0, NOTE_UNITS);
        log({ event: 'speech-config-failed' });
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };

  /** The settings now: read when none were read or the last read failed. */
  const settingsNow = async () => {
    await null;
    if (reading !== undefined) await reading;
    if (cached === undefined || settingsError !== undefined) {
      await readSettings();
    }
  };

  /** At `openAudio`: a read when none, failed, or older than `maxAgeMs`. */
  const refreshIfStale = () => {
    if (
      reading === undefined &&
      (cached === undefined ||
        settingsError !== undefined ||
        Date.now() - cached.readAt > maxAgeMs)
    ) {
      void readSettings();
    }
  };

  /** @returns {EngineContext} */
  const engineContext = () => {
    /** @type {string | undefined} */
    let cwd;
    try {
      cwd = join(context.stateDir, 'agent-host');
    } catch {
      cwd = undefined;
    }
    return harden({
      log,
      readGrant: context.readGrant,
      cwd,
      timeouts,
      limits,
    });
  };

  /**
   * The slot's engine, made at first use; `undefined` when the direction is
   * off or its engine cannot be made (`slot.error`).
   * @param {Slot} slot
   */
  const engineOf = slot => {
    if (slot.engine !== undefined || slot.settings.kind === 'off') {
      return slot.engine;
    }
    if (slot.error !== undefined) return undefined;
    const maker = kinds[slot.settings.kind]?.[slot.direction];
    if (maker === undefined) {
      slot.error = speechTexts.engineUnavailable;
      return undefined;
    }
    try {
      slot.engine = maker(slot.settings, engineContext());
      log({
        event: 'speech-engine-start',
        direction: slot.direction,
        kind: slot.settings.kind,
      });
    } catch (error) {
      slot.error = messageOf(error).slice(0, NOTE_UNITS);
      log({
        event: 'speech-engine-failed',
        direction: slot.direction,
        kind: slot.settings.kind,
      });
    }
    return slot.engine;
  };

  /**
   * @param {Slot} slot
   * @returns {DirectionState}
   */
  const stateOf = slot => {
    if (settingsError !== undefined) return 'failed';
    if (slot.settings.kind === 'off') return 'off';
    if (slot.error !== undefined) return 'failed';
    if (slot.engine !== undefined) return slot.engine.state();
    return kinds[slot.settings.kind]?.[slot.direction] === undefined
      ? 'failed'
      : 'idle';
  };

  /** @param {Slot} slot */
  const usable = slot =>
    settingsError === undefined &&
    slot.settings.kind !== 'off' &&
    slot.error === undefined &&
    kinds[slot.settings.kind]?.[slot.direction] !== undefined;

  /**
   * The engine a new stream of `direction` uses; throws the stream's
   * refusal text.
   * @param {'speechIn' | 'speechOut'} direction
   */
  const engineFor = async direction => {
    await settingsNow();
    if (settingsError !== undefined || slots === undefined) {
      throw Error(speechTexts.engineUnavailable);
    }
    const slot = slots[direction];
    if (slot.settings.kind === 'off') {
      throw Error(
        direction === 'speechIn'
          ? speechTexts.speechInOff
          : speechTexts.speechOutOff,
      );
    }
    const engine = engineOf(slot);
    if (engine === undefined) {
      throw Error(
        direction === 'speechIn'
          ? speechTexts.engineUnavailable
          : speechTexts.synthFailed,
      );
    }
    return { slot, engine };
  };

  /** @param {Slot} slot */
  const catalogueOf = slot => {
    slot.catalogue ??= Promise.resolve().then(() =>
      /** @type {TtsEngine} */ (engineOf(slot)).catalogue(),
    );
    return slot.catalogue;
  };

  /**
   * A stream took the slot's engine.
   * @param {Slot} slot
   */
  const takeEngine = slot => {
    slot.busy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot.busy -= 1;
      if (slot.retired && slot.busy === 0) stopSlotEngine(slot);
    };
  };

  // ------------------------------------------------------------ ports

  /** @type {Set<PortState>} */
  const ports = new Set();
  /** @type {Map<string, PortState>} unbound ports by token digest (hex) */
  const byDigest = new Map();
  /** @type {WeakMap<object, PortState>} */
  const portOf = new WeakMap();

  const streamCount = () => {
    let n = 0;
    for (const state of ports) n += state.streams.size;
    return n;
  };

  /**
   * @param {PortState} state
   * @param {number} code
   * @param {string} reason
   */
  const closePort = (state, code, reason) => {
    if (state.closed) return;
    state.closed = true;
    if (state.tokenTimer !== undefined) clearTimeout(state.tokenTimer);
    if (state.digest !== undefined) byDigest.delete(state.digest);
    state.digest = undefined;
    ports.delete(state);
    for (const stream of [...state.streams.values()]) stream.stop();
    state.streams.clear();
    state.playback = undefined;
    const { connection } = state;
    state.connection = undefined;
    connection?.close(code, reason);
    log({ event: 'speech-port-closed', ports: ports.size });
  };

  /**
   * The port's next stream number of `kind`, skipping open and recently
   * ended ones.
   * @param {PortState} state
   * @param {'utterance' | 'playback'} kind
   */
  const nextNumber = (state, kind) => {
    const odd = kind === 'utterance';
    let n = odd ? state.nextOdd : state.nextEven;
    const first = odd ? streamNumbers.first : streamNumbers.first + 1;
    for (;;) {
      if (n >= streamNumbers.max) n = first;
      if (!state.streams.has(n) && !state.recent.some(r => r.number === n)) {
        break;
      }
      n += 2;
    }
    if (odd) state.nextOdd = n + 2;
    else state.nextEven = n + 2;
    return n;
  };

  /**
   * The stream `number` is over. `by`: `page` (its END or ABORT: nothing
   * kept), `abort` (the server aborted it: late frames ignored) or `end`
   * (the server ended it: a late ABORT ignored).
   * @param {PortState} state
   * @param {number} number
   * @param {'page' | 'abort' | 'end'} by
   */
  const forgetStream = (state, number, by) => {
    if (!state.streams.delete(number)) return;
    if (by !== 'page') {
      state.recent.push({ number, aborted: by === 'abort' });
      if (state.recent.length > RECENT_STREAMS) state.recent.shift();
    }
  };

  /**
   * A port that may open a stream of `kind` now; throws the refusal.
   * @param {any} exo
   * @param {'utterance' | 'playback'} kind
   */
  const portForStream = (exo, kind) => {
    const state = portOf.get(exo);
    if (
      stopped ||
      state === undefined ||
      state.closed ||
      state.connection === undefined
    ) {
      throw Error(speechTexts.portClosed);
    }
    // A newer playback replaces the current one, so it takes its place.
    const replaced = kind === 'playback' && state.playback !== undefined;
    if (state.streams.size - (replaced ? 1 : 0) >= limits.streamsPerPort) {
      throw Error(speechTexts.tooManyStreams);
    }
    if (kind === 'utterance') {
      let utterances = 0;
      for (const stream of state.streams.values()) {
        if (stream.kind === 'utterance') utterances += 1;
      }
      if (utterances >= limits.utterancesPerPort) {
        throw Error(speechTexts.tooManyStreams);
      }
    }
    return state;
  };

  /**
   * Open an utterance on `state`'s socket.
   * @param {PortState} state
   * @param {Slot} slot
   * @param {SttEngine} engine
   */
  const openUtterance = (state, slot, engine) => {
    const number = nextNumber(state, 'utterance');
    const connection = /** @type {AudioConnection} */ (state.connection);
    let over = false;
    let ended = false;
    const release = takeEngine(slot);
    /** @type {Utterance & { tooLong?: () => boolean }} */
    let utterance;
    /** @param {'page' | 'abort' | 'end'} by */
    const done = by => {
      over = true;
      release();
      forgetStream(state, number, by);
    };
    /** @type {import('./engine-types.js').UtteranceSink} */
    const sink = harden({
      phase: phase => {
        if (!over) connection.event(number, harden({ type: 'phase', phase }));
      },
      partial: text => {
        if (!over) connection.event(number, harden({ type: 'partial', text }));
      },
      final: text => {
        if (over) return;
        done('end');
        connection.event(number, harden({ type: 'final', text }));
        connection.event(
          number,
          harden(
            utterance?.tooLong?.() === true
              ? { type: 'end', note: speechTexts.utteranceTooLong }
              : { type: 'end' },
          ),
        );
      },
      abort: reason => {
        if (over) return;
        done('abort');
        connection.event(number, harden({ type: 'abort', reason }));
        log({ event: 'speech-stream-abort', direction: 'in' });
      },
    });
    /** @type {Stream} */
    const stream = {
      kind: 'utterance',
      frame: (kind, payload) => {
        if (kind === frameKinds.abort) {
          if (!over) {
            done('page');
            utterance.abort();
          }
          return true;
        }
        if (ended) return false;
        if (kind === frameKinds.end) {
          ended = true;
          utterance.end();
          return true;
        }
        // AUDIO
        if (payload.length > limits.audioFrameBytes) {
          utterance.abort();
          sink.abort(speechTexts.frameTooLarge);
          return true;
        }
        utterance.audio(payload);
        return true;
      },
      stop: () => {
        if (over) return;
        done('page');
        utterance.abort();
      },
    };
    state.streams.set(number, stream);
    utterance = engine.open(sink);
    return number;
  };

  /**
   * Open a playback on `state`'s socket. Its number is taken at once (it
   * counts against `streamsPerPort` while the source opens); `source`
   * opens the source over the playback's sink (`begin`, if any, is
   * called once the playback started).
   * The page learns the number from the answer, so no frame of it can
   * arrive before.
   * @param {PortState} state
   * @param {Slot} slot
   * @param {TtsEngine} engine
   * @param {CheckedTtsOptions} checked
   * @param {(sink: import('./engine-types.js').TurnTextSink) => Promise<PlaybackSource>} source
   */
  const openPlayback = async (state, slot, engine, checked, source) => {
    await null;
    const release = takeEngine(slot);
    const number = nextNumber(state, 'playback');
    /** @type {'page' | 'end'} a playback takes only ABORT from the page */
    let by = 'end';
    const playback = makePlayback({
      stream: number,
      connection: /** @type {AudioConnection} */ (state.connection),
      engine,
      options: checked,
      speechText: pipeline.makeSpeechText({
        sentenceUnits: limits.sentenceUnits,
      }),
      limits,
      log,
      onOver: () => {
        release();
        forgetStream(state, number, by);
        if (state.playback === playback) state.playback = undefined;
      },
    });
    state.streams.set(number, {
      kind: 'playback',
      frame: kind => {
        if (kind !== frameKinds.abort) return false;
        by = 'page';
        playback.stop();
        return true;
      },
      stop: () => {
        by = 'page';
        playback.stop();
      },
    });
    /** @type {PlaybackSource} */
    let opened;
    try {
      opened = await source(playback.sink);
    } catch (error) {
      by = 'page';
      playback.stop();
      throw error;
    }
    if (playback.isOver()) {
      // The port closed, or the source failed, while it opened.
      opened.close();
      throw Error(
        state.closed ? speechTexts.portClosed : speechTexts.turnNotFound,
      );
    }
    playback.setSource(opened.close);
    const previous = state.playback;
    state.playback = playback;
    previous?.replace();
    playback.start();
    opened.begin?.();
    return number;
  };

  /**
   * @param {Slot} slot
   * @param {Record<string, unknown> | undefined} ttsOptions
   */
  const checkedFor = async (slot, ttsOptions) => {
    const catalogue = await catalogueOf(slot);
    return checkTtsOptions(ttsOptions ?? {}, catalogue);
  };

  /** A new `AudioPort` for `state`. */
  const makePort = () => {
    /** @type {PortState} */
    const state = {
      exo: undefined,
      digest: undefined,
      tokenTimer: undefined,
      connection: undefined,
      streams: new Map(),
      recent: [],
      nextOdd: streamNumbers.first,
      nextEven: streamNumbers.first + 1,
      playback: undefined,
      closed: false,
    };
    const exo = makeExo('AudioPort', guards.interfaces.AudioPort, {
      transcribe: async () => {
        portForStream(exo, 'utterance');
        const { slot, engine } = await engineFor('speechIn');
        const ready = portForStream(exo, 'utterance');
        return harden({ stream: openUtterance(ready, slot, engine) });
      },
      /**
       * @param {any} session
       * @param {string} turnId
       * @param {Record<string, unknown>} [ttsOptions]
       */
      speak: async (session, turnId, ttsOptions) => {
        portForStream(exo, 'playback');
        const { slot, engine } = await engineFor('speechOut');
        const checked = await checkedFor(slot, ttsOptions);
        const ready = portForStream(exo, 'playback');
        const stream = await openPlayback(
          ready,
          slot,
          engine,
          checked,
          async sink => {
            const view = await pipeline.openTurnView({
              live: context.live,
              content: context.content,
              session,
              turnId,
              sink,
              limits: {
                speakViewsPerSession: limits.speakViewsPerSession,
                sentenceBacklogUnits: limits.sentenceBacklogUnits,
              },
            });
            return harden({ close: () => view.close() });
          },
        );
        return harden({ stream });
      },
      close: () => {
        closePort(state, audioCloseCodes.portClosed, speechTexts.portClosed);
        return undefined;
      },
    });
    markNeverLeaves(exo);
    state.exo = exo;
    portOf.set(exo, state);
    return state;
  };

  /**
   * Feed replay pieces to `sink`: inline texts as they are, Blobs read a
   * page at a time through `Content` in this process.
   * @param {readonly any[]} pieces
   * @param {import('./engine-types.js').TurnTextSink} sink
   */
  const replaySource = async (pieces, sink) => {
    let cancelled = false;
    const run = async () => {
      await null;
      for (const [index, piece] of pieces.entries()) {
        if (cancelled) return;
        if (index > 0) sink.text('\n');
        if (typeof piece === 'string') {
          sink.text(piece);
        } else {
          let offset = 0;
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const page = await E(context.content).read(
              piece,
              harden({ offset, maxBytes: guestLimits.blobPageBytes }),
            );
            if (cancelled) return;
            sink.text(page.text);
            if (page.done) break;
            offset = page.next;
          }
        }
      }
      if (!cancelled) sink.end();
    };
    return harden({
      close: () => {
        cancelled = true;
      },
      // After the playback started: nothing waits in its early buffer.
      begin: () => {
        void run().catch(() => {
          if (!cancelled) sink.abort(speechTexts.synthFailed);
        });
      },
    });
  };

  // ------------------------------------------------------------ Speech

  const speech = makeExo('Speech', guards.interfaces.Speech, {
    openAudio: () => {
      if (stopped) throw Error(speechTexts.serviceStopped);
      if (ports.size >= limits.ports) throw Error(speechTexts.tooManyPorts);
      refreshIfStale();
      const state = makePort();
      const token = randomBytes(limits.tokenBytes);
      state.digest = digestOf(token).toString('hex');
      byDigest.set(state.digest, state);
      ports.add(state);
      state.tokenTimer = setTimeout(() => {
        if (state.connection === undefined) {
          closePort(
            state,
            audioCloseCodes.tokenRefused,
            speechTexts.tokenRefused,
          );
        }
      }, timeouts.tokenMs);
      state.tokenTimer.unref?.();
      log({ event: 'speech-port-open', ports: ports.size });
      return harden({ port: state.exo, token: token.toString('hex') });
    },
    configuration: async () => {
      await settingsNow();
      const language =
        slots?.speechIn.settings.language === undefined
          ? {}
          : { language: String(slots.speechIn.settings.language) };
      const ranges = harden(
        Object.fromEntries(
          Object.entries(ttsRanges).map(([option, { min, max, step }]) => [
            option,
            harden({ min, max, step }),
          ]),
        ),
      );
      const speechIn = slots !== undefined && usable(slots.speechIn);
      /** @type {readonly any[]} */
      let voices = [];
      /** @type {Record<string, string | number>} */
      let defaults = harden({ ...ttsDefaults });
      /** @type {string | undefined} */
      let warning = settingsError;
      let speechOut = false;
      if (slots !== undefined && usable(slots.speechOut)) {
        try {
          const catalogue = await catalogueOf(slots.speechOut);
          voices = catalogue.voices.slice(0, speechGuardLimits.voices);
          defaults = harden({ ...ttsDefaults, ...catalogue.defaults });
          speechOut = voices.some(entry => entry.id === defaults.voice);
          warning ??= catalogue.warning;
        } catch {
          warning ??= speechTexts.synthFailed;
          log({ event: 'speech-engine-failed', direction: 'speechOut' });
        }
      }
      return harden({
        speechIn,
        speechOut,
        voices: voices.map(({ id, name, sampleRate }) =>
          harden({ id, name, sampleRate }),
        ),
        defaults,
        ranges,
        ...language,
        ...(warning === undefined
          ? {}
          : { warning: warning.slice(0, NOTE_UNITS) }),
      });
    },
    status: () => {
      if (cached === undefined && settingsError === undefined) {
        void (reading ?? readSettings());
      }
      const error =
        settingsError ?? slots?.speechIn.error ?? slots?.speechOut.error;
      return harden({
        speechIn:
          slots === undefined
            ? settingsError
              ? 'failed'
              : 'idle'
            : stateOf(slots.speechIn),
        speechOut:
          slots === undefined
            ? settingsError
              ? 'failed'
              : 'idle'
            : stateOf(slots.speechOut),
        ports: ports.size,
        streams: streamCount(),
        ...(error === undefined ? {} : { error: error.slice(0, NOTE_UNITS) }),
      });
    },
    /**
     * @param {any} port
     * @param {readonly any[]} pieces
     * @param {Record<string, unknown>} [ttsOptions]
     */
    replay: async (port, pieces, ttsOptions) => {
      portForStream(port, 'playback');
      const { slot, engine } = await engineFor('speechOut');
      const checked = await checkedFor(slot, ttsOptions);
      const ready = portForStream(port, 'playback');
      const stream = await openPlayback(ready, slot, engine, checked, sink =>
        replaySource(pieces, sink),
      );
      return harden({ stream });
    },
  });
  markNeverLeaves(speech);

  // ------------------------------------------------------------ route

  /**
   * HELLO: bind the port whose token this is (contract 4).
   * @param {Buffer} token
   * @param {AudioConnection} connection
   * @returns {Promise<AudioBinding | undefined>}
   */
  const bind = async (token, connection) => {
    if (stopped || token.length !== limits.tokenBytes) return undefined;
    const digest = digestOf(token);
    const state = byDigest.get(digest.toString('hex'));
    if (
      state === undefined ||
      state.closed ||
      state.connection !== undefined ||
      state.digest === undefined ||
      !timingSafeEqual(Buffer.from(state.digest, 'hex'), digest)
    ) {
      return undefined;
    }
    byDigest.delete(state.digest);
    state.digest = undefined;
    if (state.tokenTimer !== undefined) clearTimeout(state.tokenTimer);
    state.tokenTimer = undefined;
    state.connection = connection;
    await settingsNow().catch(() => {});
    if (state.closed) return undefined;
    return harden({
      ready: harden({
        speechIn: slots !== undefined && usable(slots.speechIn),
        speechOut: slots !== undefined && usable(slots.speechOut),
        sampleRate: sttFormat.sampleRate,
        audioFrameBytes: limits.audioFrameBytes,
      }),
      frame: (kind, number, payload) => {
        const stream = state.streams.get(number);
        if (stream === undefined) {
          const recent = state.recent.find(r => r.number === number);
          if (recent === undefined) return false;
          return kind === frameKinds.abort || recent.aborted;
        }
        return stream.frame(kind, payload);
      },
      closed: () => {
        state.connection = undefined;
        closePort(state, audioCloseCodes.portClosed, speechTexts.portClosed);
      },
    });
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const state of [...ports]) {
      closePort(
        state,
        audioCloseCodes.serviceStopped,
        speechTexts.serviceStopped,
      );
    }
    const engines =
      slots === undefined ? [] : [slots.speechIn, slots.speechOut];
    for (const slot of engines) stopSlotEngine(slot);
  };

  return harden({ speech, timeouts, bind, stop });
};
harden(makeSpeechHost);
