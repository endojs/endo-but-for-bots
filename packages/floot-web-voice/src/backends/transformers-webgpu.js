// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND A — transformers-webgpu  (main-thread server)
// ─────────────────────────────────────────────────────────────────────────────
//
// In-browser STT + TTS on the WebGPU backend via Hugging Face's
// `@huggingface/transformers` (Moonshine ASR) and `kokoro-js` (Kokoro-82M TTS).
//
// All model download + inference runs in transformers-webgpu.worker.js (a
// dedicated module Worker). This main-thread module owns the STTServer /
// TTSServer exos: it decodes/encodes PCM, sentence-chunks reply text, posts work
// to the worker, and marshals the worker's results onto the CapTP wire channels
// from ../wire.js. Models load once in the worker and stay resident across turns
// (warmed when createSTT/createTTS is first called).
//
// MODEL CACHING: transformers.js caches downloaded weights in the browser Cache
// API by default, so the (large) Moonshine + Kokoro weights download only on the
// first run; subsequent worker starts read from cache. (OPFS via
// `env.useFSCache` is a future option; the default Cache API is automatic.)
//
// STT STREAMING PARTIALS: transformers.js's ASR pipeline has no true frame-
// streaming partial API, so partials are produced by periodic re-transcription
// of the GROWING accumulated buffer (every ~PARTIAL_INTERVAL_MS of new audio).
// Each pass returns the full transcript so far, which is exactly the transcript
// wire's REPLACE semantics. This is the accepted transformers.js approach.

import { makeError, X, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

import { hasWebGPU } from '../feature-detect.js';
import { makeAudioOutChannel, makeTranscriptChannel } from '../wire.js';

/** @import { STTServer, TTSServer, VoiceBackend } from '../types.js' */

const ID = 'transformers-webgpu';

// Re-transcribe at most this often while audio accumulates. A phone GPU running
// Moonshine-base over a growing buffer can't keep up with frame-rate partials;
// ~500 ms of new audio between passes keeps the UI responsive without thrashing.
const PARTIAL_INTERVAL_MS = 500;

// Mic audio arrives as 16 kHz mono s16le PCM (the wire form), so 500 ms is this
// many samples of new audio between partial passes.
const STT_SAMPLE_RATE = 16_000;
const PARTIAL_INTERVAL_SAMPLES = Math.floor(
  (STT_SAMPLE_RATE * PARTIAL_INTERVAL_MS) / 1000,
);

// ── PCM / base64 helpers (pure; host-side, portable Uint8Array path) ──────────

/**
 * Decode base64 of 16 kHz mono s16le PCM into a normalized Float32Array in
 * [-1, 1] (the form the ASR pipeline consumes). Uses `atob` + a DataView rather
 * than Node Buffer so it runs in the browser/SES realms.
 *
 * @param {string} b64
 * @returns {Float32Array}
 */
export const pcmBase64ToFloat32 = b64 => {
  const binary = atob(`${b64}`);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  const frames = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32_768;
  }
  return out;
};
harden(pcmBase64ToFloat32);

/**
 * Convert a Float32Array in [-1, 1] to raw s16le mono PCM, base64-encoded — the
 * `bytes`-event payload the TTS playback path (floot-component.js enqueuePcm)
 * consumes directly into an AudioBuffer with no decode hop.
 *
 * @param {Float32Array} samples
 * @returns {string}
 */
export const float32ToPcmBase64 = samples => {
  const n = samples.length;
  const bytes = new Uint8Array(n * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      i * 2,
      clamped < 0 ? clamped * 32_768 : clamped * 32_767,
      true,
    );
  }
  // btoa over a binary string built in chunks to avoid blowing the call stack on
  // long utterances (a 24 kHz sentence is tens of thousands of samples).
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
harden(float32ToPcmBase64);

// ── Sentence chunker (ported verbatim from tts-server-caplet.js) ─────────────
// The caplets are deliberately self-contained; we do the same here rather than
// import across the package boundary, so the in-browser path has no daemon dep.

