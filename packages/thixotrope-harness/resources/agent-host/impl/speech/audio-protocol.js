// @ts-check
/**
 * The audio WebSocket's wire format, its bounds and its fixed texts
 * (`designs/m11-interfaces.md` sections 4 and 5). Shared by the agent-host
 * adapter (`AH/speech/`) and the browser bundle (`ui/src/voice/`): no
 * imports, plain frozen data, no Node or browser API.
 *
 * One `/audio` socket per page, bound to one `AudioPort` by a one-time
 * token (HELLO). Streams are opened by CapTP calls (`AudioPort.transcribe`,
 * `AudioPort.speak`, `Speech.replay(port, ...)`), which answer the stream
 * number; the
 * stream's data then travels in binary frames on this socket. Audio never
 * travels through CapTP and never through a vat (architecture D-12, rule
 * "vats decide, adapters carry data").
 *
 * Every frame is one binary WebSocket message:
 *
 *   byte 0      kind (`frameKinds`)
 *   byte 1      0 (reserved; a frame with another value is a protocol error)
 *   bytes 2-3   stream number, unsigned 16-bit big-endian (0 for HELLO and
 *               READY)
 *   bytes 4..   payload (per kind, below)
 *
 * Payloads: HELLO the 32 token bytes; AUDIO 16 kHz mono s16le PCM (a
 * trailing odd byte is dropped, R5-12); END and ABORT none (ABORT may carry
 * a UTF-8 reason of at most `audioLimits.reasonBytes`); READY and EVENT one
 * UTF-8 JSON record (`SpeechEvent`, section 5.3 of the contract); PCM a
 * 4-byte unsigned big-endian sample rate, then s16le mono PCM (event
 * boundaries carry no meaning, R5-43).
 */

/** The upgrade route's path (a `GatewayRoute` of `GW/extensions/speech.js`). */
export const AUDIO_PATH = '/audio';

/**
 * The capture worklet's path (an `http` route of the same extension); the
 * page passes it to `audioWorklet.addModule`, which CSP `script-src 'self'`
 * admits.
 */
export const CAPTURE_WORKLET_PATH = '/speech/capture-worklet.js';

/** Bytes before the payload. */
export const FRAME_HEADER_BYTES = 4;

/** Frame kinds (byte 0). Client-to-server below 0x10, server-to-client above. */
export const frameKinds = Object.freeze({
  /** client: first frame, the 32 token bytes; stream 0. */
  hello: 0x01,
  /** client: PCM of an open utterance. */
  audio: 0x02,
  /** client: the utterance is complete (the final follows). */
  end: 0x03,
  /** client: abandon a stream (an utterance, or stop a playback). */
  abort: 0x04,
  /** server: the socket is bound; payload `ReadyEvent` JSON; stream 0. */
  ready: 0x11,
  /** server: one `SpeechEvent` JSON record for a stream. */
  event: 0x12,
  /** server: 4-byte sample rate, then PCM, for a playback stream. */
  pcm: 0x13,
});

/** Close codes of the audio socket (4100-4199: speech; the gateway's are 4001-4010). */
export const audioCloseCodes = Object.freeze({
  /** No valid HELLO within `audioTimeouts.helloMs`. */
  helloDeadline: 4101,
  /** A malformed frame, an unknown kind or stream, a frame before HELLO. */
  protocol: 4102,
  /** The token is unknown, used, or expired. */
  tokenRefused: 4103,
  /** The port was closed by `AudioPort.close()` or replaced. */
  portClosed: 4104,
  /** The speech service of this incarnation stopped. */
  serviceStopped: 4105,
});

/** Stream numbers: server-chosen, odd for utterances, even for playbacks; 0 is the socket. */
export const streamNumbers = Object.freeze({
  first: 1,
  max: 65_535,
});

/** Sample format of speech in (R5-3, R5-12). */
export const sttFormat = Object.freeze({
  sampleRate: 16_000,
  bytesPerSample: 2,
  /** About 85 ms of audio (R5-3): 1,360 samples. */
  blockBytes: 2720,
});

/** Sample rate the client assumes when a PCM frame says 0 (R5-43). */
export const defaultPlaybackSampleRate = 22_050;

/**
 * Bounds of the audio path (contract section 5.2). Each bounds retained
 * state or one message; none counts a lifetime.
 */
