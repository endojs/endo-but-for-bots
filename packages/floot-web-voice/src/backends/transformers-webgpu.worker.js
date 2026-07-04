// @ts-check
/* eslint-env worker */
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND A — transformers-webgpu  (Web Worker)
// ─────────────────────────────────────────────────────────────────────────────
//
// This module runs inside a dedicated Web Worker (module type), instantiated by
// transformers-webgpu.js with:
//
//   new Worker(new URL('./transformers-webgpu.worker.js', import.meta.url),
//              { type: 'module' });
//
// It is where ALL heavy work happens: model download + WebGPU compile + every
// STT / TTS inference. The main-thread STTServer / TTSServer exos never touch
// the model libraries — they only postMessage frames/text in and map result
// messages back onto the CapTP wire channels. This keeps model compile and
// per-inference latency off the UI thread (and off the CapTP event loop).
//
// IMPORTANT: This file deliberately imports the heavy model libraries
// (`@huggingface/transformers`, `kokoro-js`). It must therefore ONLY ever be
// loaded as a Worker — never imported from the main thread, and never from a
// node test. The main-thread backend (transformers-webgpu.js) is the only thing
// that references it, and only via `new Worker(new URL(...))`, which the bundler
// turns into a separate chunk. node tests cover the pure helpers (PCM/base64
// conversion, the sentence chunker) without importing this module.
//
// SES NOTE: like the rest of @endo/floot-web-voice this is HOST-side browser
// code, NOT a confined SES worker, so `harden` is not a global. We do not import
// `@endo/init` / `ses` here either — doing so inside a Worker that the libraries
// expect to mutate (transformers.js patches its env) would break them. This
// module is plain module-worker JS.
//
// ── Wire protocol with the main thread ──────────────────────────────────────
//
// Messages IN (main -> worker), each `{ kind, id, ... }` where `id` scopes a
// single transcribe()/synthesize() turn:
//   { kind:'stt-warm' }                              — preload + warm STT model
//   { kind:'tts-warm' }                              — preload + warm TTS model
//   { kind:'stt-start', id }                         — begin an utterance
//   { kind:'stt-transcribe', id, seq, pcm:Float32Array, final:boolean }
//        — transcribe the WHOLE accumulated buffer the main thread sends. The
//          main thread owns the growing buffer and re-sends it on a cadence for
//          partials, and once more with `final:true` at end-of-audio. Decoding
//          base64 PCM -> Float32 happens on the main thread.
//   { kind:'stt-abort', id }                         — cancel the utterance
//   { kind:'tts-synth', id, seq, text }              — synthesize one sentence
//   { kind:'tts-abort', id }                         — cancel a synth turn
//
// Messages OUT (worker -> main):
//   { kind:'ready', model:'stt'|'tts' }              — warm complete
//   { kind:'stt-partial', id, text }                 — cumulative transcript
//   { kind:'stt-final',   id, text }                 — final transcript
//   { kind:'stt-error',   id, seq, message }
//   { kind:'tts-audio',   id, seq, pcm:Float32Array, sampleRate }
//   { kind:'tts-done',    id, seq }                  — that sentence finished
//   { kind:'tts-error',   id, seq, message }
//   { kind:'error', model, message }                 — warm/load failure
//
// Float32 sample buffers are passed by transfer where possible to avoid copies.

import { KokoroTTS } from 'kokoro-js';
import { pipeline } from '@huggingface/transformers';

// ── Configuration ───────────────────────────────────────────────────────────
//
// STT: Moonshine base. Chosen over Whisper because (a) it is the same engine
// family as the server-side moonshine caplet (engine parity with the daemon
// path this package mirrors), and (b) it is markedly lighter / lower-latency
// than Whisper-base, which matters for the every-~500 ms re-transcription cadence
// of the streaming-partials approach on a phone GPU. `onnx-community/moonshine-
// base-ONNX` ships the WebGPU-friendly ONNX weights transformers.js expects.
const STT_MODEL = 'onnx-community/moonshine-base-ONNX';
// fp32 is the safest default for Moonshine's encoder/decoder on WebGPU; q4/fp16
// can be selected later if accuracy holds. transformers.js accepts a per-module
// dtype map, but a single dtype keeps the warm path simple.
const STT_DTYPE = 'fp32';

// TTS: Kokoro-82M v1.0 ONNX via kokoro-js. q8 keeps the weights small for a
// phone while staying intelligible; fp16 is the higher-quality alternative on a
// flagship GPU. Kokoro emits 24 kHz mono Float32.
const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const TTS_DTYPE = 'q8';
const TTS_VOICE = 'af_heart';

// ── STT model singleton (resident across turns) ─────────────────────────────

/** @type {Promise<any> | null} */
let sttPipelinePromise = null;
// Per-turn abort flags so a finished/aborted turn's late inference is dropped.
/** @type {Set<string>} */
const sttAborted = new Set();

