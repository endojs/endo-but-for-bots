// @ts-check

import { makeCapTP } from '@endo/captp';
import { isPassable, passableAsJustin } from '@endo/marshal';
import { mapWriter, mapReader } from '@endo/stream';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';

/** @import { Stream, Reader, Writer } from '@endo/stream' */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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
 * @template TBootstrap
 * @param {string} name
 * @param {Stream<unknown, any, unknown, unknown>} writer
 * @param {Stream<any, undefined, undefined, undefined>} reader
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} bootstrap
 */
export const makeMessageCapTP = (
  name,
  writer,
  reader,
  cancelled,
  bootstrap,
) => {
  /** @param {any} message */
  const send = message => {
    return writer.next(message);
  };

  const { dispatch, getBootstrap, abort } = makeCapTP(name, send, bootstrap);

  const drained = (async () => {
    for await (const message of reader) {
      dispatch(message);
    }
  })();

  const closed = cancelled.catch(async () => {
    abort();
    await Promise.all([writer.return(undefined), drained]);
  });

  return {
    getBootstrap,
    closed,
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
  // console.log('->', text);
  const bytes = textEncoder.encode(text);
  return bytes;
};

/** @param {Uint8Array} bytes */
export const bytesToMessage = bytes => {
  const text = textDecoder.decode(bytes);
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
 */
export const makeNetstringCapTP = (
  name,
  bytesWriter,
  bytesReader,
  cancelled,
  bootstrap,
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
  );
};
