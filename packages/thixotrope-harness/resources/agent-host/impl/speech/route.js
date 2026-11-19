// @ts-check
/**
 * The `/audio` socket of the speech host (`designs/m11-interfaces.md`
 * section 4): binary frames in and out, HELLO and its deadline, and the
 * hand-off of every later frame to the port the token bound. Frame layout,
 * kinds, close codes and bounds are `audio-protocol.js`; what a frame does
 * to a stream is the host's (`host.js`).
 *
 * `makeAudioRoute({ hostNow })` answers the extension's `upgrade` route on
 * `AUDIO_PATH`. The gateway server checks the path and the Origin as for
 * `/ws`, then calls `handle(request, raw, head, accept)`; `accept` does the
 * handshake and the connection counts (seam H5) and answers a
 * `GatewaySocket`. `hostNow()` is the incarnation's speech host (the route
 * receives no context: `GW/extensions/speech.js` keeps the one host of the
 * process).
 *
 * On the socket: the first frame must be HELLO on stream 0 with exactly
 * `audioLimits.tokenBytes` token bytes, within `helloMs`; the host compares
 * the token's digest and binds the port once (`tokenRefused` otherwise),
 * then the server sends READY. A frame before HELLO, a second HELLO, a frame
 * that is not a client kind, a reserved byte that is not 0, or a frame while
 * the binding is under way closes with `protocol`. Nothing here keeps a
 * token: the bytes go to the host and are dropped.
 *
 * Node only (agent-host adapter).
 */
import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';

import { gatewayLimits } from '../gateway/protocol.js';
import {
  AUDIO_PATH,
  FRAME_HEADER_BYTES,
  audioCloseCodes,
  audioLimits,
  frameKinds,
  speechTexts,
} from './audio-protocol.js';

/**
 * What the route hands the host to reach one bound socket.
 * @typedef {object} AudioConnection
 * @property {(stream: number, record: Record<string, unknown>) => void} event
 *   one EVENT frame (`SpeechEvent` JSON)
 * @property {(stream: number, sampleRate: number, pcm: Uint8Array) => void} pcm
 *   one PCM frame (the caller keeps it under `audioLimits.pcmFrameBytes`)
 * @property {(code: number, reason: string) => void} close
 * @property {() => number} bufferedBytes bytes queued on the socket
 */

/**
 * What the host answers for a valid token: the READY record and the
 * port's frame handler.
 * @typedef {object} AudioBinding
 * @property {Record<string, unknown>} ready
 * @property {(kind: number, stream: number, payload: Buffer) => boolean} frame
 *   false: a protocol error (the route closes the socket)
 * @property {() => void} closed the socket is gone
 */

/**
 * The host as the route sees it.
 * @typedef {object} AudioHost
 * @property {{ helloMs: number }} timeouts
 * @property {(token: Buffer, connection: AudioConnection) => Promise<AudioBinding | undefined>} bind
 *   `undefined`: unknown, used or expired token
 */

/** Client-to-server kinds after HELLO. */
/** @type {Set<number>} */
const streamKinds = new Set([
  frameKinds.audio,
  frameKinds.end,
  frameKinds.abort,
]);

/**
 * One frame.
 * @param {number} kind
 * @param {number} stream
 * @param {Uint8Array} [payload]
 * @returns {Buffer}
 */
export const encodeFrame = (kind, stream, payload = new Uint8Array(0)) => {
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.byteLength);
  frame[0] = kind;
  frame[1] = 0;
  frame.writeUInt16BE(stream, 2);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
};
harden(encodeFrame);

/**
 * One frame's parts, or `undefined` when it is too short or its reserved
 * byte is not 0.
 * @param {Buffer} bytes
 * @returns {{ kind: number, stream: number, payload: Buffer } | undefined}
 */
export const decodeFrame = bytes => {
  if (bytes.length < FRAME_HEADER_BYTES || bytes[1] !== 0) return undefined;
  return {
    kind: bytes[0],
    stream: bytes.readUInt16BE(2),
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  };
};
harden(decodeFrame);

/**
 * An EVENT (or READY) frame of one JSON record.
 * @param {number} kind `frameKinds.event` or `frameKinds.ready`
 * @param {number} stream
 * @param {Record<string, unknown>} record
 */
export const encodeRecord = (kind, stream, record) => {
  const json = Buffer.from(JSON.stringify(record), 'utf8');
  if (json.length > audioLimits.eventBytes) {
    throw RangeError('speech event over eventBytes');
  }
  return encodeFrame(kind, stream, json);
};
harden(encodeRecord);

