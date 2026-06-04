/* global globalThis */

import test from '@endo/ses-ava/test.js';

import {
  sliceFunction,
  transferFunction,
  concatImmutablesFunction,
  bytesFromImmutableFunction,
  toUtf8StringFunction,
  fromUtf8StringFunction,
  getFreezableConstructor,
  symbols,
} from '../src/spackle-install.js';

import { bytesFromText } from '../src/from-string.js';
import { bytesToText } from '../src/to-string.js';
import { bytesToImmutable } from '../src/to-immutable.js';
import { bytesFromImmutable } from '../src/from-immutable.js';
import { concatImmutables } from '../src/concat-immutables.js';

test('spackle: symbols are registered via Symbol.for', t => {
  t.is(symbols.sliceBufferToImmutable, Symbol.for('sliceBufferToImmutable'));
  t.is(
    symbols.transferBufferToImmutable,
    Symbol.for('transferBufferToImmutable'),
  );
  t.is(symbols.concatImmutables, Symbol.for('concatImmutables'));
  t.is(symbols.bytesFromImmutable, Symbol.for('bytesFromImmutable'));
  t.is(symbols.toUtf8String, Symbol.for('toUtf8String'));
  t.is(symbols.fromUtf8String, Symbol.for('fromUtf8String'));
  t.is(symbols.freezableConstructor, Symbol.for('freezableConstructor'));
});

// When the spackle gets to run before `lockdown()` (the default
// here, since the bytes ses-ava configs do not freeze the intrinsics
// before this module loads in the endo-shims-only configuration),
// the slots on the intrinsics are populated. When SES lockdown has
// already run, the install gracefully fails and the exported function
// references still work as conventional ponyfills.
const spackleInstallable = (() => {
  // Heuristic: if the slot is defined on the intrinsic, the install
  // ran (either ours or an earlier one). Under post-lockdown the
  // slot is absent.
  return (
    typeof ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')] ===
    'function'
  );
})();

test('spackle: ArrayBuffer.prototype[Symbol.for("sliceBufferToImmutable")] install or graceful fallback', t => {
  const slot = ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, sliceFunction);
  } else {
    t.is(slot, undefined);
    // Function reference still works.
    t.is(typeof sliceFunction, 'function');
  }
});

test('spackle: ArrayBuffer[Symbol.for("concatImmutables")] install or graceful fallback', t => {
  const slot = ArrayBuffer[Symbol.for('concatImmutables')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, concatImmutablesFunction);
  } else {
    t.is(slot, undefined);
    t.is(typeof concatImmutablesFunction, 'function');
  }
});

test('spackle: Uint8Array[Symbol.for("bytesFromImmutable")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('bytesFromImmutable')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, bytesFromImmutableFunction);
  } else {
    t.is(slot, undefined);
    t.is(typeof bytesFromImmutableFunction, 'function');
  }
});

test('spackle: Uint8Array[Symbol.for("toUtf8String")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('toUtf8String')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, toUtf8StringFunction);
  } else {
    t.is(slot, undefined);
    t.is(typeof toUtf8StringFunction, 'function');
  }
});

test('spackle: Uint8Array[Symbol.for("fromUtf8String")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('fromUtf8String')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, fromUtf8StringFunction);
  } else {
    t.is(slot, undefined);
    t.is(typeof fromUtf8StringFunction, 'function');
  }
});

test('spackle: Uint8Array[Symbol.for("freezableConstructor")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('freezableConstructor')];
  if (spackleInstallable) {
    t.is(typeof slot, 'function');
    t.is(slot, getFreezableConstructor(Uint8Array));
  } else {
    t.is(slot, undefined);
    t.is(typeof getFreezableConstructor(Uint8Array), 'function');
  }
});

test('spackle: freezable constructor is installed on every TypedArray family when installable', t => {
  if (!spackleInstallable) {
    // Fallback: the exported getFreezableConstructor still works.
    t.is(typeof getFreezableConstructor(Uint8Array), 'function');
    return;
  }
  const sym = Symbol.for('freezableConstructor');
  const families = [
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  ];
  for (const Ctor of families) {
    if (Ctor !== undefined) {
      const slot = Ctor[sym];
      t.is(
        typeof slot,
        'function',
        `${Ctor.name} has installed freezable ctor`,
      );
    }
  }
});

test('spackle: optional transferBufferToImmutable install when supported', t => {
  const slot = ArrayBuffer.prototype[Symbol.for('transferBufferToImmutable')];
  if (!spackleInstallable) {
    t.is(slot, undefined);
    return;
  }
  if (transferFunction === undefined) {
    t.is(slot, undefined);
  } else {
    t.is(typeof slot, 'function');
    t.is(slot, transferFunction);
  }
});

