// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import harden from '@endo/harden';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { FlootApp } from '@endo/space-floot';
import { h, renderConfined, unmount } from './setup-preact-container.js';
import { makeScreenWakeLock } from './wake-lock.js';
import { makeFlootRecovery } from './floot-recovery.js';
import { makeFlootNetwork } from './floot-network.js';
import { makeFlootExecution } from './floot-execution.js';
import {
  applyTranscriptEvent,
  normalizePending,
} from './floot-session-state.js';

// The view's controller/state/message shapes are defined (and enforced at the
// `h(FlootApp, …)` boundary) by `@endo/space-floot`'s own types; like the other
// migrated space wrappers (e.g. peers-component.js) the host does not re-import
// them.

// ── Background turns ─────────────────────────────────────────────────────────
// A Floot turn runs on the daemon, which also decides when one starts: this
// side submits text (`session.enqueue`) and is told of the turn through the
// session's `watch()`. It is a view: it pulls the turn's disposable `watch()`
// stream and stops the turn only by calling `cancel()`. Dropping the stream — unmount, tab close, gateway loss —
// detaches this viewer and leaves the turn running to finish and persist.
// The loop is kept HERE, outside any component instance, so a remounted
// component reattaches to the accumulated state of a still-streaming reply and
// shows a "thinking" indicator. The entry is removed once the turn ends, so a
// finished reply simply falls back to getHistory().
/**
 * @typedef {{ role: 'assistant' | 'tool', text?: string, id?: string,
 *   name?: string, args?: string, result?: string | null }} TurnMessage
 * @typedef {{
 *   sessionId: string,
 *   ref: Promise<any>,
 *   target: any,
 *   retire: () => void,
 *   messages: TurnMessage[],
 *   streamingText: string,
 *   phase: string,
 *   done: boolean,
 *   error: string | null,
 *   usage: { inputTokens: number, outputTokens: number, turns: number } | null,
 *   whenDone: Promise<void>,
 *   subscribe: (fn: (ev: { type: string }) => void) => () => void,
 *   stop: () => void,
 * }} FlootTurn
 */
/** @type {WeakMap<object, Map<string, FlootTurn>>} */
const inFlightTurns = new WeakMap();

/** @param {object} factory */
const turnsForFactory = factory => {
  let turns = inFlightTurns.get(factory);
  if (!turns) {
    turns = new Map();
    inFlightTurns.set(factory, turns);
  }
  return turns;
};

/**
 * Watch a daemon-owned turn in the background, accumulating renderable turn
 * state and notifying subscribers as events arrive. Survives component unmount.
 *
 * @param {Map<string, FlootTurn>} registry
 * @param {string} key session id
 * @param {string} sessionId
 * @param {any} turnRef the FlootTurn returned by session.startTurn()
 * @returns {FlootTurn}
 */
const startFlootTurn = (registry, key, sessionId, turnRef) => {
  // Stream the view over the exo-stream protocol rather than one CapTP round
  // trip per event. `buffer` primes the synchronize chain; the responder is a
  // buffered channel, so it acknowledges eagerly regardless — the pre-resolved
  // nodes only save the first round trip.
  const repliesP = E(turnRef)
    .watch()
    .then(view => iterateReader(view, { buffer: 8 }));
  /** @type {Set<(ev: { type: string }) => void>} */
  const listeners = new Set();
  /** @type {TurnMessage[]} */
  const messages = [];
  // Tool calls in one batch run concurrently, so results arrive out of order —
  // track each pending call by its id and pair its result back by id.
  /** @type {Map<string, TurnMessage>} */
  const pendingTools = new Map();
  let stopped = false;
  /** @type {() => void} */
  let resolveDone = () => {};
  /** @type {Promise<void>} */
  const whenDone = new Promise(resolve => {
    resolveDone = resolve;
  });

  /** @param {{ type: string }} ev */
  const emit = ev => {
    for (const fn of [...listeners]) {
      try {
        fn(ev);
      } catch {
        // a view error must not stall the background loop
      }
    }
  };

  /** @type {FlootTurn} */
  const turn = {
    sessionId,
    ref: Promise.resolve(turnRef),
    // The turn itself, for telling one observation from another: the session
    // names the turn in flight by this same presence.
    target: turnRef,
    retire() {
      // Retiring an obsolete observation never cancels daemon execution.
      if (registry.get(key) === turn) registry.delete(key);
      emit({ type: 'superseded' });
      listeners.clear();
      void repliesP.then(reader => reader.return()).catch(() => {});
    },
    messages,
    streamingText: '',
    phase: 'thinking',
    done: false,
    error: null,
    usage: null,
    whenDone,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Cancelling is the only thing that stops the turn: dropping the view
      // stream would just detach this viewer and leave it generating.
      E(turnRef)
        .cancel()
        .catch(error => {
          stopped = false;
          turn.error = error instanceof Error ? error.message : String(error);
          emit({ type: 'abort' });
        });
    },
  };
  registry.set(key, turn);

  (async () => {
    try {
      for await (const raw of await repliesP) {
        const value = /** @type {any} */ (raw);
        if (value.type === 'snapshot') {
          // A view opens on the turn's state as of the moment `watch()` ran, so
          // no event is lost to the round trip and a reattaching component
          // repaints a turn already in progress. Adopt it wholesale.
          const { status } = value;
          messages.length = 0;
          // The snapshot arrives hardened; a pending tool message is still
          // waiting for its result to be written into it, so keep copies.
          messages.push(
            ...status.messages.map((/** @type {TurnMessage} */ message) => ({
              ...message,
            })),
          );
          pendingTools.clear();
          for (const message of messages) {
            if (message.role === 'tool' && message.id && !message.result) {
              pendingTools.set(message.id, message);
            }
          }
          turn.streamingText = status.streamingText;
          turn.phase = status.phase;
          turn.usage = status.usage;
          turn.error = status.error;
          emit({ type: 'snapshot' });
        } else if (value.type === 'delta') {
          turn.streamingText += value.text;
          emit({ type: 'delta' });
        } else if (value.type === 'final') {
          turn.streamingText = value.text;
          emit({ type: 'final' });
        } else if (value.type === 'tool_call') {
          if (turn.streamingText.trim()) {
            messages.push({
              role: 'assistant',
              text: turn.streamingText.trim(),
            });
          }
          turn.streamingText = '';
          const toolMsg = {
            role: /** @type {const} */ ('tool'),
            id: value.id,
            name: value.name,
            args: value.args,
            result: /** @type {string | null} */ (null),
          };
          pendingTools.set(value.id, toolMsg);
          messages.push(toolMsg);
          emit({ type: 'tool_call' });
        } else if (value.type === 'tool_result') {
          const toolMsg = pendingTools.get(value.id);
          if (toolMsg) {
            toolMsg.result = value.result;
            pendingTools.delete(value.id);
          }
          emit({ type: 'tool_result' });
        } else if (value.type === 'phase') {
          turn.phase = value.phase;
          emit({ type: 'phase' });
        } else if (value.type === 'usage') {
          turn.usage = {
            inputTokens: value.inputTokens,
            outputTokens: value.outputTokens,
            turns: value.turns,
          };
          emit({ type: 'usage' });
        } else if (value.type === 'end') {
          break;
        } else if (value.type === 'abort') {
          turn.error = value.reason;
          emit({ type: 'abort' });
          break;
        }
      }
      if (turn.streamingText.trim()) {
        messages.push({ role: 'assistant', text: turn.streamingText.trim() });
        turn.streamingText = '';
      }
    } catch (err) {
      turn.error = /** @type {Error} */ (err)?.message || String(err);
      emit({ type: 'abort' });
    } finally {
      turn.done = true;
      if (registry.get(key) === turn) registry.delete(key);
      emit({ type: 'done' });
      resolveDone();
    }
  })();

  return turn;
};

// ── PCM / base64 helpers (pure; host-side) ───────────────────────────────────

// Average-decimate Float32 [-1,1] samples from inRate to outRate as s16le PCM.
const toPcm16le = (
  /** @type {Float32Array} */ input,
  /** @type {number} */ inRate,
  /** @type {number} */ outRate,
) => {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const bytes = new Uint8Array(outLen * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < outLen; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = end > start ? sum / (end - start) : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      i * 2,
      clamped < 0 ? clamped * 32_768 : clamped * 32_767,
      true,
    );
  }
  return bytes;
};
harden(toPcm16le);

const bytesToBase64 = (/** @type {Uint8Array} */ bytes) => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      /** @type {any} */ (bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
};
harden(bytesToBase64);

const base64ToBytes = (/** @type {string} */ b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
harden(base64ToBytes);

// Buffered async-iterator exo: the remote audio object pulls frames with
// next(); the mic callback pushes them. Each next() coalesces all PCM buffered
// since the last pull into one frame so a slow CapTP round trip catches up in
// one message instead of letting audio back up unboundedly.
const makeAudioChannel = () => {
  /** @type {Uint8Array[]} */
  let pcmChunks = [];
  /** @type {any} */
  let terminal = null;
  let finished = false;
  /** @type {((value?: unknown) => void) | null} */
  let wake = null;

  const wakeUp = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const reader = Far('StreamReader', {
    next: async () => {
      for (;;) {
        if (pcmChunks.length) {
          const chunks = pcmChunks;
          pcmChunks = [];
          let total = 0;
          for (const c of chunks) total += c.length;
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
          }
          return harden({
            value: harden({ type: 'bytes', b64: bytesToBase64(merged) }),
            done: false,
          });
        }
        if (terminal) {
          const value = terminal;
          terminal = null;
          finished = true;
          return harden({ value, done: false });
        }
        if (finished) return harden({ value: undefined, done: true });
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => {
          wake = resolve;
        });
      }
    },
    return: async () => {
      finished = true;
      pcmChunks = [];
      terminal = null;
      wakeUp();
      return harden({ value: undefined, done: true });
    },
    throw: async (/** @type {any} */ error) => {
      finished = true;
      pcmChunks = [];
      terminal = null;
      wakeUp();
      throw error;
    },
  });

  return harden({
    reader,
    writeBytes: (/** @type {Uint8Array} */ pcm) => {
      if (finished || terminal) return;
      pcmChunks.push(pcm);
      wakeUp();
    },
    end: () => {
      if (finished || terminal) return;
      terminal = harden({ type: 'end' });
      wakeUp();
    },
  });
};
harden(makeAudioChannel);

// A text feed the chat pushes a finished message's full text into for replay.
// The remote TTS object consumes it and returns an audio stream. (A live turn
// is spoken by the daemon instead, from its own view of the turn.)
// Wire (APPEND deltas): { type:'delta', text } | { type:'end' } | { type:'abort' }
const makeTextFeed = () => {
  const { push, reader, isClosed } = makeBufferedReader();
  return harden({
    reader,
    delta: (/** @type {string} */ text) => push({ type: 'delta', text }),
    end: () => push({ type: 'end' }),
    abort: () => push({ type: 'abort', reason: 'cancelled' }),
    isClosed,
  });
};
harden(makeTextFeed);

// Continuous, hands-free listening with noise-floor voice-activity detection
// (ported from the Floot Native web UI's useVAD). The mic stays open; an
// AnalyserNode tracks RMS volume. After a 1s calibration we learn the room's
// noise floor and derive a speech threshold; crossing it starts an utterance
// (a fresh transcribe() stream), and trailing silence ends it and auto-sends.
const VAD = harden({
  CALIBRATION_MS: 1000,
  // Silence that ends an utterance. This is now a *tentative* end: the text is
  // buffered, not sent, until RESUME_GRACE_MS more passes without speech.
  SILENCE_MS: 1200,
  // After a tentative end, wait this long for the user to resume a pause-heavy
  // thought before sending. Resumed speech is appended, so an intra-thought
  // pause no longer kicks off a reply mid-sentence and drops the rest.
  RESUME_GRACE_MS: 800,
  MIN_SPEECH_MS: 400,
  PREROLL_FRAMES: 6, // ~0.5s of buffered audio prepended so onsets aren't clipped
  EMA_ALPHA: 0.01,
  THRESHOLD_MULT: 2.5,
  BARGE_MULT: 3,
  // Extra barge headroom required while our own TTS is audibly playing. The
  // phone speaker leaks the bot's voice back into the mic past browser echo
  // cancellation; without this the bot barges in on itself.
  ECHO_BARGE_MULT: 2,
  MIN_THRESHOLD: 0.01,
  MIN_BARGE: 0.05,
  DISPLAY_FULL_SCALE: 0.1,
});

