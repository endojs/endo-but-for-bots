// @ts-check
/**
 * The page's side of the `/audio` socket (`designs/m11-interfaces.md`
 * sections 4 and 5; D-M11-3). Frame layout, kinds, close codes and bounds
 * are `audio-protocol.js`'s; this module encodes the client's frames,
 * decodes the server's, and routes them to streams.
 *
 * A stream's number comes from a CapTP call on the other socket
 * (`AudioPort.transcribe`, `AudioPort.speak`, `Speech.replay`), and the
 * server starts sending on it at once, so either side can be first:
 * - frames for a number nobody has claimed yet are held (at most
 *   `audioLimits.streamsPerPort` numbers and `audioLimits.pcmBufferedBytes`
 *   in all; past that the oldest held number is dropped and its stream,
 *   when claimed, aborts with `speechTexts.backlog`);
 * - audio for an utterance whose number has not arrived yet is queued (at
 *   most `audioLimits.sttBacklogBytes`; past that the utterance aborts).
 *
 * A stream ends at its `end` or `abort` event, at `abort()`/`stop()` from
 * the page, or when the socket closes (every open stream then aborts with
 * the close code's text). Frames that arrive for a stream the page has
 * ended are dropped.
 */
import {
  audioCloseCodes,
  audioLimits,
  FRAME_HEADER_BYTES,
  frameKinds,
  speechTexts,
} from '../../../resources/agent-host/impl/speech/audio-protocol.js';
import { audioReconnectDelaysMs } from './endpointing-defaults.js';

/**
 * @typedef {{ speechIn: boolean, speechOut: boolean, sampleRate: number, audioFrameBytes: number }} ReadyEvent
 * @typedef {{ type: string, phase?: string, text?: string, index?: number, note?: string, reason?: string }} SpeechEvent
 * @typedef {{ kind: number, stream: number, payload: Uint8Array }} Frame
 * @typedef {(
 *   | { kind: 'ready', ready: ReadyEvent }
 *   | { kind: 'event', stream: number, event: SpeechEvent }
 *   | { kind: 'pcm', stream: number, sampleRate: number, pcm: Uint8Array }
 * )} ServerFrame
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = new Uint8Array(0);
/** @type {Set<number>} */
const serverKinds = new Set([
  frameKinds.ready,
  frameKinds.event,
  frameKinds.pcm,
]);
const terminal = new Set(['end', 'abort']);

/** Ended stream numbers remembered so their late frames are dropped. */
const ENDED_KEPT = 16;

/**
 * One frame: kind, the reserved 0, the stream number (big-endian), payload.
 *
 * @param {number} kind
 * @param {number} stream
 * @param {Uint8Array} [payload]
 */
export const encodeFrame = (kind, stream, payload = empty) => {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint8(1, 0);
  view.setUint16(2, stream);
  bytes.set(payload, FRAME_HEADER_BYTES);
  return bytes;
};
harden(encodeFrame);

/**
 * The header and payload of a frame, or undefined when it is shorter than
 * a header or its reserved byte is not 0.
 *
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {Frame | undefined}
 */
export const decodeFrame = data => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < FRAME_HEADER_BYTES || bytes[1] !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  return harden({
    kind: bytes[0],
    stream: view.getUint16(2),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  });
};
harden(decodeFrame);

/**
 * The 32 token bytes of `Speech.openAudio`'s hex token.
 *
 * @param {string} token 64 hex digits
 */