const MIN_CHUNK_LENGTH = 10;
const ABBREVIATIONS = harden(
  new Set(['St', 'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'vs', 'etc', 'Jr', 'Sr']),
);

// Strip the markdown that would otherwise be read aloud as punctuation noise.
const stripMarkdown = text =>
  `${text}`
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, ''); // bullet markers

const isAbbrev = (text, i) => {
  const m = text.slice(0, i).match(/([A-Za-z]+)$/);
  return m !== null && ABBREVIATIONS.has(m[1]);
};
const isListMarker = (text, i) => {
  const before = text.slice(0, i);
  const linePrefix = before.slice(before.lastIndexOf('\n') + 1);
  return /^\d+$/.test(linePrefix);
};
const isBoundary = (text, i) => {
  const c = text[i];
  if (c === '\n') return true;
  if (c !== '.' && c !== '!' && c !== '?') return false;
  const next = text[i + 1];
  if (next === undefined || !/\s/.test(next)) return false;
  if (c === '.' && (isListMarker(text, i) || isAbbrev(text, i))) return false;
  return true;
};

/**
 * Accumulating sentence chunker. `push(text)` returns any complete sentences
 * unlocked by the new text; `finish()` returns the trailing remainder. Ported
 * from tts-server-caplet.js so the in-browser TTS chunking matches the caplet.
 */
export const makeChunker = () => {
  let buffer = '';
  const flush = () => {
    const rawParts = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (!isBoundary(buffer, i)) continue; // eslint-disable-line no-continue
      let end = i + 1;
      while (end < buffer.length && /\s/.test(buffer[end])) end += 1;
      rawParts.push(buffer.slice(start, end));
      start = end;
      i = end - 1;
    }
    const tail = buffer.slice(start);
    const chunks = [];
    let pending = '';
    for (const part of rawParts) {
      const trimmed = stripMarkdown(part).trim();
      if (!trimmed) continue; // eslint-disable-line no-continue
      const combined = pending ? `${pending} ${trimmed}` : trimmed;
      if (combined.length >= MIN_CHUNK_LENGTH) {
        chunks.push(combined);
        pending = '';
      } else {
        pending = combined;
      }
    }
    buffer = pending ? [pending, tail].filter(Boolean).join(' ') : tail;
    return chunks;
  };
  return harden({
    push: text => {
      buffer += text;
      return flush();
    },
    finish: () => {
      const trimmed = stripMarkdown(buffer).trim();
      buffer = '';
      return trimmed ? [trimmed] : [];
    },
  });
};
harden(makeChunker);

// ── Web Worker management ────────────────────────────────────────────────────

let nextTurnId = 0;
const newTurnId = () => {
  nextTurnId += 1;
  return `t${nextTurnId}`;
};

/**
 * Spawn the model Worker with the bundler-friendly `new URL(...)` pattern so the
 * worker module is emitted as its own chunk. Routes worker messages to per-turn
 * and per-warm handlers keyed by `id`. A single worker hosts both models so the
 * STT and TTS servers share it (models stay resident across turns).
 *
 * @returns {{
 *   post: (msg: object, transfer?: Transferable[]) => void,
 *   onTurn: (id: string, handler: (msg: any) => void) => () => void,
 *   onceReady: (model: 'stt'|'tts') => Promise<void>,
 *   terminate: () => void,
 * }}
 */