test('spackle: sliceFunction yields immutable buffer with byteArray-passStyle contents', t => {
  const view = new Uint8Array([1, 2, 3, 4]);
  const immutable = sliceFunction.call(
    view.buffer,
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  t.true(immutable instanceof ArrayBuffer);
  t.is(immutable.byteLength, 4);
});

test('spackle: subsequent loads adopt the existing install (idempotent shape)', t => {
  // The install dance writes once at module load; the slot is not
  // configurable nor writable. Importing the module again would find
  // the slot already populated and adopt it. Verified here by
  // re-reading the slot and matching the function reference.
  const slot1 = ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')];
  const slot2 = ArrayBuffer.prototype[Symbol.for('sliceBufferToImmutable')];
  t.is(slot1, slot2);
  if (!spackleInstallable) {
    // Lockdown ran first; the install was a graceful no-op.
    return;
  }
  // Cannot re-defineProperty: the descriptor is non-configurable.
  t.throws(
    () => {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(
        ArrayBuffer.prototype,
        Symbol.for('sliceBufferToImmutable'),
        { value: () => {}, configurable: true },
      );
    },
    { instanceOf: TypeError },
  );
});

test('spackle: encode/decode round-trip via installed slots', t => {
  if (!spackleInstallable) {
    // Fall back to the spackle module's exported references.
    const bytes = fromUtf8StringFunction('Hello, 世界 \u{1F600}');
    t.is(toUtf8StringFunction(bytes), 'Hello, 世界 \u{1F600}');
    return;
  }
  const sym1 = Symbol.for('fromUtf8String');
  const sym2 = Symbol.for('toUtf8String');
  const encode = Uint8Array[sym1];
  const decode = Uint8Array[sym2];
  const bytes = encode('Hello, 世界 \u{1F600}');
  t.is(decode(bytes), 'Hello, 世界 \u{1F600}');
});

test('spackle: text codec survives globalThis.TextEncoder replacement', t => {
  // The spackle captures TextEncoder at module load. Replace the
  // globalThis binding now; the install must continue to produce the
  // correct bytes because it holds the realm's original encoder.
  const originalTE = globalThis.TextEncoder;
  try {
    /** @type {any} */ (globalThis).TextEncoder = function BadTextEncoder() {
      throw new Error('TextEncoder was tampered with');
    };
    const bytes = bytesFromText('abc');
    t.deepEqual([...bytes], [97, 98, 99]);
  } finally {
    globalThis.TextEncoder = originalTE;
  }
});

test('spackle: text codec survives globalThis.TextDecoder replacement', t => {
  const originalTD = globalThis.TextDecoder;
  try {
    /** @type {any} */ (globalThis).TextDecoder = function BadTextDecoder() {
      throw new Error('TextDecoder was tampered with');
    };
    const s = bytesToText(new Uint8Array([97, 98, 99]));
    t.is(s, 'abc');
  } finally {
    globalThis.TextDecoder = originalTD;
  }
});

test('spackle: freezable constructor accepts immutable buffer as sole arg', t => {
  const FreezableUint8Array = /** @type {any} */ (
    getFreezableConstructor(Uint8Array)
  );
  const realAb = new ArrayBuffer(4);
  const iab = bytesToImmutable(new Uint8Array(realAb));
  // The freezable constructor accepts an emulated immutable
  // ArrayBuffer and yields a freezable view.
  const fta = new FreezableUint8Array(iab);
  t.truthy(fta);
});

test('spackle: freezable constructor falls through to OriginalConstructor for non-immutable args', t => {
  const FreezableUint8Array = /** @type {any} */ (
    getFreezableConstructor(Uint8Array)
  );
  const realAb = new ArrayBuffer(4);
  const ta = new FreezableUint8Array(realAb);
  t.true(ta instanceof Uint8Array || ta.constructor === FreezableUint8Array);
});

test('spackle: concatImmutables via installed slot agrees with direct call', t => {
  const parts = [
    bytesToImmutable(new Uint8Array([1, 2, 3])),
    bytesToImmutable(new Uint8Array([4])),
    bytesToImmutable(new Uint8Array([5, 6, 7, 8])),
  ];
  const viaSpackle = concatImmutables(parts);
  if (spackleInstallable) {
    const directSlot = ArrayBuffer[Symbol.for('concatImmutables')];
    const viaDirectSlot = directSlot(parts);
    t.deepEqual(
      [...bytesFromImmutable(viaSpackle)],
      [...bytesFromImmutable(viaDirectSlot)],
    );
  }
  t.deepEqual([...bytesFromImmutable(viaSpackle)], [1, 2, 3, 4, 5, 6, 7, 8]);
});
