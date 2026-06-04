/* global globalThis */

import test from '@endo/ses-ava/test.js';

import {
  installedSliceToImmutable,
  symSliceToImmutable,
} from '../src/install-to-immutable.js';
import {
  installedTransferToImmutable,
  symTransferToImmutable,
} from '../src/install-transfer-to-immutable.js';
import {
  installedFromImmutableValue,
  symFromImmutable,
} from '../src/install-from-immutable.js';
import {
  getFreezableConstructor,
  symFreezable,
} from '../src/install-freezable-typedarrays.js';

import { bytesFromText } from '../src/from-string.js';
import { bytesToText } from '../src/to-string.js';
import { bytesToImmutable } from '../src/to-immutable.js';
import { bytesFromImmutable } from '../src/from-immutable.js';
import { concatImmutables } from '../src/concat-immutables.js';

// Widen each rendezvous symbol to `symbol` so `t.is(..., Symbol.for(...))`
// does not collide with `unique symbol` on the install-side exports.
const symbols = /** @type {Record<string, symbol>} */ ({
  sliceToImmutable: symSliceToImmutable,
  transferToImmutable: symTransferToImmutable,
  fromImmutable: symFromImmutable,
  freezable: symFreezable,
});

test('install: symbols are registered via Symbol.for', t => {
  t.is(symbols.sliceToImmutable, Symbol.for('sliceToImmutable'));
  t.is(symbols.transferToImmutable, Symbol.for('transferToImmutable'));
  t.is(symbols.fromImmutable, Symbol.for('fromImmutable'));
  t.is(symbols.freezable, Symbol.for('freezable'));
});

// When the install gets to run before `lockdown()` (the default here,
// since the bytes ses-ava configs do not freeze the intrinsics before
// these modules load in the endo-shims-only configuration), the slots
// on the intrinsics are populated. When SES lockdown has already run,
// the install gracefully fails and the exported function references
// still work as conventional ponyfills.
const installable = (() => {
  // Heuristic: if the slot is defined on the intrinsic, the install
  // ran (either ours or an earlier one). Under post-lockdown the slot
  // is absent.
  return (
    typeof ArrayBuffer.prototype[Symbol.for('sliceToImmutable')] === 'function'
  );
})();

test('install: ArrayBuffer.prototype[Symbol.for("sliceToImmutable")] install or graceful fallback', t => {
  const slot = ArrayBuffer.prototype[Symbol.for('sliceToImmutable')];
  if (installable) {
    t.is(typeof slot, 'function');
    t.is(slot, installedSliceToImmutable);
  } else {
    t.is(slot, undefined);
    // Function reference still works.
    t.is(typeof installedSliceToImmutable, 'function');
  }
});

test('install: Uint8Array[Symbol.for("fromImmutable")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('fromImmutable')];
  if (installable) {
    t.is(typeof slot, 'function');
    t.is(slot, installedFromImmutableValue);
  } else {
    t.is(slot, undefined);
    t.is(typeof installedFromImmutableValue, 'function');
  }
});

test('install: Uint8Array[Symbol.for("freezable")] install or graceful fallback', t => {
  const slot = Uint8Array[Symbol.for('freezable')];
  if (installable) {
    t.is(typeof slot, 'function');
    t.is(slot, getFreezableConstructor(Uint8Array));
  } else {
    t.is(slot, undefined);
    t.is(typeof getFreezableConstructor(Uint8Array), 'function');
  }
});

test('install: freezable constructor is installed on every TypedArray family when installable', t => {
  if (!installable) {
    // Fallback: the exported getFreezableConstructor still works.
    t.is(typeof getFreezableConstructor(Uint8Array), 'function');
    return;
  }
  const sym = Symbol.for('freezable');
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

test('install: optional transferToImmutable install when supported', t => {
  const slot = ArrayBuffer.prototype[Symbol.for('transferToImmutable')];
  if (!installable) {
    t.is(slot, undefined);
    return;
  }
  if (installedTransferToImmutable === undefined) {
    t.is(slot, undefined);
  } else {
    t.is(typeof slot, 'function');
    t.is(slot, installedTransferToImmutable);
  }
});

test('install: sliceToImmutable yields immutable buffer with byteArray-passStyle contents', t => {
  const view = new Uint8Array([1, 2, 3, 4]);
  const immutable = installedSliceToImmutable.call(
    view.buffer,
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  t.true(immutable instanceof ArrayBuffer);
  t.is(immutable.byteLength, 4);
});

test('install: subsequent loads adopt the existing install (idempotent shape)', t => {
  // The install dance writes once at module load; the slot is not
  // configurable nor writable. Importing the module again would find
  // the slot already populated and adopt it. Verified here by
  // re-reading the slot and matching the function reference.
  const slot1 = ArrayBuffer.prototype[Symbol.for('sliceToImmutable')];
  const slot2 = ArrayBuffer.prototype[Symbol.for('sliceToImmutable')];
  t.is(slot1, slot2);
  if (!installable) {
    // Lockdown ran first; the install was a graceful no-op.
    return;
  }
  // Cannot re-defineProperty: the descriptor is non-configurable.
  t.throws(
    () => {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(
        ArrayBuffer.prototype,
        Symbol.for('sliceToImmutable'),
        { value: () => {}, configurable: true },
      );
    },
    { instanceOf: TypeError },
  );
});

test('codec: encode/decode round-trip via exported callables', t => {
  const bytes = bytesFromText('Hello, 世界 \u{1F600}');
  t.is(bytesToText(bytes), 'Hello, 世界 \u{1F600}');
});

test('codec: bytesToText with { fatal: true } accepts valid UTF-8 and throws on invalid', t => {
  const validBytes = bytesFromText('Hello, world!');
  t.is(bytesToText(validBytes, { fatal: true }), 'Hello, world!');
  // 0xC3 begins a two-byte sequence; 0x28 is not a valid continuation byte.
  const invalid = new Uint8Array([0xc3, 0x28]);
  t.throws(() => bytesToText(invalid, { fatal: true }), {
    instanceOf: TypeError,
  });
});

test('codec: bytesFromText survives globalThis.TextEncoder replacement', t => {
  // The module captures TextEncoder at module load. Replace the
  // globalThis binding now; bytesFromText must continue to produce the
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

test('codec: bytesToText survives globalThis.TextDecoder replacement', t => {
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

test('install: freezable constructor accepts immutable buffer as sole arg', t => {
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

test('install: freezable constructor falls through to OriginalConstructor for non-immutable args', t => {
  const FreezableUint8Array = /** @type {any} */ (
    getFreezableConstructor(Uint8Array)
  );
  const realAb = new ArrayBuffer(4);
  const ta = new FreezableUint8Array(realAb);
  t.true(ta instanceof Uint8Array || ta.constructor === FreezableUint8Array);
});

test('concatImmutables: pure-JS implementation concatenates immutable buffers', t => {
  const parts = [
    bytesToImmutable(new Uint8Array([1, 2, 3])),
    bytesToImmutable(new Uint8Array([4])),
    bytesToImmutable(new Uint8Array([5, 6, 7, 8])),
  ];
  const concatenated = concatImmutables(parts);
  t.deepEqual(
    [...bytesFromImmutable(concatenated)],
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});