const makeWorkerHost = () => {
  const worker = new Worker(
    new URL('./transformers-webgpu.worker.js', import.meta.url),
    { type: 'module' },
  );
  /** @type {Map<string, (msg: any) => void>} */
  const turnHandlers = new Map();
  /** @type {Map<string, Array<{ resolve: () => void, reject: (e: Error) => void }>>} */
  const readyWaiters = new Map();

  worker.onmessage = event => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'ready') {
      const waiters = readyWaiters.get(msg.model) || [];
      readyWaiters.set(msg.model, []);
      for (const w of waiters) w.resolve();
      return;
    }
    if (msg.kind === 'error' && msg.model) {
      const waiters = readyWaiters.get(msg.model) || [];
      readyWaiters.set(msg.model, []);
      const err = makeError(
        X`${q(ID)} ${q(msg.model)} model failed: ${q(`${msg.message}`)}`,
      );
      for (const w of waiters) w.reject(err);
      return;
    }
    if (msg.id) {
      const handler = turnHandlers.get(msg.id);
      if (handler) handler(msg);
    }
  };
  worker.onerror = event => {
    // Surface a worker-level failure to anyone waiting on a warm.
    const message = /** @type {any} */ (event)?.message || 'worker error';
    for (const [model, waiters] of readyWaiters) {
      readyWaiters.set(model, []);
      for (const w of waiters) {
        w.reject(makeError(X`${q(ID)} worker error: ${q(`${message}`)}`));
      }
    }
  };

  return {
    post: (msg, transfer) =>
      transfer ? worker.postMessage(msg, transfer) : worker.postMessage(msg),
    onTurn: (id, handler) => {
      turnHandlers.set(id, handler);
      return () => turnHandlers.delete(id);
    },
    onceReady: model =>
      new Promise((resolve, reject) => {
        const list = readyWaiters.get(model) || [];
        list.push({ resolve, reject });
        readyWaiters.set(model, list);
      }),
    terminate: () => worker.terminate(),
  };
};

// One shared worker host, created lazily on first createSTT/createTTS. Kept for
// the life of the page so models stay resident; never torn down here (the host
// process owns lifecycle and can drop the whole backend).
/** @type {ReturnType<typeof makeWorkerHost> | null} */
let workerHost = null;
const ensureWorker = () => {
  if (!workerHost) workerHost = makeWorkerHost();
  return workerHost;
};

// ── isSupported ──────────────────────────────────────────────────────────────

/** @type {() => Promise<boolean>} */
const isSupported = async () => {
  try {
    return await hasWebGPU();
  } catch {
    return false;
  }
};

// ── STT server ───────────────────────────────────────────────────────────────

const STTServerInterface = M.interface('AudioServer', {
  transcribe: M.call(M.any()).returns(M.remotable()),
  help: M.call().returns(M.string()),
});

/**
 * Pump audio frames from `audioReader` into the worker, re-transcribing the
 * growing buffer on a cadence to emit cumulative (REPLACE) partials, then a
 * final pass at end-of-audio.
 *
 * @param {ReturnType<typeof makeWorkerHost>} host
 * @param {any} audioReader
 * @param {ReturnType<typeof makeTranscriptChannel>['writer']} writer
 * @param {(fn: () => void) => void} setOnClose
 */