export const audioLimits = Object.freeze({
  /** Token bytes in HELLO (256 bits, minted with `node:crypto`). */
  tokenBytes: 32,
  /** Largest AUDIO payload (about 2 s of speech in; a catch-up after a stall). */
  audioFrameBytes: 65_536,
  /** Largest PCM payload the server sends in one frame. */
  pcmFrameBytes: 65_536,
  /** Largest EVENT or READY payload (UTF-8 JSON). */
  eventBytes: 16_384,
  /** Largest ABORT reason (UTF-8). */
  reasonBytes: 256,
  /** Open streams per port (utterances and playbacks together). */
  streamsPerPort: 4,
  /** Open utterances per port. */
  utterancesPerPort: 2,
  /** Ports of one incarnation (bound or waiting for HELLO). */
  ports: 64,
  /** Audio of one utterance; at the bound the server ends it (END semantics). */
  utteranceBytes: 300 * 16_000 * 2,
  /** Audio waiting for a slow speech-in engine; over it the utterance aborts. */
  sttBacklogBytes: 2 * 1024 * 1024,
  /** PCM queued on the socket before the server pauses synthesis (backpressure). */
  pcmBufferedBytes: 1024 * 1024,
  /** Text waiting to be synthesized for one playback (UTF-16 units). */
  sentenceBacklogUnits: 1_048_576,
  /** A sentence with no boundary is cut at whitespace after this many units. */
  sentenceUnits: 1000,
  /** Engine output line (JSON lines protocol), UTF-8 bytes. */
  engineLineBytes: 65_536,
  /** Pieces of one `AudioPort.replay` call. */
  replayPieces: 64,
  /** Live speech views per session (each takes one of the session channel's 32 subscribers). */
  speakViewsPerSession: 2,
});

/**
 * Timeouts of the audio path (R5-67 fixed; contract section 5.4). All are
 * adapter timers; a test passes shorter values through the host's options.
 */
export const audioTimeouts = Object.freeze({
  /** A socket must send a valid HELLO within this. */
  helloMs: 5000,
  /** A minted token must be used within this, or the port is forgotten. */
  tokenMs: 30_000,
  /** An open utterance with no AUDIO frame for this long is aborted. */
  sttIdleMs: 30_000,
  /** No speech-in engine output for an utterance for this long: the engine is restarted. */
  engineTimeoutMs: 10_000,
  /** No PCM for a written sentence for this long: that sentence fails, the next is tried. */
  synthTimeoutMs: 10_000,
  /** A process engine that does not report ready within this is killed (first runs download models). */
  engineLoadMs: 600_000,
  /** SIGTERM, then SIGKILL after this. */
  killGraceMs: 2000,
});

/**
 * Speech event types (EVENT payload `type`). Utterance: `phase`,
 * `partial`, `final`, `end`, `abort`. Playback: `phase`, `sentence-failed`,
 * `end`, `abort`.
 */
export const speechEventTypes = Object.freeze([
  'phase',
  'partial',
  'final',
  'sentence-failed',
  'end',
  'abort',
]);

/** Phases (R5-12 `listening`, `transcribing`; R5-38 `synthesizing`). */
export const speechPhases = Object.freeze([
  'listening',
  'transcribing',
  'synthesizing',
]);

/**
 * Fixed texts of the audio path: ABORT reasons and close reasons the page
 * shows (contract section 15). Never a provider body, a path or a key.
 */
export const speechTexts = Object.freeze({
  helloDeadline: 'Audio connection did not identify itself in time',
  tokenRefused: 'Audio connection refused: unknown or used token',
  protocol: 'Audio connection closed: malformed frame',
  portClosed: 'Audio connection closed',
  serviceStopped: 'Speech service stopped',
  speechInOff: 'Speech input is not configured',
  speechOutOff: 'Speech output is not configured',
  tooManyStreams: 'Too many audio streams on this page',
  tooManyPorts: 'Too many audio connections',
  sttIdle: 'No audio arrived for 30 seconds; the utterance was abandoned',
  engineTimeout: 'Speech recognition stopped responding and was restarted',
  engineFailed: 'Speech recognition failed',
  engineUnavailable: 'Speech recognition is not available',
  utteranceTooLong: 'The utterance reached its length limit and was ended',
  backlog:
    'Speech recognition fell too far behind; the utterance was abandoned',
  frameTooLarge: 'An audio frame was too large',
  synthFailed: 'Speech synthesis failed',
  synthTimeout: 'A sentence could not be synthesized in time and was skipped',
  turnNotLive: 'This reply is no longer live; use Replay to hear it again',
  turnNotFound: 'The turn to speak was not found',
  tooManyViews: 'Too many replies are being spoken in this session',
  textBacklog: 'The reply is too long to keep up with; speaking stopped',
  stopped: 'Playback stopped',
  replaced: 'Playback replaced by a newer one',
});

/** Templated texts (R5-41 word for word where the spec gives one). */
export const speechTextOf = Object.freeze({
  /** @param {string} id R5-41 / A.5 */
  unknownVoice: id => `Unknown TTS voice "${id}"`,
  /**
   * @param {string} option
   * @param {number} min
   * @param {number} max
   */
  outOfRange: (option, min, max) =>
    `TTS option ${option} must be a finite number from ${min} to ${max}`,
});