const loadStt = () => {
  if (!sttPipelinePromise) {
    // transformers.js caches downloaded weights in the browser Cache API by
    // default, so this network fetch happens only on the very first run; later
    // worker starts read from cache. (OPFS is an alternative we could wire via
    // `env.useFSCache`, but the default Cache API is sufficient and automatic.)
    sttPipelinePromise = pipeline('automatic-speech-recognition', STT_MODEL, {
      device: 'webgpu',
      dtype: STT_DTYPE,
    }).catch(err => {
      // Reset so a later warm can retry rather than re-rejecting forever.
      sttPipelinePromise = null;
      throw err;
    });
  }
  return sttPipelinePromise;
};

// Run ASR over the accumulated buffer and return the full transcript so far.
// transformers.js's ASR pipeline does not expose true frame-streaming partials,
// so streaming partials are produced by the MAIN THREAD re-invoking us over the
// growing buffer on a cadence; here we just transcribe whatever buffer we are
// handed. The cumulative output matches the transcript wire's REPLACE semantics.
/**
 * @param {Float32Array} samples normalized [-1,1] @ 16 kHz mono
 * @returns {Promise<string>}
 */
const transcribeBuffer = async samples => {
  const asr = await loadStt();
  // Moonshine / Whisper pipelines accept a raw Float32Array @ 16 kHz directly.
  const out = await asr(samples);
  const text = Array.isArray(out)
    ? out.map(o => o?.text ?? '').join(' ')
    : (out?.text ?? '');
  return `${text}`.trim();
};

// ── TTS model singleton (resident across turns) ─────────────────────────────

/** @type {Promise<any> | null} */
let ttsPromise = null;
/** @type {Set<string>} */
const ttsAborted = new Set();

const loadTts = () => {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(TTS_MODEL, {
      dtype: TTS_DTYPE,
      device: 'webgpu',
    }).catch(err => {
      ttsPromise = null;
      throw err;
    });
  }
  return ttsPromise;
};

/**
 * @param {string} text one speakable sentence
 * @returns {Promise<{ pcm: Float32Array, sampleRate: number }>}
 */
const synthSentence = async text => {
  const tts = await loadTts();
  // kokoro-js returns a RawAudio-like object: { audio: Float32Array,
  // sampling_rate: number }. `generate` is the single-shot API; a streaming
  // splitter exists but we already chunk by sentence on the main thread.
  const result = await tts.generate(text, { voice: TTS_VOICE });
  const pcm = result?.audio ?? result;
  const sampleRate = result?.sampling_rate ?? 24_000;
  return { pcm, sampleRate };
};

// ── Message dispatch ─────────────────────────────────────────────────────────

const post = (msg, transfer) => {
  // @ts-expect-error — DedicatedWorkerGlobalScope.postMessage in a worker.
  self.postMessage(msg, transfer || []);
};

// @ts-expect-error — `self` is the worker global; `onmessage` is the entry.
self.onmessage = async event => {
  const data = event?.data;
  if (!data || typeof data !== 'object') return;
  const { kind, id } = data;

  switch (kind) {
    case 'stt-warm': {
      try {
        const asr = await loadStt();
        // Warm with a short silence buffer so the first real utterance does not
        // pay the WebGPU shader-compile / kernel-warm cost.
        await asr(new Float32Array(16_000));
        post({ kind: 'ready', model: 'stt' });
      } catch (err) {
        post({ kind: 'error', model: 'stt', message: messageOf(err) });
      }
      return;
    }

    case 'tts-warm': {
      try {
        await loadTts();
        // A tiny warm utterance compiles the kokoro graph ahead of the reply.
        await synthSentence('Ready.');
        post({ kind: 'ready', model: 'tts' });
      } catch (err) {
        post({ kind: 'error', model: 'tts', message: messageOf(err) });
      }
      return;
    }

    case 'stt-start': {
      sttAborted.delete(id);
      return;
    }

    case 'stt-transcribe': {
      // The main thread owns the accumulating buffer and sends the full buffer
      // it wants transcribed (a partial pass, or the final pass when `final`).
      if (sttAborted.has(id)) return;
      try {
        const text = await transcribeBuffer(data.pcm);
        if (sttAborted.has(id)) return;
        post({
          kind: data.final ? 'stt-final' : 'stt-partial',
          id,
          seq: data.seq,
          text,
        });
      } catch (err) {
        if (sttAborted.has(id)) return;
        post({ kind: 'stt-error', id, seq: data.seq, message: messageOf(err) });
      }
      return;
    }

    case 'stt-abort': {
      sttAborted.add(id);
      return;
    }

    case 'tts-synth': {
      if (ttsAborted.has(id)) return;
      try {
        const { pcm, sampleRate } = await synthSentence(data.text);
        if (ttsAborted.has(id)) return;
        // Transfer the PCM buffer to avoid a structured-clone copy of audio.
        post(
          { kind: 'tts-audio', id, seq: data.seq, pcm, sampleRate },
          pcm?.buffer ? [pcm.buffer] : [],
        );
        post({ kind: 'tts-done', id, seq: data.seq });
      } catch (err) {
        if (ttsAborted.has(id)) return;
        post({ kind: 'tts-error', id, seq: data.seq, message: messageOf(err) });
      }
      return;
    }

    case 'tts-abort': {
      ttsAborted.add(id);
      return;
    }

    default:
      // Unknown message kind — ignore (forward-compat with the main thread).
  }
};

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : `${err}`;
}