const pumpStt = async (host, audioReader, writer, setOnClose) => {
  const id = newTurnId();
  // Accumulate ALL samples of the utterance; partial passes transcribe the whole
  // buffer so far (REPLACE semantics), and the final pass transcribes everything.
  /** @type {Float32Array[]} */
  let chunks = [];
  let totalSamples = 0;
  let samplesSinceLastPartial = 0;
  let aborted = false;
  // Set once the final pass is imminent: it latches partial passes off so a
  // stale partial can never land AFTER the final on the wire.
  let ending = false;
  // Track the in-flight partial pass so we never overlap two transcriptions of
  // the same buffer (Moonshine on a phone GPU can't run them concurrently
  // anyway) and so the final pass can await it before running last.
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let pendingPartial = false;
  let seq = 0;

  const concatBuffer = () => {
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return merged;
  };

  const cancel = reason => {
    if (aborted) return;
    aborted = true;
    host.post({ kind: 'stt-abort', id });
    if (reason !== undefined) writer.abort(reason);
  };

  setOnClose(() => cancel(undefined));

  // Resolve a single transcription pass through the worker.
  const transcribePass = (final = false) =>
    new Promise(resolve => {
      seq += 1;
      const mySeq = seq;
      const off = host.onTurn(id, msg => {
        if (msg.seq !== undefined && msg.seq !== mySeq) return;
        if (msg.kind === 'stt-partial') {
          if (!aborted) writer.partial(msg.text);
          off();
          resolve(undefined);
        } else if (msg.kind === 'stt-final') {
          if (!aborted) writer.final(msg.text);
          off();
          resolve(undefined);
        } else if (msg.kind === 'stt-error') {
          off();
          if (!aborted) cancel(`${msg.message}`);
          resolve(undefined);
        }
      });
      // Send a copy of the buffer (do NOT transfer — we keep accumulating).
      const buf = concatBuffer();
      host.post({ kind: 'stt-transcribe', id, seq: mySeq, pcm: buf, final });
    });

  const maybePartial = async () => {
    // Once ending, never start another partial pass — a late partial resolving
    // after the final would clobber the final transcript (REPLACE semantics).
    if (aborted || ending) return;
    if (inFlight) {
      // A pass is already running; remember to run one more once it settles so
      // the latest audio is reflected, but never queue more than one.
      pendingPartial = true;
      return;
    }
    inFlight = transcribePass(false);
    await inFlight;
    inFlight = null;
    if (pendingPartial && !aborted && !ending) {
      pendingPartial = false;
      await maybePartial();
    }
  };

  try {
    host.post({ kind: 'stt-start', id });
    writer.setPhase('listening');
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await audioReader.next();
      if (done || aborted) break;
      if (value.type === 'bytes') {
        const samples = pcmBase64ToFloat32(value.b64);
        if (samples.length) {
          chunks.push(samples);
          totalSamples += samples.length;
          samplesSinceLastPartial += samples.length;
        }
        if (samplesSinceLastPartial >= PARTIAL_INTERVAL_SAMPLES) {
          samplesSinceLastPartial = 0;
          // Fire-and-forget: a partial pass must not block frame intake.
          // eslint-disable-next-line no-await-in-loop
          maybePartial().catch(() => {});
        }
      } else if (value.type === 'end') {
        break;
      } else if (value.type === 'abort') {
        cancel(value.reason);
        return;
      }
    }
    if (aborted) return;
    // Latch off further partials, then wait for any in-flight partial to settle
    // so the final pass is strictly last on the wire, and transcribe the whole
    // buffer.
    ending = true;
    writer.setPhase('transcribing');
    if (inFlight) await inFlight;
    await transcribePass(true);
    if (!aborted) writer.end();
  } catch (err) {
    cancel(/** @type {Error} */ (err)?.message ?? `${err}`);
  } finally {
    chunks = [];
  }
};

// Return type is `any`, not STTServer: makeExo yields a Guarded exo whose
// method args are Passable, which does not structurally match the STTServer
// reader types (the exo/E() generics friction). The VoiceBackend typedef still
// documents the real STTServer contract.
/** @type {() => Promise<any>} */
const createSTT = async () => {
  const host = ensureWorker();
  // Warm the STT model now so the first utterance doesn't pay load latency.
  // Don't fail createSTT if warm-up rejects (e.g. transient fetch): the first
  // transcribe will retry the load. Just kick it off.
  host.post({ kind: 'stt-warm' });
  host.onceReady('stt').catch(() => {});

  return makeExo('AudioServer', STTServerInterface, {
    transcribe: audioReader => {
      const { writer, reader, setOnClose } = makeTranscriptChannel();
      // pumpStt settles the writer on every path; guard the floating promise so
      // a throw before its try can't surface as an unhandled rejection.
      pumpStt(host, audioReader, writer, setOnClose).catch(() => {});
      return reader;
    },
    help: () =>
      'AudioServer (STT, transformers-webgpu): transcribe(audioReader) -> textReader; ' +
      'Moonshine ASR on WebGPU, streaming REPLACE-semantics partials.',
  });
};

// ── TTS server ───────────────────────────────────────────────────────────────

const TTSServerInterface = M.interface('TtsServer', {
  synthesize: M.call(M.any()).returns(M.remotable()),
  help: M.call().returns(M.string()),
});

