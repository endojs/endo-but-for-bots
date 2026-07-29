// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { Readable, PassThrough } from 'node:stream';

import {
  encodeEnvelope,
  decodeEnvelope,
  encodeFrame,
  decodeFrame,
  readFrameFromStream,
  writeFrameToStream,
} from '../src/envelope.js';

test('encodeEnvelope / decodeEnvelope round-trip', t => {
  const env = {
    handle: 42,
    verb: 'hello',
    payload: new Uint8Array([1, 2, 3]),
    nonce: 7,
  };
  const encoded = encodeEnvelope(env);
  t.true(encoded instanceof Uint8Array);
  const decoded = decodeEnvelope(encoded);
  t.is(decoded.handle, 42);
  t.is(decoded.verb, 'hello');
  t.deepEqual(decoded.payload, new Uint8Array([1, 2, 3]));
  t.is(decoded.nonce, 7);
});

test('encodeEnvelope defaults payload and nonce', t => {
  const env = { handle: 0, verb: 'ping' };
  const encoded = encodeEnvelope(env);
  const decoded = decodeEnvelope(encoded);
  t.is(decoded.handle, 0);
  t.is(decoded.verb, 'ping');
  t.deepEqual(decoded.payload, new Uint8Array(0));
  t.is(decoded.nonce, 0);
});

test('encodeFrame / decodeFrame round-trip', t => {
  const data = new Uint8Array([10, 20, 30, 40]);
  const frame = encodeFrame(data);
  t.true(frame instanceof Uint8Array);
  const decoded = decodeFrame(frame);
  t.deepEqual(decoded, data);
});

test('round-trip with large handle and long payload', t => {
  const payload = new Uint8Array(300);
  for (let i = 0; i < 300; i += 1) {
    payload[i] = i % 256;
  }
  const env = {
    handle: 65_535,
    verb: 'data',
    payload,
    nonce: 999,
  };
  const encoded = encodeEnvelope(env);
  const decoded = decodeEnvelope(encoded);
  t.is(decoded.handle, 65_535);
  t.is(decoded.verb, 'data');
  t.deepEqual(decoded.payload, payload);
  t.is(decoded.nonce, 999);
});

test('round-trip with negative handle', t => {
  const env = {
    handle: -1,
    verb: 'error',
    payload: new Uint8Array(0),
    nonce: 0,
  };
  const encoded = encodeEnvelope(env);
  const decoded = decodeEnvelope(encoded);
  t.is(decoded.handle, -1);
});

test('frame wrapping preserves envelope', t => {
  const env = {
    handle: 5,
    verb: 'test',
    payload: new Uint8Array([99]),
    nonce: 1,
  };
  const envBytes = encodeEnvelope(env);
  const frame = encodeFrame(envBytes);
  const unwrapped = decodeFrame(frame);
  const decoded = decodeEnvelope(unwrapped);
  t.is(decoded.handle, 5);
  t.is(decoded.verb, 'test');
  t.deepEqual(decoded.payload, new Uint8Array([99]));
});

test('round-trip with empty verb', t => {
  const env = { handle: 1, verb: '', payload: new Uint8Array(0), nonce: 0 };
  const encoded = encodeEnvelope(env);
  const decoded = decodeEnvelope(encoded);
  t.is(decoded.verb, '');
});

// Golden vectors: the exact canonical bytes for a handful of envelopes and one
// frame, derived by hand from RFC 8949 independently of the codec. These lock
// the wire format so a future codec change (e.g. a further primitive swap)
// cannot silently move the bytes exchanged with the Rust peer.
const hex = u8 => Buffer.from(u8).toString('hex');

