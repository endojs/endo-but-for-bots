// @ts-check

/**
 * @import { ByteStream, OcapnNoiseTransport } from '../src/types.js'
 */

import harden from '@endo/harden';

/**
 * A simulated-stall fault injector. Wraps a transport so that a test
 * can hold every write on every stream the transport opens or accepts,
 * and later let them through in order. Reads are unaffected.
 *
 * @param {OcapnNoiseTransport} transport
 */
export const makeStallableTransport = transport => {
  /** @type {Promise<void>} */
  let gate = Promise.resolve();
  /** @type {(() => void) | undefined} */
  let release;
  let heldWrites = 0;

  /**
   * @param {ByteStream} stream
   * @returns {ByteStream}
   */
  const wrapStream = stream => {
    /** @type {ByteStream['writer']} */
    const writer = harden({
      next: async value => {
        await null;
        heldWrites += 1;
        try {
          await gate;
        } finally {
          heldWrites -= 1;
        }
        return stream.writer.next(value);
      },
      return: value => stream.writer.return(value),
      throw: error => stream.writer.throw(error),
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return harden({ reader: stream.reader, writer });
  };

  const { listen } = transport;
  /** @type {OcapnNoiseTransport} */
  const stallable = harden({
    scheme: transport.scheme,
    connect: async hints => {
      await null;
      const stream = await transport.connect(hints);
      return wrapStream(stream);
    },
    listen:
      listen &&
      (async handler => listen(stream => handler(wrapStream(stream)))),
    shutdown: () => transport.shutdown(),
  });

  return harden({
    transport: stallable,
    stall: () => {
      if (release !== undefined) return;
      gate = new Promise(resolve => {
        release = resolve;
      });
    },
    /** Let held writes through, in the order they were made. */
    resume: () => {
      if (release === undefined) return;
      release();
      release = undefined;
    },
    getHeldWrites: () => heldWrites,
  });
};
harden(makeStallableTransport);
