// @ts-check

/**
 * @import { ByteStream, OcapnNoiseTransport } from '../src/types.js'
 */

import harden from '@endo/harden';

/** @type {Promise<never>} */
const never = new Promise(() => {});

/**
 * The transport-loss fault injector for
 * `designs/ocapn-noise-session-reconnect.md` § Phased Implementation,
 * Phase 3. Wraps a transport so that a test can partition every stream
 * it has opened or accepted so far: from then on those streams carry
 * nothing in either direction (writes resolve but are lost, as bytes in
 * a kernel send buffer are when the path dies, and reads never yield
 * again), while streams opened afterwards work normally. A test can
 * also refuse new connections, to hold a partition open across
 * reconnect attempts.
 *
 * @param {OcapnNoiseTransport} transport
 */
export const makeLossyTransport = transport => {
  /** @type {Set<{ severed: boolean }>} */
  const live = new Set();
  let refusing = false;
  let connects = 0;
  /** @type {number | undefined} */
  let nextReadLimit;

  /**
   * @param {ByteStream} stream
   * @param {number} [readLimit] Messages the stream yields before its
   *   reads stall.
   * @returns {ByteStream}
   */
  const wrapStream = (stream, readLimit = Infinity) => {
    const state = { severed: false };
    live.add(state);
    let reads = 0;
    /** @type {ByteStream['reader']} */
    const reader = harden({
      next: async value => {
        await null;
        if (state.severed || reads >= readLimit) return never;
        reads += 1;
        const result = await stream.reader.next(value);
        if (state.severed) return never;
        return result;
      },
      return: value => stream.reader.return(value),
      throw: error => stream.reader.throw(error),
      [Symbol.asyncIterator]() {
        return reader;
      },
    });
    /** @type {ByteStream['writer']} */
    const writer = harden({
      next: async value => {
        await null;
        if (state.severed) return harden({ done: false, value: undefined });
        return stream.writer.next(value);
      },
      return: value => stream.writer.return(value),
      throw: error => stream.writer.throw(error),
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return harden({ reader, writer });
  };

  const { listen } = transport;
  /** @type {OcapnNoiseTransport} */
  const lossy = harden({
    scheme: transport.scheme,
    connect: async hints => {
      await null;
      connects += 1;
      if (refusing) throw Error('lossy transport: connection refused');
      const readLimit = nextReadLimit;
      nextReadLimit = undefined;
      return wrapStream(await transport.connect(hints), readLimit);
    },
    listen:
      listen &&
      (async handler =>
        listen(stream => {
          if (refusing) {
            Promise.resolve(stream.writer.return(undefined)).catch(() => {});
            return;
          }
          handler(wrapStream(stream));
        })),
    shutdown: () => transport.shutdown(),
  });

  return harden({
    transport: lossy,
    sever: () => {
      for (const state of live) state.severed = true;
      live.clear();
    },
    /** @param {boolean} refuse Refuse (or again allow) new connections. */
    refuse: refuse => {
      refusing = refuse;
    },
    /**
     * Let the next opened connection read only `count` messages; later
     * reads never yield, as if the peer's replies were lost.
     *
     * @param {number} count
     */
    limitNextReads: count => {
      nextReadLimit = count;
    },
    getConnects: () => connects,
  });
};
harden(makeLossyTransport);