test('golden vectors: envelope encoding is canonical', t => {
  // 84 00 60 40 00: array(4), uint 0, text"", bytes[], uint 0.
  t.is(
    hex(
      encodeEnvelope({
        handle: 0,
        verb: '',
        payload: new Uint8Array(0),
        nonce: 0,
      }),
    ),
    '8400604000',
  );
  // 84 01 65 "hello" 43 010203 07.
  t.is(
    hex(
      encodeEnvelope({
        handle: 1,
        verb: 'hello',
        payload: new Uint8Array([1, 2, 3]),
        nonce: 7,
      }),
    ),
    '84016568656c6c6f4301020307',
  );
  // 84 20 60 40 00: array(4), negint -1 (major 1, arg 0), text"", bytes[], uint 0.
  t.is(
    hex(
      encodeEnvelope({
        handle: -1,
        verb: '',
        payload: new Uint8Array(0),
        nonce: 0,
      }),
    ),
    '8420604000',
  );
  // 84 19ffff 64 "data" 40 1903e7: uint 65535 (2-byte head), nonce 999 (2-byte head).
  t.is(
    hex(
      encodeEnvelope({
        handle: 65_535,
        verb: 'data',
        payload: new Uint8Array(0),
        nonce: 999,
      }),
    ),
    '8419ffff6464617461401903e7',
  );
  // 44 0a141e28: byte-string frame of [10,20,30,40].
  t.is(hex(encodeFrame(new Uint8Array([10, 20, 30, 40]))), '440a141e28');
});

test('decoder rejects a non-minimal head (strict reader)', t => {
  // 84 1800 60 40 00: the handle 0 is encoded in the non-minimal 1-byte form
  // (0x18 0x00) rather than the inline 0x00. The previous tolerant reader
  // accepted this; @endo/cbor's strict reader rejects it. Canonical traffic
  // (the Rust peer writes minimal heads) is unaffected.
  const nonMinimal = new Uint8Array([0x84, 0x18, 0x00, 0x60, 0x40, 0x00]);
  t.throws(() => decodeEnvelope(nonMinimal), { message: /[Nn]on-minimal/ });
});

// --- Stream functions ---

test('writeFrameToStream and readFrameFromStream round-trip', async t => {
  const passthrough = new PassThrough();
  const data = new Uint8Array([10, 20, 30, 40, 50]);

  await writeFrameToStream(passthrough, data);
  passthrough.end();

  const result = await readFrameFromStream(passthrough);
  t.deepEqual(result, data);
});

test('readFrameFromStream returns null on empty stream', async t => {
  const stream = Readable.from([]);
  const result = await readFrameFromStream(stream);
  t.is(result, null);
});

test('readFrameFromStream reads small frame (length < 24)', async t => {
  const passthrough = new PassThrough();
  const data = new Uint8Array([1, 2, 3]);
  await writeFrameToStream(passthrough, data);
  passthrough.end();

  const result = await readFrameFromStream(passthrough);
  t.deepEqual(result, data);
});

test('readFrameFromStream reads medium frame (length > 255)', async t => {
  const passthrough = new PassThrough();
  const data = new Uint8Array(300);
  for (let i = 0; i < 300; i += 1) data[i] = i % 256;

  await writeFrameToStream(passthrough, data);
  passthrough.end();

  const result = await readFrameFromStream(passthrough);
  t.deepEqual(result, data);
});

test('readFrameFromStream reads empty frame', async t => {
  const passthrough = new PassThrough();
  await writeFrameToStream(passthrough, new Uint8Array(0));
  passthrough.end();

  const result = await readFrameFromStream(passthrough);
  t.deepEqual(result, new Uint8Array(0));
});

test('multiple frames read sequentially', async t => {
  const passthrough = new PassThrough();

  await writeFrameToStream(passthrough, new Uint8Array([1]));
  await writeFrameToStream(passthrough, new Uint8Array([2, 3]));
  passthrough.end();

  const f1 = await readFrameFromStream(passthrough);
  const f2 = await readFrameFromStream(passthrough);
  const f3 = await readFrameFromStream(passthrough);

  t.deepEqual(f1, new Uint8Array([1]));
  t.deepEqual(f2, new Uint8Array([2, 3]));
  t.is(f3, null, 'third read returns null (EOF)');
});
