// @ts-check
/* global process */

import { makeCapTP } from '@endo/captp';
import { isPassable, passableAsJustin } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { mapWriter, mapReader } from '@endo/stream';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';
import { bytesFromText } from '@endo/bytes/from-string.js';
import { bytesToText } from '@endo/bytes/to-string.js';
import { makeMessageSlots, flipEnvelopePayload } from '@endo/slots';
import { encodeEnvelope, decodeEnvelope } from './envelope.js';

/** @import { Stream, Reader, Writer } from '@endo/stream' */
/** @import { CapTpConnectionRegistrar } from './types.js' */

/**
 * Sentinel marker for an Error encoded as a plain object on the
 * `CTP_DISCONNECT.reason` wire shape. The marker disambiguates an
 * encoded Error from an arbitrary plain object that happens to carry
 * `name`, `message`, or `stack` fields.
 */
const ERROR_SENTINEL = '@@error';

/**
 * Render a CapTP rejection reason as a string suitable for diagnostic
 * display. Recognizes three shapes:
 *
 * 1. A real `Error` instance (from the local realm, before the wire
 *    round-trip strips it).
 * 2. The `{ '@@error': true, name, message, stack }` plain shape that
 *    `messageToBytes` emits for Error reasons on `CTP_DISCONNECT`.
 * 3. Any other Passable, rendered through `passableAsJustin` (the
 *    project-standard diagnostic renderer).
 *
 * As a last defence, non-Passable reasons fall through to
 * `String(reason)` annotated with their type tag, so an unexpected
 * reason still produces something readable in the trap.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export const renderRejection = reason => {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}\n${reason.stack || ''}`;
  }
  if (
    reason !== null &&
    typeof reason === 'object' &&
    /** @type {any} */ (reason)[ERROR_SENTINEL] === true
  ) {
    const {
      name = 'Error',
      message = '',
      stack = '',
    } = /** @type {{name?: string, message?: string, stack?: string}} */ (
      reason
    );
    return `${name}: ${message}\n${stack}`;
  }
  if (isPassable(reason)) {
    return passableAsJustin(reason);
  }
  return `(non-passable ${typeof reason}) ${String(reason)}`;
};
harden(renderRejection);

/**
 * @param {CapTpConnectionRegistrar | undefined} registrar
 * @param {string} name
 * @param {(reason?: Error) => Promise<void>} close
 * @param {Promise<void>} closed
 * @returns {import('@endo/captp').CapTPOptions}
 */
const registerCapTpConnection = (registrar, name, close, closed) => {
  if (registrar === undefined) {
    return {};
  }
  return registrar({ name, close, closed });
};

/**
 * Callers that need to capture CapTP-boundary rejections (for example
 * the trace aggregator capturing framing or dispatch errors that never
 * reach the marshal layer) pass an `onReject` through `capTpOptions`.
 * Without one, CapTP rejections are rendered through `renderRejection`
 * and logged on `console.error`.
 *
 * @template TBootstrap
 * @param {string} name
 * @param {Stream<unknown, any, unknown, unknown>} writer
 * @param {Stream<any, undefined, undefined, undefined>} reader
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} bootstrap
 * @param {import('@endo/captp').CapTPOptions} [capTpOptions]
 * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
 */
