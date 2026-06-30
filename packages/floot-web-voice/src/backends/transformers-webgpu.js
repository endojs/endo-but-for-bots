// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND A — transformers-webgpu  (STUB; backend agent A implements this)
// ─────────────────────────────────────────────────────────────────────────────
//
// In-browser STT + TTS on the WebGPU backend via Hugging Face's
// `@huggingface/transformers` (a.k.a. Transformers.js) and `kokoro-js`.
//
// WHAT TO IMPLEMENT
// -----------------
// `isSupported()` — return `await hasWebGPU()` from ../feature-detect.js. You
//   MAY additionally gate on `isCrossOriginIsolated()` if you enable threaded
//   WASM fallbacks, but for the pure-WebGPU path WebGPU presence is the gate.
//   Must never throw; resolve `false` on any unsupported environment.
//
// `createSTT()` — resolve an `STTServer` (see ../types.js) whose
//   `transcribe(audioReader) -> textReader` matches the daemon caplet wire
//   EXACTLY (audio-server-caplet.js):
//     * Build the output channel with `makeTranscriptChannel()` from ../wire.js.
//       Wire its `setOnClose` to abort the in-flight model run when the consumer
//       returns the reader.
//     * Pump the input `audioReader` with `E(audioReader).next()`. Input events:
//       { type:'bytes', b64 } (16 kHz mono s16le PCM, base64) | { type:'end' } |
//       { type:'abort', reason }.
//     * Emit REPLACE-semantics transcript events via the channel writer:
//       setPhase('listening') -> partial(fullTranscriptSoFar) … ->
//       setPhase('transcribing') -> final(fullTranscript) -> end(). On input
//       abort or error: writer.abort(reason).
//     * Model: Whisper-base (`onnx-community/whisper-base` or similar) OR
//       Moonshine (`onnx-community/moonshine-base-ONNX`), `{ device: 'webgpu' }`,
//       streaming partials. Decode base64 PCM to Float32 [-1,1] @ 16 kHz before
//       feeding the pipeline. Wrap the model in a Web Worker (see below).
//
// `createTTS()` — resolve a `TTSServer` whose `synthesize(textReader) ->
//   audioReader` matches the caplet wire EXACTLY (tts-server-caplet.js):
//     * Build the output channel with `makeAudioOutChannel(onClose)` from
//       ../wire.js; `onClose` aborts the worker so it stops synthesizing for a
//       consumer that left.
//     * Pump the input `textReader`. Input events (APPEND deltas):
//       { type:'delta', text } | { type:'end' } | { type:'abort', reason }.
//     * Sentence-chunk the accumulated deltas (port tts-server-caplet.js's
//       chunker, or reuse a shared one) and synthesize chunk-by-chunk so audio
//       starts mid-reply. Emit one writer.bytes(b64, sampleRate) per sentence
//       (raw s16le mono PCM, base64), then writer.end(). On abort: writer.abort.
//     * Model: Kokoro-82M via `kokoro-js` (`KokoroTTS.from_pretrained(
//       'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype, device: 'webgpu' })`).
//       Convert kokoro's Float32 output to s16le PCM bytes + base64 before
//       emitting, and report kokoro's sample rate (24 kHz) on each bytes event.
//
// WEB WORKER
// ----------
// Run all model load + inference in a dedicated Web Worker, never on the main
// thread — model compile and per-frame inference will jank the UI otherwise.
// The STTServer/TTSServer exos live on the main thread and post messages to the
// worker; the channel writers (from ../wire.js) marshal worker results onto the
// CapTP wire. Load the model once and warm it; keep it resident across turns.
//
// MODEL CACHING
// -------------
// Transformers.js caches downloaded weights in the Cache API by default; ensure
// it is enabled (or wire OPFS) so the large weights download only once. See the
// package README "Model caching" section.
//
// NPM DEPS TO ADD (to this package's package.json `dependencies`)
// ---------------------------------------------------------------
//   @huggingface/transformers   — Whisper/Moonshine STT pipeline + WebGPU
//   kokoro-js                    — Kokoro-82M TTS
//   onnxruntime-web              — (transitive via the above; pin if needed for
//                                  the WebGPU/WASM execution providers)
// The lockfile update is a separate follow-up commit.

import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';

// These are the helpers backend A must build its servers on. Imported here so
// the stub fails to load loudly if they are ever renamed (and so the agent sees
// the exact import paths). They are intentionally unused until implemented.
// eslint-disable-next-line no-unused-vars
import {
  makeAudioOutChannel,
  makeTranscriptChannel,
} from '../wire.js';

/** @import { STTServer, TTSServer, VoiceBackend } from '../types.js' */

const ID = 'transformers-webgpu';

const notImplemented = method =>
  makeError(
    X`@endo/floot-web-voice backend ${q(ID)} ${q(
      method,
    )} is not yet implemented`,
  );

/** @type {() => Promise<boolean>} */
const isSupported = async () => {
  // TODO(backend A): return `await hasWebGPU()` (and optionally gate on
  // cross-origin isolation). Must never throw.
  return false;
};

/** @type {() => Promise<STTServer>} */
const createSTT = async () => {
  throw notImplemented('createSTT');
};

/** @type {() => Promise<TTSServer>} */
const createTTS = async () => {
  throw notImplemented('createTTS');
};

/** @type {VoiceBackend} */
export const transformersWebGpuBackend = harden({
  id: ID,
  isSupported,
  createSTT,
  createTTS,
});
