// @ts-check

// The framing seam beneath the daemon's session protocols.
//
// A byte stream carries one of two framings, `netstring`
// (`@endo/netstring`) or `cbor-frame` (`@endo/cbor-frame`). The two
// grammars are disjoint at the first byte of a connection: a netstring
// frame opens with an ASCII decimal digit (0x30 through 0x39) and a
// cbor-frame frame opens with its mandatory tag-24 prefix (0xd8). An
// accepting end can therefore classify a connection by its first byte
// and mirror the initiator's framing, with no handshake.
//
// See designs/daemon-cbor-frame-migration.md.

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';
import { makeCborFrameReader, makeCborFrameWriter } from '@endo/cbor-frame';
import { encodeHex } from '@endo/hex';

/** @import { Reader, Writer } from '@endo/stream' */
/** @import { PromiseKit } from '@endo/promise-kit' */

/** @typedef {'netstring' | 'cbor-frame'} FramingName */

const CBOR_FRAME_INITIAL = 0xd8;

/**
 * Classify the framing of a connection from its first byte.
 *
 * @param {number} byte
 * @param {string} [name]
 * @returns {FramingName}
 */
export const classifyFirstByte = (byte, name = '<unknown>') => {
  if (byte >= 0x30 && byte <= 0x39) {
    return 'netstring';
  }
  if (byte === CBOR_FRAME_INITIAL) {
    return 'cbor-frame';
  }
  const hex = encodeHex(Uint8Array.of(byte));
  throw Error(
    `Unrecognized framing: first byte 0x${hex} is neither a netstring length digit nor the cbor-frame tag-24 prefix at offset 0 of ${name}`,
  );
};
harden(classifyFirstByte);

/**
 * @param {FramingName} framing
 */
const assertFraming = framing => {
  if (framing !== 'netstring' && framing !== 'cbor-frame') {
    throw TypeError(`Unknown framing ${String(framing)}`);
  }
};

/**
 * Writer for one chosen framing.
 *
 * @param {Writer<Uint8Array>} bytesWriter
 * @param {object} opts
 * @param {FramingName} opts.framing
 * @param {string} [opts.name]
 * @returns {Writer<Uint8Array>}
 */
export const makeFrameWriter = (bytesWriter, { framing, name }) => {
  assertFraming(framing);
  if (framing === 'netstring') {
    return makeNetstringWriter(bytesWriter, { chunked: true });
  }
  return makeCborFrameWriter(bytesWriter, { chunked: true, name });
};
harden(makeFrameWriter);

/**
 * Reader for one chosen framing.
 *
 * @param {Iterable<Uint8Array> | AsyncIterable<Uint8Array>} bytesReader
 * @param {object} opts
 * @param {FramingName} opts.framing
 * @param {string} [opts.name]
 * @param {number} [opts.maxMessageLength]
 * @returns {Reader<Uint8Array>}
 */
export const makeFrameReader = (
  bytesReader,
  { framing, name, maxMessageLength },
) => {
  assertFraming(framing);
  if (framing === 'netstring') {
    return makeNetstringReader(bytesReader, { name, maxMessageLength });
  }
  return makeCborFrameReader(bytesReader, { name, maxMessageLength });
};
harden(makeFrameReader);

/**
 * Accept-side reader. Classifies the first byte of the stream, then
 * delegates to the reader for that framing. `framingChosen` fulfills
 * when the first byte arrives and rejects if the stream ends before
 * any byte or opens with a byte neither framing admits, so an
 * accept-side writer can be gated on it.
 *
 * @param {Reader<Uint8Array>} bytesReader
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.maxMessageLength]
 * @returns {{ framingChosen: Promise<FramingName>, reader: Reader<Uint8Array> }}
 */
export const makeSniffingFrameReader = (
  bytesReader,
  { name = '<unknown>', maxMessageLength = undefined } = {},
) => {
  /** @type {PromiseKit<FramingName>} */
  const {
    promise: framingChosen,
    resolve: resolveFraming,
    reject: rejectFraming,
  } = makePromiseKit();
  // The caller may never gate a writer on the choice; a rejection is
  // also surfaced through the reader, so it is never lost.
  framingChosen.catch(() => {});

  async function* sniff() {
    await null;
    /** @type {Uint8Array | undefined} */
    let first;
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await bytesReader.next(undefined);
        if (done) {
          rejectFraming(Error(`Stream ${name} ended before its first frame`));
          return undefined;
        }
        if (value.length !== 0) {
          first = value;
          break;
        }
      }
    } catch (error) {
      rejectFraming(error);
      throw error;
    }

    /** @type {FramingName} */
    let framing;
    try {
      framing = classifyFirstByte(first[0], name);
    } catch (error) {
      rejectFraming(error);
      throw error;
    }
    resolveFraming(framing);

    const firstChunk = first;
    async function* replay() {
      yield firstChunk;
      yield* bytesReader;
    }
    return yield* makeFrameReader(replay(), {
      framing,
      name,
      maxMessageLength,
    });
  }

  return harden({
    framingChosen,
    reader: /** @type {Reader<Uint8Array>} */ (harden(sniff())),
  });
};
harden(makeSniffingFrameReader);

/**
 * Writer whose framing is settled by a promise, typically a sniffing
 * reader's `framingChosen`. Writes wait for the choice rather than
 * guessing, so a write issued before the peer's first frame stalls
 * instead of corrupting the stream; if the choice rejects, so do the
 * writes.
 *
 * @param {Writer<Uint8Array>} bytesWriter
 * @param {Promise<FramingName>} framingChosen
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @returns {Writer<Uint8Array>}
 */
export const makeGatedFrameWriter = (
  bytesWriter,
  framingChosen,
  { name = undefined } = {},
) => {
  /** @type {Writer<Uint8Array> | undefined} */
  let chosenWriter;
  const writerP = framingChosen.then(framing => {
    chosenWriter = makeFrameWriter(bytesWriter, { framing, name });
    return chosenWriter;
  });
  writerP.catch(() => {});

  return harden({
    async next(message) {
      const writer = await writerP;
      return writer.next(message);
    },
    // Closing never waits for the choice: a peer that connects and
    // never speaks must not wedge teardown.
    async return(value) {
      if (chosenWriter !== undefined) {
        return chosenWriter.return(value);
      }
      return bytesWriter.return(value);
    },
    async throw(error) {
      if (chosenWriter !== undefined) {
        return chosenWriter.throw(error);
      }
      return bytesWriter.throw(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
};
harden(makeGatedFrameWriter);
