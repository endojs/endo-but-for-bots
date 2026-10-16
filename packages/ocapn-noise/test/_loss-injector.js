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
 * reconnect attempts, or delay them to force crossed hellos (Phase 5).
 *
 * @param {OcapnNoiseTransport} transport
 */
export const makeLossyTransport = transport => {
  /** @type {Set<{ severed: boolean, closed: boolean }>} */
  const live = new Set();
  let refusing = false;
  let refusingOutbound = false;
  let connects = 0;
  let connectDelayMs = 0;

  /**
   * @param {ByteStream} stream
   * @returns {ByteStream}
   */
  const wrapStream = stream => {
    const state = { severed: false, closed: false };
    live.add(state);
    /** @type {ByteStream['reader']} */
    const reader = harden({
      next: async value => {
        await null;
        if (state.severed) return never;
        const result = await stream.reader.next(value);
        if (state.severed) return never;
        return result;
      },
      return: value => {
        state.closed = true;
        return stream.reader.return(value);
      },
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
      return: value => {
        state.closed = true;
        return stream.writer.return(value);
      },
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
      if (connectDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, connectDelayMs));
      }
      if (refusing || refusingOutbound) {
        throw Error('lossy transport: connection refused');
      }
      return wrapStream(await transport.connect(hints));
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
    /** Partition every stream opened so far. */
    sever: () => {
      for (const state of live) state.severed = true;
      live.clear();
    },
    /** @param {boolean} refuse Refuse (or again allow) new connections. */
    refuse: refuse => {
      refusing = refuse;
    },
    /** @param {boolean} refuse Refuse (or again allow) outbound connections only. */
    refuseOutbound: refuse => {
      refusingOutbound = refuse;
    },
    /**
     * Hold every new connection attempt for `ms` before it reaches the
     * peer, so that two sides redialing at nearly the same moment are
     * both mid-dial when the other's attempt arrives (crossed hellos).
     *
     * @param {number} ms
     */
    delayConnects: ms => {
      connectDelayMs = ms;
    },
    /** Streams neither partitioned nor closed by this side. */
    getOpenStreams: () =>
      [...live].filter(state => !state.closed && !state.severed).length,
    /** How many connections have been attempted through the transport. */
    getConnects: () => connects,
  });
};
harden(makeLossyTransport);
