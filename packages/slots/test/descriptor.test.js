// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  Direction,
  Kind,
  encodeDescriptor,
  decodeDescriptor,
  descriptorKey,
  flipDirection,
} from '../src/descriptor.js';

test('canonical fixture: Descriptor(Local, Object, 0) → 82 00 00', t => {
  // This is the byte-level fixture from the Rust crate at
  // rust/endo/slots/src/wire/codec.rs::descriptor_byte_fixture.
  const desc = { dir: Direction.Local, kind: Kind.Object, position: 0 };
  const bytes = encodeDescriptor(desc);
  t.deepEqual([...bytes], [0x82, 0x00, 0x00]);
});

test('kind byte layout — direction in bit 0, kind in bits 1..2', t => {
  // Local × Object = 0b000 = 0
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Local,
        kind: Kind.Object,
        position: 0,
      }),
    ],
    [0x82, 0x00, 0x00],
  );
  // Remote × Object = 0b001 = 1
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Remote,
        kind: Kind.Object,
        position: 0,
      }),
    ],
    [0x82, 0x01, 0x00],
  );
  // Local × Promise = 0b010 = 2
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Local,
        kind: Kind.Promise,
        position: 0,
      }),
    ],
    [0x82, 0x02, 0x00],
  );
  // Remote × Promise = 0b011 = 3
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Remote,
        kind: Kind.Promise,
        position: 0,
      }),
    ],
    [0x82, 0x03, 0x00],
  );
  // Local × Answer = 0b100 = 4
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Local,
        kind: Kind.Answer,
        position: 0,
      }),
    ],
    [0x82, 0x04, 0x00],
  );
  // Local × Device = 0b110 = 6
  t.deepEqual(
    [
      ...encodeDescriptor({
        dir: Direction.Local,
        kind: Kind.Device,
        position: 0,
      }),
    ],
    [0x82, 0x06, 0x00],
  );
});

test('roundtrip across all kinds and directions', t => {
  for (const dir of [Direction.Local, Direction.Remote]) {
    for (const kind of [Kind.Object, Kind.Promise, Kind.Answer, Kind.Device]) {
      for (const position of [0, 1, 23, 24, 255, 256, 65535, 65536]) {
        const d = { dir, kind, position };
        const bytes = encodeDescriptor(d);
        const d2 = decodeDescriptor(bytes);
        t.is(d2.dir, dir);
        t.is(d2.kind, kind);
        t.is(d2.position, position);
      }
    }
  }
});

test('decode rejects descriptor with reserved bits set', t => {
  // kindByte 0b1000 = 8 has reserved bit 3 set.
  const bad = new Uint8Array([0x82, 0x08, 0x00]);
  t.throws(() => decodeDescriptor(bad), { message: /reserved bits/ });
});

test('decode rejects wrong array arity', t => {
  // 3-element array
  const bad = new Uint8Array([0x83, 0x00, 0x00, 0x00]);
  t.throws(() => decodeDescriptor(bad), { message: /2-element/ });
});

test('descriptorKey is stable and unique', t => {
  const a = { dir: Direction.Local, kind: Kind.Object, position: 5 };
  const b = { dir: Direction.Local, kind: Kind.Object, position: 5 };
  const c = { dir: Direction.Remote, kind: Kind.Object, position: 5 };
  t.is(descriptorKey(a), descriptorKey(b));
  t.not(descriptorKey(a), descriptorKey(c));
});

test('flipDirection inverts the frame', t => {
  t.is(flipDirection(Direction.Local), Direction.Remote);
  t.is(flipDirection(Direction.Remote), Direction.Local);
});
