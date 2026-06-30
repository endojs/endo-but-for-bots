# @endo/floot-web-voice

Browser-side (WASM / WebGPU) speech-to-text and text-to-speech servers for
Floot.
This package is the shared foundation that lets a capable client run the voice
models **locally**, replacing the server-side voice caplets
(`audio-server-caplet.js` / `tts-server-caplet.js`) for clients that can run the
models in-browser.

It ships:

- the **contract** (`src/types.js`) every backend codes against,
- the **stream-wire helpers** (`src/wire.js`) that bridge model output onto
  CapTP,
- **feature detection** (`src/feature-detect.js`),
- a **backend selector** (`src/index.js`), and
- two **backend stubs** (`src/backends/`) the next two agents fill in.

It does **not** implement model inference.

## This is HOST-side code

These servers run on the **host** side of the chat app, alongside
`packages/chat/floot-component.js` — the wrapper that owns CapTP resolution, the
mic capture loop, and TTS playback.
They are **not** part of the confined Preact view (`@endo/space-floot`), which
never touches audio handles or capabilities.

Because this runs host-side in the browser, `harden` is **not** a SES global
here.
Every module imports it explicitly (`import harden from '@endo/harden'`), exactly
as `floot-component.js` does.

## The contract

A backend is a `VoiceBackend`:

```js
/** @typedef {{
 *   id: string,
 *   isSupported: () => Promise<boolean>,
 *   createSTT: () => Promise<STTServer>,
 *   createTTS: () => Promise<TTSServer>,
 * }} VoiceBackend */
```

The two servers mirror the daemon caplets' exos exactly, so a host can call
either a local or a remote implementation the same way:

```js
/** @typedef {{
 *   transcribe: (audioReader) => TranscriptReader,  // STT
 *   help: () => string,
 * }} STTServer */

/** @typedef {{
 *   synthesize: (textReader) => TtsAudioReader,      // TTS
 *   help: () => string,
 * }} TTSServer */
```

Both methods are synchronous: they return the output reader immediately, then
stream events into it.

### Wire vocabularies (copied exactly from the caplets)

These are identical to `audio-server-caplet.js` and `tts-server-caplet.js`, so
the local and remote paths are interchangeable from the caller's view.

STT input (`audioReader`) — 16 kHz mono s16le PCM, base64:

```
{ type:'bytes', b64 } | { type:'end' } | { type:'abort', reason }
```

STT output (`textReader`) — REPLACE semantics; `text` is always the full
transcript so far (recognizer partials are cumulative and revise earlier words):

```
{ type:'phase', phase } | { type:'partial', text } | { type:'final', text }
  | { type:'end' } | { type:'abort', reason }
```

TTS input (`textReader`) — APPEND deltas (the streaming LLM reply); for replay,
feed the whole text as one delta then `end`:

```
{ type:'delta', text } | { type:'end' } | { type:'abort', reason }
```

TTS output (`audioReader`) — one `bytes` event per sentence, raw s16le mono PCM
base64 at `sampleRate` Hz, so playback starts mid-reply with no decode hop:

```
{ type:'phase', phase } | { type:'bytes', b64, sampleRate }
  | { type:'end' } | { type:'abort', reason }
```

### Stream-wire helpers (`src/wire.js`)

Build your output readers on these instead of hand-rolling the buffer / wake /
park loop.
Import paths the backends use:

```js
import {
  makeAudioOutChannel,
  makeTranscriptChannel,
} from '../wire.js'; // from inside src/backends/
```

- `makeTranscriptChannel()` -> `{ writer, reader, setOnClose }` for STT output.
  `writer` has `setPhase`, `partial`, `final`, `end`, `abort` (REPLACE
  semantics).
  Wire `setOnClose` to abort the in-flight model run when the consumer returns
  the reader.
- `makeAudioOutChannel(onClose)` -> `{ writer, reader, isClosed }` for TTS
  output.
  `writer` has `setPhase`, `bytes(b64, sampleRate)`, `end`, `abort`.
  `onClose` fires when the consumer stops pulling, so you can abort synthesis.
- `makeBufferedReader(name, { onClose })` is the generic primitive both layer
  on.

## Cross-origin isolation requirement

