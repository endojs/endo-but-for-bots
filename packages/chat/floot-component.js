// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import harden from '@endo/harden';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { FlootApp } from '@endo/space-floot';
import { h, renderConfined, unmount } from './setup-preact-container.js';
import { makeScreenWakeLock } from './wake-lock.js';

// The view's controller/state/message shapes are defined (and enforced at the
// `h(FlootApp, …)` boundary) by `@endo/space-floot`'s own types; like the other
// migrated space wrappers (e.g. peers-component.js) the host does not re-import
// them.

// ── Background turns ─────────────────────────────────────────────────────────
// A Floot turn runs on the daemon (`session.startTurn`). This side is a view: it
// pulls the turn's disposable `watch()` stream and stops the turn only by
// calling `cancel()`. Dropping the stream — unmount, tab close, gateway loss —
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
   *   model: string, messages: HistoryMessage[], facet: any, loaded: boolean }}
   *   FlootSession
   * @typedef {{ id: string, title: string, description: string }} FlootPreset
   * @typedef {{ id: string, title: string, description: string,
   *   default: boolean }} FlootModel
   */

  /** @type {FlootPreset[]} */
  let presets = [];
  /** @type {FlootModel[]} */
  let models = [];
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

  const liveTurnFor = (/** @type {string} */ id) => {
    const turn = turnsForFactory(factory).get(id);
    return turn && !turn.done ? turn : null;
  };

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

  // Pull the spoken transcript for a session from its guest into the cache.
  const loadHistory = async (
    /** @type {FlootSession} */ session,
    historyP = E(facetFor(session)).getHistory(),
    accept = () => true,
  ) => {
    const previousMessages = session.messages;
    const previousLength = previousMessages.length;
    try {
      const history = await historyP;
      // A new submission or refresh takes precedence over stale history I/O.
      if (
        !accept() ||
        session.messages !== previousMessages ||
        session.messages.length !== previousLength
      )
        return;
      session.messages = historyMessages(history);
    } catch {
      // leave whatever we have; history just won't repaint
    }
    session.loaded = true;
  };

  // Create a new session on the factory and prepend it to the local list.
  /**
   * @param {string} [title]
   * @param {string} [presetId]
   * @param {string} [model]
   * @param {string} [reasoningEffort]
   */
  const createSession = async (title, presetId, model, reasoningEffort) => {
    const requiresRecordForm = Boolean(
      reasoningEffort || (model && model.includes(':')),
    );
    const facet = requiresRecordForm
      ? await E(factory).createSession({
          title: title || DEFAULT_TITLE,
          ...(presetId ? { presetId } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        })
      : await E(factory).createSession(title || DEFAULT_TITLE, presetId, model);
    const info = await E(facet).getInfo();
    /** @type {FlootSession} */
    const session = {
      id: info.id,
      title: info.title || DEFAULT_TITLE,
      createdAt: info.createdAt || Date.now(),
      presetId: info.presetId || DEFAULT_PRESET_ID,
      model: info.model || '',
      messages: [],
      facet,
      loaded: true,
    };
    sessions.unshift(session);
    activeSessionId = session.id;
    return session;
  };

  // Pull a session's cumulative usage from its guest and show it (cost survives
  // restarts; a live turn updates it again via the 'usage' reply event).
  const showSessionTokens = (/** @type {FlootSession | null} */ session) => {
    usage = null;
    notify();
    if (!session) return;
    E(facetFor(session))
      .getUsage()
      .then((/** @type {any} */ u) => {
        if (activeSessionId === session.id) {
          usage = u;
          notify();
        }
      })
      .catch(() => {});
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

  const getState = () => {
    const session = getActiveSession();
    const liveTurn = session ? liveTurnFor(session.id) : null;
    const base = session ? session.messages : [];
    const sent = liveTurn ? [...base, ...liveTurn.messages] : base;
    // Queued submissions render after the live turn's output: they run after
    // it, and hiding them until then reads as a swallowed message. The view
    // lifts them out by `pending` and puts them below the thinking indicator.
    const queued = session
      ? queuedSends
          .filter(q => q.sessionId === session.id)
          .map(q => ({
            role: /** @type {const} */ ('user'),
            text: q.text,
            pending: true,
            pendingId: q.id,
          }))
      : [];
    const allMessages = [...sent.map(toViewMessage), ...queued];
    return harden({
      sessions: sessions.map(s => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        presetId: s.presetId,
        model: s.model,
        status: liveTurnFor(s.id)
          ? /** @type {const} */ ('streaming')
          : sessionStatus.get(s.id) || 'idle',
        messageCount: s.messages.length,
        loaded: s.loaded,
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
      })),
      messages: allMessages,
      streamingText: liveTurn ? liveTurn.streamingText : '',
      phase: liveTurn ? liveTurn.phase : '',
      busy: Boolean(liveTurn),
      loaded: session ? session.loaded : false,
      status,
      input: inputText,
      settingsOpen,
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
  let cancelled = false;
  let busy = false;
  let turnCancelled = false;
  // Submissions accepted while a turn is still running (typed mid-stream, or a
  // voice utterance after a soft barge-in) queue on submitChain. They must stay
  // VISIBLE while queued: submit() clears the compose box immediately, and the
  // optimistic session push only happens once the queued turn actually starts,
  // so without this the message vanishes until the prior turn finishes.
  //
  // The queue is per-mount, unlike the turn registry above, which deliberately
  // survives unmount. Leaving the space therefore drops whatever had not run
  // yet, while the turn it was queued behind keeps going — the pre-existing
  // behaviour, now more visible because the message looked accepted. Making it
  // survive means holding the queue beside `inFlightTurns`; until then, a
  // message queued behind a long turn is only as durable as the tab.
  /** @type {Array<{ id: number, sessionId: string, text: string }>} */
  let queuedSends = [];
  let nextQueuedSendId = 1;

  /**
   * Forget a queued placeholder. Reports whether it was still there, so the
   * caller can repaint only when something actually changed.
   *
   * @param {number} id 0 for "no placeholder was made"
   * @returns {boolean}
   */
  const dropQueued = id => {
    if (!id || !queuedSends.some(q => q.id === id)) return false;
    queuedSends = queuedSends.filter(q => q.id !== id);
    return true;
  };

  /** @type {FlootTurn | null} */
  let activeTurn = null;
  // Detaches this component's view from the active turn without stopping it
  // (used on unmount so the turn keeps running in the background).
  /** @type {(() => void) | null} */
  let detachActiveTurnView = null;

  /** @type {Promise<void>} */
  let submitChain = Promise.resolve();
  /** @type {Promise<void> | null} */
  let turnPromise = null;
  let opening = harden({});
  let viewReady = Promise.resolve();
  /** @type {WeakMap<FlootSession, FlootTurn>} */
  const displayedPrompts = new WeakMap();

  // Cancel the in-flight turn (Stop button or voice barge-in). Returns a promise
  // that resolves once the turn has fully unwound.
  const cancelTurn = () => {
    if (!busy) return Promise.resolve();
    turnCancelled = true;
    // Stop button: explicitly tear the turn down (unlike leaving the space,
    // which lets it keep running in the background).
    if (activeTurn) activeTurn.stop();
    stopTts(); // also silences any spoken reply in progress
    return turnPromise || Promise.resolve();
  };

  // Voice barge-in: the user started speaking over a live reply. Unlike the Stop
  // button's hard cancel, don't abort the turn — just silence its spoken reply
  // (dropping the audio stream is what tells the daemon to stop speaking it)
  // and let it finish in the background (and in history). The user's
  // interjection is queued after it (submitChain waits on the running turn).
  const softBargeIn = () => {
    if (!busy) return;
    stopTts();
    setStatus('continuing in background…');
  };

  // Attach this component's view to a background turn — the one it just started,
  // or one still running after a remount. Notifies the view as the turn's events
  // arrive and resolves when the turn ends. Detaching (on unmount) leaves the
  // turn running.
  /**
   * @param {FlootTurn} turn
   * @param {FlootSession} session
   * @returns {Promise<void>}
   */
  const attachTurnView = (turn, session) => {
    busy = true;
    turnCancelled = false;
    activeTurn = turn;
    sessionStatus.delete(session.id);
    setStatus(`${turn.phase || 'thinking'}…`);
    if (turn.usage) usage = turn.usage;
    notify();

    return new Promise(resolve => {
      let detached = false;
      let unsubscribe = () => {};
      const detach = () => {
        if (detached) return;
        detached = true;
        unsubscribe();
        if (detachActiveTurnView === detach) {
          detachActiveTurnView = null;
          activeTurn = null;
          busy = false;
          notify();
        }
        resolve();
      };
      detachActiveTurnView = detach;

      /** @param {{ type: string }} ev */
      const onEvent = ev => {
        if (detached) return;
        if (ev.type === 'superseded') {
          detach();
          // Another view may retire our shared observation. Reconcile this
          // component too, before its released submissions resume.
          // eslint-disable-next-line no-use-before-define
          openActiveHistory();
          return;
        }
        // Attachment completion is independent of selection and history I/O.
        // Deletion can change selection while the old turn is still unwinding.
        if (ev.type === 'done' && activeSessionId !== turn.sessionId) {
          detach();
          return;
        }
        if (activeSessionId !== turn.sessionId) return;
        if (ev.type === 'snapshot') {
          // The turn's state as of the moment this view opened. Repaint from
          // it; speech, if any, is the daemon's own view of the same turn.
          if (turn.usage) usage = turn.usage;
          setStatus(`${turn.phase || 'thinking'}…`);
        } else if (ev.type === 'delta' || ev.type === 'final') {
          notify();
        } else if (ev.type === 'tool_call') {
          notify();
        } else if (ev.type === 'tool_result') {
          notify();
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
            sessionStatus.set(turn.sessionId, 'idle');
            status = stopped ? 'stopped.' : 'Ready.';
          }
          // Fold the finished turn's output into the session optimistically so
          // the reply doesn't blink out between the turn ending (it leaves the
          // registry) and the canonical history reload landing.
          session.messages.push(.../** @type {any[]} */ (turn.messages));
          notify();
          // Repaint from the daemon's canonical transcript (now including this
          // turn's persisted reply) so the turn's output is never double-shown.
          detach();
          void loadHistory(session).then(() => {
            if (!cancelled && activeSessionId === session.id) notify();
          });
        }
      };
      unsubscribe = turn.subscribe(onEvent);
      // Settle immediately if the turn finished between start and subscribe.
      if (turn.done) onEvent({ type: 'done' });
    });
  };

  /**
   * @param {string} text
   * @param {number} [queuedId] the placeholder this turn is running, if any
   */
  const runConverse = async (text, queuedId = 0) => {
    let session = getActiveSession();
    if (!session) session = await createSession();

    // The queued placeholder is superseded by the optimistic session push
    // below — the same text, now part of the running turn's transcript.
    dropQueued(queuedId);
    session.messages.push({ role: 'user', text });
    // Sending a message is an explicit "follow along" intent — re-stick.
    stick = true;
    if (session.title === DEFAULT_TITLE) {
      session.title = autoTitle(text);
      E(factory)
        .renameSession(session.id, session.title)
        .catch(() => {});
    }
    notify();

    // Start the turn on the daemon — it keeps running if this space is left —
    // then render it through the shared view. A spoken reply is a second view
    // of the same turn, which the daemon speaks (see speakTurn).
    const speakLive = ttsEnabled && Boolean(ttsServer);
    const turnRef = E(facetFor(session)).startTurn(text);
    const turn = startFlootTurn(
      turnsForFactory(factory),
      session.id,
      session.id,
      turnRef,
    );
    displayedPrompts.set(session, turn);
    if (speakLive) speakTurn(turn);
    await attachTurnView(turn, session);
  };

  // Serialize submissions so an auto-sent voice utterance can't overlap a typed
  // message: each turn waits for the previous.
  const submit = (/** @type {string} */ raw) => {
    // An explicit send supersedes any buffered voice continuation.
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = 0;
    }
    pendingUtterance = '';
    const text = (raw || '').trim();
    if (!text) return submitChain;
    // Create/resume the audio context now, still inside the user's Send
    // gesture: a browser refuses autoplay when the first resume happens only
    // after the remote round trips that start the turn and its speech.
    if (ttsEnabled && ttsServer) prepareTts();
    inputText = '';
    const submittedSessionId = activeSessionId;
    // Stand a placeholder up now, so the message is visible for as long as it
    // waits. Without an active session nothing is queued ahead of it, so it
    // dispatches straight away and needs none.
    let queuedId = 0;
    if (submittedSessionId) {
      queuedId = nextQueuedSendId;
      nextQueuedSendId += 1;
      queuedSends.push({ id: queuedId, sessionId: submittedSessionId, text });
    }
    notify();
    submitChain = submitChain.then(async () => {
      try {
        // A shared observation can be superseded while we await its completion.
        // Join the replacement view and turn too before dispatching queued
        // input.
        for (;;) {
          const ready = viewReady;
          // eslint-disable-next-line no-await-in-loop
          await ready;
          if (
            cancelled ||
            (submittedSessionId && activeSessionId !== submittedSessionId)
          )
            return;
          const previous = turnPromise;
          // eslint-disable-next-line no-await-in-loop
          if (previous) await previous;
          if (
            cancelled ||
            (submittedSessionId && activeSessionId !== submittedSessionId)
          )
            return;
          if (ready === viewReady && previous === turnPromise) break;
        }
        // Read the text back off the placeholder at the moment the turn starts,
        // rather than closing over what was typed: a queued message can be
        // edited or deleted while it waits, and the edit has to be what
        // actually runs. A missing placeholder means it was deleted — skip the
        // turn entirely.
        let queuedText = text;
        if (queuedId) {
          const queued = queuedSends.find(q => q.id === queuedId);
          if (!queued) return;
          queuedText = queued.text;
        }
        turnPromise = runConverse(queuedText, queuedId).catch(error => {
          if (!cancelled) setStatus(`error: ${error.message}`);
        });
        await turnPromise;
      } finally {
        // However this entry exits — deleted, superseded session, or the turn
        // having adopted it — the placeholder must not outlive it.
        if (dropQueued(queuedId) && !cancelled) notify();
      }
    });
    return submitChain;
  };

  /**
   * Rewrite a queued submission while it waits. No effect once its turn has
   * started: the placeholder is gone by then.
   *
   * @param {number} id
   * @param {string} raw
   */
  const editPending = (id, raw) => {
    const text = (raw || '').trim();
    // An empty edit is a no-op rather than a delete: deleting has its own
    // button, and losing a message by clearing the box would be a surprising
    // way to lose one.
    if (!text) return;
    if (!queuedSends.some(q => q.id === id)) return;
    queuedSends = queuedSends.map(q => (q.id === id ? { ...q, text } : q));
    notify();
  };

  /**
   * Drop a queued submission before it runs. Its chain entry is already
   * scheduled, so removing the placeholder is what cancels it: the entry finds
   * nothing and skips its turn.
   *
   * @param {number} id
   */
  const cancelPending = id => {
    if (dropQueued(id)) notify();
  };

  // ── Session actions (controller callbacks) ──────────────────────────────────
  const openActiveHistory = () => {
    const generation = harden({});
    opening = generation;
    // Opening a session starts at the latest message.
    stick = true;
    const session = getActiveSession();
    if (!session) {
      viewReady = Promise.resolve();
      usage = null;
      notify();
      return;
    }
    showSessionTokens(session);
    const stillSelected = () =>
      !cancelled && opening === generation && activeSessionId === session.id;
    viewReady = (async () => {
      // Recover the daemon's handle after a reload or transport loss. The
      // browser registry is only a cache; it is never the source of liveness.
      const current = await E(facetFor(session)).getCurrentTurn();
      if (!stillSelected()) return;
      let turn = liveTurnFor(session.id);
      if (turn && (!current || (await turn.ref) !== current.turn)) {
        if (!stillSelected()) return;
        turn.retire();
        turn = null;
      }
      if (!stillSelected()) return;
      if (!current) {
        await loadHistory(session);
        if (stillSelected()) notify();
        return;
      }
      if (!turn) {
        turn = startFlootTurn(
          turnsForFactory(factory),
          session.id,
          session.id,
          current.turn,
        );
      }
      if (displayedPrompts.get(session) !== turn) {
        const adoptedTurn = turn;
        const prompt =
          typeof current.input === 'string'
            ? [{ role: /** @type {const} */ ('user'), text: current.input }]
            : [];
        session.messages = prompt;
        session.loaded = false;
        displayedPrompts.set(session, turn);
        // Discovery exposes the handle before queued mail establishes history.
        // Observe/cancel now; install only this turn's baseline when it arrives.
        void Promise.resolve(current.history)
          .then(history => {
            if (
              !stillSelected() ||
              adoptedTurn.done ||
              liveTurnFor(session.id) !== adoptedTurn ||
              displayedPrompts.get(session) !== adoptedTurn
            )
              return;
            session.messages = [...historyMessages(history), ...prompt];
            session.loaded = true;
            notify();
          })
          .catch(error => {
            if (stillSelected() && liveTurnFor(session.id) === adoptedTurn)
              setStatus(`error: ${error.message}`);
          });
      }
      if (!busy) turnPromise = attachTurnView(turn, session);
      notify();
    })().catch(error => {
      if (stillSelected()) setStatus(`error: ${error.message}`);
    });
  };

  const selectSession = (/** @type {string} */ id) => {
    if (busy) return; // don't switch context mid-turn
    // A per-message replay plays without setting busy; silence it so it doesn't
    // keep speaking over the session we're switching to.
    stopTts();
    activeSessionId = id;
    turnPromise = null;
    setStatus('Ready.');
    openActiveHistory();
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
    if (activeSessionId === id) {
      // Deletion owns daemon teardown; the UI need not wait for it to release
      // its attachment or submission queue. Late events cannot affect a new view.
      if (detachActiveTurnView) detachActiveTurnView();
      activeSessionId = sessions.length ? sessions[0].id : null;
      turnPromise = null;
    }
    E(factory)
      .deleteSession(id)
      .catch(err => setStatus(`error: ${err.message}`));
    notify();
    openActiveHistory();
  };

  /**
   * @param {string} [presetId]
   * @param {string} [model]
   * @param {string} [reasoningEffort]
   */
  const newSession = (presetId, model, reasoningEffort) => {
    if (busy) return;
    createSession(undefined, presetId, model, reasoningEffort)
      .then(() => {
        stick = true;
        notify();
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
      let onsetThreshold = busy ? bargeThreshold : speechThreshold;
      // If our own TTS is audibly playing (even after the text turn finished),
      // demand more headroom still so speaker→mic leakage can't self-barge.
      if (ttsAudible()) {
        onsetThreshold = Math.max(
          onsetThreshold,
          bargeThreshold * VAD.ECHO_BARGE_MULT,
        );
      }
      if (vol > onsetThreshold) {
        if (busy) softBargeIn();
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
    screenWakeLock.set(!cancelled && Boolean(micActive || ttsSpeaking || busy));
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
    // Queue-jump for the pending submission at the head of the queue. It is
    // already scheduled on submitChain directly behind the turn in flight, so
    // "send now" is precisely "cut that turn short": cancelling releases it.
    //
    // Only the head. Every entry runs the message it was scheduled with, so
    // cancelling on behalf of a LATER one would end a turn that is not in front
    // of it — throwing away that reply — and still leave it waiting. The view
    // offers the control on the head row alone; this is the check that makes
    // that a rule rather than a convention.
    sendPendingNow(/** @type {number} */ id) {
      const head = queuedSends.find(q => q.sessionId === activeSessionId);
      if (!busy || !head || head.id !== id) return;
      cancelTurn();
    },
    editPending(/** @type {number} */ id, /** @type {string} */ text) {
      editPending(id, text);
    },
    cancelPending(/** @type {number} */ id) {
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

  renderConfined(h(FlootApp, { controller }), $mount);

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
  // Load the session list from the factory (most-recent first), seeding a
  // default session if the factory has none, then repaint the active history.
  let recoveryRefreshTimer;
  // A session stuck in a non-ready lifecycle (a failed creation, a hosted
  // backend that is no longer installed) never becomes ready on its own, and
  // the factory only recovers at startup. Poll a bounded number of times with
  // a widening delay, then stop and let the user get on with a new session
  // rather than spinning on three CapTP round trips forever.
  const RECOVERY_ATTEMPTS = 8;
  let recoveryAttempt = 0;
  const loadInitialSessions = async () => {
    try {
      factory = await factory;
      const [metas, presetList, modelList] = await Promise.all([
        E(factory).listSessions(),
        E(factory)
          .listPresets()
          .catch(() => []),
        E(factory).listModels(),
      ]);
      presets = presetList;
      models = modelList;
      // `listSessions()` is a remote call, so its result is unknown here;
      // materialize it once as an array both the filter and the recovery
      // check below can read.
      const allMetas = /** @type {any[]} */ ([...metas]);
      const readyMetas = allMetas.filter(
        (/** @type {any} */ meta) =>
          !meta.lifecycle || meta.lifecycle === 'ready',
      );
      sessions = readyMetas
        .sort(
          (/** @type {any} */ a, /** @type {any} */ b) =>
            (b.createdAt || 0) - (a.createdAt || 0),
        )
        .map((/** @type {any} */ m) => ({
          id: m.id,
          title: m.title || DEFAULT_TITLE,
          createdAt: m.createdAt || 0,
          presetId: m.presetId || DEFAULT_PRESET_ID,
          model: m.model || '',
          messages: [],
          facet: null,
          loaded: false,
        }));
      if (
        !sessions.length &&
        allMetas.length > 0 &&
        recoveryAttempt < RECOVERY_ATTEMPTS
      ) {
        recoveryAttempt += 1;
        setStatus(
          `Recovering sessions… (${recoveryAttempt}/${RECOVERY_ATTEMPTS})`,
        );
        recoveryRefreshTimer = setTimeout(
          () => {
            // The user may have created a session and started talking while
            // this was armed. Reloading would replace the session list and
            // reset the active session out from under them.
            if (!cancelled && !sessions.length) void loadInitialSessions();
          },
          250 * 2 ** (recoveryAttempt - 1),
        );
        return;
      }
      recoveryAttempt = 0;
      const strandedCount = allMetas.length - sessions.length;
      if (!sessions.length) {
        await createSession();
      } else {
        activeSessionId = sessions[0].id;
      }
      // Say so rather than reporting a clean "Ready." over sessions the
      // factory could not revive; they are still listed by the factory and an
      // operator has to deal with them.
      setStatus(
        strandedCount > 0
          ? `Ready. ${strandedCount} session(s) could not be recovered.`
          : 'Ready.',
      );
      openActiveHistory();
    } catch (err) {
      setStatus(`error: ${/** @type {Error} */ (err).message}`);
    }
  };
  void loadInitialSessions();

  // Mail-driven workflow completions do not have a UI reply stream. Refresh
  // idle history so the readiness message appears while this space is open.
  // Never overwrite an optimistic/in-flight user turn with an older snapshot.
  let historyTimer;
  const refreshMailHistory = async () => {
    const session = getActiveSession();
    if (session && !busy && !liveTurnFor(session.id)) {
      const previousCount = session.messages.length;
      await loadHistory(
        session,
        undefined,
        () => !cancelled && !busy && !liveTurnFor(session.id),
      );
      if (
        !cancelled &&
        activeSessionId === session.id &&
        session.messages.length > previousCount
      ) {
        notify();
      }
    }
    if (!cancelled) historyTimer = setTimeout(refreshMailHistory, 3000);
  };
  historyTimer = setTimeout(refreshMailHistory, 3000);

  return () => {
    cancelled = true;
    wakeLockDoc.removeEventListener('visibilitychange', onVisibilityChange);
    // `cancelled` is set, so this releases rather than re-requests.
    updateWakeLock();
    clearTimeout(historyTimer);
    if (recoveryRefreshTimer !== undefined) {
      clearTimeout(recoveryRefreshTimer);
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