export const makeMessageCapTP = (
  name,
  writer,
  reader,
  cancelled,
  bootstrap,
  capTpOptions = undefined,
  capTpConnectionRegistrar = undefined,
) => {
  // eslint-disable-next-line no-undef
  const traceCapTP =
    typeof process !== 'undefined' && process.env.ENDO_CAPTP_TRACE;

  // Serialize outbound writes. CapTP invokes `send` without awaiting the
  // previous write, relying on the writer to frame each message atomically
  // and in order. A TCP socket happens to honor this because `socket.write`
  // resolves synchronously, so one message's framing completes before the
  // next begins. Asynchronous byte sinks (e.g. iroh's QUIC streams) do not:
  // overlapping writes let the chunked netstring header and payload of
  // different messages interleave and corrupt the frame. Chaining each write
  // on the previous restores the ordering guarantee for every transport.
  /** @type {Promise<any>} */
  let writeTail = Promise.resolve();
  /** @param {any} message */
  const send = message => {
    if (traceCapTP) {
      console.log(
        `[captp:${name}] SEND`,
        JSON.stringify(message).slice(0, 200),
      );
    }
    const writeP = writeTail.then(() => writer.next(message));
    // Advance the tail regardless of this write's outcome so a single failed
    // write does not wedge the queue.
    writeTail = writeP.then(
      () => {},
      () => {},
    );
    // Contain this direct branch without changing `writeP`: CapTP observes a
    // rejected rawSend result, aborts the connection, and routes the failure
    // through its onReject policy. Logging here would present the same write
    // failure a second time and would bypass a caller's structured policy.
    writeP.catch(() => {});
    return writeP;
  };

  const { promise: closedPromise, resolve: resolveClosed } = makePromiseKit();

  // The registrar receives `close` before CapTP is initialized, but
  // it only stashes it for later use — it never calls it synchronously.
  // We rely on this invariant to define `close` as a forward reference
  // that captures `abort`, `shutdown`, and `drained` from the CapTP setup
  // below.
  /** @type {(reason?: Error, options?: { graceful?: boolean }) => Promise<void>} */
  let close;

  const registrarOptions = registerCapTpConnection(
    capTpConnectionRegistrar,
    name,
    reason => close(reason),
    closedPromise,
  );
  const defaultOnReject = err => {
    console.error(`CapTP ${name} exception:`, renderRejection(err));
  };
  const mergedOptions = {
    onReject: defaultOnReject,
    ...registrarOptions,
    ...capTpOptions,
  };
  const { dispatch, getBootstrap, abort, shutdown } = makeCapTP(
    name,
    send,
    bootstrap,
    mergedOptions,
  );

  const drained = (async () => {
    for await (const message of reader) {
      if (traceCapTP) {
        console.log(
          `[captp:${name}] RECV`,
          JSON.stringify(message).slice(0, 200),
        );
      }
      dispatch(message);
    }
  })();

  drained.then(
    () => close(new Error('Connection stream ended')),
    error => close(error),
  );

  let isClosed = false;
  close = (reason, { graceful = false } = {}) => {
    if (isClosed) {
      return closedPromise;
    }
    isClosed = true;
    if (graceful) {
      shutdown(reason);
    } else {
      abort(reason);
    }
    Promise.all([
      // Flush any writes still queued on `writeTail` (notably the
      // CTP_DISCONNECT that `abort` or `shutdown` just enqueued) before
      // closing the writer, so serialization does not drop the final frame.
      // `writeTail` always settles — it advances on each write's resolution
      // or rejection — so this cannot wedge close on a live or dead
      // transport.
      writeTail.then(() => writer.return(undefined)).catch(() => {}),
      drained.catch(() => {}),
    ]).then(() => {
      resolveClosed(undefined);
    });
    return closedPromise;
  };

  // Cancellation is the caller's own deliberate teardown signal, so it
  // closes the connection gracefully: pending operations still reject
  // with the cancellation reason, but neither this side nor the peer
  // reports the reason as a CapTP exception. Stream failures keep the
  // loud `abort` path above.
  const closedP = cancelled.catch(error => {
    close(error, { graceful: true });
  });
  const closedRace = Promise.race([closedP, closedPromise]);

  return {
    getBootstrap,
    closed: closedRace,
    close,
  };
};

/** @param {any} message */
export const messageToBytes = message => {
  let outgoing = message;
  // Error own-properties (`message`, `stack`, `name`) are non-enumerable
  // and therefore invisible to `JSON.stringify`. Without this branch, a
  // `CTP_DISCONNECT` carrying an Error reason arrives at the peer as
  // `{"reason":{}}` and the receiver-side trap loses the diagnostic.
  // The narrow type guard keeps the fast path for `CTP_CALL` and
  // friends, which already serialize Error fulfilments through
  // `@endo/marshal`.
  if (
    message !== null &&
    typeof message === 'object' &&
    message.type === 'CTP_DISCONNECT' &&
    message.reason instanceof Error
  ) {
    const { name: errName, message: errMessage, stack } = message.reason;
    outgoing = {
      ...message,
      reason: {
        [ERROR_SENTINEL]: true,
        name: errName,
        message: errMessage,
        stack,
      },
    };
  }
  const text = JSON.stringify(outgoing);
  const bytes = bytesFromText(text);
  return bytes;
};

