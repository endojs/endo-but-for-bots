// @ts-nocheck
// The emulated TypedArray constructor must keep the genuine constructor's own
// statics. On an engine that ships the ArrayBuffer base64 proposal,
// `%Uint8Array%` owns `fromBase64` and `fromHex`; the shim's replacement global
// hid them, so `@endo/base64` fell back to its JavaScript decoder (seen inside
// Ironhorse vats, where the native exists). Node 22 lacks those natives, so a
// subclass that owns stand-ins plays the genuine constructor here.
import test from 'ava';
import { makeEmulatedTypedArrayConstructor } from '../src/lib.js';

const { getOwnPropertyDescriptor } = Object;

test('emulated constructor carries the genuine own statics', t => {
  class Genuine extends Uint8Array {
    static fromBase64(string) {
      return `b64:${string}`;
    }

    static fromHex(string) {
      return `hex:${string}`;
    }
  }
  const symbol = Symbol('static');
  Object.defineProperty(Genuine, symbol, { value: 7 });
  const Emulated = makeEmulatedTypedArrayConstructor(Genuine);
  t.is(Emulated.fromBase64, Genuine.fromBase64);
  t.is(Emulated.fromHex, Genuine.fromHex);
  t.is(Emulated.fromBase64('QQ=='), 'b64:QQ==');
  t.deepEqual(
    getOwnPropertyDescriptor(Emulated, 'fromHex'),
    getOwnPropertyDescriptor(Genuine, 'fromHex'),
  );
  t.deepEqual(
    getOwnPropertyDescriptor(Emulated, symbol),
    getOwnPropertyDescriptor(Genuine, symbol),
  );
  t.is(Emulated.name, 'Genuine');
  t.is(Emulated.prototype, Genuine.prototype);
  t.is(Emulated.BYTES_PER_ELEMENT, 1);
});

test('a constructor without base64 statics gains none', t => {
  const Emulated = makeEmulatedTypedArrayConstructor(Int16Array);
  t.is(
    Object.hasOwn(Emulated, 'fromBase64'),
    Object.hasOwn(Int16Array, 'fromBase64'),
  );
  t.is(Emulated.BYTES_PER_ELEMENT, 2);
});
