// @ts-check

/**
 * @typedef {import('../types.js').ByteStream} ByteStream
 * @typedef {import('../types.js').OcapnNoiseTransport} OcapnNoiseTransport
 * @typedef {import('../types.js').TransportListener} TransportListener
 */

import harden from '@endo/harden';
import { makeQueue } from '@endo/stream';

/**
 * Pipe where writes complete immediately without waiting for the
 * reader. `@endo/stream`'s `makePipe` uses ack-based back-pressure,
 * which deadlocks any protocol where both sides write before either
 * reads. That pattern is central to our handshake: the Noise initiator
 * and responder each send their greeting before consuming the peer's.
 *
 * @template T
 * @returns {[import('@endo/stream').Writer<T>, import('@endo/stream').Reader<T>]}
 */
const makeUnackedPipe = () => {
  /** @type {import('@endo/stream').AsyncQueue<IteratorResult<T, undefined>>} */
  const queue = makeQueue();
  let closed = false;

  const writer = /** @type {import('@endo/stream').Writer<T>} */ (
    harden({
      /** @param {T} value */
      async next(value) {
        if (closed) return harden({ done: true, value: undefined });
        queue.put(harden({ done: false, value }));
        return harden({ done: false, value: undefined });
      },
      async return() {
        closed = true;
        queue.put(harden({ done: true, value: undefined }));
        return harden({ done: true, value: undefined });
      },
      /** @param {Error} err */
      async throw(err) {
        closed = true;
        queue.put(harden(Promise.reject(err)));
        throw err;
      },
      [Symbol.asyncIterator]() {
        return writer;
      },
    })
  );
  const reader = /** @type {import('@endo/stream').Reader<T>} */ (
    harden({
      next: () => queue.get(),
      return: async () => {
        closed = true;
        return harden({ done: true, value: undefined });
      },
      /** @param {Error} err */
      throw: async err => {
        closed = true;
        throw err;
      },
      [Symbol.asyncIterator]() {
        return reader;
      },
    })
  );
  return [writer, reader];
};

/**
 * Create a matched pair of in-process transports for tests. Calling
 * `transportA.connect({ to: '<designator>' })` delivers an inbound byte
 * stream to whatever handler `transportB.listen(...)` registered under
 * that designator, and vice versa.
 *
 * Each connection is two `@endo/stream` pipes — one per direction.
 * The `to` hint names which listener on the opposing side to route
 * to; the default is `'default'`.
 */
export const makeMockTransportPair = () => {
  /** @type {Map<string, (stream: ByteStream) => void>} */
  const listenersOnA = new Map();
  /** @type {Map<string, (stream: ByteStream) => void>} */
  const listenersOnB = new Map();

  /**
   * @param {Map<string, (stream: ByteStream) => void>} myListeners
   * @param {Map<string, (stream: ByteStream) => void>} peerListeners
   * @returns {OcapnNoiseTransport}
   */
  const makeSide = (myListeners, peerListeners) => {
    /** @returns {[ByteStream, ByteStream]} */
    const makeBidirectional = () => {
      const [aToBWriter, aToBReader] = makeUnackedPipe();
      const [bToAWriter, bToAReader] = makeUnackedPipe();
      const streamForA = harden({
        reader: bToAReader,
        writer: aToBWriter,
      });
      const streamForB = harden({
        reader: aToBReader,
        writer: bToAWriter,
      });
      return [streamForA, streamForB];
    };

    /** @type {OcapnNoiseTransport} */
    const transport = harden({
      scheme: 'mock',
      connect: async hints => {
        const designator = hints.to ?? 'default';
        const accept = peerListeners.get(designator);
        if (!accept) {
          throw Error(
            `mock transport: no listener registered for ${designator}`,
          );
        }
        const [outgoing, incoming] = makeBidirectional();
        accept(incoming);
        return outgoing;
      },
      listen: async handler => {
        const designator = 'default';
        if (myListeners.has(designator)) {
          throw Error(`mock transport: listener already registered`);
        }
        myListeners.set(designator, handler);
        /** @type {TransportListener} */
        const listener = harden({
          hints: { to: designator },
          close: () => {
            myListeners.delete(designator);
          },
        });
        return listener;
      },
      shutdown: () => {
        myListeners.clear();
      },
    });
    return transport;
  };

  return {
    transportA: makeSide(listenersOnA, listenersOnB),
    transportB: makeSide(listenersOnB, listenersOnA),
  };
};