/**
 * A PCM frame: the 4-byte sample rate, then the samples.
 * @param {number} stream
 * @param {number} sampleRate
 * @param {Uint8Array} pcm
 */
export const encodePcm = (stream, sampleRate, pcm) => {
  const payload = Buffer.alloc(4 + pcm.byteLength);
  payload.writeUInt32BE(Math.trunc(sampleRate), 0);
  payload.set(pcm, 4);
  return encodeFrame(frameKinds.pcm, stream, payload);
};
harden(encodePcm);

/**
 * Serve one accepted socket: HELLO, then every frame to the bound port.
 * @param {object} options
 * @param {import('../gateway/server.js').GatewaySocket} options.socket
 * @param {AudioHost} options.host
 */
export const serveAudioSocket = ({ socket, host }) => {
  /** @type {'hello' | 'binding' | 'bound' | 'closed'} */
  let state = 'hello';
  /** @type {AudioBinding | undefined} */
  let binding;

  /**
   * @param {number} code
   * @param {string} reason
   */
  const close = (code, reason) => {
    if (state === 'closed') return;
    state = 'closed';
    socket.close(code, reason);
  };
  const protocolError = () =>
    close(audioCloseCodes.protocol, speechTexts.protocol);

  const helloTimer = setTimeout(
    () => close(audioCloseCodes.helloDeadline, speechTexts.helloDeadline),
    host.timeouts.helloMs,
  );
  helloTimer.unref?.();

  /** @type {AudioConnection} */
  const connection = harden({
    event: (stream, record) => {
      if (state !== 'closed') {
        socket.send(encodeRecord(frameKinds.event, stream, record));
      }
    },
    pcm: (stream, sampleRate, pcm) => {
      if (state !== 'closed') socket.send(encodePcm(stream, sampleRate, pcm));
    },
    close,
    bufferedBytes: () => socket.bufferedBytes(),
  });

  /** @param {Buffer} token */
  const bind = async token => {
    await null;
    /** @type {AudioBinding | undefined} */
    let made;
    try {
      made = await host.bind(token, connection);
    } catch {
      made = undefined;
    }
    if (state !== 'binding') {
      // Closed (deadline, protocol, the peer) while the host was binding.
      made?.closed();
      return;
    }
    clearTimeout(helloTimer);
    if (made === undefined) {
      close(audioCloseCodes.tokenRefused, speechTexts.tokenRefused);
      return;
    }
    binding = made;
    state = 'bound';
    socket.send(encodeRecord(frameKinds.ready, 0, made.ready));
  };

  socket.onMessage(bytes => {
    if (state === 'closed') return;
    const frame = decodeFrame(bytes);
    if (frame === undefined) {
      protocolError();
      return;
    }
    const { kind, stream, payload } = frame;
    if (state === 'hello') {
      if (
        kind !== frameKinds.hello ||
        stream !== 0 ||
        payload.length !== audioLimits.tokenBytes
      ) {
        protocolError();
        return;
      }
      state = 'binding';
      void bind(Buffer.from(payload));
      return;
    }
    if (state !== 'bound' || !streamKinds.has(kind) || stream === 0) {
      protocolError();
      return;
    }
    if (!binding?.frame(kind, stream, payload)) protocolError();
  });

  socket.onClose(() => {
    clearTimeout(helloTimer);
    state = 'closed';
    binding?.closed();
    binding = undefined;
  });
};
harden(serveAudioSocket);

/**
 * The extension's `upgrade` route on `AUDIO_PATH`.
 * @param {object} options
 * @param {() => AudioHost | undefined} options.hostNow the incarnation's
 *   speech host (none before the first page signed in)
 * @returns {import('../gateway/protocol.js').GatewayRoute}
 */
export const makeAudioRoute = ({ hostNow }) =>
  harden({
    kind: 'upgrade',
    path: AUDIO_PATH,
    handle: (request, raw, head, accept) => {
      if (accept === undefined) {
        raw.destroy();
        return;
      }
      const host = hostNow();
      accept(request, raw, head, {
        // A message over the gateway's bound closes 1009 (contract 14.2).
        maxMessageBytes: gatewayLimits.wsMessageBytes,
        onSocket: socket => {
          if (host === undefined) {
            socket.close(
              audioCloseCodes.serviceStopped,
              speechTexts.serviceStopped,
            );
            return;
          }
          serveAudioSocket({ socket, host });
        },
      });
    },
  });
harden(makeAudioRoute);