/** @param {Uint8Array} bytes */
export const bytesToMessage = bytes => {
  const text = bytesToText(bytes);
  // console.log('<-', text);
  const message = JSON.parse(text);
  return message;
};

/**
 * @template TBootstrap
 * @param {string} name
 * @param {Writer<Uint8Array>} bytesWriter
 * @param {Reader<Uint8Array>} bytesReader
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} bootstrap
 * @param {import('@endo/captp').CapTPOptions} [capTpOptions]
 * @param {CapTpConnectionRegistrar} [capTpConnectionRegistrar]
 */
export const makeNetstringCapTP = (
  name,
  bytesWriter,
  bytesReader,
  cancelled,
  bootstrap,
  capTpOptions = undefined,
  capTpConnectionRegistrar = undefined,
) => {
  const messageWriter = mapWriter(
    makeNetstringWriter(bytesWriter, { chunked: true }),
    messageToBytes,
  );
  const messageReader = mapReader(
    makeNetstringReader(bytesReader),
    bytesToMessage,
  );
  return makeMessageCapTP(
    name,
    messageWriter,
    messageReader,
    cancelled,
    bootstrap,
    capTpOptions,
    capTpConnectionRegistrar,
  );
};

/**
 * Slot-machine analogue of {@link makeNetstringCapTP}.
 *
 * Wraps a byte-level pipe (a UNIX socket, TCP socket, …) in
 * netstring framing and runs `makeMessageSlots` over the resulting
 * envelope stream.  Each netstring frame carries one CBOR envelope
 * (the same envelope codec the Rust supervisor speaks on fd 3/4),
 * so the wire format stays uniform across daemon-internal pipes
 * and external sockets.
 *
 * For 1:1 stream connections the envelope `handle` and `nonce`
 * fields are unused — we emit `handle = 0` and ignore the inbound
 * `handle` on read.
 *
 * @template TBootstrap
 * @param {string} name
 * @param {Writer<Uint8Array>} bytesWriter
 * @param {Reader<Uint8Array>} bytesReader
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} bootstrap
 * @returns {{
 *   getBootstrap: () => TBootstrap,
 *   closed: Promise<void>,
 *   close: (reason?: Error) => Promise<void>,
 * }}
 */
export const makeNetstringSlots = (
  name,
  bytesWriter,
  bytesReader,
  cancelled,
  bootstrap,
) => {
  const frameWriter = makeNetstringWriter(bytesWriter, { chunked: true });
  const frameReader = makeNetstringReader(bytesReader);
  // Peer-to-peer slot-machine over a stream socket has no translating
  // supervisor, so we flip descriptor direction once per hop on send
  // (the loopback / unit-test convention from packages/slots/test/_loopback.js).
  // Each side flipping on send means each direction sees exactly one
  // flip end-to-end, which is the kref-free equivalent of the
  // supervisor's translate_deliver under the position-1 bootstrap.
  const envelopeWriter = mapWriter(frameWriter, ({ verb, payload }) =>
    encodeEnvelope({
      handle: 0,
      verb,
      payload: flipEnvelopePayload(verb, payload),
      nonce: 0,
    }),
  );
  const envelopeReader = mapReader(frameReader, frame => {
    const env = decodeEnvelope(frame);
    return { verb: env.verb, payload: env.payload };
  });
  return /** @type {ReturnType<typeof makeNetstringSlots<TBootstrap>>} */ (
    /** @type {unknown} */ (
      makeMessageSlots(
        name,
        /** @type {any} */ (envelopeWriter),
        /** @type {any} */ (envelopeReader),
        cancelled,
        bootstrap,
      )
    )
  );
};
