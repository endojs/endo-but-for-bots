// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// BACKEND B — onnx-piper-moonshine  (STUB; backend agent B implements this)
// ─────────────────────────────────────────────────────────────────────────────
//
// In-browser STT + TTS via `onnxruntime-web` (ORT), keeping ENGINE PARITY with
// the server-side caplets: Moonshine for STT (same model family as
// audio-server-caplet.js's moonshine subprocess) and Piper for TTS (the same
// .onnx voices tts-server-caplet.js drives via the piper binary). Running the
// identical models in-browser keeps transcripts and voice consistent between
// the local and remote paths.
//
// EXECUTION PROVIDER
// ------------------
// Prefer the ORT WebGPU execution provider; fall back to the WASM EP (SIMD +
// threads) when WebGPU is unavailable. Threaded WASM requires cross-origin
// isolation (SharedArrayBuffer) — see `isCrossOriginIsolated()` and the README.
//
// WHAT TO IMPLEMENT
// -----------------
// `isSupported()` — resolve `true` when EITHER `await hasWebGPU()` OR
//   (`hasWasmSimd()` is true) — i.e. any usable ORT execution provider exists.
//   For the fastest threaded WASM fallback you also want
//   `isCrossOriginIsolated()`, but single-threaded WASM still works without it,
//   so do not hard-require it here. Must never throw.
//
// `createSTT()` — resolve an `STTServer` (see ../types.js) whose
//   `transcribe(audioReader) -> textReader` matches audio-server-caplet.js's
//   wire EXACTLY:
//     * Build the output channel with `makeTranscriptChannel()` from ../wire.js;
//       wire `setOnClose` to abort the in-flight ORT run.
//     * Input events: { type:'bytes', b64 } (16 kHz mono s16le PCM, base64) |
//       { type:'end' } | { type:'abort', reason }. Decode base64 -> Float32
//       [-1,1] @ 16 kHz for the Moonshine encoder/decoder ORT sessions.
//     * Emit REPLACE-semantics events: setPhase('listening') ->
//       partial(fullSoFar) … -> setPhase('transcribing') -> final(full) ->
//       end(); writer.abort(reason) on input abort/error.
//     * Model: Moonshine ONNX (tiny/base), e.g. the `UsefulSensors/moonshine`
//       ONNX export. Run encoder + autoregressive decoder ORT sessions.
//
// `createTTS()` — resolve a `TTSServer` whose `synthesize(textReader) ->
//   audioReader` matches tts-server-caplet.js's wire EXACTLY:
//     * Build the output channel with `makeAudioOutChannel(onClose)` from
//       ../wire.js; `onClose` aborts the worker.
//     * Input events (APPEND deltas): { type:'delta', text } | { type:'end' } |
//       { type:'abort', reason }. Sentence-chunk (port the caplet's chunker) and
//       synthesize chunk-by-chunk.
//     * Emit one writer.bytes(b64, sampleRate) per sentence (raw s16le mono PCM,
//       base64), then writer.end(); writer.abort on error.
//     * Model: a Piper voice .onnx + companion .onnx.json (phoneme/audio config)
//       run under ORT. Port the phonemization + inference Piper does natively
//       (piper-phonemize / eSpeak NG phonemes) and read `audio.sample_rate` from
//       the voice's .onnx.json config for the bytes events.
//
// WEB WORKER + CACHING
// --------------------
// Run all ORT sessions in a Web Worker (model compile + inference must stay off
// the main thread). Set `ort.env.wasm.numThreads`, `ort.env.wasm.simd`, and the
// `wasmPaths`/proxy options for the worker. Fetch the .onnx weights + Piper
// config once and persist them (Cache API or OPFS) — see the README "Model
// caching" section. The STT/TTS exos live on the main thread and bridge to the
// worker; channel writers (../wire.js) marshal results onto CapTP.
//
// NPM DEPS TO ADD (to this package's package.json `dependencies`)
// ---------------------------------------------------------------
//   onnxruntime-web   — Moonshine ONNX STT + Piper .onnx TTS (WebGPU + WASM EPs)
//   (phonemizer)      — a browser eSpeak-NG / piper-phonemize for Piper text->
//                       phonemes, e.g. `phonemizer` or a wasm espeak-ng build
// The lockfile update is a separate follow-up commit.

import { makeError, q, X } from '@endo/errors';
import harden from '@endo/harden';

// The helpers backend B must build its servers on; imported so the stub fails
// loudly if they are renamed and so the agent sees the exact import paths.
// eslint-disable-next-line no-unused-vars
import {
  makeAudioOutChannel,
  makeTranscriptChannel,
} from '../wire.js';

/** @import { STTServer, TTSServer, VoiceBackend } from '../types.js' */

const ID = 'onnx-piper-moonshine';

const notImplemented = method =>
  makeError(
    X`@endo/floot-web-voice backend ${q(ID)} ${q(
      method,
    )} is not yet implemented`,
  );

/** @type {() => Promise<boolean>} */
const isSupported = async () => {
  // TODO(backend B): resolve true when a usable ORT execution provider exists
  // (WebGPU or WASM+SIMD). Must never throw.
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
export const onnxPiperMoonshineBackend = harden({
  id: ID,
  isSupported,
  createSTT,
  createTTS,
});
