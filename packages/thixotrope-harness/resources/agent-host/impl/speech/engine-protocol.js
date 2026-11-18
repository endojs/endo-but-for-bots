// @ts-check
/**
 * What the agent-host adapter says to speech engines
 * (`designs/m11-interfaces.md` section 6): the engine kinds, the process
 * engines' protocols and the HTTP provider's paths. Node only (adapter);
 * constants and fixed texts, no implementation.
 *
 * Kinds (`SpeechInSettings.kind`, `SpeechOutSettings.kind`, held by the
 * factory's `Voice`):
 * - `off`: the direction is not configured.
 * - `process`: a local engine child process the adapter supervises, as
 *   Endo (R5-2, R5-15, R5-38, R8-43). Speech in: Endo's Moonshine daemon
 *   (`moonshine_daemon.py` at 1315bef86, JSON lines below, unchanged);
 *   speech out: Piper (`--output-raw`, one sentence per stdin line). Real
 *   steps are tagged `[real-moonshine]`, `[real-piper]`.
 * - `openai-audio`: an HTTP speech provider with the OpenAI audio API's
 *   shape, its key read through a `ReadGrant` in this process at each
 *   request (D-6: never in a vat, the hub or a log). Real steps are tagged
 *   `[real-provider]`. Tests use `test/fixtures/fake-speech-server.mjs`
 *   bound to loopback.
 *
 * Every process engine must exit when its standard input reaches end of
 * file: that is how it dies with the adapter (the adapter process exits on
 * IPC disconnect, `pkg/src/platform/node/adapter-process-entry.js`; its
 * pipes close with it).
 */

/** Engine kinds of each direction. */
export const speechEngineKinds = Object.freeze([
  'off',
  'process',
  'openai-audio',
]);

/**
 * Speech-in process protocol (Endo `moonshine_daemon.py`, JSON lines, one
 * object per line, UTF-8). The adapter writes `requests`; the engine
 * writes the `replies` shapes.
 *
 *   engine -> {"event":"ready"}                         once, after model load
 *   adapter -> {"type":"stream_start","stream":"u<n>"}
 *   adapter -> {"type":"stream_audio","stream":"u<n>","pcm":"<base64>"}
 *   engine -> {"stream":"u<n>","partial":"<full text so far>"}
 *   adapter -> {"type":"stream_stop","stream":"u<n>"}
 *   engine -> {"stream":"u<n>","text":"<final>"} | {"stream":"u<n>","error":"..."}
 *   adapter -> {"type":"stream_abort","stream":"u<n>"}  (no reply)
 *
 * The engine's `error` text is logged by kind only and never shown: the
 * utterance aborts with `speechTexts.engineFailed`.
 */
export const sttProcessMessages = Object.freeze({
  ready: 'ready',
  start: 'stream_start',
  audio: 'stream_audio',
  stop: 'stream_stop',
  abort: 'stream_abort',
});

/** The stream id the adapter gives the engine: `u` and the audio stream number. */
export const STT_STREAM_PREFIX = 'u';

/**
 * Speech-out process arguments (Piper; Endo `tts-server-caplet.js`
 * `makePiper`). Values come from the checked `TtsOptions`; `lengthScale`
 * is `1 / speed`.
 */
export const piperFlags = Object.freeze({
  model: '--model',
  outputRaw: '--output-raw',
  lengthScale: '--length-scale',
  noiseScale: '--noise-scale',
  noiseW: '--noise-w',
  sentenceSilence: '--sentence-silence',
});

/**
 * A voice of the process catalogue: `<id>.onnx` beside `<id>.onnx.json`
 * whose `audio.sample_rate` is a positive integer (R5-40). Display names
 * as Endo `voiceDisplayName` (R5-40).
 */
export const voiceFiles = Object.freeze({
  model: '.onnx',
  metadata: '.onnx.json',
  /** Largest metadata file read. */
  metadataBytes: 65_536,
  /** Voices listed at most (the catalogue answers fit one frame). */
  maxVoices: 128,
});

/**
 * `openai-audio` requests, relative to the configured base URL (which
 * `AH/providers/http.js` `providerBaseUrl` checks: `https:`, or `http:` to
 * a loopback host; no user info, query or fragment).
 *
 * Speech in: `POST <base>/audio/transcriptions`, multipart: `file` (a WAV
 * of the utterance so far, 16 kHz mono s16le), `model`, `language`,
 * `response_format=json`; answer `{ "text": "..." }`. A partial re-posts
 * the audio so far every `partialIntervalMs` while the utterance is open
 * (at most one request in flight per utterance, none over
 * `partialMaxBytes`); the final posts it all after END.
 *
 * Speech out: `POST <base>/audio/speech`, JSON `{ model, input, voice,
 * speed, response_format: "pcm" }`, one request per sentence, the body
 * streamed as raw s16le mono PCM at `openAiPcmSampleRate`.
 */
export const openAiAudio = Object.freeze({
  transcriptions: '/audio/transcriptions',
  speech: '/audio/speech',
  pcmSampleRate: 24_000,
  /** Default interval between partial re-transcriptions. */
  partialIntervalMs: 1500,
  /** No partial is requested for an utterance longer than this (bytes of PCM). */
  partialMaxBytes: 60 * 16_000 * 2,
  /** Largest JSON answer read from the provider. */
  answerBytes: 65_536,
  /** Request timeout (connect to last byte of the answer head). */
  requestTimeoutMs: 15_000,
  /** OpenAI's speed range; a `TtsOptions.speed` outside it is clamped into it. */
  speedMin: 0.25,
  speedMax: 4,
});

/**
 * Environment variables a process engine inherits (everything else is
 * dropped): enough for `uv run` to find its cache and Python, and for Piper
 * to find its libraries.
 */
export const engineEnvironment = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'UV_CACHE_DIR',
  'XDG_CACHE_HOME',
  'DYLD_LIBRARY_PATH',
  'LD_LIBRARY_PATH',
]);

/**
 * Restart pacing of a process engine that keeps failing to start: after
 * `failuresInWindow` failed starts within `windowMs`, the next start
 * waits `backoffMs`. A rate, not a lifetime count.
 */
export const engineRestart = Object.freeze({
  failuresInWindow: 3,
  windowMs: 60_000,
  backoffMs: 30_000,
});

/** Log events of the speech host (never a transcript, text, key or path argument). */
export const speechLogEvents = Object.freeze([
  'speech-engine-start',
  'speech-engine-ready',
  'speech-engine-exit',
  'speech-engine-timeout',
  'speech-engine-failed',
  'speech-port-open',
  'speech-port-closed',
  'speech-stream-abort',
  'speech-config-read',
  'speech-config-failed',
]);