// Transcripts the recognizer commonly hallucinates from silence/noise; drop
// them so a stray blip doesn't auto-send a junk turn.
const JUNK_PHRASES = harden(
  new Set([
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
    '',
  ]),
);

const DEFAULT_TITLE = 'New chat';
const DEFAULT_PRESET_ID = 'general';
// How long after the last voice-settings change to persist it and restart any
// speech in progress with it.
const TTS_SETTINGS_COMMIT_MS = 300;

/**
 * Floot Chat Space, host wrapper. Resolves a Floot factory from the
 * profilePath (the `floot-factory` caplet created by @endo/floot) and holds
 * typed conversations with it, then mounts the PURE confined Preact view
 * (`@endo/space-floot`'s `FlootApp`) through chat's sanitizing
 * `renderConfined`.
 *
 * This wrapper owns everything the confined view cannot touch: the CapTP
 * resolution, the module-level background-turn registry, mic capture + Web
 * Audio + the VAD loop, and TTS playback. It exposes all of that to the view
 * only as a `controller` — pure-data `getState()` snapshots plus callbacks.
 * No DOM node, audio handle, `MediaStream`, or capability ever crosses into
 * the view (see packages/space-floot/DESIGN.md).
 *
 * The factory owns every session; the UI never sees the backing guests. Its
 * interface includes record-form
 * `createSession({title,presetId,backendId,modelId,reasoningEffort}) -> facet`,
 * `listSessions()` with backend/model/reasoning/lifecycle metadata,
 * `listBackends()`, `listModels(backendId?)`, `getSession(id) -> facet`,
 * `renameSession(id,title)`, `deleteSession(id)`, and `listPresets()`.
 * A session facet exposes
 * `startTurn(input) -> FlootTurn`, `getHistory()`, `getInfo()`, and
 * `getUsage()`.
 *
 * When `audioPath` is given, it resolves a speech-to-text object and enables a
 * mic: speech is captured as 16 kHz mono PCM, streamed to
 * `transcribe(audioReader) -> textReader`, and the transcript fills the compose
 * box live; on end the assembled message is sent. When `ttsPath` is given, it
 * resolves a text-to-speech object and hands it to the daemon: a spoken reply
 * is a view of the turn the daemon speaks (`turn.speak(ttsServer, options)`),
 * so reply text never round-trips through this browser to be heard; the audio
 * stream that comes back (raw s16le mono PCM) is played via Web Audio as it
 * arrives. Voice and Piper controls come from the object's `getConfiguration()`
 * and are kept as whole-Floot preferences on the factory, cached per device.
 *
 * @param {HTMLElement} $parent
 * @param {unknown} rootPowers
 * @param {string[]} profilePath
 * @param {(newPath: string[]) => void} _onProfileChange
 * @param {string[]} [audioPath] - pet-name path to a speech-to-text object
 * @param {string[]} [ttsPath] - pet-name path to a text-to-speech object
 * @returns {() => void} cleanup function
 */
