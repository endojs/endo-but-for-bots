// @ts-check
/**
 * The voice feature's state (`designs/m11-interfaces.md` section 9; P-33,
 * P-34, P-35, P-49, P-66, R6-60): one `VoiceState` per page, made by
 * `makeVoiceState` and reached from the `FeatureContext` (`feature.js`
 * `voiceStateOf`). The slot components only render its `view()` and call
 * its actions.
 *
 * Page-level parts live for the page: the player, the wake lock, the
 * microphone (capture, endpointer, pre-roll, spoken draft), auto-speak
 * (page memory, R5-55), the launch id already used, and the session view
 * in spoken mode (m11-interfaces.md 9.1). Connection parts are
 * rebuilt whenever the controller gives a new `FeatureContext` (every
 * attach): the `Speech` service and `Voice` presence, the configuration and
 * the server preferences, the audio port and its socket, the submission
 * listener (H10) and the receipts waiting for their turn. Nothing here is
 * kept in browser storage except the device settings cache
 * (`VOICE_CACHE_KEY`, R5-55).
 *
 * Every browser object comes in through `VoiceIo`, so the whole flow runs
 * in Node against fakes built from the real guards
 * (`test/unit/voice-state.test.js`).
 */
import { E } from '@endo/far';

import {
  AUDIO_PATH,
  audioLimits,
  speechTexts,
} from '../../../resources/agent-host/impl/speech/audio-protocol.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../../guest/lib/limits.js';
import {
  ttsDefaults,
  ttsRanges,
  voiceLimits,
  voicePreferenceFields,
} from '../../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { isLive } from '../conversation/transcript.js';
import { signInOf, socketUrl } from '../net/fragment.js';
import { audioReconnectDelay, openAudioSocket } from './audio-socket.js';
import { openCapture as openBrowserCapture } from './capture.js';
import { endpointingDefaults } from './endpointing-defaults.js';
import { makeEndpointer, makePreRoll, makeSpokenDraft } from './endpointing.js';
import { makePlayer as makeBrowserPlayer } from './playback.js';
import { voiceUiTexts } from './texts.js';
import { makeScreenWakeLock, wakeWanted } from './wake-lock.js';

/** @import { Capture } from './capture.js' */
/** @import { Player } from './playback.js' */
/** @import { AudioSocket, PlaybackStream, Utterance, SpeechEvent } from './audio-socket.js' */

/** The device settings cache (contract section 8; R5-55). */
export const VOICE_CACHE_KEY = 'thix-voice:settings';

/** Submissions kept waiting for their turn to start (bounds retained state). */
export const WAITING_KEPT = 8;

/**
 * Inline units of one `Speech.replay` call: at 3 UTF-8 bytes a unit this
 * stays under the call's 1 MiB `wsMessageBytes` bound with its framing.
 */
export const REPLAY_INLINE_UNITS = 300_000;

/** How long Talk and a launch wait for the new session's row (ms). */
export const LIST_WAIT_MS = 10_000;

/** The largest caret position `replaceInput` clamps to the text's end. */
const WHOLE = Number.MAX_SAFE_INTEGER;

/** @param {unknown} error */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * Whether `value` is usable for one preference field: a voice id of at
 * most `voiceLimits.voiceUnits`, or a finite number in `ttsRanges`.
 *
 * @param {string} field
 * @param {unknown} value
 */
export const validPreference = (field, value) => {
  if (field === 'voice') {
    return (
      typeof value === 'string' &&
      value !== '' &&
      value.length <= voiceLimits.voiceUnits
    );
  }
  const range = /** @type {Record<string, { min: number, max: number }>} */ (
    ttsRanges
  )[field];
  return (
    range !== undefined &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
  );
};
harden(validPreference);

/**
 * The settings in use, field by field from the first layer that has a
 * usable value (R5-55: server preferences, device cache, service defaults,
 * built-in defaults; `ttsDefaults` is always the last layer).
 *
 * @param {...(Record<string, unknown> | undefined)} layers
 * @returns {Record<string, any>}
 */
export const resolveVoiceSettings = (...layers) => {
  /** @type {Record<string, any>} */
  const settings = {};
  for (const field of voicePreferenceFields) {
    for (const layer of [...layers, ttsDefaults]) {
      const value = layer ? layer[field] : undefined;
      if (validPreference(field, value)) {
        settings[field] = value;
        break;
      }
    }
  }
  return harden(settings);
};
harden(resolveVoiceSettings);

/**
 * The launch link's invocation id (R6-60): the fragment parameter `voice`
 * beside `gateway` and `agent`, or undefined.
 *
 * @param {{ hash?: string } | undefined} location
 */
export const launchIdOf = location => {
  const hash =
    location && typeof location.hash === 'string' ? location.hash : '';
  if (hash.length <= 1) return undefined;
  const id = new URLSearchParams(hash.slice(1)).get('voice');
  if (!id || id.length > voiceLimits.invocationIdUnits) return undefined;
  return id;
};
harden(launchIdOf);