For the fastest WASM paths (multi-threaded ONNX Runtime / Transformers.js) and
for `SharedArrayBuffer`, the page **must be cross-origin isolated**.
That means the document is served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

When these headers are present, `globalThis.crossOriginIsolated === true` (see
`isCrossOriginIsolated()`).

**What breaks without it:**

- `SharedArrayBuffer` is unavailable, so threaded WASM cannot be instantiated.
- ONNX Runtime / Transformers.js silently fall back to **single-threaded** WASM,
  which is dramatically slower (often several × slower per inference).
- Any cross-origin sub-resource (e.g. model weights from a CDN) must itself send
  `Cross-Origin-Resource-Policy: cross-origin` (or be same-origin), or it will
  be blocked under `require-corp`.

The pure-WebGPU path does not strictly require isolation, but enabling it is
recommended for the WASM fallback and for any threaded pre/post-processing.

## Model caching

The model weights are **large** (tens to hundreds of MB per model), so download
them **once** and cache them:

- **Transformers.js** caches weights in the **Cache API** by default — keep that
  enabled.
- For ONNX Runtime, fetch the `.onnx` weights (and Piper's `.onnx.json` config)
  yourself and persist them in the **Cache API** or **OPFS**
  (`navigator.storage.getDirectory()`), then instantiate sessions from the
  cached bytes.
- Warm the model at stand-up (a dummy inference) so the first real utterance
  doesn't pay model-load latency — the server caplets do the same.
- Surface a phase/loading indicator while weights download on first run.

## Run inference in a Web Worker

Model compile and per-frame inference will jank the UI if run on the main
thread.
Run **all** model load + inference in a dedicated **Web Worker**:

- The `STTServer` / `TTSServer` exos live on the main thread and `postMessage`
  audio / text to the worker.
- The worker streams results back; the channel writers from `src/wire.js`
  marshal those results onto the CapTP wire.
- Load each model once and keep it resident across turns.

## What to implement (per backend)

### Backend A — `transformers-webgpu`

`src/backends/transformers-webgpu.js`.
WebGPU STT + TTS via Hugging Face Transformers.js + kokoro-js:

- **STT**: Whisper-base **or** Moonshine via `@huggingface/transformers`
  (`{ device: 'webgpu' }`), streaming partials.
- **TTS**: Kokoro-82M via `kokoro-js`, 24 kHz output converted to s16le PCM
  base64.
- npm deps: `@huggingface/transformers`, `kokoro-js` (and `onnxruntime-web`
  transitively).

### Backend B — `onnx-piper-moonshine`

`src/backends/onnx-piper-moonshine.js`.
ORT STT + TTS that keeps **engine parity** with the server caplets:

- **STT**: Moonshine ONNX (same model family as the moonshine caplet) under
  `onnxruntime-web` (WebGPU EP, WASM fallback).
- **TTS**: a Piper `.onnx` voice + `.onnx.json` config (the same voices the
  piper caplet drives) under ORT, with browser phonemization.
- npm deps: `onnxruntime-web`, plus a browser phonemizer for Piper (e.g.
  `phonemizer` / a wasm eSpeak-NG build).

The model runtime deps are intentionally **not** in `package.json` yet — each
backend agent adds what it needs, and commits the lockfile as a separate
follow-up commit.

## Selector

```js
import { makeLocalVoiceServers } from '@endo/floot-web-voice';

// Probes backends in preference order; returns the first supported one's
// servers, or null if none are supported (fall back to the remote caplets).
const local = await makeLocalVoiceServers({
  preferred: ['onnx-piper-moonshine'], // optional reorder
});
if (local) {
  const { audioServer, ttsServer, backendId } = local;
  // wire audioServer.transcribe(...) / ttsServer.synthesize(...) into the host
}
```

## Testing

- **Pure wire / event-sequencing logic** (the buffered reader, the channel
  writers, the backend selector's ordering and fallback) can be unit-tested in
  **node** with no models — they have no browser dependencies.
- **On-device model verification** (actual STT accuracy, TTS audio, WebGPU /
  WASM execution providers) requires a **WebGPU-capable browser** and a
  cross-origin-isolated page; it cannot run under plain node.
- Keep the two concerns separate so CI can cover the wire contract while the
  model paths are exercised in a browser harness.