export const flootComponent = (
  $parent,
  rootPowers,
  profilePath,
  _onProfileChange,
  audioPath,
  ttsPath,
) => {
  // Resolve the floot factory by walking the profile path.
  /** @type {any} */
  let factory = rootPowers;
  for (const name of profilePath) {
    factory = E(/** @type {any} */ (factory)).lookup(name);
  }

  // Optionally resolve a speech-to-text object for mic input, the same way.
  const hasMic = Boolean(audioPath && audioPath.length);
  /** @type {any} */
  let audioServer = null;
  if (hasMic) {
    audioServer = rootPowers;
    for (const name of /** @type {string[]} */ (audioPath)) {
      audioServer = E(/** @type {any} */ (audioServer)).lookup(name);
    }
  }

  // Optionally resolve a text-to-speech object for spoken replies, the same way.
  const hasTts = Boolean(ttsPath && ttsPath.length);
  /** @type {any} */
  let ttsServer = null;
  if (hasTts) {
    ttsServer = rootPowers;
    for (const name of /** @type {string[]} */ (ttsPath)) {
      ttsServer = E(/** @type {any} */ (ttsServer)).lookup(name);
    }
  }
  // Spoken replies on by default when a TTS object is wired; toggled by the
  // speaker button. Replay buttons work regardless of this live-speech setting.
  let ttsEnabled = hasTts;
  /**
   * @typedef {{
   *   voice: string, speed: number, noiseScale: number, noiseW: number,
   *   sentenceSilence: number,
   * }} TtsSettings
   */
  /**
   * @typedef {'speed' | 'noiseScale' | 'noiseW' | 'sentenceSilence'}
   *   NumericTtsSetting
   */
  // Piper's own defaults: the seed until the TTS object's configuration and
  // the whole-Floot preferences arrive (see the load at mount), and the
  // fallback for a value the object neither accepts nor replaces.
  const ttsSeed = harden({
    speed: 1,
    noiseScale: 0.667,
    noiseW: 0.8,
    sentenceSilence: 0.2,
  });
  /** @type {TtsSettings} */
  let ttsSettings = { voice: '', ...ttsSeed };
  /**
   * @type {{
   *   voices: Array<{ id: string, name: string }>,
   *   ranges: Record<string, { min: number, max: number, step: number }>,
   * }}
   */
  let ttsConfiguration = { voices: [], ranges: {} };
  // Per-device cache of the settings, keyed by the TTS object so two wired
  // objects with different voices do not share one.
  const ttsStorageKey = `floot-tts:${(ttsPath || []).join('/')}`;

  // ── View-model state (read by getState, mutated by the host engine) ─────────
  /**
   * @typedef {{ role: 'user' | 'assistant' | 'tool', text?: string,
   *   meta?: { mail?: { from?: string } },
   *   name?: string, args?: string, result?: string | null }} HistoryMessage
   * @typedef {{ id: string, title: string, createdAt: number, presetId: string,
   *   model: string, backendId?: string, modelId?: string,
   *   effectiveModelId?: string, reasoningEffort?: string,
   *   messages: HistoryMessage[], facet: any, loaded: boolean,
   *   lifecycle?: string,
   *   activity?: 'passive' | 'working' | 'error', pendingCount?: number,
   *   transcript: { version: number, messages: readonly any[] } | null,
   *   current: { input: string | null, turn: any, pendingId?: string } | null,
   *   running: { input: string, from?: string } | null,
   *   pending: import('./floot-session-state.js').PendingState,
   *   displayTurn: FlootTurn | null,
   *   tail?: { input: string | null, turn: FlootTurn } | null,
   *   transcriptStale?: boolean }}
   *   FlootSession
   *
   * `messages` is the settled transcript the session pushes; `current` is the
   * UI turn in flight and `displayTurn` this page's observation of it;
   * `running` is whatever the agent is running, which for a mail turn is all
   * there is; `pending` is the daemon's queue of submissions not yet run.
   * @typedef {{ id: string, title: string, description: string }} FlootPreset
   * @typedef {{ id: string, title: string, description: string,
   *   default: boolean, backendId?: string, backendTitle?: string, modelId?: string,
   *   defaultReasoningEffort?: string | null, reasoningEfforts?: string[] }} FlootModel
   */

  /** @type {FlootPreset[]} */
  let presets = [];
  /** @type {FlootModel[]} */
  let models = [];
  /** @type {Array<{ id: string, title?: string }>} */
  let backends = [];
  /** @type {FlootSession[]} */
  let sessions = [];
  /** @type {string | null} */
  let activeSessionId = null;
  /** @type {Map<string, 'idle' | 'streaming' | 'error'>} */
  const sessionStatus = new Map();

  let status = 'Loading sessions…';
  let inputText = '';
  let settingsOpen = false;
  // Whether the transcript should follow new content to the bottom. Tracked
  // host-side (see the scroll observer at mount) because the confined view
  // cannot touch DOM scroll positions.
  let stick = true;
  /** @type {{ inputTokens: number, outputTokens: number } | null} */
  let usage = null;

  // Voice/meter state (pure data — no audio objects).
  let voiceTranscript = '';
  let replayingText = '';
  let meterVol = 0;
  let meterNoise = 0;
  let meterThreshold = VAD.MIN_THRESHOLD;

  // ── Subscription / snapshot plumbing ────────────────────────────────────────
  /** @type {Set<() => void>} */
  const listeners = new Set();
  // Assigned for real further down, once every binding it reads exists (see
  // "Screen wake lock"). A no-op until then, because `notify` runs during setup
  // and reaching a `let` before its declaration would throw.
  let updateWakeLock = () => {};
  const notify = () => {
    try {
      updateWakeLock();
    } catch {
      // the screen is a nicety; it must not stall the engine either
    }
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // a view error must not stall the engine
      }
    }
  };
  const setStatus = (/** @type {string} */ s) => {
    status = s;
    notify();
  };
  const saveTtsSettings = () => {
    try {
      window.localStorage.setItem(ttsStorageKey, JSON.stringify(ttsSettings));
    } catch {
      // Storage may be unavailable in a private or embedded browser context.
    }
  };
  // The synthesis options handed to the TTS object (directly for a replay,
  // through the daemon for a spoken turn). An unset voice means its default.
  const currentTtsOptions = () =>
    harden({
      ...(ttsSettings.voice ? { voice: ttsSettings.voice } : {}),
      speed: ttsSettings.speed,
      noiseScale: ttsSettings.noiseScale,
      noiseW: ttsSettings.noiseW,
      sentenceSilence: ttsSettings.sentenceSilence,
    });

  const getActiveSession = () =>
    sessions.find(s => s.id === activeSessionId) || null;

  const autoTitle = (/** @type {string} */ text) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!trimmed) return DEFAULT_TITLE;
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
  };

  // Resolve (and cache) the session facet for a session.
  const facetFor = (/** @type {FlootSession} */ session) => {
    if (!session.facet) session.facet = E(factory).getSession(session.id);
    return session.facet;
  };

  // A session has work outstanding while a turn is in flight or a submission
  // waits behind one. Both are the daemon's to say (see `applySessionEvent`).
  const hasOutstandingWork = () => {
    const session = sessions.find(s => s.id === activeSessionId);
    return Boolean(
      session && (session.current || session.pending.entries.length > 0),
    );
  };
  const recovery = makeFlootRecovery({
    notify,
    isBusy: hasOutstandingWork,
  });
  const network = makeFlootNetwork({
    notify,
    isBusy: () =>
      Boolean(recovery.getState().resolving || hasOutstandingWork()),
  });
  const execution = makeFlootExecution({ notify });

  /** @param {any[]} history
   * @returns {HistoryMessage[]} */
  const historyMessages = history => {
    return history.map((/** @type {any} */ m) =>
      m.role === 'tool'
        ? { role: 'tool', name: m.name, args: m.args, result: m.result }
        : {
            role: m.role === 'user' ? 'user' : 'assistant',
            text: m.content,
            ...(m.meta ? { meta: m.meta } : {}),
          },
    );
  };

  // Create a new session on the factory and prepend it to the local list.
  /**
   * @param {string} [title]
   * @param {string} [presetId]
   * @param {string} [model]
   * @param {string} [reasoningEffort]
   */
  const createSession = async (title, presetId, model, reasoningEffort) => {
    const selected = models.find(candidate => candidate.id === model);
    // Always the record form: it is the only one that can say this session is
    // driven from here, where replies are read aloud. The factory composes
    // the voice rules into the system prompt of a session that says so, and
    // of no other.
    const facet = await E(factory).createSession({
      title: title || DEFAULT_TITLE,
      spoken: true,
      ...(presetId ? { presetId } : {}),
      ...(model ? { model } : {}),
      ...(selected?.backendId
        ? {
            backendId: selected.backendId,
            modelId: selected.modelId || model,
          }
        : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    const info = await E(facet).getInfo();
    /** @type {FlootSession} */
    const session = {
      id: info.id,
      title: info.title || DEFAULT_TITLE,
      createdAt: info.createdAt || Date.now(),
      presetId: info.presetId || DEFAULT_PRESET_ID,
      model: info.model || '',
      backendId: info.backendId || 'provider',
      modelId: info.modelId || '',
      effectiveModelId: info.effectiveModelId || '',
      reasoningEffort: info.reasoningEffort || '',
      messages: [],
      facet,
      loaded: true,
      transcript: null,
      current: null,
      running: null,
      pending: normalizePending(null),
      displayTurn: null,
    };
    // The session list's own subscription reports the new session too, and
    // usually first (`getInfo` above is a second round trip). There must be
    // one record per session: adopt what this call learned into that one.
    const listed = sessions.find(existing => existing.id === session.id);
    if (listed) {
      Object.assign(listed, { facet, loaded: true });
      activeSessionId = listed.id;
      return listed;
    }
    sessions.unshift(session);
    activeSessionId = session.id;
    return session;
  };

  // ── Snapshot ────────────────────────────────────────────────────────────────
  const PCT = (/** @type {number} */ v) =>
    Math.min(100, (v / VAD.DISPLAY_FULL_SCALE) * 100);

  /** @param {HistoryMessage | TurnMessage} m */
  const toViewMessage = m =>
    m.role === 'tool'
      ? {
          role: /** @type {const} */ ('tool'),
          id: /** @type {any} */ (m).id,
          name: m.name,
          args: m.args,
          result: m.result == null ? null : m.result,
        }
      : {
          role: /** @type {'user' | 'assistant'} */ (m.role),
          text: m.text || '',
          .../** @type {any} */ (
            /** @type {{ meta?: unknown }} */ (m).meta
              ? { meta: /** @type {{ meta?: unknown }} */ (m).meta }
              : {}
          ),
        };

  // What a session runs on, in words. The factory reports ids; the titles come
  // from the catalogs already loaded for the new-session picker. A session
  // whose backend or model has since left the catalog still says which it was,
  // by id, rather than going blank.
  const backendLabelOf = (/** @type {FlootSession} */ s) => {
    const id = s.backendId || 'provider';
    const known = backends.find(b => b.id === id);
    if (known?.title) return known.title;
    return id === 'provider' ? 'Fae' : id;
  };
  const modelLabelOf = (/** @type {FlootSession} */ s) => {
    const backendId = s.backendId || 'provider';
    const known =
      models.find(m => m.id === s.model) ||
      models.find(
        m =>
          (m.backendId || 'provider') === backendId && m.modelId === s.modelId,
      );
    if (known?.title) return known.title;
    if (s.modelId || s.model) return s.modelId || s.model;
    // An unpinned session runs whatever the factory is configured with. The
    // catalog's `default` flag is a picker pre-selection, not a statement of
    // what runs (a configured model outside the catalog leaves the flag on a
    // model the session never uses), so it is not borrowed here. A factory
    // that knows reports it as `effectiveModelId`.
    if (s.effectiveModelId) {
      const effective = models.find(
        m =>
          (m.backendId || 'provider') === backendId &&
          (m.id === s.effectiveModelId || m.modelId === s.effectiveModelId),
      );
      return `${effective?.title || s.effectiveModelId} (default)`;
    }
    return 'default model';
  };

  const getState = () => {
    const session = getActiveSession();
    const current = session ? session.current : null;
    const shown = session ? session.displayTurn : null;
    // The settled transcript, then the turn in flight: its prompt and this
    // page's observation of its output. With no UI turn, whatever the agent is
    // running on its own (a mail turn) still shows its prompt, so a session
    // that is working never looks idle.
    /** @type {Array<HistoryMessage | TurnMessage>} */
    const sent = session ? [...session.messages] : [];
    if (current) {
      if (typeof current.input === 'string') {
        sent.push({ role: 'user', text: current.input });
      }
      if (shown) sent.push(...shown.messages);
    } else if (session?.tail) {
      // The turn is over but the transcript that contains it could not be
      // read yet: what was on screen stays there until it can.
      if (typeof session.tail.input === 'string') {
        sent.push({ role: 'user', text: session.tail.input });
      }
      sent.push(...session.tail.turn.messages);
    } else if (session?.running) {
      sent.push({
        role: 'user',
        text: session.running.input,
        ...(session.running.from
          ? { meta: { mail: { from: session.running.from } } }
          : {}),
      });
    }
    // Submissions not yet run render after the live turn's output: they run
    // after it, and hiding them until then reads as a swallowed message. The
    // view lifts them out by `pending` and puts them below the thinking
    // indicator. First the daemon's queue, then what this page has sent and
    // the daemon has not yet acknowledged.
    const queuedEntries = session
      ? session.pending.entries.filter(
          // The entry being dispatched IS the turn in flight.
          entry => !(entry.state === 'dispatching' && current),
        )
      : [];
    const queued = [
      ...queuedEntries.map(entry => ({
        role: /** @type {const} */ ('user'),
        text: entry.text,
        pending: true,
        pendingId: entry.id,
        pendingState:
          entry.state === 'dispatching'
            ? /** @type {const} */ ('sending')
            : /** @type {'queued' | 'interrupted'} */ (entry.state),
      })),
      // What this page has sent and the daemon has not yet been seen to have:
      // shown until the daemon's own report of that very message arrives, so
      // it is on screen exactly once throughout (see `reconcileSends`).
      ...(session
        ? inFlightSends
            .filter(send => send.sessionId === session.id && !send.seen)
            .map(send => ({
              role: /** @type {const} */ ('user'),
              text: send.text,
              pending: true,
              pendingId: `local-${send.id}`,
              pendingState: /** @type {const} */ ('sending'),
            }))
        : []),
    ];
    const allMessages = [...sent.map(toViewMessage), ...queued];
    const liveTurn = current && shown && !shown.done ? shown : null;
    // A turn this page has seen finish is not one it can stop, even while the
    // session has yet to report it gone (that waits for the transcript).
    const stoppable = Boolean(current) && !(shown && shown.done);
    const working = stoppable || Boolean(!current && session?.running);
    return harden({
      sessions: sessions.map(s => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        presetId: s.presetId,
        model: s.model,
        backendLabel: backendLabelOf(s),
        modelLabel: modelLabelOf(s),
        reasoningEffort: s.reasoningEffort || '',
        // The daemon says what each session is doing; for the one on screen
        // this page knows of a turn the moment it is told, and of a failure
        // the moment it sees one.
        status:
          s.id === activeSessionId && (s.current || s.running)
            ? /** @type {const} */ ('working')
            : sessionStatus.get(s.id) || s.activity || 'passive',
        messageCount: s.messages.length,
        // For the session on screen the subscription is fresher than the list.
        pendingCount:
          s.id === activeSessionId
            ? s.pending.entries.length
            : s.pendingCount || 0,
        loaded: s.loaded,
        lifecycle: s.lifecycle,
      })),
      activeSessionId,
      presets: presets.map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
      })),
      models: models.map(m => ({
        id: m.id,
        title: m.title,
        description: m.description,
        default: m.default,
        backendId: m.backendId,
        backendTitle: m.backendTitle,
        defaultReasoningEffort: m.defaultReasoningEffort,
        reasoningEfforts: m.reasoningEfforts,
      })),
      messages: allMessages,
      streamingText: liveTurn ? liveTurn.streamingText : '',
      phase: liveTurn ? liveTurn.phase : (working && 'thinking') || '',
      // `busy` offers Stop, which needs a turn this page can cancel.
      busy: stoppable,
      working,
      pendingHold: session?.pending.hold?.message || '',
      loaded: session ? session.loaded : false,
      status,
      input: inputText,
      settingsOpen,
      recovery: recovery.getState(),
      network: network.getState(),
      execution: execution.getState(),
      unavailable: Boolean(session?.lifecycle && session.lifecycle !== 'ready'),
      usage: usage
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : null,
      voice: {
        hasMic,
        hasTts,
        micActive,
        speaking,
        ttsEnabled,
        ttsSpeaking,
        meterPct: PCT(meterVol),
        noisePct: PCT(meterNoise),
        thresholdPct: PCT(meterThreshold),
        transcript: voiceTranscript,
        replayingText,
        micError,
        ttsSettings: { ...ttsSettings },
        ttsConfiguration: {
          voices: ttsConfiguration.voices.map(voice => ({ ...voice })),
          ranges: { ...ttsConfiguration.ranges },
        },
      },
      objects: {
        controller: profilePath.join('/'),
        stt: hasMic ? /** @type {string[]} */ (audioPath).join('/') : undefined,
        tts: hasTts ? /** @type {string[]} */ (ttsPath).join('/') : undefined,
      },
    });
  };

  // ── Conversation lifecycle ──────────────────────────────────────────────────
  // The daemon owns the conversation: the transcript, the turn in flight, and
  // the queue of submissions waiting for their turn. This page subscribes to
  // the active session (`watch()`) and renders what it is told; sending is
  // `enqueue`, and the daemon decides when that becomes a turn. Nothing here
  // is a queue, a lock or a timer, so switching session, reloading or closing
  // the tab loses nothing, and a second page sees the same thing.
  let cancelled = false;
  let turnCancelled = false;

  // Submissions this page has handed to the daemon and not yet had
  // acknowledged. Not a queue — each is one request in flight — but the
  // message must stay on screen for that round trip: `submit` clears the
  // compose box at once, and the daemon's own report of it (a queued entry, or
  // the turn it became) can arrive before or after the acknowledgement.
  /**
   * `pendingId` is the daemon's id for the message, once known (from the
   * acknowledgement, or claimed from the daemon's report); `acked` is the
   * acknowledgement having arrived; `seen` is the daemon having reported that
   * very message, as a queue entry or as the turn it became; `before` is
   * what the daemon had already reported when it was sent, which is therefore
   * not it.
   *
   * @typedef {{ id: number, sessionId: string, text: string,
   *   pendingId?: string, acked: boolean, seen: boolean,
   *   before: Set<string> }} InFlightSend
   */
  /** @type {InFlightSend[]} */
  let inFlightSends = [];
  let nextInFlightId = 1;
  // Queue ids of submissions this page made. The reply to one of them is
  // spoken here; one made from another page is that page's to speak.
  // Kept only while the daemon still reports the message: an id is dropped
  // once it has been seen and is no longer queued or running.
  /** @type {Map<string, { seen: boolean }>} */
  const ownSubmissions = new Map();

  /** @param {FlootSession} session */
  const reportedSubmissions = session => [
    ...session.pending.entries.map(entry => ({
      id: entry.id,
      text: entry.text,
    })),
    ...(session.current?.pendingId
      ? [{ id: session.current.pendingId, text: session.current.input }]
      : []),
  ];

  /**
   * Match what the daemon reports against what this page has sent. By id once
   * the acknowledgement has said what the id is; before that, the oldest
   * unmatched send claims the first report with its text that was not there
   * when it was sent and that no other send has claimed — so two identical
   * messages sent back to back are two messages. A placeholder goes once its
   * message has been both acknowledged and seen (or, after a fresh snapshot,
   * acknowledged: whatever became of it is in that snapshot).
   *
   * @param {FlootSession} session
   * @param {boolean} snapshot
   */
  const reconcileSends = (session, snapshot) => {
    const reported = reportedSubmissions(session);
    const claimed = new Set(
      inFlightSends.map(send => send.pendingId).filter(Boolean),
    );
    for (const send of inFlightSends) {
      if (send.sessionId === session.id && !send.seen) {
        if (send.pendingId) {
          send.seen = reported.some(item => item.id === send.pendingId);
        } else {
          const match = reported.find(
            item =>
              item.text === send.text &&
              !send.before.has(item.id) &&
              !claimed.has(item.id),
          );
          if (match) {
            send.pendingId = match.id;
            send.seen = true;
            claimed.add(match.id);
          }
        }
      }
    }
    inFlightSends = inFlightSends.filter(
      send =>
        send.sessionId !== session.id ||
        !send.acked ||
        !(send.seen || snapshot),
    );
    const live = new Set(reported.map(item => item.id));
    for (const [id, record] of ownSubmissions) {
      if (live.has(id)) record.seen = true;
      else if (record.seen || snapshot) ownSubmissions.delete(id);
    }
  };

  /** @type {FlootTurn | null} */
  let activeTurn = null;
  // Detaches this component's view from the active turn without stopping it
  // (used on unmount so the turn keeps running in the background).
  /** @type {(() => void) | null} */
  let detachActiveTurnView = null;

  const isBusy = () => {
    const session = getActiveSession();
    return Boolean(
      session?.current && !(session.displayTurn && session.displayTurn.done),
    );
  };

  // Cancel the in-flight turn (Stop button). Unlike leaving the space, which
  // lets the turn keep running, this tears it down.
  const cancelTurn = () => {
    const session = getActiveSession();
    if (!session?.current) return;
    turnCancelled = true;
    if (activeTurn && activeTurn.target === session.current.turn) {
      activeTurn.stop();
    } else {
      E(session.current.turn)
        .cancel()
        .catch((/** @type {Error} */ error) =>
          setStatus(`error: ${error.message}`),
        );
    }
    stopTts(); // also silences any spoken reply in progress
  };

  // Voice barge-in: the user started speaking over a live reply. Unlike the Stop
  // button's hard cancel, don't abort the turn — just silence its spoken reply
  // (dropping the audio stream is what tells the daemon to stop speaking it)
  // and let it finish in the background (and in history). The user's
  // interjection is queued behind it by the daemon.
  const softBargeIn = () => {
    if (!isBusy()) return;
    stopTts();
    setStatus('continuing in background…');
  };

  // Attach this component's view to the observation of a turn — one the daemon
  // just reported, or one still running after a remount. Repaints as the
  // turn's events arrive. Detaching (on unmount, or when another turn is
  // attached) leaves the turn running.
  /**
   * @param {FlootTurn} turn
   * @param {FlootSession} session
   */
  const attachTurnView = (turn, session) => {
    if (detachActiveTurnView) detachActiveTurnView();
    turnCancelled = false;
    activeTurn = turn;
    sessionStatus.delete(session.id);
    status = `${turn.phase || 'thinking'}…`;
    if (turn.usage) usage = turn.usage;

    let detached = false;
    let unsubscribe = () => {};
    const detach = () => {
      if (detached) return;
      detached = true;
      unsubscribe();
      if (detachActiveTurnView === detach) {
        detachActiveTurnView = null;
        activeTurn = null;
      }
    };
    detachActiveTurnView = detach;

    /** @param {{ type: string }} ev */
    const onEvent = ev => {
      if (detached) return;
      if (ev.type === 'superseded') {
        // Another view retired the shared observation. The session's own
        // subscription says what is current; nothing to reconcile here.
        detach();
        notify();
        return;
      }
      if (activeSessionId !== turn.sessionId) {
        if (ev.type === 'done') detach();
        return;
      }
      if (ev.type === 'snapshot') {
        // The turn's state as of the moment this view opened. Repaint from
        // it; speech, if any, is the daemon's own view of the same turn.
        if (turn.usage) usage = turn.usage;
        setStatus(`${turn.phase || 'thinking'}…`);
      } else if (ev.type === 'phase') {
        setStatus(`${turn.phase}…`);
      } else if (ev.type === 'usage') {
        usage = turn.usage;
        notify();
      } else if (ev.type === 'abort') {
        sessionStatus.set(turn.sessionId, 'error');
        notify();
      } else if (ev.type === 'done') {
        const stopped = turnCancelled;
        if (turn.error) {
          sessionStatus.set(turn.sessionId, 'error');
          status = `error: ${turn.error}`;
        } else {
          sessionStatus.delete(turn.sessionId);
          status = stopped ? 'stopped.' : 'Ready.';
        }
        // The turn's output stays on screen (it is `session.displayTurn`)
        // until the session reports the turn gone, which it does only after
        // publishing the transcript that contains it: the reply never blinks.
        detach();
        notify();
      } else {
        notify();
      }
    };
    unsubscribe = turn.subscribe(onEvent);
    // Settle immediately if the turn finished between start and subscribe.
    if (turn.done) onEvent({ type: 'done' });
  };

  /**
   * The session reported which UI turn is in flight (or that none is).
   *
   * @param {FlootSession} session
   * @param {any} reported `{ input, turn, pendingId? }` or null
   * @param {boolean} fresh false when this is the snapshot: the turn was
   *   already under way when this page looked, so it is not this page's to
   *   start speaking.
   */
  const setCurrentTurn = (session, reported, fresh) => {
    const next =
      reported && reported.turn
        ? {
            input: typeof reported.input === 'string' ? reported.input : null,
            turn: reported.turn,
            ...(typeof reported.pendingId === 'string'
              ? { pendingId: reported.pendingId }
              : {}),
          }
        : null;
    const previous = session.current;
    session.current = next;
    network.setCurrent(Boolean(next));
    if (!next) {
      // The transcript that contains the finished turn has normally arrived
      // already. If it could not be read, what was on screen stays as a tail
      // until it can, rather than the prompt and reply blinking out.
      session.tail =
        previous && session.displayTurn && session.transcriptStale
          ? { input: previous.input, turn: session.displayTurn }
          : null;
      session.displayTurn = null;
      if (previous && activeSessionId === session.id && !activeTurn) {
        // Its observation never reported an end here (it was detached, or
        // belonged to another page): leave a truthful status behind.
        if (status.endsWith('…')) status = 'Ready.';
      }
      return;
    }
    if (previous && previous.turn === next.turn) return;
    // This page's own submission has become a turn: the placeholder for the
    // round trip has done its job.
    const registry = turnsForFactory(factory);
    let turn = registry.get(session.id) || null;
    if (turn && turn.target !== next.turn) {
      // An observation of an earlier turn; retiring it never cancels anything.
      turn.retire();
      turn = null;
    }
    if (!turn) {
      turn = startFlootTurn(registry, session.id, session.id, next.turn);
    }
    session.displayTurn = turn;
    stick = true;
    if (activeSessionId === session.id) {
      attachTurnView(turn, session);
      // This page's own message: known by the id the acknowledgement gave,
      // or, when the turn beat the acknowledgement here, by the placeholder
      // that claimed it (`reconcileSends`, which has already run).
      const own = Boolean(
        next.pendingId &&
        (ownSubmissions.has(next.pendingId) ||
          inFlightSends.some(send => send.pendingId === next.pendingId)),
      );
      if (fresh && own && ttsEnabled && ttsServer) speakTurn(turn);
    }
  };

  // ── The active session's subscription ───────────────────────────────────────
  // The status line a transcript failure wrote, so its recovery clears that
  // line and no other.
  let transcriptErrorStatus = '';
  /** @type {{ close: () => void } | null} */
  let sessionView = null;
  // A subscription that ends without saying why (the daemon gave up on a
  // reader opened too late) is opened again, but not for ever: a stream that
  // keeps ending at once is a fault to report, not a loop to spin in.
  let quietEndings = 0;
  // eslint-disable-next-line no-use-before-define
  const reopenSessionView = () => openActiveSession(false);

  /**
   * @param {FlootSession} session
   * @param {any} event
   * @returns {boolean} false when the view must be reopened
   */
  const applySessionEvent = (session, event) => {
    const snapshot = event.type === 'snapshot';
    // Set by the block after the turn is adopted, so it sees both reports.
    let reconcile = snapshot;
    if (snapshot || event.type === 'transcript') {
      const delta = snapshot ? event.transcript : event;
      if (delta) {
        const next = applyTranscriptEvent(
          snapshot ? null : session.transcript,
          delta,
        );
        // A gap: an event was missed. Reopen rather than guess.
        if (!next) return false;
        session.transcript = next;
        session.messages = historyMessages(next.messages);
        session.loaded = true;
        session.tail = null;
        if (session.transcriptStale) {
          session.transcriptStale = false;
          if (status === transcriptErrorStatus) status = 'Ready.';
        }
      } else if (snapshot) {
        session.transcript = null;
        session.loaded = true;
        if (event.transcriptError) {
          session.transcriptStale = true;
          transcriptErrorStatus = `error: ${event.transcriptError}`;
          status = transcriptErrorStatus;
        }
      }
    }
    if (event.type === 'transcript-error') {
      session.transcriptStale = true;
      transcriptErrorStatus = `error: ${event.message}`;
      status = transcriptErrorStatus;
    }
    if (snapshot || event.type === 'pending') {
      session.pending = normalizePending(event.pending);
      reconcile = true;
    }
    if (snapshot || event.type === 'running') {
      session.running =
        event.running && typeof event.running.input === 'string'
          ? {
              input: event.running.input,
              ...(typeof event.running.from === 'string'
                ? { from: event.running.from }
                : {}),
            }
          : null;
    }
    if (snapshot || event.type === 'turn') {
      // Adopt the report first, so the reconciliation below can match this
      // page's send to the turn before the turn asks whether it is its own.
      const reported = event.turn;
      if (reported && reported.turn && typeof reported.pendingId === 'string') {
        const provisional = {
          input: typeof reported.input === 'string' ? reported.input : null,
          turn: reported.turn,
          pendingId: reported.pendingId,
        };
        const held = session.current;
        session.current = provisional;
        reconcileSends(session, snapshot);
        session.current = held;
      }
      setCurrentTurn(session, event.turn, !snapshot);
      reconcile = true;
    }
    if (reconcile) reconcileSends(session, snapshot);
    if ((snapshot || event.type === 'execution') && event.execution) {
      execution.adopt(event.execution);
    }
    if ((snapshot || event.type === 'network') && event.network) {
      network.adopt(event.network, Boolean(session.current));
    }
    if ((snapshot || event.type === 'usage') && event.usage) {
      usage = event.usage;
    }
    if (event.type === 'journal') void recovery.refresh();
    return true;
  };

  // Open (or reopen) the subscription on the active session, closing whichever
  // one was open. Selection never waits for a turn: the session left behind
  // keeps running on the daemon, and its queue with it.
  /** @param {boolean} [reselect] false when reopening the same session */
  const openActiveSession = (reselect = true) => {
    if (sessionView) sessionView.close();
    sessionView = null;
    if (detachActiveTurnView) detachActiveTurnView();
    // Opening a session starts at the latest message.
    stick = true;
    const session = getActiveSession();
    const ready = Boolean(
      session && (!session.lifecycle || session.lifecycle === 'ready'),
    );
    if (reselect) {
      void execution.select(session ? facetFor(session) : null);
      void recovery.select(
        session && ready ? facetFor(session) : null,
        session && !ready
          ? `Session unavailable (${session.lifecycle}). Inspect the service; no recovery action is safe here.`
          : '',
      );
      void network.select(
        session && ready ? facetFor(session) : null,
        session && !ready
          ? 'Session unavailable. Network policy changes are disabled.'
          : '',
      );
      usage = null;
    }
    if (!session) {
      notify();
      return;
    }
    if (!ready) {
      session.loaded = true;
      setStatus(`Session unavailable (${session.lifecycle}).`);
      return;
    }
    // A turn this page was already observing (a remount, or a session it
    // switched away from and back to) paints at once; the snapshot confirms.
    if (session.displayTurn && !session.displayTurn.done) {
      attachTurnView(session.displayTurn, session);
    }
    notify();

    let closed = false;
    /** @type {{ return: () => Promise<unknown> } | null} */
    let stream = null;
    const view = {
      close() {
        closed = true;
        if (stream) void Promise.resolve(stream.return()).catch(() => {});
      },
    };
    sessionView = view;
    const live = () => !cancelled && !closed && sessionView === view;
    (async () => {
      const reader = iterateReader(await E(facetFor(session)).watch(), {
        buffer: 4,
      });
      stream = reader;
      if (!live()) {
        view.close();
        return;
      }
      let ended = false;
      for await (const event of reader) {
        if (!live()) break;
        const value = /** @type {any} */ (event);
        if (value.type === 'end') {
          ended = true;
          break;
        }
        if (!applySessionEvent(session, value)) {
          reopenSessionView();
          return;
        }
        if (value.type !== 'snapshot') quietEndings = 0;
        notify();
      }
      if (!ended && live()) {
        quietEndings += 1;
        if (quietEndings <= 3) {
          reopenSessionView();
        } else {
          setStatus('error: the session stopped reporting; reload to retry.');
        }
        return;
      }
      if (ended && live()) {
        // Deleted from somewhere else. The session list says so too; this
        // just stops the view pretending the session is still there.
        session.loaded = true;
        setStatus('This session was deleted.');
      }
    })().catch((/** @type {Error} */ error) => {
      if (live()) {
        // Nothing is known about this session now; what was last known (a
        // turn, a queue) may be long gone, and must not offer a Stop.
        session.loaded = true;
        session.current = null;
        session.running = null;
        session.displayTurn = null;
        session.pending = normalizePending(null);
        setStatus(`error: ${error.message}`);
      }
    });
  };

  // Hand a message to the daemon. It starts at once if the session is idle and
  // otherwise waits its turn there — whether or not this page stays open.
  const submit = (/** @type {string} */ raw) => {
    if (execution.getState().blocked) {
      setStatus(
        'Session stopped or stopping. Inspect Settings before resuming.',
      );
      return;
    }
    if (network.getState().changing || network.getState().blocked) {
      setStatus(
        'Finish or retry the sandbox network policy change before sending.',
      );
      return;
    }
    const selected = getActiveSession();
    if (selected?.lifecycle && selected.lifecycle !== 'ready') {
      setStatus(
        'Session unavailable. Inspect its lifecycle and service before sending.',
      );
      return;
    }
    if (recovery.getState().resolving || recovery.getState().blocked) {
      setStatus(
        'Sending is blocked while a journal resolution is pending or imported legacy evidence needs verification. Inspect the Journal.',
      );
      return;
    }
    // An explicit send supersedes any buffered voice continuation.
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = 0;
    }
    pendingUtterance = '';
    const text = (raw || '').trim();
    if (!text) return;
    // Create/resume the audio context now, still inside the user's Send
    // gesture: a browser refuses autoplay when the first resume happens only
    // after the remote round trips that start the turn and its speech.
    if (ttsEnabled && ttsServer) prepareTts();
    inputText = '';
    // Sending a message is an explicit "follow along" intent — re-stick.
    stick = true;

    /** @type {InFlightSend} */
    const send = {
      id: nextInFlightId,
      sessionId: selected ? selected.id : '',
      text,
      acked: false,
      seen: false,
      before: new Set(
        selected ? reportedSubmissions(selected).map(item => item.id) : [],
      ),
    };
    nextInFlightId += 1;
    inFlightSends.push(send);
    notify();

    (async () => {
      let session = selected;
      if (!session) {
        session = await createSession();
        send.sessionId = session.id;
        openActiveSession();
      }
      if (session.title === DEFAULT_TITLE) {
        session.title = autoTitle(text);
        E(factory)
          .renameSession(session.id, session.title)
          .catch(() => {});
        notify();
      }
      const accepted = await E(facetFor(session)).enqueue(text);
      send.acked = true;
      if (accepted && typeof accepted.id === 'string') {
        send.pendingId = accepted.id;
        ownSubmissions.set(accepted.id, { seen: false });
      }
      // The placeholder stays until the daemon's own report of this message
      // has been seen: the acknowledgement can arrive first (the report waits
      // its turn behind a transcript read), and dropping the placeholder on
      // it would take the message off the screen in between.
      reconcileSends(session, false);
    })()
      .catch((/** @type {Error} */ error) => {
        if (cancelled) return;
        inFlightSends = inFlightSends.filter(other => other !== send);
        // Nothing was accepted: the text goes back where it can be sent
        // again. Unless the daemon has reported it after all (a failure after
        // it was queued), in which case restoring it would make two of it.
        if (!send.seen && !inputText) inputText = text;
        setStatus(`error: ${error.message}`);
      })
      .finally(() => {
        if (!cancelled) notify();
      });
  };

  /**
   * @param {string} action
   * @param {Promise<unknown>} result
   */
  const reportQueueFailure = (action, result) => {
    Promise.resolve(result).catch((/** @type {Error} */ error) => {
      if (!cancelled) setStatus(`${action} failed: ${error.message}`);
    });
  };

  /**
   * Rewrite a queued submission while it waits. The daemon refuses once its
   * turn has started.
   *
   * @param {number | string} id
   * @param {string} raw
   */
  const editPending = (id, raw) => {
    const text = (raw || '').trim();
    const session = getActiveSession();
    // An empty edit is a no-op rather than a delete: deleting has its own
    // button, and losing a message by clearing the box would be a surprising
    // way to lose one.
    if (!text || !session || typeof id !== 'string') return;
    reportQueueFailure('Edit', E(facetFor(session)).editPending(id, text));
  };

  /**
   * Drop a queued submission before it runs.
   *
   * @param {number | string} id
   */
  const cancelPending = id => {
    const session = getActiveSession();
    if (!session || typeof id !== 'string') return;
    reportQueueFailure('Delete', E(facetFor(session)).cancelPending(id));
  };

  /**
   * "Send now": release a held queue, send an interrupted message again, or —
   * for the head of the queue behind a running turn — cut that turn short.
   * Which of those applies is the daemon's call; only the head may end a turn.
   *
   * @param {number | string} id
   */
  const sendPendingNow = id => {
    const session = getActiveSession();
    if (!session || typeof id !== 'string') return;
    const [head] = session.pending.entries;
    if (session.current && head && head.id === id) {
      turnCancelled = true;
      stopTts();
    }
    ownSubmissions.set(id, { seen: true });
    reportQueueFailure('Send', E(facetFor(session)).sendPending(id));
  };

  // ── Session actions (controller callbacks) ──────────────────────────────────
  const selectSession = (/** @type {string} */ id) => {
    if (id === activeSessionId) return;
    // A per-message replay, or the reply being spoken, belongs to the session
    // being left; the turn itself carries on without this page.
    stopTts();
    activeSessionId = id;
    quietEndings = 0;
    setStatus('Ready.');
    openActiveSession();
  };

  const deleteSessionById = (/** @type {string} */ id) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${session.title}"?`)) return;
    // Stop any replay still speaking the session we're deleting.
    stopTts();
    sessions = sessions.filter(s => s.id !== id);
    sessionStatus.delete(id);
    inFlightSends = inFlightSends.filter(send => send.sessionId !== id);
    const wasActive = activeSessionId === id;
    if (wasActive) {
      // Deletion owns daemon teardown; the UI need not wait for it. The
      // status line was the deleted session's turn's; its end will never be
      // reported here.
      activeSessionId = sessions.length ? sessions[0].id : null;
      status = 'Ready.';
    }
    E(factory)
      .deleteSession(id)
      .catch(err => setStatus(`error: ${err.message}`));
    notify();
    if (wasActive) openActiveSession();
  };

  /**
   * @param {string} [presetId]
   * @param {string} [model]
   * @param {string} [reasoningEffort]
   */
  const newSession = (presetId, model, reasoningEffort) => {
    createSession(undefined, presetId, model, reasoningEffort)
      .then(() => {
        stick = true;
        setStatus('Ready.');
        openActiveSession();
      })
      .catch(err => setStatus(`error: ${err.message}`));
  };

  const renameSession = (
    /** @type {string} */ id,
    /** @type {string} */ title,
  ) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    session.title = title || DEFAULT_TITLE;
    E(factory)
      .renameSession(id, session.title)
      .catch(err => setStatus(`error: ${err.message}`));
    notify();
  };

  // ── Mic input (optional) ─────────────────────────────────────────────────────
  let micActive = false; // mic open and listening
  let speaking = false; // currently inside a detected utterance
  let calibrating = false;
  // Actionable guidance shown when the browser/OS denies mic access (distinct
  // from the transient status line, since it needs to persist until retried).
  let micError = '';
  let noiseFloor = 0;
  let calibStart = 0;
  let speechStart = 0;
  let silenceStart = 0;
  // Continuation buffering across short pauses (see RESUME_GRACE_MS): a finalized
  // utterance accrues here and is only submitted once the grace elapses without
  // the user resuming.
  let pendingUtterance = '';
  let resumeTimer = 0;
  let rafId = 0;
  /** @type {number[]} */
  let calibSamples = [];
  /** @type {Uint8Array[]} */
  let preroll = [];
  let micInRate = 16_000;
  /** @type {MediaStream | null} */
  let mediaStream = null;
  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  let source = null;
  /** @type {ScriptProcessorNode | null} */
  let processor = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {Float32Array<ArrayBuffer> | null} */
  let analyserBuf = null;
  /** @type {ReturnType<typeof makeAudioChannel> | null} */
  let channel = null;

  const filterTranscript = (/** @type {string} */ raw) => {
    const norm = (raw || '')
      .trim()
      .toLowerCase()
      .replace(/[.!?,]+$/g, '')
      .trim();
    if (!norm || norm.length < 2) return '';
    if (JUNK_PHRASES.has(norm)) return '';
    return raw.trim();
  };

  // Drain one utterance's transcript stream. Partials/finals (replace semantics)
  // fill the compose box live; on `end` the filtered text is auto-sent.
  const drainTranscript = async (
    /** @type {any} */ textReader,
    /** @type {any} */ ownChannel,
  ) => {
    let last = '';
    try {
      for await (const raw of iterateReader(textReader, { buffer: 4 })) {
        const value = /** @type {any} */ (raw);
        if (cancelled) break;
        if (value.type === 'partial' || value.type === 'final') {
          last = value.text;
          // Show buffered continuation text ahead of the live partial.
          inputText = pendingUtterance ? `${pendingUtterance} ${last}` : last;
          voiceTranscript = last;
          notify();
        } else if (value.type === 'end') {
          break;
        } else if (value.type === 'abort') {
          setStatus(`mic error: ${value.reason}`);
          break;
        }
      }
    } catch (err) {
      setStatus(`mic error: ${/** @type {Error} */ (err).message}`);
    } finally {
      if (ownChannel === channel) channel = null;
    }
    const text = filterTranscript(last);
    inputText = '';
    voiceTranscript = '';
    notify();
    commitUtterance(text);
  };

  // Buffer a finalized utterance and hold briefly for a continuation before
  // sending, so a mid-thought pause doesn't start a reply and drop the rest.
  const commitUtterance = (/** @type {string} */ text) => {
    if (text) {
      pendingUtterance = pendingUtterance
        ? `${pendingUtterance} ${text}`
        : text;
    }
    // The recognizer's last result can land after the mic was switched off —
    // the audio reader closes, and the final arrives behind it. A torn-down
    // utterance neither repopulates the compose box nor arms a send: turning
    // the mic off mid-sentence means "not that", not "send it in a second".
    if (!micActive) {
      pendingUtterance = '';
      inputText = '';
      notify();
      return;
    }
    // Keep the buffered utterance visible in the compose box for the whole
    // grace window. Blanking it made recognized speech vanish for about a
    // second before it sent, which reads as a swallowed message.
    inputText = pendingUtterance;
    notify();
    if (resumeTimer) clearTimeout(resumeTimer);
    if (!pendingUtterance) return;
    resumeTimer = window.setTimeout(() => {
      resumeTimer = 0;
      pendingUtterance = '';
      // The buffer has been sitting in the compose box as ordinary editable
      // text for the whole grace window, so the box IS the buffer: a correction
      // typed there is what sends, and clearing it cancels the send. Sending
      // what was recognized instead would silently discard the edit.
      const full = inputText.trim();
      if (full) submit(full);
    }, VAD.RESUME_GRACE_MS);
  };

  const computeRms = () => {
    if (!analyser || !analyserBuf) return 0;
    analyser.getFloatTimeDomainData(analyserBuf);
    let sum = 0;
    for (let i = 0; i < analyserBuf.length; i += 1) {
      sum += analyserBuf[i] * analyserBuf[i];
    }
    return Math.sqrt(sum / analyserBuf.length);
  };

  // Store the meter levels and notify the view (throttled — the VAD loop runs at
  // animation-frame rate, but the meter only needs ~15 Hz). Speaking-state
  // transitions notify immediately via begin/endUtterance.
  let lastMeterNotify = 0;
  const setMeter = (
    /** @type {number} */ vol,
    /** @type {number} */ noise,
    /** @type {number} */ threshold,
  ) => {
    meterVol = vol;
    meterNoise = noise;
    meterThreshold = threshold;
    const now = Date.now();
    if (now - lastMeterNotify >= 60) {
      lastMeterNotify = now;
      notify();
    }
  };

  // Open a fresh transcribe() stream for the utterance just detected and flush
  // the pre-roll so the word's onset isn't clipped.
  const beginUtterance = () => {
    if (speaking || !audioServer) return;
    // If we're within the post-utterance grace, this is a continuation of the
    // same thought: cancel the pending send and keep the buffered text.
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = 0;
    }
    speaking = true;
    // Never let a reply talk over a live recording: silence any TTS still
    // playing or scheduled ahead.
    stopTts();
    speechStart = Date.now();
    silenceStart = 0;
    // Preserve any buffered continuation text; a fresh utterance clears it.
    inputText = pendingUtterance;
    notify();
    channel = makeAudioChannel();
    const ownChannel = channel;
    const textReader = E(audioServer).transcribe(channel.reader);
    drainTranscript(textReader, ownChannel);
    for (const frame of preroll) ownChannel.writeBytes(frame);
    preroll = [];
  };

  const endUtterance = () => {
    if (!speaking) return;
    speaking = false;
    silenceStart = 0;
    const tooShort = Date.now() - speechStart < VAD.MIN_SPEECH_MS;
    if (tooShort) {
      // A blip below the minimum-speech duration — discard as noise, but keep
      // any buffered continuation visible rather than blanking the box.
      if (channel)
        E(channel.reader)
          .return()
          .catch(() => {});
      channel = null;
      inputText = pendingUtterance;
      notify();
      return;
    }
    notify();
    channel?.end(); // flush → recognizer emits final + end → drainTranscript sends
  };

  const abortUtterance = () => {
    if (!speaking) return;
    speaking = false;
    silenceStart = 0;
    if (channel)
      E(channel.reader)
        .return()
        .catch(() => {});
    channel = null;
  };

  // The VAD heartbeat: one RMS sample per animation frame drives calibration,
  // noise-floor drift, onset/barge-in, and end-of-speech silence detection.
  const vadLoop = () => {
    if (!micActive) return;
    const now = Date.now();
    const vol = computeRms();

    if (calibrating) {
      calibSamples.push(vol);
      setMeter(vol, noiseFloor, VAD.MIN_THRESHOLD);
      if (now - calibStart >= VAD.CALIBRATION_MS) {
        const sorted = [...calibSamples].sort((a, b) => a - b);
        noiseFloor = sorted[Math.floor(sorted.length * 0.75)] || 0;
        calibrating = false;
        calibSamples = [];
        setStatus('listening…');
      }
      rafId = requestAnimationFrame(vadLoop);
      return;
    }

    const speechThreshold = Math.max(
      VAD.MIN_THRESHOLD,
      noiseFloor * VAD.THRESHOLD_MULT,
    );
    const bargeThreshold = Math.max(
      VAD.MIN_BARGE,
      speechThreshold * VAD.BARGE_MULT,
    );
    setMeter(vol, noiseFloor, speechThreshold);

    if (!speaking) {
      if (vol < speechThreshold) {
        // Drift the noise floor toward the ambient level while quiet.
        noiseFloor = (1 - VAD.EMA_ALPHA) * noiseFloor + VAD.EMA_ALPHA * vol;
      }
      // While the assistant is replying require a louder onset (barge-in).
      let onsetThreshold = isBusy() ? bargeThreshold : speechThreshold;
      // If our own TTS is audibly playing (even after the text turn finished),
      // demand more headroom still so speaker→mic leakage can't self-barge.
      if (ttsAudible()) {
        onsetThreshold = Math.max(
          onsetThreshold,
          bargeThreshold * VAD.ECHO_BARGE_MULT,
        );
      }
      if (vol > onsetThreshold) {
        if (isBusy()) softBargeIn();
        beginUtterance();
      }
    } else if (vol > speechThreshold) {
      silenceStart = 0;
    } else if (silenceStart === 0) {
      silenceStart = now;
    } else if (now - silenceStart >= VAD.SILENCE_MS) {
      endUtterance();
    }

    rafId = requestAnimationFrame(vadLoop);
  };

  const startMic = async () => {
    if (micActive || !audioServer) return;
    // Preflight the two environment failures that deny the mic *without* a
    // browser prompt, so the user gets an explanation instead of silence:
    //   1. a non-secure context (mic is HTTPS/localhost only), and
    //   2. a browser that doesn't expose `mediaDevices` (privacy hardening,
    //      or an embedded webview with the API stripped).
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      micError =
        'Microphone needs a secure (https) connection. Open this page over https and try again.';
      notify();
      return;
    }
    const media =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.getUserMedia !== 'function') {
      micError =
        `This browser isn't exposing microphone access. Check the browser's ` +
        `privacy/shields settings for this site, or try another browser.`;
      notify();
      return;
    }
    // Still inside the tap: prime the audio context now, since a hands-free
    // reply starts from the utterance timer, not a gesture.
    if (ttsEnabled && ttsServer) prepareTts();
    micActive = true;
    calibrating = true;
    calibStart = Date.now();
    calibSamples = [];
    noiseFloor = 0;
    preroll = [];
    inputText = '';
    micError = '';
    setStatus('calibrating microphone…');
    try {
      // Called synchronously off the tap (no await precedes it) so the user
      // gesture that mobile browsers require is still in effect.
      mediaStream = await media.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audioCtx = new AudioContext();
      source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserBuf = new Float32Array(analyser.fftSize);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      micInRate = audioCtx.sampleRate;
      processor.onaudioprocess = e => {
        const data = e.inputBuffer.getChannelData(0);
        const pcm = toPcm16le(data, micInRate, 16_000);
        if (!pcm.length) return;
        if (speaking && channel) {
          channel.writeBytes(pcm);
        } else {
          // Ring-buffer recent audio so an utterance's onset isn't clipped.
          preroll.push(pcm);
          if (preroll.length > VAD.PREROLL_FRAMES) preroll.shift();
        }
      };
      source.connect(analyser);
      source.connect(processor);
      processor.connect(audioCtx.destination);
      rafId = requestAnimationFrame(vadLoop);
    } catch (err) {
      micActive = false;
      calibrating = false;
      const name = /** @type {Error} */ (err).name;
      const message = /** @type {Error} */ (err).message;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        // Say where the block is, as far as this browser will tell. A site
        // permission of 'denied' means the browser's site settings. Chrome
        // names a prompt the user closed ("dismissed") and a microphone the
        // OS withheld from the browser app ("denied by system", with the site
        // permission still 'granted' — the "set to Ask, yet no prompt" case).
        // Anything else — 'prompt', or a browser with no microphone
        // permission query at all (Firefox) — could be either place, and the
        // guidance says so instead of guessing.
        let permState = '';
        try {
          const permStatus = await navigator.permissions?.query?.(
            /** @type {any} */ ({ name: 'microphone' }),
          );
          permState = permStatus?.state || '';
        } catch {
          // Permissions API unsupported, or 'microphone' isn't a known name on
          // this browser — leave permState empty and give generic guidance.
        }
        const android =
          typeof navigator !== 'undefined' &&
          /android/i.test(navigator.userAgent || '');
        // A home-screen install (PWA/WebAPK, or a Chrome shortcut) has its own
        // app entry, so its mic permission lives under that app in the
        // system's settings — not necessarily under the browser the user
        // thinks of.
        const standalone =
          (typeof window !== 'undefined' &&
            !!window.matchMedia?.('(display-mode: standalone)')?.matches) ||
          /** @type {any} */ (navigator).standalone === true;
        const appNote = standalone
          ? ` (This is installed to your home screen, so its microphone ` +
            `permission is under that installed app in ${
              android ? 'Android Settings → Apps' : 'the system settings'
            }, which may differ from the browser.)`
          : '';
        const osLevel = /system/i.test(message) || permState === 'granted';
        if (permState === 'denied') {
          micError =
            `Microphone blocked for this site. Tap the address-bar lock → ` +
            `Permissions → Microphone → Allow (or “Reset permissions”), ` +
            `reload, then tap 🎤 again.${appNote}`;
        } else if (/dismissed/i.test(message)) {
          micError =
            'The microphone prompt was closed without an answer. Tap 🎤 ' +
            'again and choose Allow.';
        } else if (osLevel && android) {
          micError =
            `The browser tried to ask for the microphone but got no answer, ` +
            `so the block is at the phone’s OS level. Enable Android Settings ` +
            `→ Apps → (your browser) → Permissions → Microphone, and turn on ` +
            `the system “Microphone access” switch (swipe down → Privacy / ` +
            `Quick Settings). Then tap 🎤 again.${appNote}`;
        } else if (osLevel) {
          micError =
            `The system withheld the microphone from this browser. Allow it ` +
            `in the operating system’s microphone privacy settings (on a Mac: ` +
            `System Settings → Privacy & Security → Microphone), then tap 🎤 ` +
            `again.${appNote}`;
        } else {
          micError =
            `Microphone access was refused. Allow the microphone when the ` +
            `browser asks; if it never asks, check this site’s permissions ` +
            `(address-bar lock → Permissions → Microphone) and ${
              android
                ? 'the phone’s Settings → Apps → (your browser) → Permissions'
                : 'the operating system’s microphone privacy setting'
            } for this browser, then tap 🎤 again.${appNote}`;
        }
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        micError = 'No microphone was found on this device.';
      } else if (name === 'NotReadableError') {
        micError =
          'The microphone is in use by another app. Close it and tap 🎤 again.';
      } else {
        micError = `Could not start the microphone: ${message}`;
      }
      setStatus('microphone unavailable');
      notify();
    }
  };

  const stopMic = () => {
    if (!micActive) return;
    micActive = false;
    calibrating = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    abortUtterance();
    // Drop any buffered voice continuation that never got sent — including its
    // compose-box mirror, so no orphaned text lingers after the mic is off. A
    // box the user has since typed into is theirs, and is left alone.
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = 0;
    }
    if (pendingUtterance && inputText === pendingUtterance) inputText = '';
    pendingUtterance = '';
    if (processor) processor.onaudioprocess = null;
    try {
      source?.disconnect();
      analyser?.disconnect();
      processor?.disconnect();
    } catch {
      // already disconnected
    }
    mediaStream?.getTracks().forEach(t => t.stop());
    audioCtx?.close();
    preroll = [];
    source = null;
    processor = null;
    analyser = null;
    analyserBuf = null;
    mediaStream = null;
    audioCtx = null;
    channel = null;
    voiceTranscript = '';
    setStatus('Ready.');
  };

  // ── TTS playback (optional) ──────────────────────────────────────────────────
  /** @type {AudioContext | null} */
  let ttsCtx = null;
  // Token guarding the active playback session: stop() bumps it so a stale
  // drain loop (still awaiting a CapTP next()) can't schedule buffers anymore.
  let ttsPlaybackId = 0;
  /** @type {AudioBufferSourceNode[]} */
  let ttsSources = [];
  // The live audio iteration, held so barge-in can close it (which fires the
  // caplet's onClose and aborts piper mid-utterance).
  /** @type {any} */
  let ttsActiveStream = null;
  // The turn whose spoken view is playing, so a settings change can restart
  // its speech; null while playback is idle or a replay is speaking.
  /** @type {FlootTurn | null} */
  let ttsSpeechTurn = null;
  let ttsNextStart = 0;
  let ttsSpeaking = false;

  // ── Screen wake lock ────────────────────────────────────────────────────────
  // A voice session is long stretches with no touch input — the mic is open, a
  // reply is being spoken, or a turn is running — which is exactly when a phone
  // dims and locks. Hold the screen while the app is genuinely busy and release
  // it the moment it is not: an always-on lock would trade a screen complaint
  // for a battery one.
  //
  // Host-side on purpose. The confined space has no `navigator` by design and
  // should not gain one; this component already owns the imperative half (mic,
  // Web Audio, the VAD loop) and already sees every state change through
  // `notify`. Declared below `busy`, `micActive` and `ttsSpeaking` so the reader
  // never reaches them in their temporal dead zone.
  const wakeLockDoc = $parent.ownerDocument;
  const screenWakeLock = makeScreenWakeLock({
    getApi: () => globalThis.navigator?.wakeLock,
    isVisible: () => wakeLockDoc.visibilityState === 'visible',
  });

  updateWakeLock = () => {
    screenWakeLock.set(
      !cancelled && Boolean(micActive || ttsSpeaking || isBusy()),
    );
  };

  // The browser drops the lock when the page is hidden and does not restore it.
  // Registered with the other listeners at mount, below, so a throw during setup
  // cannot strand it on the document with no disposer to remove it.
  const onVisibilityChange = () => screenWakeLock.refresh();

  // Each request for playback. stopTts() bumps it too, so a request that
  // resumes after the audio context resumed (mute, Stop, barge-in, or unmount
  // meanwhile) finds itself superseded and lets go of its stream instead of
  // starting it.
  let ttsRequestSeq = 0;

  // Create/resume the audio context. Also called synchronously from the Send
  // gesture (see submit) so autoplay is allowed by the time audio arrives.
  const prepareTts = () => {
    try {
      if (!ttsCtx) ttsCtx = new AudioContext();
    } catch {
      // No Web Audio here (a stripped-down webview): replies stay text-only.
      return Promise.resolve();
    }
    if (ttsCtx.state === 'suspended') {
      return ttsCtx.resume().catch(() => {});
    }
    return Promise.resolve();
  };

  const stopTts = () => {
    ttsPlaybackId += 1;
    ttsRequestSeq += 1;
    for (const src of ttsSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        // already stopped
      }
    }
    ttsSources = [];
    ttsNextStart = 0;
    if (ttsActiveStream) {
      // Closing the stream signals the responder over the synchronize chain;
      // swallow the async rejection (it may already be closed remotely).
      ttsActiveStream.return().catch(() => {});
      ttsActiveStream = null;
    }
    ttsSpeechTurn = null;
    if (ttsSpeaking) {
      ttsSpeaking = false;
      notify();
    }
  };

  // True while scheduled TTS audio extends past the present — i.e. the bot is
  // (or is about to be) audibly speaking, so the mic is hearing itself.
  const ttsAudible = () => !!ttsCtx && ttsNextStart > ttsCtx.currentTime;

  // Decode one raw s16le mono PCM chunk into a scheduled AudioBuffer and queue
  // it back-to-back after whatever is already playing.
  const enqueuePcm = (
    /** @type {Uint8Array} */ bytes,
    /** @type {number} */ sampleRate,
  ) => {
    if (!ttsCtx) return;
    const frames = Math.floor(bytes.length / 2);
    if (!frames) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const buffer = ttsCtx.createBuffer(1, frames, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      samples[i] = view.getInt16(i * 2, true) / 32_768;
    }
    const src = ttsCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(ttsCtx.destination);
    const startAt = Math.max(ttsCtx.currentTime, ttsNextStart);
    src.start(startAt);
    ttsNextStart = startAt + buffer.duration;
    ttsSources.push(src);
    if (!ttsSpeaking) {
      ttsSpeaking = true;
      notify();
    }
    src.onended = () => {
      ttsSources = ttsSources.filter(s => s !== src);
      if (!ttsSources.length && ttsSpeaking) {
        ttsSpeaking = false;
        if (!ttsActiveStream) ttsSpeechTurn = null;
        notify();
      }
    };
  };

  // Pull synthesized audio from a TTS stream and play it back in order. Resolves
  // when the stream ends or playback is superseded by a newer stopTts().
  // `speechTurn` names the turn being spoken (null for a replay of a finished
  // message), so a settings change can restart its speech.
  const playAudioStream = async (
    /** @type {any} */ audioReader,
    /** @type {FlootTurn | null} */ speechTurn = null,
  ) => {
    if (!ttsServer) return;
    ttsRequestSeq += 1;
    const mySeq = ttsRequestSeq;
    await prepareTts();
    if (
      cancelled ||
      !ttsCtx ||
      mySeq !== ttsRequestSeq ||
      (speechTurn && !ttsEnabled)
    ) {
      // Superseded, muted, or unmounted while the audio context resumed:
      // release the daemon-side branch rather than leave it synthesizing for
      // nobody.
      iterateReader(audioReader)
        .return()
        .catch(() => {});
      return;
    }
    // Begin a fresh session: bump the token and adopt this reader.
    stopTts();
    ttsSpeechTurn = speechTurn;
    const myId = ttsPlaybackId;
    const audio = iterateReader(audioReader, { buffer: 4 });
    ttsActiveStream = audio;
    ttsNextStart = ttsCtx.currentTime;
    try {
      for await (const raw of audio) {
        const value = /** @type {any} */ (raw);
        if (cancelled || myId !== ttsPlaybackId) break;
        if (value.type === 'bytes') {
          enqueuePcm(base64ToBytes(value.b64), value.sampleRate || 22_050);
        } else if (value.type === 'end' || value.type === 'abort') {
          break;
        }
      }
    } catch (err) {
      // The iteration throws only when the stream could not start (no such
      // voice, TTS unreachable) or its transport failed; a stopTts() close
      // ends it cleanly and an in-band abort is a value. Say so, unless this
      // playback was superseded meanwhile. Audio already scheduled plays out.
      if (!cancelled && myId === ttsPlaybackId) {
        setStatus(`speech failed: ${/** @type {Error} */ (err).message}`);
      }
    } finally {
      if (myId === ttsPlaybackId && ttsActiveStream === audio) {
        ttsActiveStream = null;
        if (!ttsSources.length) ttsSpeechTurn = null;
      }
    }
  };

  // Play a finished message through TTS by feeding its whole text as one delta.
  // Independent of the live turn: starting a replay supersedes any other audio.
  const replayMessage = (/** @type {string} */ text) => {
    if (!ttsServer || !text.trim()) return;
    const feed = makeTextFeed();
    feed.delta(text);
    feed.end();
    replayingText = text;
    notify();
    playAudioStream(
      E(ttsServer).synthesize(feed.reader, currentTtsOptions()),
    ).finally(() => {
      if (replayingText === text) {
        replayingText = '';
        notify();
      }
    });
  };

  // Toggle spoken replies. Turning it off mid-reply silences the current one.
  const toggleTts = () => {
    ttsEnabled = !ttsEnabled;
    if (ttsEnabled) {
      // Still inside the tap: prime the audio context for the hands-free
      // path, whose replies start from the utterance timer, not a gesture.
      if (ttsServer) prepareTts();
    } else {
      stopTts();
    }
    notify();
  };

  // Ask the daemon for a spoken view of a turn and play it. Called again with
  // new settings it restarts speech: the fresh view opens on everything the
  // turn has said so far, and adopting its stream drops the previous one —
  // which is what tells the daemon that branch is no longer wanted. A speak()
  // that rejects (no such voice, TTS unreachable) just ends the iteration in
  // playAudioStream; the text reply is unaffected.
  const speakTurn = (/** @type {FlootTurn} */ turn) => {
    if (!ttsServer) return;
    playAudioStream(E(turn.ref).speak(ttsServer, currentTtsOptions()), turn);
  };

  // Mirror the settings to the whole-Floot preferences so the change follows
  // the user across sessions and devices. Best-effort: the per-device cache
  // already applied it, and an older factory simply rejects the call.
  const mirrorTtsSettings = () => {
    E(factory)
      .setVoicePreferences(harden({ ...ttsSettings }))
      .catch(() => {});
  };
  // A range slider fires one input event per pixel, and every restart
  // re-speaks the reply so far; commit after the last change in a burst.
  let ttsSettingsTimer = 0;
  // Set once the user changes a setting here, so the settings load still in
  // flight at mount (see below) cannot snap their choice back.
  let ttsSettingsDirty = false;
  const commitTtsSettings = () => {
    ttsSettingsTimer = 0;
    mirrorTtsSettings();
    const speechTurn = ttsSpeechTurn;
    // Restart only a reply still being produced. For one that has finished,
    // a restart would be the whole reply from the top; its tail plays out and
    // the new settings apply from the next reply (or a replay).
    if (
      speechTurn &&
      speechTurn === activeTurn &&
      (ttsSpeaking || ttsActiveStream)
    ) {
      speakTurn(speechTurn);
    }
  };
  const setTtsSetting = (
    /** @type {keyof TtsSettings} */ name,
    /** @type {string | number} */ raw,
  ) => {
    ttsSettingsDirty = true;
    if (name === 'voice') {
      ttsSettings = { ...ttsSettings, voice: `${raw}` };
    } else {
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      ttsSettings = { ...ttsSettings, [name]: value };
    }
    saveTtsSettings();
    notify();
    if (ttsSettingsTimer) clearTimeout(ttsSettingsTimer);
    ttsSettingsTimer = window.setTimeout(
      commitTtsSettings,
      TTS_SETTINGS_COMMIT_MS,
    );
  };

  // ── Controller (the view's only handle on the host engine) ───────────────────
  const controller = harden({
    getState,
    emergencyStop() {
      // Queued prompts are not a request to resume a stopped session: the
      // daemon holds them until the user sends one (they are kept, not lost).
      stopTts();
      void execution.stop();
    },
    resumeSession() {
      void execution.resume();
    },
    refreshNetworkPolicy() {
      void network.refresh();
    },
    setNetworkPolicy(/** @type {string} */ policy) {
      void network.set(policy);
    },
    resolveNetworkPolicyRequest(
      /** @type {string} */ id,
      /** @type {boolean} */ approve,
      /** @type {string} */ note,
    ) {
      void network.resolve(id, approve, note);
    },
    refreshRecovery() {
      void recovery.refresh();
    },
    resolveTurn(
      /** @type {string} */ turnId,
      /** @type {string} */ note,
      /** @type {boolean} */ confirmed,
    ) {
      if (network.getState().changing) return;
      void recovery.resolve(turnId, note, confirmed);
    },
    subscribe(/** @type {() => void} */ listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(/** @type {string | undefined} */ text) {
      submit(typeof text === 'string' ? text : inputText);
    },
    stop() {
      cancelTurn();
    },
    // Queue-jump. For the head of the queue behind a running turn this cuts
    // that turn short; the daemon enforces "only the head", since ending a
    // turn on behalf of a later message would throw a reply away and still
    // leave that message waiting. On a held queue it is what releases it.
    sendPendingNow(/** @type {number | string} */ id) {
      sendPendingNow(id);
    },
    editPending(/** @type {number | string} */ id, /** @type {string} */ text) {
      editPending(id, text);
    },
    cancelPending(/** @type {number | string} */ id) {
      cancelPending(id);
    },
    selectSession(/** @type {string} */ id) {
      selectSession(id);
    },
    newSession(
      /** @type {string | undefined} */ presetId,
      /** @type {string | undefined} */ model,
      /** @type {string | undefined} */ reasoningEffort,
    ) {
      newSession(presetId, model, reasoningEffort);
    },
    renameSession(/** @type {string} */ id, /** @type {string} */ title) {
      renameSession(id, title);
    },
    deleteSession(/** @type {string} */ id) {
      deleteSessionById(id);
    },
    toggleMic() {
      if (micActive) stopMic();
      else startMic();
    },
    toggleTts() {
      toggleTts();
    },
    setTtsSetting(
      /** @type {keyof TtsSettings} */ name,
      /** @type {string | number} */ value,
    ) {
      setTtsSetting(name, value);
    },
    replayMessage(/** @type {string} */ text) {
      replayMessage(text);
    },
    toggleSettings() {
      settingsOpen = !settingsOpen;
      if (settingsOpen) void network.refresh();
      if (settingsOpen) void execution.refresh();
      notify();
    },
    setInput(/** @type {string} */ text) {
      inputText = text;
      notify();
    },
  });

  // ── Mount the confined Preact view ───────────────────────────────────────────
  $parent.replaceChildren();
  const $mount = $parent.ownerDocument.createElement('div');
  $mount.id = 'floot-root';
  $mount.style.width = '100%';
  $mount.style.height = '100%';
  $parent.appendChild($mount);

  // `target` is opted in so a published capability URL in a reply opens in a
  // new tab as the tool promises: the renderer admits only `_self`/`_blank`
  // for it and forces `rel="noopener noreferrer"`, so nothing else widens.
  renderConfined(h(FlootApp, { controller }), $mount, {
    allowedAttrs: ['target'],
  });

  // Sticky-bottom transcript scrolling lives HOST-side: the confined view cannot
  // touch DOM nodes (the renderer strips refs), so the host owns `$mount` and
  // nudges `.floot-messages` to the bottom after each render while the reader is
  // already near the bottom. A capture-phase scroll listener (scroll does not
  // bubble, but capture still reaches ancestors) tracks whether to keep sticking.
  const STICK_THRESHOLD_PX = 48;
  const onScrollCapture = (/** @type {Event} */ e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (!el || !el.classList || !el.classList.contains('floot-messages'))
      return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick = dist <= STICK_THRESHOLD_PX;
  };
  $mount.addEventListener('scroll', onScrollCapture, true);
  wakeLockDoc.addEventListener('visibilitychange', onVisibilityChange);
  const scrollObserver = new MutationObserver(() => {
    if (!stick) return;
    const el = /** @type {HTMLElement | null} */ (
      $mount.querySelector('.floot-messages')
    );
    if (el) el.scrollTop = el.scrollHeight;
  });
  scrollObserver.observe($mount, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // ── Voice settings ───────────────────────────────────────────────────────────
  // Build the controls from the TTS object's own configuration (voices, ranges,
  // defaults) and seed them by precedence: the whole-Floot preferences on the
  // factory, then this device's cache, then the object's defaults. An older
  // factory has no preferences call — that reads as "unset" — and an older or
  // swapped TTS object without getConfiguration() still synthesizes with its
  // defaults, so both failures are tolerated.
  if (ttsServer) {
    Promise.all([
      E(ttsServer).getConfiguration(),
      E(factory)
        .getVoicePreferences()
        .catch(() => ({})),
    ])
      .then(([config, serverPrefs]) => {
        if (cancelled) return;
        const voices = Array.isArray(config?.voices) ? config.voices : [];
        const defaults = config?.defaults || {};
        const ranges = config?.ranges || {};
        /** @type {Record<string, unknown>} */
        let saved = {};
        try {
          const raw = window.localStorage.getItem(ttsStorageKey);
          if (raw) saved = JSON.parse(raw);
        } catch {
          // Ignore unavailable storage and malformed old settings.
        }
        const prefs = /** @type {Record<string, unknown>} */ (
          serverPrefs || {}
        );
        const pick = (/** @type {string} */ key) => prefs[key] ?? saved[key];
        const voiceIds = new Set(voices.map(voice => voice.id));
        // A setting the user changed while this load was in flight wins over
        // what it fetched: a selection must not snap back. Either way the
        // values are held to the object's voices and ranges.
        /** @type {TtsSettings} */
        const next = ttsSettingsDirty
          ? { ...ttsSettings }
          : {
              voice: `${pick('voice') || defaults.voice || ''}`,
              speed: Number(pick('speed') ?? defaults.speed ?? ttsSeed.speed),
              noiseScale: Number(
                pick('noiseScale') ?? defaults.noiseScale ?? ttsSeed.noiseScale,
              ),
              noiseW: Number(
                pick('noiseW') ?? defaults.noiseW ?? ttsSeed.noiseW,
              ),
              sentenceSilence: Number(
                pick('sentenceSilence') ??
                  defaults.sentenceSilence ??
                  ttsSeed.sentenceSilence,
              ),
            };
        if (!voiceIds.has(next.voice)) {
          next.voice = `${defaults.voice || voices[0]?.id || ''}`;
        }
        /** @type {NumericTtsSetting[]} */
        const numericSettings = [
          'speed',
          'noiseScale',
          'noiseW',
          'sentenceSilence',
        ];
        for (const name of numericSettings) {
          const range = ranges[name];
          const value = next[name];
          if (
            !Number.isFinite(value) ||
            (range && (value < Number(range.min) || value > Number(range.max)))
          ) {
            // Back to the object's default — or, should it not name one,
            // Piper's.
            next[name] = Number(defaults[name] ?? ttsSeed[name]);
          }
        }
        ttsSettings = next;
        ttsConfiguration = { voices, ranges };
        // Warm the per-device cache with the resolved values so a later
        // offline load still reflects the whole-Floot choice.
        saveTtsSettings();
        notify();
      })
      .catch(() => {
        // Older/swapped TTS objects can still synthesize with defaults.
      });
  }

  // ── Initial load ─────────────────────────────────────────────────────────────
  // Subscribe to the factory's session list (most-recent first), seeding a
  // default session if the factory has none, then open the active session.
  // The list stays subscribed: a session made elsewhere (another page, an agent
  // spawning a subagent), a rename, a deletion and each session's activity all
  // arrive here without being asked for.
  /** @param {any} m a session record as the factory reports it */
  const adoptSessionMeta = m => {
    const existing = sessions.find(s => s.id === m.id);
    const fields = {
      title: m.title || DEFAULT_TITLE,
      createdAt: m.createdAt || 0,
      presetId: m.presetId || DEFAULT_PRESET_ID,
      model: m.model || '',
      backendId: m.backendId || 'provider',
      modelId: m.modelId || '',
      effectiveModelId: m.effectiveModelId || '',
      reasoningEffort: m.reasoningEffort || '',
      lifecycle: m.lifecycle,
      activity: m.activity,
      pendingCount: Number(m.pendingCount) || 0,
    };
    if (existing) {
      Object.assign(existing, fields);
      return existing;
    }
    /** @type {FlootSession} */
    const session = {
      id: m.id,
      ...fields,
      messages: [],
      facet: null,
      loaded: false,
      transcript: null,
      current: null,
      running: null,
      pending: normalizePending(null),
      displayTurn: null,
    };
    sessions.push(session);
    return session;
  };
  const sortSessions = () => {
    sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  };
  /** @type {{ return: () => Promise<unknown> } | null} */
  let sessionListStream = null;

  /** @param {any} event */
  const applyListEvent = event => {
    if (event.type === 'session' && event.session) {
      const known = sessions.some(s => s.id === event.session.id);
      const wasReady = sessions.find(s => s.id === event.session.id)?.lifecycle;
      const session = adoptSessionMeta(event.session);
      if (!known) sortSessions();
      // The session on screen became usable (or stopped being): reopen it.
      if (
        session.id === activeSessionId &&
        (wasReady || 'ready') !== (session.lifecycle || 'ready')
      ) {
        openActiveSession();
      }
      // A circle this page painted red gives way once the daemon says better.
      if (session.activity !== 'error') sessionStatus.delete(session.id);
    } else if (event.type === 'removed' && typeof event.id === 'string') {
      const index = sessions.findIndex(s => s.id === event.id);
      if (index >= 0) {
        sessions = sessions.filter(s => s.id !== event.id);
        sessionStatus.delete(event.id);
        if (activeSessionId === event.id) {
          activeSessionId = sessions.length ? sessions[0].id : null;
          status = 'Ready.';
          openActiveSession();
        }
      }
    }
  };

  // Follow the list for the life of the mount. A stream that ends or fails is
  // opened again (a few times, not for ever), and the fresh snapshot is
  // reconciled against what is on screen, so the sidebar never freezes
  // silently on a list that stopped reporting.
  /** @param {AsyncIterator<any> & AsyncIterable<any>} first */
  const followSessionList = async first => {
    let list = first;
    let failures = 0;
    while (!cancelled) {
      let heard = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        for await (const event of list) {
          if (cancelled) return;
          heard = true;
          if (event.type === 'snapshot' && Array.isArray(event.sessions)) {
            const listed = new Set(
              event.sessions.map((/** @type {any} */ m) => m.id),
            );
            for (const meta of event.sessions) adoptSessionMeta(meta);
            for (const gone of sessions.filter(s => !listed.has(s.id))) {
              applyListEvent({ type: 'removed', id: gone.id });
            }
            sortSessions();
          } else {
            applyListEvent(event);
          }
          notify();
        }
      } catch {
        // Falls through to the reopen below.
      }
      if (cancelled) return;
      failures = heard ? 1 : failures + 1;
      if (failures > 3) {
        setStatus(
          'error: the session list stopped reporting; reload to retry.',
        );
        return;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        list = iterateReader(await E(factory).watchSessions(), { buffer: 4 });
        sessionListStream = list;
      } catch (error) {
        setStatus(`error: ${/** @type {Error} */ (error).message}`);
        return;
      }
    }
  };

  const loadInitialSessions = async () => {
    try {
      factory = await factory;
      const [listReader, presetList, modelList, backendList] =
        await Promise.all([
          E(factory).watchSessions(),
          E(factory)
            .listPresets()
            .catch(() => []),
          E(factory).listModels(),
          E(factory)
            .listBackends()
            .catch(() => []),
        ]);
      const list = iterateReader(listReader, { buffer: 4 });
      sessionListStream = list;
      if (cancelled) {
        void Promise.resolve(list.return()).catch(() => {});
        return;
      }
      presets = presetList;
      backends = backendList.map((/** @type {any} */ b) => ({
        id: b.id,
        title: b.title,
      }));
      models = modelList.map(m => ({
        ...m,
        backendTitle: backendList.find(b => b.id === m.backendId)?.title,
      }));
      // The first event is the list as it stands. Unavailable sessions are
      // retained too: hiding them would hide recovery work.
      const first = /** @type {any} */ ((await list.next()).value);
      const metas = /** @type {any[]} */ (
        first && first.type === 'snapshot' ? first.sessions : []
      );
      for (const meta of metas) adoptSessionMeta(meta);
      sortSessions();
      const strandedCount = metas.filter(
        m => m.lifecycle && m.lifecycle !== 'ready',
      ).length;
      if (!sessions.length) {
        await createSession();
      } else {
        activeSessionId = (
          sessions.find(s => !s.lifecycle || s.lifecycle === 'ready') ||
          sessions[0]
        ).id;
      }
      // Say so rather than reporting a clean "Ready." over sessions the
      // factory could not revive; they are still listed by the factory and an
      // operator has to deal with them.
      setStatus(
        strandedCount > 0
          ? `Ready. ${strandedCount} session(s) could not be recovered.`
          : 'Ready.',
      );
      openActiveSession();
      void followSessionList(list);
    } catch (err) {
      if (!cancelled) setStatus(`error: ${/** @type {Error} */ (err).message}`);
    }
  };
  void loadInitialSessions();

  return () => {
    cancelled = true;
    void recovery.select(null);
    void network.select(null);
    void execution.select(null);
    wakeLockDoc.removeEventListener('visibilitychange', onVisibilityChange);
    // `cancelled` is set, so this releases rather than re-requests.
    updateWakeLock();
    // Closing a subscription detaches this page and nothing else.
    if (sessionView) sessionView.close();
    if (sessionListStream) {
      void Promise.resolve(sessionListStream.return()).catch(() => {});
    }
    // Leave any in-flight turn running in the background — just detach our view
    // (don't return the reader, which would abort the agent). The turn finishes
    // and persists; a later remount reattaches or falls back to history.
    if (detachActiveTurnView) detachActiveTurnView();
    if (ttsSettingsTimer) {
      // A change still waiting for its burst to end is not lost with the tab.
      clearTimeout(ttsSettingsTimer);
      ttsSettingsTimer = 0;
      mirrorTtsSettings();
    }
    stopMic();
    stopTts();
    if (ttsCtx) {
      ttsCtx.close().catch(() => {});
      ttsCtx = null;
    }
    scrollObserver.disconnect();
    $mount.removeEventListener('scroll', onScrollCapture, true);
    unmount($mount);
    $mount.remove();
  };
};
harden(flootComponent);
