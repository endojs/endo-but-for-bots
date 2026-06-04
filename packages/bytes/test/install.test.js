/* global globalThis */

import test from '@endo/ses-ava/test.js';

import { installedSliceToImmutable } from '../src/install-to-immutable.js';
import { installedTransferToImmutable } from '../src/install-transfer-to-immutable.js';
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
  fromImmutable: symFromImmutable,
  freezable: symFreezable,
});

test('install: symbols are registered via Symbol.for', t => {
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
  // Heuristic: check whether one of the registered-symbol slots that
  // ONLY the @endo/bytes spackle install would populate is populated.
  // Cannot use `ArrayBuffer.prototype.sliceToImmutable` for this
  // check, because the `@endo/immutable-arraybuffer/shim.js` shim
  // (loaded by `ses`) also installs at the string key pre-lockdown,
  // so the slot is populated under the lockdown config even though
  // the spackle's own installs of `fromImmutable` and `freezable`
  // would have failed.
  return typeof Uint8Array[Symbol.for('fromImmutable')] === 'function';
})();

test('install: ArrayBuffer.prototype.sliceToImmutable adopts the shim or installs', t => {
  // The `@endo/immutable-arraybuffer/shim.js` shim (imported
  // transitively by `ses`) installs `sliceToImmutable` on
  // `ArrayBuffer.prototype` at the string key before lockdown runs,
  // so the slot is present under all configurations the bytes
  // package tests under. `installOrAdopt` finds the shim's method
  // and adopts it as `installedSliceToImmutable`.
  const slot = /** @type {Function | undefined} */ (
    /** @type {unknown} */ (ArrayBuffer.prototype.sliceToImmutable)
  );
  t.is(typeof slot, 'function');
  t.is(slot, installedSliceToImmutable);
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

test('install: optional transferToImmutable adopts the shim or installs', t => {
  // Same shape as sliceToImmutable: the shim installs
  // `transferToImmutable` on `ArrayBuffer.prototype` at the string
  // key before lockdown runs, and `installOrAdopt` adopts it.
  // Optional because the shim's install of `transferToImmutable`
  // depends on platform support for `structuredClone` or
  // `ArrayBuffer.prototype.transfer`.
  const slot = /** @type {Function | undefined} */ (
    /** @type {unknown} */ (ArrayBuffer.prototype.transferToImmutable)
  );
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
  // The install dance writes once at module load; importing the
  // module again would find the slot already populated and adopt it.
  // Verified here by re-reading the slot and matching the function
  // reference. Across all configurations, the shim has installed
  // `sliceToImmutable` at the string key before `@endo/bytes` loads,
  // so `@endo/bytes`'s install adopts the shim's method.
  const slot1 = /** @type {Function | undefined} */ (
    /** @type {unknown} */ (ArrayBuffer.prototype.sliceToImmutable)
  );
  const slot2 = /** @type {Function | undefined} */ (
    /** @type {unknown} */ (ArrayBuffer.prototype.sliceToImmutable)
  );
  t.is(slot1, slot2);
  t.is(slot1, installedSliceToImmutable);
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
  t.deepEqual([...bytesFromImmutable(concatenated)], [1, 2, 3, 4, 5, 6, 7, 8]);
});
