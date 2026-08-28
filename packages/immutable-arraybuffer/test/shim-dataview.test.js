// @ts-nocheck
import '../src/shim.js';
import harden from '@endo/harden';
import test from 'ava';
import { emulatedOnlyTest } from './_emulated-only.js';

const { freeze, getPrototypeOf, isFrozen } = Object;

const makeImmutableFixture = () => {
  const buffer = new ArrayBuffer(32);
  const writer = new DataView(buffer);
  writer.setInt8(0, -12);
  writer.setUint8(1, 250);
  writer.setInt16(2, -1234, true);
  writer.setUint16(4, 0xabcd, true);
  writer.setInt32(6, -12_345_678, true);
  writer.setUint32(10, 0xdead_beef, true);
  writer.setFloat32(14, 1.5, true);
  writer.setFloat64(18, -Math.PI, true);
  return buffer.sliceToImmutable();
};

test('DataView on an immutable ArrayBuffer preserves construction ranges and reads', t => {
  const immutable = makeImmutableFixture();
  const view = new DataView(immutable, 1, 25);

  t.is(view.buffer, immutable);
  t.is(view.byteOffset, 1);
  t.is(view.byteLength, 25);
  t.is(view.getUint8(0), 250);
  t.is(view.getInt16(1, true), -1234);
  t.is(view.getUint16(3, true), 0xabcd);
  t.is(view.getInt32(5, true), -12_345_678);
  t.is(view.getUint32(9, true), 0xdead_beef);
  t.is(view.getFloat32(13, true), 1.5);
  t.is(view.getFloat64(17, true), -Math.PI);

  t.throws(() => new DataView(immutable, -1), { instanceOf: RangeError });
  t.throws(() => new DataView(immutable, 33), { instanceOf: RangeError });
  t.throws(() => new DataView(immutable, 30, 3), {
    instanceOf: RangeError,
  });
  t.is(new DataView(immutable, 32).byteLength, 0);
  t.is(new DataView(immutable, 1, undefined).byteLength, 31);
});

test('DataView on an immutable ArrayBuffer rejects every write family', t => {
  const view = new DataView(makeImmutableFixture());
  const writes = [
    ['setInt8', () => view.setInt8(0, 1)],
    ['setUint8', () => view.setUint8(0, 1)],
    ['setInt16', () => view.setInt16(0, 1)],
    ['setUint16', () => view.setUint16(0, 1)],
    ['setInt32', () => view.setInt32(0, 1)],
    ['setUint32', () => view.setUint32(0, 1)],
    ['setFloat32', () => view.setFloat32(0, 1)],
    ['setFloat64', () => view.setFloat64(0, 1)],
    ['setBigInt64', () => view.setBigInt64(0, 1n)],
    ['setBigUint64', () => view.setBigUint64(0, 1n)],
  ];
  if ('setFloat16' in view) {
    writes.push(['setFloat16', () => view.setFloat16(0, 1)]);
  }
  for (const [name, write] of writes) {
    t.throws(write, {
      instanceOf: TypeError,
      message: `Cannot ${name} through a DataView on an immutable ArrayBuffer`,
    });
  }
  t.is(view.getInt8(0), -12);
});

test('DataView shim preserves genuine mutable DataView behavior', t => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer, 2, 4);
  t.true(ArrayBuffer.isView(view));
  t.is(view.buffer, buffer);
  view.setUint32(0, 0x1234_5678);
  t.is(view.getUint32(0), 0x1234_5678);
  freeze(view);
  view.setUint8(0, 0xff);
  t.is(view.getUint8(0), 0xff);
});

test('DataView on an immutable ArrayBuffer has DataView branding and is freezable', t => {
  const immutable = makeImmutableFixture();
  const view = new DataView(immutable);
  t.true(view instanceof DataView);
  t.is(getPrototypeOf(view), DataView.prototype);
  t.is(Object.prototype.toString.call(view), '[object DataView]');
  t.is(view.constructor, DataView);
  t.is(freeze(view), view);
  t.true(isFrozen(view));

  const hardened = harden(new DataView(immutable));
  t.true(isFrozen(hardened));
  t.is(hardened.getUint8(1), 250);
  t.throws(() => hardened.setUint8(1, 0), { instanceOf: TypeError });
});

test('DataView shim preserves constructor and method metadata', t => {
  t.is(DataView.name, 'DataView');
  t.is(DataView.length, 1);
  t.is(DataView.prototype.getUint8.name, 'getUint8');
  t.is(DataView.prototype.getUint8.length, 1);
  t.is(DataView.prototype.setUint8.name, 'setUint8');
  t.is(DataView.prototype.setUint8.length, 2);
});

test('DataView shim preserves subclass prototypes', t => {
  class DerivedDataView extends DataView {}
  const view = new DerivedDataView(makeImmutableFixture(), 1, 2);
  t.true(view instanceof DerivedDataView);
  t.true(view instanceof DataView);
  t.is(getPrototypeOf(view), DerivedDataView.prototype);
  t.is(view.byteOffset, 1);
  t.is(view.byteLength, 2);
  t.throws(() => DataView(new ArrayBuffer(1)), { instanceOf: TypeError });
});

emulatedOnlyTest(
  'emulated immutable DataView is the ordinary non-view shape',
  t => {
    const view = new DataView(makeImmutableFixture());
    t.false(ArrayBuffer.isView(view));
    t.deepEqual(Reflect.ownKeys(view), []);
  },
);
