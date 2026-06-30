// @ts-check
// The voice contract, captured as JSDoc typedefs. No runtime code — this module
// exists only to be `@import`ed by the backends, the wire helpers, and the
// consuming host (floot-component.js). The two later backend agents code their
// STT/TTS servers against the `STTServer`, `TTSServer`, and `VoiceBackend`
// shapes defined here, and against the four wire event vocabularies — which are
// copied EXACTLY from the daemon caplets so the in-browser path and the
// server-side caplet path stay interchangeable from the caller's view.

// ─────────────────────────────────────────────────────────────────────────────
// STT (speech-to-text) wires — see audio-server-caplet.js.
//   transcribe(audioReader) -> textReader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STT INPUT: audio frames pushed by the mic capture loop. `b64` is base64 of
 * 16 kHz mono s16le PCM (the form floot-component.js's makeAudioChannel emits).
 *
 * @typedef {(
 *   | { type: 'bytes', b64: string }
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} SttAudioInEvent
 */

/**
 * STT OUTPUT: transcript events with REPLACE semantics — `text` is always the
 * full transcript so far, not a delta, because recognizer partials are
 * cumulative and revise earlier words mid-stream.
 *
 * @typedef {(
 *   | { type: 'phase', phase: string }
 *   | { type: 'partial', text: string }
 *   | { type: 'final', text: string }
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} TranscriptOutEvent
 */

// ─────────────────────────────────────────────────────────────────────────────
// TTS (text-to-speech) wires — see tts-server-caplet.js.
//   synthesize(textReader) -> audioReader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TTS INPUT: reply text with APPEND semantics — each `delta` is new text to
 * append (the LLM reply as it streams). For replay of a finished message the
 * caller feeds the whole text as a single delta then `end`. A `final` event is
 * deliberately NOT part of this wire so a caller can't double-speak the words.
 *
 * @typedef {(
 *   | { type: 'delta', text: string }
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} TtsTextInEvent
 */

/**
 * TTS OUTPUT: synthesized audio. One `bytes` event per speakable sentence chunk
 * (emitted as soon as that chunk finishes, so the browser can start playing
 * sentence 1 while later text is still arriving). `b64` is base64 of raw s16le
 * mono PCM at `sampleRate` Hz — raw PCM (not WAV/mp3) so the browser builds an
 * AudioBuffer directly with no decode step.
 *
 * @typedef {(
 *   | { type: 'phase', phase: string }
 *   | { type: 'bytes', b64: string, sampleRate: number }
 *   | { type: 'end' }
 *   | { type: 'abort', reason: string }
 * )} TtsAudioOutEvent
 */

// ─────────────────────────────────────────────────────────────────────────────
// Remotable server shapes. These mirror the AudioServer / TtsServer exos in the
// daemon caplets so a host can `E(server).transcribe(...)` / `.synthesize(...)`
// against either a local (this package) or remote (caplet) implementation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Far StreamReader of `TranscriptOutEvent`s (the return of `transcribe`).
 * Consumed via `E(reader).next()`; `E(reader).return()` stops the producer.
 *
 * @typedef {object} TranscriptReader
 * @property {() => Promise<{ value: TranscriptOutEvent | undefined, done: boolean }>} next
 * @property {() => Promise<{ value: undefined, done: true }>} return
 * @property {(error: unknown) => Promise<never>} throw
 */

/**
 * A Far StreamReader of `TtsAudioOutEvent`s (the return of `synthesize`).
 *
 * @typedef {object} TtsAudioReader
 * @property {() => Promise<{ value: TtsAudioOutEvent | undefined, done: boolean }>} next
 * @property {() => Promise<{ value: undefined, done: true }>} return
 * @property {(error: unknown) => Promise<never>} throw
 */

/**
 * A Far StreamReader of `SttAudioInEvent`s, supplied by the caller to
 * `transcribe`. (floot-component.js's makeAudioChannel produces one.)
 *
 * @typedef {object} SttAudioReader
 * @property {() => Promise<{ value: SttAudioInEvent | undefined, done: boolean }>} next
 * @property {() => Promise<{ value: undefined, done: true }>} return
 * @property {(error: unknown) => Promise<never>} throw
 */

/**
 * A Far StreamReader of `TtsTextInEvent`s, supplied by the caller to
 * `synthesize`. (floot-component.js's makeTextFeed produces one.)
 *
 * @typedef {object} TtsTextReader
 * @property {() => Promise<{ value: TtsTextInEvent | undefined, done: boolean }>} next
 * @property {() => Promise<{ value: undefined, done: true }>} return
 * @property {(error: unknown) => Promise<never>} throw
 */

/**
 * Speech-to-text server. Same shape as the AudioServer exo in
 * audio-server-caplet.js.
 *
 * @typedef {object} STTServer
 * @property {(audioReader: SttAudioReader) => TranscriptReader} transcribe
 *   Synchronously returns the transcript reader, then streams events into it as
 *   audio arrives.
 * @property {() => string} help
 */

/**
 * Text-to-speech server. Same shape as the TtsServer exo in
 * tts-server-caplet.js.
 *
 * @typedef {object} TTSServer
 * @property {(textReader: TtsTextReader) => TtsAudioReader} synthesize
 *   Synchronously returns the audio reader, then streams synthesized audio into
 *   it sentence by sentence.
 * @property {() => string} help
 */

/**
 * A pluggable in-browser voice backend. `isSupported` does runtime
 * feature-detection (e.g. WebGPU adapter availability / WASM / cross-origin
 * isolation) and must NOT throw — it resolves to false on any unsupported
 * environment. `createSTT` / `createTTS` are only called after `isSupported`
 * resolved true, and may be expensive (download + compile + warm the model).
 *
 * @typedef {object} VoiceBackend
 * @property {string} id Stable identifier (e.g. 'transformers-webgpu').
 * @property {() => Promise<boolean>} isSupported
 * @property {() => Promise<STTServer>} createSTT
 * @property {() => Promise<TTSServer>} createTTS
 */

/**
 * Result of {@link makeLocalVoiceServers}: ready-to-use local servers plus the
 * id of the backend that won selection. `null` when no backend is supported.
 *
 * @typedef {object} LocalVoiceServers
 * @property {STTServer} audioServer
 * @property {TTSServer} ttsServer
 * @property {string} backendId
 */

// No runtime exports — a harden'd empty object keeps this a valid hardened
// module and gives importers a concrete (if empty) namespace.
export {};