/**
 * Read reply text deltas, chunk into sentences, synthesize each in order in the
 * worker, and emit one bytes event per sentence so playback starts mid-reply.
 *
 * @param {ReturnType<typeof makeWorkerHost>} host
 * @param {string} id worker turn id (also used by the onClose abort hook)
 * @param {any} textReader
 * @param {ReturnType<typeof makeAudioOutChannel>['writer']} writer
 * @param {() => boolean} isClosed
 * @param {(cancel: (reason?: string) => void) => void} setCancel
 *   Receives the turn's cancel fn so the channel's onClose hook can abort the
 *   exact in-flight worker turn (not a mismatched id).
 */
const pumpTts = async (host, id, textReader, writer, isClosed, setCancel) => {
  const chunker = makeChunker();
  /** @type {string[]} */
  const queue = [];
  let aborting = false;
  let seq = 0;

  const cancel = reason => {
    if (aborting) return;
    aborting = true;
    host.post({ kind: 'tts-abort', id });
    if (reason !== undefined) writer.abort(reason);
  };
  setCancel(cancel);

  // Synthesize one sentence via the worker and emit its audio bytes.
  const synthOne = sentence =>
    new Promise((resolve, reject) => {
      seq += 1;
      const mySeq = seq;
      const off = host.onTurn(id, msg => {
        if (msg.seq !== mySeq) return;
        if (msg.kind === 'tts-audio') {
          if (!aborting && !isClosed()) {
            writer.bytes(float32ToPcmBase64(msg.pcm), msg.sampleRate);
          }
        } else if (msg.kind === 'tts-done') {
          off();
          resolve(undefined);
        } else if (msg.kind === 'tts-error') {
          off();
          reject(makeError(X`tts synth failed: ${q(`${msg.message}`)}`));
        }
      });
      host.post({ kind: 'tts-synth', id, seq: mySeq, text: sentence });
    });

  // Synthesize queued sentences in arrival order, one at a time so audio plays
  // back in order and we never run two kokoro generations at once.
  const drain = async () => {
    while (queue.length && !aborting && !isClosed()) {
      const sentence = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await synthOne(sentence);
    }
  };

  try {
    writer.setPhase('synthesizing');
    for (;;) {
      if (isClosed()) {
        cancel(undefined);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await textReader.next();
      if (done) break;
      if (value.type === 'delta') {
        for (const s of chunker.push(value.text)) queue.push(s);
        // eslint-disable-next-line no-await-in-loop
        await drain();
      } else if (value.type === 'end') {
        break;
      } else if (value.type === 'abort') {
        cancel(value.reason);
        return;
      }
    }
    for (const s of chunker.finish()) queue.push(s);
    await drain();
    if (!aborting) writer.end();
  } catch (err) {
    cancel(/** @type {Error} */ (err)?.message ?? `${err}`);
  }
};

/** @type {() => Promise<any>} */
const createTTS = async () => {
  const host = ensureWorker();
  // Warm the Kokoro model so the first sentence doesn't pay load latency.
  host.post({ kind: 'tts-warm' });
  host.onceReady('tts').catch(() => {});

  return makeExo('TtsServer', TTSServerInterface, {
    synthesize: textReader => {
      const id = newTurnId();
      // makeAudioOutChannel's onClose aborts the worker turn if the consumer
      // stops pulling (e.g. replay interrupted) so we stop synthesizing audio
      // no one will receive. The hook calls the pump's own cancel (wired via
      // setCancel) so it aborts THIS turn id and marks the pump as aborting.
      let cancelTurn = () => {
        // Until the pump wires its cancel, fall back to a bare worker abort.
        host.post({ kind: 'tts-abort', id });
      };
      const { writer, reader, isClosed } = makeAudioOutChannel(() =>
        cancelTurn(),
      );
      // pumpTts settles the writer on every path; guard the floating promise.
      pumpTts(host, id, textReader, writer, isClosed, cancel => {
        cancelTurn = cancel;
      }).catch(() => {});
      return reader;
    },
    help: () =>
      'TtsServer (transformers-webgpu): synthesize(textReader) -> audioReader; ' +
      'Kokoro-82M on WebGPU, one raw s16le PCM bytes event per sentence.',
  });
};

/** @type {VoiceBackend} */
export const transformersWebGpuBackend = harden({
  id: ID,
  isSupported,
  createSTT,
  createTTS,
});
