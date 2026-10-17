// @ts-check

/**
 * @import { OcapnCodec } from '../../src/codec-interface.js'
 */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '../../src/cbor/index.js';
import { syrupCodec } from '../../src/syrup/index.js';
import {
  readOcapnSessionControlMessage,
  writeOcapnHeartbeatMessage,
  writeOcapnSessionControlMessage,
} from '../../src/codecs/operations.js';

/** @type {Array<[string, OcapnCodec]>} */
const codecs = [
  ['syrup', syrupCodec],
  ['cbor', cborCodec],
];

/** @param {number} length */
const token = length => Uint8Array.from({ length }, (_, i) => i);

/**
 * @param {OcapnCodec} codec
 * @param {any} message
 */
const roundTrip = (codec, message) =>
  readOcapnSessionControlMessage(
    codec.makeReader(writeOcapnSessionControlMessage(message, codec)),
  );

/**
 * Encode an `op:session-hello` field by field, bypassing the codec's
 * write-side checks, so the read side sees a malformed record.
 *
 * @param {OcapnCodec} codec
 * @param {Uint8Array} session
 */
const writeRawHello = (codec, session) => {
  const writer = codec.makeWriter();
  writer.enterRecord(5);
  // CBOR labels records with plain strings, Syrup with selectors.
  if (codec === cborCodec) {
    writer.writeString('op:session-hello');
  } else {
    writer.writeSelectorFromString('op:session-hello');
  }
  writer.writeInteger(0n);
  writer.writeInteger(0n);
  writer.writeBytestring(session);
  writer.writeInteger(0n);
  writer.exitRecord();
  return writer.getBytes();
};

for (const [name, codec] of codecs) {
  test(`op:session-hello round-trips [${name}]`, t => {
    for (const hello of [
      { features: 0n, epoch: 0n, received: 0n },
      { features: 3n, epoch: 0n, received: 0n },
      { features: 3n, epoch: 7n, received: 42n },
      { features: 2n ** 64n, epoch: 2n ** 64n, received: 2n ** 64n },
    ]) {
      const message = {
        type: 'op:session-hello',
        ...hello,
        session: token(32),
      };
      const decoded = roundTrip(codec, message);
      t.is(decoded.type, 'op:session-hello');
      t.is(decoded.features, hello.features);
      t.is(decoded.epoch, hello.epoch);
      t.is(decoded.received, hello.received);
      t.deepEqual(new Uint8Array(decoded.session), token(32));
    }
  });

  test(`op:session-end round-trips [${name}]`, t => {
    for (const epoch of [0n, 1n, 2n ** 64n]) {
      t.deepEqual(roundTrip(codec, { type: 'op:session-end', epoch }), {
        type: 'op:session-end',
        epoch,
      });
    }
  });

  test(`op:session-hello rejects a session token that is not 32 bytes [${name}]`, t => {
    for (const length of [31, 33]) {
      t.throws(
        () =>
          writeOcapnSessionControlMessage(
            {
              type: 'op:session-hello',
              features: 0n,
              epoch: 0n,
              session: token(length),
              received: 0n,
            },
            codec,
          ),
        undefined,
        `write rejects a ${length}-byte session`,
      );
      t.throws(
        () =>
          readOcapnSessionControlMessage(
            codec.makeReader(writeRawHello(codec, token(length))),
          ),
        undefined,
        `read rejects a ${length}-byte session`,
      );
    }
    t.is(
      readOcapnSessionControlMessage(
        codec.makeReader(writeRawHello(codec, token(32))),
      ).type,
      'op:session-hello',
      'the raw encoding is well-formed at 32 bytes',
    );
  });

  test(`session control rejects negative integers [${name}]`, t => {
    t.throws(() =>
      writeOcapnSessionControlMessage(
        { type: 'op:session-end', epoch: -1n },
        codec,
      ),
    );
    t.throws(() =>
      writeOcapnSessionControlMessage(
        {
          type: 'op:session-hello',
          features: -1n,
          epoch: 0n,
          session: token(32),
          received: 0n,
        },
        codec,
      ),
    );
  });

  test(`session control rejects a record with another label [${name}]`, t => {
    const ping = writeOcapnHeartbeatMessage(
      { type: 'op:ping', epoch: 0n, sequence: 0n },
      codec,
    );
    t.throws(() => readOcapnSessionControlMessage(codec.makeReader(ping)));
  });
}
