// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND B — onnx-piper-moonshine
// ─────────────────────────────────────────────────────────────────────────────
//
// In-browser STT + TTS via `onnxruntime-web` (ORT), keeping ENGINE PARITY with
// the server-side caplets: Moonshine for STT (same model family as
// audio-server-caplet.js's moonshine subprocess) and Piper for TTS (the same
// .onnx voices tts-server-caplet.js drives via the piper binary). Running the
// identical models in-browser keeps transcripts and voice consistent between
// the local and remote paths.
//
// This module is the MAIN-THREAD half: the STTServer / TTSServer exos plus the
// pure-logic helpers (PCM/base64 conversion, the ported sentence chunker, and
// the Piper phoneme-id mapping — all unit-testable in node without ORT). All
// model load + inference happens in onnx-piper-moonshine.worker.js, which this
// module instantiates and bridges to. The channel writers from ../wire.js
// marshal the worker's results onto the CapTP wire.
//
// EXECUTION PROVIDER: the worker configures ORT to prefer the 'webgpu' EP with
// a 'wasm' fallback. Threaded WASM needs cross-origin isolation; single-threaded
// WASM works without it (see ../feature-detect.js and the README).

import { E } from '@endo/eventual-send';
import { makeError, X, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

import { hasWasmSimd, hasWebGPU } from '../feature-detect.js';
import { makeAudioOutChannel, makeTranscriptChannel } from '../wire.js';

/** @import { STTServer, TTSServer, VoiceBackend } from '../types.js' */

const ID = 'onnx-piper-moonshine';

// Cadence (ms) at which we re-run Moonshine over the accumulated buffer to emit
// a fresh cumulative partial while the user is still speaking. Cheap enough on a
// flagship Android GPU; coarse enough not to starve inference.
const PARTIAL_INTERVAL_MS = 700;

// `transcribe` / `synthesize` are synchronous (return the output reader
// immediately, then stream), so they are guarded with `M.call`. Guards mirror
// the daemon caplets' permissive shape.
const AudioServerInterface = M.interface('AudioServer', {
  transcribe: M.call(M.any()).returns(M.remotable()),
  help: M.call().returns(M.string()),
});

const TtsServerInterface = M.interface('TtsServer', {
  synthesize: M.call(M.any()).returns(M.remotable()),
  help: M.call().returns(M.string()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic — exported so the worker can reuse it and so node tests can cover
// it WITHOUT importing onnxruntime-web. Keep this block free of ORT imports.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Float32 audio in [-1, 1] -> little-endian s16 PCM bytes.
 *
 * @param {Float32Array} float
 * @returns {Uint8Array}
 */
export const floatToPcm16 = float => {
  const out = new Uint8Array(float.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < float.length; i += 1) {
    let s = float[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Asymmetric int16 range: scale by 0x7fff for +, 0x8000 for -.
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
};
harden(floatToPcm16);

/**
 * base64 of 16-bit LE PCM -> normalized Float32 in [-1, 1].
 *
 * @param {string} b64
 * @returns {Float32Array}
 */
export const pcmBase64ToFloat = b64 => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const frames = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
};
harden(pcmBase64ToFloat);

/**
 * Uint8Array -> base64 (chunked to avoid call-stack limits on big buffers).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const bytesToBase64 = bytes => {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};
harden(bytesToBase64);

// Piper interleaves a pad id (the id of `_`) BETWEEN every symbol and wraps the
// sequence with BOS (`^`) and EOS (`$`). Multi-codepoint IPA phonemes map
// per-codepoint via the voice's phoneme_id_map.
const PIPER_PAD = '_';
const PIPER_BOS = '^';
const PIPER_EOS = '$';

/**
 * Build Piper input ids from IPA phoneme text and the voice's phoneme_id_map.
 *
 * @param {string} phonemeText IPA string from espeak-ng.
 * @param {Record<string, number[]>} phonemeIdMap symbol -> id list.
 * @returns {number[]}
 */
export const phonemesToIds = (phonemeText, phonemeIdMap) => {
  const idOf = sym => {
    const ids = phonemeIdMap[sym];
    return ids && ids.length ? ids[0] : undefined;
  };
  const padId = idOf(PIPER_PAD);
  const bosId = idOf(PIPER_BOS);
  const eosId = idOf(PIPER_EOS);
  /** @type {number[]} */
  const ids = [];
  const pushPad = () => {
    if (padId !== undefined) ids.push(padId);
  };
  if (bosId !== undefined) ids.push(bosId);
  pushPad();
  // Iterate by Unicode code point so multi-byte IPA symbols map correctly.
  for (const sym of Array.from(phonemeText)) {
    const id = idOf(sym);
    if (id === undefined) continue; // eslint-disable-line no-continue
    ids.push(id);
    pushPad();
  }
  if (eosId !== undefined) ids.push(eosId);
  return ids;
};
harden(phonemesToIds);

// ─────────────────────────────────────────────────────────────────────────────
// Sentence chunker — ported verbatim from tts-server-caplet.js (the caplets are
// deliberately self-contained; we do the same so the in-browser TTS chunks
// reply text into the SAME sentence boundaries as the server path).
// ─────────────────────────────────────────────────────────────────────────────

const MIN_CHUNK_LENGTH = 10;
const ABBREVIATIONS = harden(
  new Set(['St', 'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'vs', 'etc', 'Jr', 'Sr']),
);

/**
 * Strip the markdown that would otherwise be read aloud as punctuation noise.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripMarkdown = text =>
  `${text}`
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1') // bold/italic
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, ''); // bullet markers
harden(stripMarkdown);

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
 * Incremental sentence chunker. `push(text)` returns complete sentences ready to
 * synthesize; `finish()` flushes the tail. Identical behavior to the caplet.
 *
 * @returns {{ push: (text: string) => string[], finish: () => string[] }}
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

// ─────────────────────────────────────────────────────────────────────────────
// Worker bridge. One resident Web Worker holds the ORT sessions; we post
// requests with a monotonic id and resolve the matching reply. Abort is
// cooperative: we post an `abort` keyed on the in-flight request id.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} [cfg] backend configuration forwarded to the worker (model
 *   URLs, wasmPaths). Defaults live in the worker.
 */
const makeWorkerBridge = (cfg = {}) => {
  const worker = new Worker(
    new URL('./onnx-piper-moonshine.worker.js', import.meta.url),
    { type: 'module' },
  );
  let nextId = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>} */
  const pending = new Map();

  worker.onmessage = event => {
    const { id, type, message, ...rest } = event.data || {};
    const slot = pending.get(id);
    if (!slot) return;
    pending.delete(id);
    if (type === 'error') slot.reject(makeError(X`worker: ${q(message)}`));
    else slot.resolve(rest);
  };
  worker.onerror = event => {
    const err = makeError(X`voice worker crashed: ${q(event.message)}`);
    for (const slot of pending.values()) slot.reject(err);
    pending.clear();
  };

  /**
   * @param {string} type
   * @param {object} [payload]
   * @param {Transferable[]} [transfer]
   * @returns {{ id: number, done: Promise<any> }}
   */
  const request = (type, payload = {}, transfer = []) => {
    const id = nextId;
    nextId += 1;
    const done = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    worker.postMessage({ type, id, ...payload }, transfer);
    return { id, done };
  };

  return harden({
    cfg,
    init: () => request('init', { cfg }).done,
    warm: which => request('warm', { which, cfg }).done,
    request,
    abort: targetId => {
      worker.postMessage({ type: 'abort', id: nextId, targetId });
      nextId += 1;
    },
    terminate: () => {
      worker.terminate();
      pending.clear();
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// isSupported — ORT runs on plain WASM, so any usable EP suffices. Prefer
// WebGPU when present; accept WASM+SIMD otherwise. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {() => Promise<boolean>} */
const isSupported = async () => {
  try {
    if (typeof Worker === 'undefined') return false;
    // WebGPU is the fast path, but WASM+SIMD is a fully usable fallback.
    if (await hasWebGPU()) return true;
    return hasWasmSimd();
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STT pump — drain audioReader, accumulate Float32, re-run Moonshine on a
// cadence for cumulative partials, finalize on end. REPLACE semantics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof makeWorkerBridge>} bridge
 * @param {any} audioReader
 * @param {ReturnType<typeof makeTranscriptChannel>['writer']} writer
 * @param {(fn: () => void) => void} setOnClose
 */
const pumpStt = async (bridge, audioReader, writer, setOnClose) => {
  /** @type {Float32Array[]} */
  let buffers = [];
  let totalLen = 0;
  let cancelled = false;
  /** @type {number | null} */
  let inflightId = null;

  setOnClose(() => {
    cancelled = true;
    if (inflightId !== null) bridge.abort(inflightId);
  });

  const concatSamples = () => {
    const all = new Float32Array(totalLen);
    let offset = 0;
    for (const b of buffers) {
      all.set(b, offset);
      offset += b.length;
    }
    return all;
  };

  // Re-run Moonshine over everything accumulated so far -> cumulative partial.
  const transcribeSoFar = async emit => {
    if (cancelled || totalLen === 0) return '';
    const samples = concatSamples();
    const { id, done } = bridge.request('stt', { samples }, [samples.buffer]);
    inflightId = id;
    try {
      const { text } = await done;
      if (!cancelled && text) emit(text);
      return text || '';
    } finally {
      if (inflightId === id) inflightId = null;
    }
  };

  try {
    writer.setPhase('listening');
    let lastPartialAt = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await E(audioReader).next();
      if (done) break;
      if (value.type === 'bytes') {
        const float = pcmBase64ToFloat(value.b64);
        buffers.push(float);
        totalLen += float.length;
        const now = Date.now();
        if (now - lastPartialAt >= PARTIAL_INTERVAL_MS) {
          lastPartialAt = now;
          // eslint-disable-next-line no-await-in-loop
          await transcribeSoFar(text => writer.partial(text));
        }
      } else if (value.type === 'end') {
        break;
      } else if (value.type === 'abort') {
        cancelled = true;
        if (inflightId !== null) bridge.abort(inflightId);
        writer.abort(value.reason);
        return;
      }
    }
    if (cancelled) return;
    writer.setPhase('transcribing');
    const final = await transcribeSoFar(() => {});
    writer.final(final);
    writer.end();
  } catch (err) {
    if (inflightId !== null) bridge.abort(inflightId);
    writer.abort(/** @type {Error} */ (err)?.message || String(err));
  } finally {
    buffers = [];
    totalLen = 0;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TTS pump — drain textReader, sentence-chunk, synthesize each in order, emit
// one bytes event per sentence. APPEND deltas.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<typeof makeWorkerBridge>} bridge
 * @param {any} textReader
 * @param {ReturnType<typeof makeAudioOutChannel>['writer']} writer
 * @param {() => boolean} isClosed
 */
const pumpTts = async (bridge, textReader, writer, isClosed, setCancel) => {
  const chunker = makeChunker();
  /** @type {string[]} */
  const queue = [];
  let aborting = false;
  // Worker request id of the sentence currently synthesizing, so a
  // consumer-close can abort THAT in-flight request instead of letting it run
  // to completion with no one to receive the audio.
  /** @type {number | null} */
  let currentId = null;

  const cancel = reason => {
    if (aborting) return;
    aborting = true;
    if (currentId !== null) bridge.abort(currentId);
    if (reason !== undefined) writer.abort(reason);
  };
  // createTTS wires the channel's onClose to this so stopping playback (barge-in
  // / replay interrupt) halts synthesis, not just pauses between sentences.
  if (setCancel) setCancel(cancel);

  writer.setPhase('synthesizing');

  const drain = async () => {
    while (queue.length && !aborting && !isClosed()) {
      const sentence = queue.shift();
      const req = bridge.request('tts', { sentence });
      currentId = req.id;
      // eslint-disable-next-line no-await-in-loop
      const { b64, sampleRate } = await req.done;
      currentId = null;
      if (aborting || isClosed()) return;
      if (b64) writer.bytes(b64, sampleRate);
    }
  };

  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await E(textReader).next();
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
    cancel(/** @type {Error} */ (err)?.message || String(err));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// createSTT / createTTS — stand up a worker, warm the resident session, return
// the exo. The exo's transcribe/synthesize return the output reader
// synchronously, then the pump streams into it.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {() => Promise<STTServer>} */
const createSTT = async () => {
  const bridge = makeWorkerBridge();
  await bridge.init();
  // Warm at stand-up so the first utterance doesn't pay model-load latency (the
  // server caplet warms moonshine the same way). Best-effort — a warm failure
  // still lets the first real run surface the error.
  await bridge.warm('stt').catch(() => {});

  return makeExo('AudioServer', AudioServerInterface, {
    transcribe: audioReader => {
      const { writer, reader, setOnClose } = makeTranscriptChannel();
      // pump settles the writer on every path; guard the floating promise so a
      // throw before its try can't surface as an unhandled rejection.
      pumpStt(bridge, audioReader, writer, setOnClose).catch(() => {});
      return reader;
    },
    help: () =>
      'AudioServer (STT, onnx-piper-moonshine): transcribe(audioReader) -> textReader; Moonshine ONNX via onnxruntime-web (WebGPU/WASM). Streams replace-style transcript events (phase/partial/final/end/abort).',
  });
};

/** @type {() => Promise<TTSServer>} */
const createTTS = async () => {
  const bridge = makeWorkerBridge();
  await bridge.init();
  await bridge.warm('tts').catch(() => {});

  return makeExo('TtsServer', TtsServerInterface, {
    synthesize: textReader => {
      // onClose fires when the consumer stops pulling (barge-in / replay
      // interrupt); wire it to the pump's cancel so we abort the in-flight
      // sentence. pumpTts replaces cancelTurn synchronously via setCancel before
      // this returns, so the hook can never fire into the no-op.
      let cancelTurn = () => {};
      const { writer, reader, isClosed } = makeAudioOutChannel(() =>
        cancelTurn(),
      );
      pumpTts(bridge, textReader, writer, isClosed, cancel => {
        cancelTurn = cancel;
      }).catch(() => {});
      return reader;
    },
    help: () =>
      'TtsServer (onnx-piper-moonshine): synthesize(textReader) -> audioReader; Piper .onnx voice via onnxruntime-web with espeak-ng phonemization. Streams raw s16le PCM bytes (one event per sentence).',
  });
};

/** @type {VoiceBackend} */
export const onnxPiperMoonshineBackend = harden({
  id: ID,
  isSupported,
  createSTT,
  createTTS,
});