export const tokenBytesOf = token => {
  if (
    typeof token !== 'string' ||
    token.length !== audioLimits.tokenBytes * 2 ||
    !/^[0-9a-f]+$/iu.test(token)
  ) {
    throw TypeError('audio token must be 64 hex digits');
  }
  const bytes = new Uint8Array(audioLimits.tokenBytes);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
harden(tokenBytesOf);

/** @param {string} token */
export const helloFrame = token =>
  encodeFrame(frameKinds.hello, 0, tokenBytesOf(token));
harden(helloFrame);

/**
 * AUDIO frames for `pcm`, each payload at most `audioLimits.audioFrameBytes`
 * and of whole samples (a trailing odd byte is dropped, R5-12).
 *
 * @param {number} stream
 * @param {Uint8Array} pcm
 */
export const audioFrames = (stream, pcm) => {
  const whole = pcm.length - (pcm.length % 2);
  /** @type {Uint8Array[]} */
  const frames = [];
  for (let at = 0; at < whole; at += audioLimits.audioFrameBytes) {
    const end = Math.min(whole, at + audioLimits.audioFrameBytes);
    frames.push(encodeFrame(frameKinds.audio, stream, pcm.subarray(at, end)));
  }
  return frames;
};
harden(audioFrames);

/** @param {number} stream */
export const endFrame = stream => encodeFrame(frameKinds.end, stream);
harden(endFrame);

/**
 * ABORT, with the reason cut to `audioLimits.reasonBytes` of UTF-8 (at a
 * character boundary).
 *
 * @param {number} stream
 * @param {string} [reason]
 */
export const abortFrame = (stream, reason = '') => {
  let text = String(reason);
  let bytes = encoder.encode(text);
  while (bytes.length > audioLimits.reasonBytes) {
    text = Array.from(text).slice(0, -1).join('');
    bytes = encoder.encode(text);
  }
  return encodeFrame(frameKinds.abort, stream, bytes);
};
harden(abortFrame);

/**
 * A server frame, decoded and checked, or undefined when it breaks the
 * protocol (unknown or client kind, reserved byte, READY on a stream, JSON
 * that does not parse or is over `audioLimits.eventBytes`, an EVENT without
 * a known `type`, a PCM frame without its rate or over
 * `audioLimits.pcmFrameBytes`).
 *
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {ServerFrame | undefined}
 */
export const decodeServerFrame = data => {
  const frame = decodeFrame(data);
  if (!frame || !serverKinds.has(frame.kind)) return undefined;
  const { kind, stream, payload } = frame;
  if (kind === frameKinds.pcm) {
    if (
      stream === 0 ||
      payload.length < 4 ||
      payload.length - 4 > audioLimits.pcmFrameBytes
    ) {
      return undefined;
    }
    const sampleRate = new DataView(
      payload.buffer,
      payload.byteOffset,
      4,
    ).getUint32(0);
    return harden({
      kind: 'pcm',
      stream,
      sampleRate,
      pcm: payload.subarray(4),
    });
  }
  if (payload.length > audioLimits.eventBytes) return undefined;
  /** @type {any} */
  let record;
  try {
    record = JSON.parse(decoder.decode(payload));
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return undefined;
  }
  if (kind === frameKinds.ready) {
    if (stream !== 0) return undefined;
    return harden({ kind: 'ready', ready: record });
  }
  if (stream === 0 || typeof record.type !== 'string') return undefined;
  return harden({ kind: 'event', stream, event: record });
};
harden(decodeServerFrame);

/**
 * The text a stream aborts with when its socket closed with `code`.
 *
 * @param {number} code
 */
export const closeReasonOf = code => {
  switch (code) {
    case audioCloseCodes.helloDeadline:
      return speechTexts.helloDeadline;
    case audioCloseCodes.protocol:
      return speechTexts.protocol;
    case audioCloseCodes.tokenRefused:
      return speechTexts.tokenRefused;
    case audioCloseCodes.serviceStopped:
      return speechTexts.serviceStopped;
    default:
      return speechTexts.portClosed;
  }
};
harden(closeReasonOf);

/**
 * The delay before re-opening the audio socket after attempt `attempt`
 * (0-based) failed; a new port and token are needed each time.
 *
 * @param {number} attempt
 */
export const audioReconnectDelay = attempt =>
  audioReconnectDelaysMs[Math.min(attempt, audioReconnectDelaysMs.length - 1)];
harden(audioReconnectDelay);

/**
 * @typedef {object} StreamHandlers
 * @property {(event: SpeechEvent) => void} [onEvent] every event, the last
 *   one `end` or `abort`
 * @property {(sampleRate: number, pcm: Uint8Array) => void} [onPcm] a
 *   playback's audio
 */

/**
 * @typedef {object} Utterance
 * @property {(pcm: Uint8Array) => void} send audio, in order (queued until
 *   the stream number is known)
 * @property {() => void} end the utterance is complete (the final follows)
 * @property {(reason?: string) => void} abort abandon it
 * @property {Promise<SpeechEvent>} done the last event
 */

/**
 * @typedef {object} PlaybackStream
 * @property {() => void} stop stop it (ABORT; synthesis ends, the turn
 *   does not)
 * @property {Promise<SpeechEvent>} done the last event
 */

/**
 * @typedef {object} AudioSocket
 * @property {Promise<ReadyEvent>} ready READY, or a rejection when the
 *   socket closed first
 * @property {(stream: number | Promise<number>, handlers?: StreamHandlers) => Utterance} utterance
 * @property {(stream: number | Promise<number>, handlers?: StreamHandlers) => PlaybackStream} playback
 * @property {() => number} bufferedBytes bytes the browser has not sent yet
 * @property {() => boolean} closed
 * @property {() => void} close
 */

/**
 * Open `/audio` and bind it to a port with its token.
 *
 * @param {object} options
 * @param {string} options.url `socketUrl(gateway, AUDIO_PATH)`
 * @param {string} options.token `Speech.openAudio`'s token
 * @param {new (url: string) => any} options.WebSocket
 * @param {(code: number, reason: string) => void} [options.onClose]
 * @returns {AudioSocket}
 */
export const openAudioSocket = ({ url, token, WebSocket, onClose }) => {
  const hello = helloFrame(token);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let isClosed = false;
  /** The text streams abort with once the socket closed. */
  /** @type {string} */
  let closeText = speechTexts.portClosed;

  /** @type {(ready: ReadyEvent) => void} */
  let resolveReady = () => {};
  /** @type {(error: Error) => void} */
  let rejectReady = () => {};
  /** @type {Promise<ReadyEvent>} */
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  /**
   * @typedef {object} Claimed
   * @property {StreamHandlers} handlers
   * @property {(event: SpeechEvent) => void} finish
   */
  /** @type {Map<number, Claimed>} */
  const claimed = new Map();
  /** @type {Map<number, Array<ServerFrame>>} */
  const held = new Map();
  let heldBytes = 0;
  /** @type {number[]} */
  const dropped = [];
  /** @type {number[]} */
  const ended = [];

  /**
   * @param {number[]} list
   * @param {number} stream
   */
  const remember = (list, stream) => {
    list.push(stream);
    if (list.length > ENDED_KEPT) list.shift();
  };

  /** @param {ServerFrame} frame */
  const sizeOf = frame => (frame.kind === 'pcm' ? frame.pcm.length : 64);

  /** @param {Uint8Array} bytes */
  const sendBytes = bytes => {
    if (isClosed) return;
    try {
      ws.send(bytes);
    } catch {
      // closing: the close handler ends every stream
    }
  };

  /**
   * @param {number} stream
   * @param {ServerFrame} frame
   */
  const deliver = (stream, frame) => {
    const entry = claimed.get(stream);
    if (!entry) return;
    if (frame.kind === 'pcm') {
      entry.handlers.onPcm?.(frame.sampleRate, frame.pcm);
      return;
    }
    if (frame.kind !== 'event') return;
    if (terminal.has(frame.event.type)) {
      entry.finish(frame.event);
      return;
    }
    entry.handlers.onEvent?.(frame.event);
  };

  /**
   * @param {number} stream
   * @param {ServerFrame} frame
   */
  const hold = (stream, frame) => {
    if (ended.includes(stream) || dropped.includes(stream)) return;
    let list = held.get(stream);
    if (!list) {
      while (held.size >= audioLimits.streamsPerPort) {
        const [oldest] = held.keys();
        dropHeld(oldest);
      }
      list = [];
      held.set(stream, list);
    }
    list.push(frame);
    heldBytes += sizeOf(frame);
    while (heldBytes > audioLimits.pcmBufferedBytes && held.size > 0) {
      const [oldest] = held.keys();
      dropHeld(oldest);
    }
  };

  /** @param {number} stream */
  const dropHeld = stream => {
    for (const frame of held.get(stream) ?? []) heldBytes -= sizeOf(frame);
    held.delete(stream);
    remember(dropped, stream);
  };

  const protocolClose = () => {
    try {
      ws.close(audioCloseCodes.protocol, speechTexts.protocol);
    } catch {
      // already closing
    }
  };

  /** @param {{ data: unknown }} message */
  const onMessage = message => {
    if (isClosed) return;
    const { data } = message;
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
      protocolClose();
      return;
    }
    const frame = decodeServerFrame(data);
    if (!frame) {
      protocolClose();
      return;
    }
    if (frame.kind === 'ready') {
      resolveReady(frame.ready);
      return;
    }
    const { stream } = frame;
    if (claimed.has(stream)) deliver(stream, frame);
    else hold(stream, frame);
  };

  /**
   * @param {number} code
   * @param {string} [reason]
   */
  const onClosed = (code, reason = '') => {
    if (isClosed) return;
    isClosed = true;
    const text = closeReasonOf(code);
    closeText = text;
    rejectReady(Error(text));
    for (const entry of [...claimed.values()]) {
      entry.finish(harden({ type: 'abort', reason: text }));
    }
    held.clear();
    heldBytes = 0;
    onClose?.(code, reason);
  };

  ws.onopen = () => sendBytes(hello);
  ws.onmessage = onMessage;
  ws.onclose = (/** @type {{ code: number, reason?: string }} */ event) =>
    onClosed(event.code, event.reason);
  ws.onerror = () => {};

  /**
   * One stream: claimed when its number arrives; held frames replayed.
   *
   * @param {number | Promise<number>} streamOf
   * @param {StreamHandlers} handlers
   */
  const openStream = (streamOf, handlers) => {
    /** @type {number | undefined} */
    let number;
    let done = false;
    /** @type {(event: SpeechEvent) => void} */
    let resolveDone = () => {};
    /** @type {Promise<SpeechEvent>} */
    const finished = new Promise(resolve => {
      resolveDone = resolve;
    });
    /** @type {Array<() => void>} */
    const onNumber = [];

    /** @param {SpeechEvent} event */
    const finish = event => {
      if (done) return;
      done = true;
      if (number !== undefined) {
        claimed.delete(number);
        remember(ended, number);
      }
      handlers.onEvent?.(event);
      resolveDone(event);
    };

    /**
     * End from the page: ABORT once the number is known.
     *
     * @param {string} reason
     */
    const abortFromPage = reason => {
      if (done) return;
      const send = () => {
        if (number !== undefined) sendBytes(abortFrame(number, reason));
      };
      if (number === undefined) {
        // queued audio and END are moot: only the ABORT goes out
        onNumber.length = 0;
        onNumber.push(send);
      } else {
        send();
      }
      finish(harden({ type: 'abort', reason }));
    };

    Promise.resolve(streamOf).then(
      stream => {
        if (isClosed && !done) {
          finish(harden({ type: 'abort', reason: closeText }));
        }
        number = stream;
        if (done) {
          // ended by the page before its number came: tell the server
          for (const run of onNumber.splice(0)) run();
          remember(ended, stream);
          const late = held.get(stream);
          if (late) {
            for (const frame of late) heldBytes -= sizeOf(frame);
            held.delete(stream);
          }
          return;
        }
        if (dropped.includes(stream)) {
          dropped.splice(dropped.indexOf(stream), 1);
          sendBytes(abortFrame(stream, speechTexts.backlog));
          finish(harden({ type: 'abort', reason: speechTexts.backlog }));
          return;
        }
        claimed.set(stream, { handlers, finish });
        for (const run of onNumber.splice(0)) run();
        const early = held.get(stream);
        if (early) {
          held.delete(stream);
          for (const frame of early) {
            heldBytes -= sizeOf(frame);
            deliver(stream, frame);
          }
        }
      },
      error => {
        onNumber.length = 0;
        finish(
          harden({
            type: 'abort',
            reason: String(error?.message ?? speechTexts.portClosed),
          }),
        );
      },
    );

    return {
      finished,
      abortFromPage,
      isDone: () => done,
      /** @param {() => void} run */
      whenNumbered: run => {
        if (done) return;
        if (number === undefined) onNumber.push(run);
        else run();
      },
      numberOf: () => number,
    };
  };

  return harden({
    ready,
    utterance(streamOf, handlers = {}) {
      const stream = openStream(streamOf, handlers);
      let queued = 0;
      return harden({
        send(pcm) {
          if (stream.isDone() || pcm.length === 0) return;
          const n = stream.numberOf();
          if (n !== undefined) {
            for (const frame of audioFrames(n, pcm)) sendBytes(frame);
            return;
          }
          queued += pcm.length;
          if (queued > audioLimits.sttBacklogBytes) {
            stream.abortFromPage(speechTexts.backlog);
            return;
          }
          const copy = pcm.slice();
          stream.whenNumbered(() => {
            queued -= copy.length;
            const m = /** @type {number} */ (stream.numberOf());
            for (const frame of audioFrames(m, copy)) sendBytes(frame);
          });
        },
        end() {
          stream.whenNumbered(() =>
            sendBytes(endFrame(/** @type {number} */ (stream.numberOf()))),
          );
        },
        abort(reason = speechTexts.stopped) {
          stream.abortFromPage(reason);
        },
        done: stream.finished,
      });
    },
    playback(streamOf, handlers = {}) {
      const stream = openStream(streamOf, handlers);
      return harden({
        stop() {
          stream.abortFromPage(speechTexts.stopped);
        },
        done: stream.finished,
      });
    },
    bufferedBytes: () => Number(ws.bufferedAmount ?? 0),
    closed: () => isClosed,
    close() {
      try {
        ws.close(1000);
      } catch {
        // already closing
      }
      onClosed(audioCloseCodes.portClosed);
    },
  });
};
harden(openAudioSocket);