/**
 * The `/audio` URL of the page's gateway, or undefined when the page has no
 * usable sign-in fragment.
 *
 * @param {{ hash?: string, search?: string } | undefined} location
 * @param {any} [session] this tab’s sign-in storage
 */
export const audioUrlOf = (location, session = undefined) => {
  if (!location) return undefined;
  const signIn = signInOf(location, session);
  return 'gateway' in signIn
    ? socketUrl(signIn.gateway, AUDIO_PATH)
    : undefined;
};
harden(audioUrlOf);

/**
 * Cut a text into replay pieces of at most `units`, at the last white
 * space before the bound when there is one.
 *
 * @param {string} text
 * @param {number} [units]
 */
export const textPieces = (text, units = limits.inlineBytes) => {
  /** @type {string[]} */
  const pieces = [];
  let rest = text;
  while (rest.length > units) {
    const space = rest.lastIndexOf(' ', units);
    const cut = space > units / 2 ? space + 1 : units;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
};
harden(textPieces);

/**
 * The replay pieces of a turn's assistant messages (D-M11-17): inline
 * texts cut to `inlineBytes` units, the Blob of a staged text, the text of
 * a sealed (archived) field read with `readContent`. At most
 * `audioLimits.replayPieces` pieces and `REPLAY_INLINE_UNITS` inline units;
 * the rest is not spoken.
 *
 * @param {readonly any[]} messages `turnContent(entry).messages`
 * @param {(staged: any) => Promise<string>} readContent
 * @returns {Promise<any[]>}
 */
export const replayPiecesOf = async (messages, readContent) => {
  /** @type {any[]} */
  const pieces = [];
  let units = 0;
  /** @param {string} text */
  const addText = text => {
    for (const piece of textPieces(text)) {
      if (
        pieces.length >= audioLimits.replayPieces ||
        units + piece.length > REPLAY_INLINE_UNITS
      ) {
        return;
      }
      pieces.push(piece);
      units += piece.length;
    }
  };
  for (const message of messages) {
    if (pieces.length >= audioLimits.replayPieces) break;
    const value = message && message.role === 'assistant' && message.text;
    if (typeof value === 'string') {
      if (value.trim() !== '') addText(`${value}\n`);
    } else if (value && typeof value === 'object' && value.blob) {
      pieces.push(value.blob);
    } else if (value && typeof value === 'object' && value.sealed) {
      // eslint-disable-next-line no-await-in-loop
      addText(`${await readContent(value)}\n`);
    }
  }
  return pieces;
};
harden(replayPiecesOf);

/**
 * @typedef {object} VoiceIo
 * @property {any} controller the page's `UiController`
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(timer: any) => void} [clearTimer]
 * @property {() => any} [storage] answers `localStorage` or undefined
 * @property {() => any} [sessionStorage]
 * @property {() => any} [location] answers `globalThis.location`
 * @property {(options: { url: string, token: string, onClose: (code: number, reason: string) => void }) => AudioSocket} openSocket
 * @property {(options: { onBlock: (pcm: Uint8Array, rms: number) => void }) => Capture} openCapture
 * @property {(onChange: (playing: boolean) => void) => Player} makePlayer
 * @property {{ set: (wanted: boolean) => void, refresh: () => void }} wakeLock
 * @property {(onGesture: () => void) => void} [watchActivation]
 * @property {(onChange: (hidden: boolean) => void) => void} [watchVisibility]
 */

/**
 * @typedef {object} ShortcutChoice
 * @property {'idle' | 'loading' | 'ready' | 'error'} state
 * @property {Array<{ preset: any, label: string, available: boolean, unavailableReason?: string }>} entries
 * @property {number} selected the chosen preset's index, -1 for none
 * @property {number} revision the catalogue revision read
 */

/**
 * What the components render.
 *
 * @typedef {object} VoiceView
 * @property {boolean} available a speech service is on this connection
 * @property {boolean} configured whether the service has answered its configuration query
 * @property {boolean} speechIn
 * @property {boolean} speechOut
 * @property {boolean} micOn
 * @property {boolean} spoken the view is in spoken mode (9.1): the mic
 *   listens, each dictated send carries the spoken marker and its reply
 *   is read aloud
 * @property {number} level the last block's RMS
 * @property {number} floor
 * @property {number} threshold
 * @property {boolean} autoSpeak
 * @property {boolean} playing
 * @property {boolean} talking a Talk or launch is starting its session
 * @property {boolean} bargeIn R5-46: show "continuing in background…"
 * @property {string} note the last warning or failure ('' when none)
 * @property {Record<string, any>} settings
 * @property {Array<{ id: string, name: string }>} voices
 * @property {Record<string, { min: number, max: number, step: number }>} ranges
 * @property {ShortcutChoice} shortcut
 */

/**
 * @param {VoiceIo} io
 */
export const makeVoiceState = ({
  controller,
  now = () => Date.now(),
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = timer => globalThis.clearTimeout(timer),
  storage = () => undefined,
  location = () => undefined,
  sessionStorage = () => undefined,
  openSocket,
  openCapture,
  makePlayer,
  wakeLock,
  watchActivation = () => {},
  watchVisibility = () => {},
}) => {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {VoiceView | undefined} */
  let cachedView;
  const notify = () => {
    cachedView = undefined;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // a component's listener must not break the feature
      }
    }
  };

  // ---------------------------------------------------------- page parts

  const player = makePlayer(() => onPlayerChange());
  /** @type {boolean | undefined} R5-55: on whenever speech out is wired, until toggled */
  let autoSpeakChoice;
  let note = '';
  let bargeIn = false;
  let talking = false;
  /** @type {string | undefined} */
  let launchedId;
  /**
   * The session whose view is in spoken mode (9.1); undefined in text mode.
   * One at a time: the page has one microphone. Leaving that view ends it.
   * @type {string | undefined}
   */
  let spokenKey;
  let meter = { level: 0, floor: 0, threshold: 0 };
  /** @type {Record<string, any>} */
  let settings = resolveVoiceSettings();
  /** @type {Record<string, unknown>} */
  let patch = {};
  /** @type {any} */
  let debounce;
  /** @type {any} */
  let grace;
  /** @type {ShortcutChoice} */
  let shortcut = { state: 'idle', entries: [], selected: -1, revision: 0 };
  /** The last turn the active view showed: `${key} ${turnId}`. */
  let lastTurn = '';
  let playGeneration = 0;

  /**
   * @typedef {object} Mic
   * @property {Capture} capture
   * @property {ReturnType<typeof makeEndpointer>} endpointer
   * @property {ReturnType<typeof makePreRoll>} preRoll
   * @property {ReturnType<typeof makeSpokenDraft>} draft
   * @property {Utterance | undefined} utterance
   * @property {string | undefined} draftKey the session the dictation is for
   */
  /** @type {Mic | undefined} */
  let mic;

  /**
   * @typedef {object} Playing
   * @property {PlaybackStream} stream
   * @property {string} [turnId] the spoken turn (`speak`), absent for a replay
   * @property {() => void} restart R5-50: the same playback with the
   *   current options
   */
  /** @type {Playing | undefined} */
  let playing;

  // ---------------------------------------------------- connection parts

  /**
   * @typedef {object} Connection
   * @property {any} context the `FeatureContext` this connection's parts belong to
   * @property {any} speech the `Speech` extras service, or undefined
   * @property {Promise<any> | undefined} voice `Operator.getVoice()`
   * @property {Record<string, any> | undefined} configuration
   * @property {Record<string, any> | undefined} preferences
   * @property {any} port
   * @property {AudioSocket | undefined} socket
   * @property {boolean} bound the socket's READY came: the port takes streams
   * @property {Promise<Connection | undefined> | undefined} opening
   * @property {number} attempt reconnect attempts since the last READY
   * @property {Array<{ sessionKey: string, session: any, requestId: string }>} waiting
   * @property {() => void} unsubscribe
   */
  /** @type {Connection | undefined} */
  let conn;

  const viewState = () => controller.getState();
  const busy = () => Boolean(viewState().view && viewState().view.busy);
  const autoSpeak = () =>
    autoSpeakChoice ??
    Boolean(conn && conn.configuration && conn.configuration.speechOut);

  /** Whether this page's fresh turns are spoken now (R5-45). */
  const speaks = () =>
    autoSpeak() &&
    Boolean(conn && conn.configuration && conn.configuration.speechOut);

  const updateWake = () =>
    wakeLock.set(
      wakeWanted({
        micOn: mic !== undefined,
        audible: player.playing(),
        busy: busy(),
      }),
    );

  const onPlayerChange = () => {
    updateWake();
    notify();
  };

  /** @param {unknown} error */
  const report = error => {
    note = messageOf(error);
    notify();
  };

  /** @param {unknown} error */
  const reportAutoSpeech = error => {
    if (!messageOf(error).includes(speechTexts.turnNotLive)) report(error);
  };

  /** @param {Connection} c */
  const voiceOf = c => {
    c.voice ??= E(c.context.powers.operator).getVoice();
    return c.voice;
  };

  /** The device cache (R5-55), or undefined. */
  const readCache = () => {
    try {
      const raw = storage()?.getItem(VOICE_CACHE_KEY);
      if (typeof raw !== 'string') return undefined;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const writeCache = () => {
    try {
      storage()?.setItem(VOICE_CACHE_KEY, JSON.stringify(settings));
    } catch {
      // quota or blocked storage: the server preferences still hold
    }
  };

  /** @param {Connection} c */
  const resolveFrom = c => {
    settings = resolveVoiceSettings(
      c.preferences,
      readCache(),
      c.configuration && c.configuration.defaults,
    );
  };

  /** Options for `speak` and `replay`: the settings, the voice only when listed. */
  const ttsOptions = () => {
    const configuration = conn && conn.configuration;
    const voices = configuration ? configuration.voices : [];
    /** @type {Record<string, any>} */
    const options = {};
    for (const field of voicePreferenceFields) {
      const value = settings[field];
      if (field === 'voice') {
        if (voices.some(/** @param {any} v */ v => v.id === value)) {
          options.voice = value;
        }
      } else {
        const range = configuration && configuration.ranges[field];
        options[field] = range
          ? Math.min(range.max, Math.max(range.min, value))
          : value;
      }
    }
    return harden(options);
  };

  /** @param {string} box */
  const setBox = box => {
    if (viewState().view) controller.replaceInput(0, WHOLE, box);
  };

  // --------------------------------------------------------- audio port

  /**
   * @param {Connection} c
   * @param {AudioSocket} socket
   */
  const onSocketClosed = (c, socket) => {
    if (c.socket !== socket) return;
    c.socket = undefined;
    c.port = undefined;
    c.bound = false;
    if (conn !== c || !mic) return;
    // The mic stays on: open a new port after the backoff (R6-14 style).
    const delay = audioReconnectDelay(c.attempt);
    c.attempt += 1;
    setTimer(() => {
      if (conn === c && mic) ensurePort().catch(report);
    }, delay);
  };

  /**
   * @param {Connection} c
   * @returns {Promise<Connection | undefined>}
   */
  const openPort = async c => {
    const url = audioUrlOf(location(), sessionStorage());
    if (!url) throw Error(speechTexts.portClosed);
    const grant = await E(c.speech).openAudio();
    if (conn !== c) {
      E(grant.port)
        .close()
        .catch(() => {});
      return undefined;
    }
    /** @type {AudioSocket} */
    const socket = openSocket({
      url,
      token: grant.token,
      onClose: () => onSocketClosed(c, socket),
    });
    c.port = grant.port;
    c.socket = socket;
    await socket.ready;
    c.bound = c.socket === socket;
    c.attempt = 0;
    return conn === c ? c : undefined;
  };

  /** The connection with a bound audio port, or undefined. */
  const ensurePort = async () => {
    const c = conn;
    if (!c || !c.speech) return undefined;
    if (c.socket && !c.socket.closed()) {
      await c.socket.ready;
      return conn === c ? c : undefined;
    }
    if (!c.opening) {
      c.opening = openPort(c).finally(() => {
        c.opening = undefined;
      });
    }
    return c.opening;
  };

  // ----------------------------------------------------------- playback

  const stopPlayback = () => {
    playGeneration += 1;
    const current = playing;
    playing = undefined;
    if (current) current.stream.stop();
    player.stop();
  };

  /**
   * Replace the playback with a new stream (R5-44).
   *
   * @param {(c: Connection) => Promise<{ stream: number }>} open
   * @param {{ turnId?: string, restart: () => void }} about
   */
  const startPlayback = async (open, about) => {
    stopPlayback();
    const mine = playGeneration;
    const c = await ensurePort();
    if (!c || !c.socket || mine !== playGeneration) return;
    const track = player.begin();
    /** @type {Playing} */
    const entry = {
      stream: c.socket.playback(
        open(c).then(answer => answer.stream),
        {
          onPcm: track.pcm,
          onEvent: (/** @type {SpeechEvent} */ event) => {
            if (event.type !== 'end' && event.type !== 'abort') return;
            if (playing === entry) playing = undefined;
            if (
              event.type === 'abort' &&
              event.reason !== speechTexts.stopped &&
              event.reason !== speechTexts.replaced &&
              !(
                about.turnId !== undefined &&
                String(event.reason ?? '').includes(speechTexts.turnNotLive)
              )
            ) {
              note = String(event.reason ?? '');
            }
            notify();
          },
        },
      ),
      ...(about.turnId === undefined ? {} : { turnId: about.turnId }),
      restart: about.restart,
    };
    playing = entry;
    notify();
  };

  /**
   * Speak a turn of this page (D-M11-20).
   *
   * @param {any} session
   * @param {string} turnId
   */
  const speakTurn = (session, turnId) =>
    startPlayback(c => E(c.port).speak(session, turnId, ttsOptions()), {
      turnId,
      restart: () => {
        speakTurn(session, turnId).catch(reportAutoSpeech);
      },
    });

  /**
   * @param {string} sessionKey
   * @param {any} session
   * @param {string | undefined} turnId
   */
  const speakFresh = (sessionKey, session, turnId) => {
    if (turnId === undefined || !speaks()) return;
    if (viewState().activeKey !== sessionKey) return;
    speakTurn(session, turnId).catch(reportAutoSpeech);
  };

  /** @param {Record<string, any>} receipt */
  const turnIdOf = async receipt => {
    if (typeof receipt.turnId === 'string') return receipt.turnId;
    if (!receipt.turn) return undefined;
    const status = await E(receipt.turn).getStatus();
    return status.turnId;
  };

  /**
   * H10: a send of this page was answered.
   *
   * @param {Connection} c
   * @param {Record<string, any>} notice
   */
  const onSubmission = (c, notice) => {
    const { sessionKey, session, requestId, receipt } = notice;
    // Nothing is read for a send that will not be spoken (no crank, rule 9):
    // only a send from spoken mode is read aloud (9.1).
    if (conn !== c || !receipt || notice.spoken !== true || !speaks()) return;
    if (receipt.state === 'started') {
      turnIdOf(receipt).then(
        turnId => speakFresh(sessionKey, session, turnId),
        report,
      );
      return;
    }
    c.waiting.push({ sessionKey, session, requestId });
    while (c.waiting.length > WAITING_KEPT) c.waiting.shift();
  };

  /**
   * The active session's view showed a new running turn: one receipt read
   * per waiting submission of that session (D-M11-20).
   *
   * @param {string} sessionKey
   * @param {string} turnId
   */
  const onTurnStart = (sessionKey, turnId) => {
    const c = conn;
    if (!c || !speaks()) return;
    for (const wait of c.waiting.filter(w => w.sessionKey === sessionKey)) {
      E(wait.session)
        .getSubmissionReceipt(wait.requestId)
        .then(async (/** @type {any} */ receipt) => {
          if (!receipt || receipt.state !== 'started') return;
          const index = c.waiting.indexOf(wait);
          if (index >= 0) c.waiting.splice(index, 1);
          if ((await turnIdOf(receipt)) === turnId) {
            speakFresh(sessionKey, wait.session, turnId);
          }
        })
        .catch(report);
    }
  };

  // ---------------------------------------------------------- dictation

  const clearGrace = () => {
    if (grace !== undefined) clearTimer(grace);
    grace = undefined;
  };

  /**
   * @param {Mic} m
   * @param {number | undefined} sendAt
   */
  const armGrace = (m, sendAt) => {
    clearGrace();
    if (sendAt === undefined || mic !== m) return;
    grace = setTimer(
      () => {
        grace = undefined;
        if (mic !== m) return;
        const state = viewState();
        const text = m.draft.due(now(), {
          box: state.view ? state.view.input.text : '',
          micOn: true,
          utteranceOpen: m.endpointer.speaking(),
        });
        if (typeof text === 'string' && state.activeKey === m.draftKey) {
          controller.send(text, { spoken: true });
        }
      },
      Math.max(0, sendAt - now()),
    );
  };

  /**
   * An utterance on the bound port, or undefined while none is bound.
   *
   * @param {Mic} m
   */
  const openUtterance = m => {
    const c = conn;
    // Before READY the port refuses streams (W11.5: `portClosed`).
    if (!c || !c.bound || !c.socket || c.socket.closed()) return undefined;
    const port = c.port;
    return c.socket.utterance(
      E(port)
        .transcribe()
        .then((/** @type {any} */ answer) => answer.stream),
      {
        onEvent: (/** @type {SpeechEvent} */ event) => {
          if (event.type === 'partial') {
            setBox(m.draft.partial(String(event.text ?? '')).box);
          } else if (event.type === 'final') {
            const next = m.draft.final(String(event.text ?? ''), now());
            setBox(next.box);
            armGrace(m, next.sendAt);
          } else if (event.type === 'abort') {
            armGrace(m, m.draft.dropped(now()).sendAt);
            if (event.reason !== speechTexts.stopped) {
              note = String(event.reason ?? '');
              notify();
            }
          }
        },
      },
    );
  };

  /**
   * One capture block (W11.6's endpointer decides).
   *
   * @param {Mic} m
   * @param {Uint8Array} pcm
   * @param {number} rms
   */
  const onBlock = (m, pcm, rms) => {
    if (mic !== m) return;
    const decision = m.endpointer.block(rms, now());
    meter = {
      level: decision.level,
      floor: decision.floor,
      threshold: decision.threshold,
    };
    switch (decision.action) {
      case 'onset': {
        clearGrace();
        m.draft.onset();
        stopPlayback();
        if (decision.bargeIn) bargeIn = true;
        m.draftKey = viewState().activeKey;
        m.utterance = openUtterance(m);
        const before = m.preRoll.take();
        if (m.utterance) {
          for (const block of before) m.utterance.send(block);
          m.utterance.send(pcm);
        }
        break;
      }
      case 'speech':
        m.utterance?.send(pcm);
        break;
      case 'end':
        if (m.utterance) {
          m.utterance.send(pcm);
          m.utterance.end();
        }
        m.utterance = undefined;
        break;
      case 'discard':
        m.utterance?.abort();
        m.utterance = undefined;
        break;
      default:
        m.preRoll.push(pcm);
    }
    notify();
  };

  /** The mic off, and with it spoken mode (9.1). */
  const micOff = () => {
    const m = mic;
    spokenKey = undefined;
    if (!m) return;
    mic = undefined;
    m.capture.stop();
    m.utterance?.abort();
    clearGrace();
    const state = viewState();
    // R5-48: mic off discards the unsent text; a box the user typed in stays.
    if (m.draft.discard(state.view ? state.view.input.text : '')) setBox('');
    meter = { level: 0, floor: 0, threshold: 0 };
    updateWake();
    notify();
  };

  /**
   * Turn the microphone on: call inside the tap (R5-44, R5-55).
   *
   * @param {{ immediate?: boolean }} [options] invocation mode (R5-23)
   */
  const micOn = ({ immediate = false } = {}) => {
    if (mic) return;
    player.unlock();
    note = '';
    /** @type {Mic} */
    const m = {
      // Inside the tap, before anything is awaited (capture.js).
      capture: openCapture({ onBlock: (pcm, rms) => onBlock(m, pcm, rms) }),
      endpointer: makeEndpointer(endpointingDefaults, {
        immediate,
        busy,
        audible: () => player.audible(),
      }),
      preRoll: makePreRoll(),
      draft: makeSpokenDraft(),
      utterance: undefined,
      draftKey: undefined,
    };
    mic = m;
    m.capture.started.catch(error => {
      if (mic !== m) return;
      micOff();
      note =
        voiceUiTexts.captureFailure[
          /** @type {keyof typeof voiceUiTexts.captureFailure} */ (
            error?.reason
          )
        ] ?? voiceUiTexts.micUnavailable;
      notify();
    });
    ensurePort().catch(report);
    updateWake();
    notify();
  };

  // ------------------------------------------------- sessions and launch

  /**
   * Select a session once its row is listed (Talk, launch).
   *
   * @param {string} key
   */
  const selectWhenListed = key =>
    new Promise(resolve => {
      const listed = () =>
        controller
          .getState()
          .sessions.some(/** @param {any} row */ row => row.key === key);
      if (listed()) {
        resolve(controller.selectSession(key));
        return;
      }
      /** @type {() => void} */
      let unsubscribe = () => {};
      const timer = setTimer(() => {
        unsubscribe();
        resolve(undefined);
      }, LIST_WAIT_MS);
      unsubscribe = controller.subscribe(() => {
        if (!listed()) return;
        unsubscribe();
        clearTimer(timer);
        resolve(controller.selectSession(key));
      });
    });

  /**
   * `Voice.startVoiceSession`, then select the answered session and show
   * its warning (G-11).
   *
   * @param {Connection} c
   * @param {Record<string, any>} request
   */
  const startSession = async (c, request) => {
    talking = true;
    autoSpeakChoice = true;
    notify();
    try {
      const answer = await E(voiceOf(c)).startVoiceSession(request);
      if (answer.warning) note = answer.warning;
      await selectWhenListed(answer.key);
    } finally {
      talking = false;
      // The view the mic listens in (the new session's, once selected) is
      // in spoken mode (9.1).
      if (mic) spokenKey = viewState().activeKey;
      notify();
    }
  };

  /** @param {Connection} c */
  const launch = c => {
    const id = launchIdOf(location());
    if (id === undefined || launchedId !== undefined) return;
    launchedId = id;
    startSession(c, { invocationId: id, at: now() })
      .then(() => {
        micOn({ immediate: true });
        spokenKey = viewState().activeKey;
      })
      .catch(report);
  };

  // --------------------------------------------------- connection load

  /** @param {Connection} c */
  const load = async c => {
    const [configuration, preferences] = await Promise.all([
      E(c.speech)
        .configuration()
        .catch((/** @type {unknown} */ error) => {
          note = messageOf(error);
          return undefined;
        }),
      E(voiceOf(c))
        .getPreferences()
        .catch(() => undefined),
    ]);
    if (conn !== c) return;
    c.configuration = configuration;
    c.preferences = preferences;
    resolveFrom(c);
    if (preferences) writeCache();
    if (configuration && configuration.warning) note = configuration.warning;
    notify();
  };

  const closeConnection = () => {
    const c = conn;
    if (!c) return;
    conn = undefined;
    c.unsubscribe();
    c.waiting.length = 0;
    if (mic && mic.utterance) {
      mic.utterance.abort();
      mic.utterance = undefined;
    }
    if (playing) {
      playing.stream.stop();
      playing = undefined;
    }
    if (c.socket) c.socket.close();
  };

  // ------------------------------------------------ controller watching

  const onControllerChange = () => {
    const state = viewState();
    const current = state.view && state.view.current;
    if (current && !state.sessionPath?.[1] && state.activeKey !== undefined) {
      const seen = `${state.activeKey} ${current.turnId}`;
      if (seen !== lastTurn) {
        lastTurn = seen;
        if (isLive(current.state)) onTurnStart(state.activeKey, current.turnId);
      }
      // R5-48: Stop cancels the turn and stops its playback.
      if (
        current.state === 'cancelled' &&
        playing &&
        playing.turnId === current.turnId
      ) {
        stopPlayback();
      }
    }
    if (bargeIn && !busy()) {
      bargeIn = false;
      notify();
    }
    // Spoken mode belongs to one session view: leaving it ends it (9.1).
    if (spokenKey !== undefined && !talking && state.activeKey !== spokenKey) {
      micOff();
    }
    updateWake();
  };
  controller.subscribe(onControllerChange);

  // A typed send gets its receipt after the user gesture has ended.
  watchActivation(() => {
    if (speaks()) player.unlock();
  });

  watchVisibility(hidden => {
    if (mic) {
      if (hidden) {
        if (mic.endpointer.pause()) {
          mic.utterance?.abort();
          mic.utterance = undefined;
        }
      } else {
        mic.endpointer.resume();
      }
    }
    wakeLock.refresh();
  });

  // ----------------------------------------------------- shortcut preset

  /** @param {Connection} c */
  const loadShortcut = async c => {
    shortcut = { ...shortcut, state: 'loading' };
    notify();
    try {
      const catalog = E(c.context.powers.operator).getPresets();
      const [configuration, chosen] = await Promise.all([
        E(catalog).configuration(),
        E(voiceOf(c)).getVoicePreset(),
      ]);
      const entries = await Promise.all(
        configuration.presets.map((/** @type {any} */ preset) =>
          E(preset)
            .describe()
            .then(
              (/** @type {any} */ view) => ({
                preset,
                label: String(view.label),
                available: view.available !== false,
                ...(view.unavailableReason === undefined
                  ? {}
                  : { unavailableReason: String(view.unavailableReason) }),
              }),
              (/** @type {unknown} */ error) => ({
                preset,
                label: '',
                available: false,
                unavailableReason: messageOf(error),
              }),
            ),
        ),
      );
      if (conn !== c) return;
      shortcut = {
        state: 'ready',
        entries,
        selected: entries.findIndex(entry => entry.preset === chosen),
        revision: configuration.revision,
      };
    } catch (error) {
      shortcut = { ...shortcut, state: 'error' };
      note = messageOf(error);
    }
    notify();
  };

  // ------------------------------------------------------------ the API

  return harden({
    /**
     * Bind to the controller's current `FeatureContext` (idempotent): a new
     * context is a new connection, whose parts are rebuilt.
     *
     * @param {any} context
     */
    attach(context) {
      if (conn && conn.context === context) return;
      closeConnection();
      let speech;
      try {
        speech = context.powers ? context.extra('speech') : undefined;
      } catch {
        speech = undefined;
      }
      /** @type {Connection} */
      const c = {
        context,
        speech,
        voice: undefined,
        configuration: undefined,
        preferences: undefined,
        port: undefined,
        socket: undefined,
        bound: false,
        opening: undefined,
        attempt: 0,
        waiting: [],
        unsubscribe: () => {},
      };
      conn = c;
      shortcut = { state: 'idle', entries: [], selected: -1, revision: 0 };
      if (speech) {
        c.unsubscribe = controller.onSubmission(
          (/** @type {Record<string, any>} */ notice) =>
            onSubmission(c, notice),
        );
        load(c)
          .then(() => launch(c))
          .catch(report);
      }
      notify();
    },

    /** @returns {VoiceView} */
    view() {
      if (cachedView) return cachedView;
      const configuration = conn && conn.configuration;
      cachedView = harden({
        available: Boolean(conn && conn.speech),
        configured: Boolean(configuration),
        speechIn: Boolean(configuration && configuration.speechIn),
        speechOut: Boolean(configuration && configuration.speechOut),
        micOn: mic !== undefined,
        spoken: mic !== undefined,
        ...meter,
        autoSpeak: autoSpeak(),
        playing: player.playing(),
        talking,
        bargeIn,
        note: note.includes(speechTexts.turnNotLive)
          ? voiceUiTexts.playbackUnavailable
          : note,
        settings,
        voices: configuration ? configuration.voices : [],
        ranges: configuration ? configuration.ranges : ttsRanges,
        shortcut,
      });
      return cachedView;
    },

    /**
     * @param {() => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * The mode switch of the active session's view (9.1), called inside
     * the tap (R5-44, R5-55). Spoken mode turns the mic on; text mode turns
     * it off, discarding the unsent dictation (R5-48), and stops the reply
     * being read. Spoken mode needs both speech in and speech out.
     */
    toggleMode() {
      if (mic) {
        micOff();
        stopPlayback();
        notify();
        return;
      }
      const key = viewState().activeKey;
      const configuration = conn && conn.configuration;
      if (
        key === undefined ||
        !configuration ||
        !configuration.speechIn ||
        !configuration.speechOut
      ) {
        return;
      }
      micOn();
      spokenKey = key;
      notify();
    },

    /** @param {boolean} on "Spoken replies" (R5-56) */
    setAutoSpeak(on) {
      if (on) player.unlock();
      autoSpeakChoice = Boolean(on);
      if (!on) stopPlayback();
      notify();
    },

    /**
     * One preference field: used at once, cached on the device, written
     * after `settingsDebounceMs`; the running playback then restarts with
     * the new options (R5-50).
     *
     * @param {string} field
     * @param {unknown} value
     */
    setPreference(field, value) {
      if (!validPreference(field, value)) return;
      settings = resolveVoiceSettings({ ...settings, [field]: value });
      patch = { ...patch, [field]: value };
      writeCache();
      if (debounce !== undefined) clearTimer(debounce);
      const c = conn;
      debounce = setTimer(() => {
        debounce = undefined;
        const written = patch;
        patch = {};
        if (playing) playing.restart();
        if (!c || conn !== c || !c.speech) return;
        E(voiceOf(c))
          .setPreferences(written)
          .then((/** @type {Record<string, any>} */ answer) => {
            if (conn !== c) return;
            c.preferences = answer;
            resolveFrom(c);
            notify();
          })
          .catch(report);
      }, voiceLimits.settingsDebounceMs);
      notify();
    },

    /** Talk (P-49): a spoken session from the shortcut preset, mic on. */
    talk() {
      const c = conn;
      if (!c || !c.speech || talking) return;
      micOn();
      startSession(c, { at: now() }).catch(report);
    },

    /**
     * Replay the selected assistant message, independently of auto-speak.
     * @param {import('../conversation/ToolGroup.js').ShownMessage} message
     */
    replay(message) {
      player.unlock();
      const run = async () => {
        // A later selection or Stop can supersede an archived text read.
        playGeneration += 1;
        const selected = playGeneration;
        const pieces = await replayPiecesOf([message], staged =>
          controller.readContent(staged),
        );
        if (selected !== playGeneration || pieces.length === 0) return;
        await startPlayback(
          c => E(c.speech).replay(c.port, pieces, ttsOptions()),
          {
            restart: () => {
              run().catch(report);
            },
          },
        );
      };
      return run().catch(report);
    },

    /** The Voice panel opened: read the preferences and the shortcut again. */
    panelOpened() {
      const c = conn;
      if (!c || !c.speech) return;
      E(voiceOf(c))
        .getPreferences()
        .then((/** @type {Record<string, any>} */ preferences) => {
          if (conn !== c) return;
          c.preferences = preferences;
          resolveFrom(c);
          writeCache();
          notify();
        })
        .catch(report);
      loadShortcut(c).catch(report);
    },

    /**
     * Choose the shortcut's preset (R5-53) with the catalogue revision read;
     * a stale revision is refused by the factory and the list is read again.
     *
     * @param {number} index
     */
    async chooseShortcut(index) {
      const c = conn;
      const entry = shortcut.entries[index];
      if (!c || !entry) return;
      try {
        await E(voiceOf(c)).setVoicePreset(entry.preset, shortcut.revision);
      } catch (error) {
        note = messageOf(error);
      }
      await loadShortcut(c);
    },
  });
};
harden(makeVoiceState);

/**
 * The page's own `VoiceIo` (everything but the controller): the browser's
 * WebSocket, microphone, Web Audio, wake lock, storage, location and
 * visibility, each read when first used, never at import (Node imports
 * this module to collect the features).
 *
 * @returns {Omit<VoiceIo, 'controller'>}
 */
export const browserVoiceIo = () => {
  const g = /** @type {any} */ (globalThis);
  return {
    storage: () => {
      try {
        return g.localStorage;
      } catch {
        return undefined;
      }
    },
    location: () => g.location,
    sessionStorage: () => {
      try {
        return g.sessionStorage;
      } catch {
        return undefined;
      }
    },
    openSocket: ({ url, token, onClose }) =>
      openAudioSocket({ url, token, WebSocket: g.WebSocket, onClose }),
    openCapture: ({ onBlock }) => openBrowserCapture({ onBlock }),
    makePlayer: onChange => makeBrowserPlayer({ onChange }),
    wakeLock: makeScreenWakeLock({
      getApi: () => g.navigator?.wakeLock,
      isVisible: () => g.document?.visibilityState !== 'hidden',
    }),
    watchActivation: onGesture => {
      const activate = (/** @type {Event} */ event) => {
        if (event.isTrusted) onGesture();
      };
      g.document?.addEventListener?.('click', activate, true);
      g.document?.addEventListener?.('keydown', activate, true);
    },
    watchVisibility: onChange => {
      g.document?.addEventListener?.('visibilitychange', () =>
        onChange(g.document.visibilityState === 'hidden'),
      );
    },
  };
};
harden(browserVoiceIo);

/** @type {WeakMap<object, ReturnType<typeof makeVoiceState>>} */
const statesByPage = new WeakMap();

/**
 * The page's voice state, bound to `context` (a new context, made by the
 * controller at each attach, is a new connection). Found by the context's
 * controller: one state per page.
 *
 * @param {any} context a `FeatureContext`
 * @param {() => Omit<VoiceIo, 'controller'>} [ioOf] the page's io, asked
 *   once per page (tests pass fakes)
 */
export const voiceStateOf = (context, ioOf = browserVoiceIo) => {
  const { controller } = context;
  let state = statesByPage.get(controller);
  if (!state) {
    state = makeVoiceState({ ...ioOf(), controller });
    statesByPage.set(controller, state);
  }
  state.attach(context);
  return state;
};
harden(voiceStateOf);
