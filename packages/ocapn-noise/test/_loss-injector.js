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
 * reconnect attempts, or hold them to force crossed hellos
 * (`designs/ocapn-noise-session-reconnect.md` § 3, Crossed-Hellos
 * Tiebreaker).
 *
 * @param {OcapnNoiseTransport} transport
 */
export const makeLossyTransport = transport => {
  /**
   * @typedef {{
   *   severed: boolean,
   *   closed: boolean,
   *   outbound: boolean,
   *   writes: number,
   *   firstWrite: Uint8Array | undefined,
   *   writesAtReturn: number | undefined,
   * }} StreamState
   */
  /** @type {Set<StreamState>} */
  const live = new Set();
  /** @type {StreamState[]} */
  const all = [];
  let refusing = false;
  let refusingOutbound = false;
  let connects = 0;
  /** @type {Promise<void> | undefined} */
  let held;
  let release = () => {};

  /**
   * @param {ByteStream} stream
   * @param {boolean} outbound
   * @returns {ByteStream}
   */
  const wrapStream = (stream, outbound) => {
    /** @type {StreamState} */
    const state = {
      severed: false,
      closed: false,
      outbound,
      writes: 0,
      firstWrite: undefined,
      writesAtReturn: undefined,
    };
    live.add(state);
    all.push(state);
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
        if (state.writes === 0) state.firstWrite = value;
        state.writes += 1;
        if (state.severed) return harden({ done: false, value: undefined });
        return stream.writer.next(value);
      },
      return: value => {
        state.closed = true;
        if (state.writesAtReturn === undefined) {
          state.writesAtReturn = state.writes;
        }
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
      if (held) await held;
      if (refusing || refusingOutbound) {
        throw Error('lossy transport: connection refused');
      }
      return wrapStream(await transport.connect(hints), true);
    },
    listen:
      listen &&
      (async handler =>
        listen(stream => {
          if (refusing) {
            Promise.resolve(stream.writer.return(undefined)).catch(() => {});
            return;
          }
          handler(wrapStream(stream, false));
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
    /**
     * Refuse (or again allow) outbound connections only, so the peer's
     * dials still arrive.
     *
     * @param {boolean} refuse
     */
    refuseOutbound: refuse => {
      refusingOutbound = refuse;
    },
    /**
     * Hold every new connection attempt short of the peer until released,
     * so that a test can wait for two sides to both be mid-dial before
     * either attempt arrives (crossed hellos).
     *
     * @param {boolean} hold
     */
    holdConnects: hold => {
      if (hold && !held) {
        held = new Promise(resolve => {
          release = () => resolve(undefined);
        });
      } else if (!hold && held) {
        held = undefined;
        release();
      }
    },
    /**
     * Streams neither partitioned nor closed by this side.
     *
     * @param {boolean} [outbound] Count only streams this side dialed
     *   (`true`) or accepted (`false`).
     */
    getOpenStreams: outbound =>
      [...live].filter(
        state =>
          !state.closed &&
          !state.severed &&
          (outbound === undefined || state.outbound === outbound),
      ).length,
    /**
     * Every stream this side has dialed or accepted, in order. The first
     * write is kept because an initiator's SYN or a responder's SYNACK
     * carries the handshake ephemerals in the clear.
     */
    getStreams: () =>
      all.map(({ outbound, writes, firstWrite, closed, writesAtReturn }) => ({
        outbound,
        writes,
        firstWrite,
        closed,
        writesAtReturn,
      })),
    /** How many connections have been attempted through the transport. */
    getConnects: () => connects,
  });
};
harden(makeLossyTransport);
