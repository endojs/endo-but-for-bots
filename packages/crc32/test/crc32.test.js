// @ts-check

import test from 'ava';

import { bytesFromText } from '@endo/bytes/from-string.js';

import { crc32 } from '../index.js';

const checkBytes = bytesFromText('123456789');

test('matches the IEEE CRC-32 check value', t => {
  t.is(crc32(checkBytes), 0xcbf4_3926);
});

test('computes a byte range', t => {
  const framed = bytesFromText('xx123456789yy');
  t.is(crc32(framed, checkBytes.length, 2), 0xcbf4_3926);
  t.is(crc32(framed, 0, 2), 0);
});

test('continues incrementally from a prior checksum', t => {
  const first = crc32(checkBytes, 4);
  t.is(crc32(checkBytes, 5, 4, first), crc32(checkBytes));

  let checksum = 0;
  for (let index = 0; index < checkBytes.length; index += 1) {
    checksum = crc32(checkBytes, 1, index, checksum);
  }
  t.is(checksum, 0xcbf4_3926);
});

test('rejects invalid inputs and ranges', t => {
  t.throws(() => crc32(/** @type {any} */ ('123456789')), {
    instanceOf: TypeError,
  });
  t.throws(() => crc32(new Uint8Array(2), 2, 1), {
    instanceOf: RangeError,
  });
  t.throws(() => crc32(new Uint8Array(2), -1), {
    instanceOf: RangeError,
  });
  // A negative `index` must throw, not wrap through `.at`'s relative indexing
  // into a silently-wrong checksum.
  t.throws(() => crc32(new Uint8Array(2), 1, -1), {
    instanceOf: RangeError,
  });
  t.throws(() => crc32(new Uint8Array(2), 1, 1.5), {
    instanceOf: RangeError,
  });
  t.throws(() => crc32(new Uint8Array(2), 1, 0, 2 ** 32), {
    instanceOf: RangeError,
  });
});

test('accepts a conforming emulated byte-array view via the .at protocol', t => {
  // A stand-in for an emulated immutable/mutable ArrayBuffer view: it satisfies
  // the `.at`/`.length` protocol through its own conforming implementations
  // rather than the genuine `Uint8Array` intrinsics.
  const emulatedView = Object.freeze({
    length: checkBytes.length,
    at: index => checkBytes[index],
  });
  t.is(crc32(/** @type {any} */ (emulatedView)), 0xcbf4_3926);
});

test('rejects a non-conforming proxy over a Uint8Array', t => {
  // A bare proxy forwards `.at`/`.length` to the brand-checking intrinsics,
  // which throw on the proxy receiver, so it does not conform to the protocol.
  // It is also not an `ArrayBuffer` view, so it takes the `.at` path, not the
  // indexed fast path.
  const proxy = new Proxy(new Uint8Array([1, 2, 3]), {});
  t.throws(() => crc32(proxy), { instanceOf: TypeError });
});

test('an emulated .at that yields a non-byte throws rather than coercing', t => {
  // A lying emulated view must not produce a plausible-but-wrong checksum: an
  // `.at` returning `undefined` used to fold to a zero byte (`x & 0xff` of a
  // coerced `NaN`), yielding the checksum of zero bytes with no error.
  t.throws(
    () =>
      crc32(
        /** @type {any} */ (Object.freeze({ length: 3, at: () => undefined })),
      ),
    { instanceOf: TypeError },
  );
  t.throws(
    () =>
      crc32(/** @type {any} */ (Object.freeze({ length: 3, at: () => '7' }))),
    { instanceOf: TypeError },
  );
  t.throws(
    () =>
      crc32(/** @type {any} */ (Object.freeze({ length: 3, at: () => 256 }))),
    { instanceOf: TypeError },
  );
});

test('reads Int8Array and Uint8ClampedArray as the same bytes', t => {
  // Both are genuine single-byte views (length === byteLength), so they take
  // the indexed fast path and must agree with the Uint8Array checksum of the
  // same underlying bytes — Int8Array reinterprets bytes as signed, but
  // `checksum ^ byte & 0xff` recovers the unsigned byte.
  const bytes = [0, 1, 127, 128, 200, 255];
  const reference = crc32(new Uint8Array(bytes));
  t.is(crc32(new Int8Array(new Uint8Array(bytes).buffer)), reference);
  t.is(crc32(new Uint8ClampedArray(bytes)), reference);
});

test('a non-byte view is not read through the indexed fast path', t => {
  // `ArrayBuffer.isView` is true for every DataView and every typed-array
  // element kind, so the old fast path silently folded a wide view's elements
  // (or a DataView's undefined indexed reads) as if they were bytes. The
  // `[Symbol.toStringTag]` byte-view brand rejects a multi-byte view outright
  // and routes a DataView to the validating `.at`/`.length` path instead.
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  // A DataView is not a genuine single-byte view, so it falls to the emulated
  // branch; it has no numeric `.length`, so it is rejected rather than
  // checksummed as four zero bytes (the wrong-checksum failure the brand exists
  // to prevent), whether or not an explicit range is supplied.
  t.throws(() => crc32(/** @type {any} */ (new DataView(buffer))), {
    instanceOf: RangeError,
  });
  t.throws(() => crc32(/** @type {any} */ (new DataView(buffer)), 4), {
    instanceOf: RangeError,
  });
  // A multi-byte view is a genuine typed array whose elements are not bytes.
  // Reading it through `.at` would checksum its element *values*, not the
  // underlying bytes — historically identical to a plain Uint8Array of the same
  // small numbers. It must throw for EVERY element value, not only those that
  // happen to exceed 255, so the wrong-checksum path is closed rather than
  // merely narrowed.
  for (const wide of [
    new Uint16Array([256, 257]), // elements > 255 (the old test's only case)
    new Uint16Array([1, 2, 3, 4]), // elements <= 255: silently wrong before the fix
    new Uint32Array(4), // all-zero wide view
    new Float64Array([0, 1, 2]),
    new Int16Array([1, 2, 3]),
    new Uint16Array(0), // zero-length wide view
  ]) {
    t.throws(() => crc32(/** @type {any} */ (wide)), {
      instanceOf: TypeError,
    });
  }
  // Sanity: the small-element wide view is NOT equal to the byte view of the
  // same numbers (it would have been, silently, before the fix).
  t.throws(() => crc32(/** @type {any} */ (new Uint16Array([1, 2, 3, 4]))));
});

test('an emulated view with a non-integer length is rejected', t => {
  // The emulated `.at`/`.length` branch must validate `.length` as a
  // non-negative safe integer. An untrusted `NaN`/`undefined`/non-numeric
  // `.length` otherwise makes both bounds comparisons vacuously false, so the
  // range guard becomes a no-op: an explicit `length` argument then reads past
  // the view's real end, and a huge `.length` spins an unbounded loop.
  const at = () => 0;
  for (const length of [Number.NaN, undefined, 'abc', 1.5, -1, {}]) {
    t.throws(
      () =>
        crc32(/** @type {any} */ (Object.freeze({ length, at })), undefined, 0),
      { instanceOf: RangeError },
      `length ${String(length)} must be rejected`,
    );
  }
  // The classic attack: a spoofed length lets an explicit range read out of
  // bounds. With validation, the bad length is caught before the range guard.
  t.throws(
    () =>
      crc32(/** @type {any} */ (Object.freeze({ length: Number.NaN, at })), 8),
    { instanceOf: RangeError },
  );
});

test('a length-overriding subclass cannot forge the byte range', t => {
  // The fast path reads the true intrinsic length through the captured
  // `%TypedArray%.prototype` getter, so a subclass whose own `length` getter
  // lies cannot drive out-of-range reads that fold as zero bytes.
  class Spoofed extends Uint8Array {
    // eslint-disable-next-line class-methods-use-this
    get length() {
      return 8;
    }
  }
  const spoofed = new Spoofed(new Uint8Array([1, 2, 3, 4]).buffer);
  // The true length is 4; a range of 8 must be rejected, not read past the
  // real bytes as zeroes.
  t.throws(() => crc32(spoofed, 8), { instanceOf: RangeError });
  // Consuming the true 4 bytes agrees with a plain Uint8Array over them.
  t.is(crc32(spoofed), crc32(new Uint8Array([1, 2, 3, 4])));
});

test('an emulated view length above 2**32 - 1 is rejected', t => {
  // Fail fast rather than hang to the package timeout: this guards a resource
  // exhaustion regression, so a reverted cap must redden promptly, not spin the
  // `.at` loop until AVA's 2-minute wall.
  t.timeout(30_000);
  // A safe integer alone still admits values up to `Number.MAX_SAFE_INTEGER`,
  // so a tiny object could declare that length and spin the `.at` loop for
  // order-of-a-year of synchronous CPU. The length must additionally be bounded
  // by what a real single-byte view could back (`2**32 - 1`). Validate the
  // length-check throw WITHOUT ever entering the loop.
  const at = () => 0;
  t.throws(
    () =>
      crc32(
        /** @type {any} */ (
          Object.freeze({ length: Number.MAX_SAFE_INTEGER, at })
        ),
      ),
    { instanceOf: RangeError },
  );
  // Just over the cap also throws.
  t.throws(
    () =>
      crc32(
        /** @type {any} */ (Object.freeze({ length: 0xffff_ffff + 1, at })),
      ),
    { instanceOf: RangeError },
  );
  // The cap itself passes the length check: consuming a zero-length range does
  // not iterate, so an object declaring the maximum length still returns the
  // empty-input checksum without spinning the loop.
  t.is(
    crc32(/** @type {any} */ (Object.freeze({ length: 0xffff_ffff, at })), 0),
    crc32(new Uint8Array(0)),
  );
});

test('a view over a detached ArrayBuffer throws rather than checksumming as empty', t => {
  // A detached (transferred) view's intrinsic `length` getter returns 0 rather
  // than throwing, so an unchecked detached view would silently checksum as
  // empty — indistinguishable from a real zero-length view. It must throw.
  const view = new Uint8Array([1, 2, 3, 4]);
  structuredClone(view.buffer, { transfer: [view.buffer] });
  t.true(view.buffer.detached);
  t.throws(() => crc32(view), { instanceOf: TypeError });
});

test('a view out of bounds over a shrunk resizable ArrayBuffer throws rather than checksumming as empty', t => {
  // A fixed-length view whose window exceeds a shrunk resizable ArrayBuffer is
  // out of bounds, NOT detached: a construct-a-zero-length-view detach probe
  // succeeds (the buffer is live), and the intrinsic `length` getter returns 0
  // without throwing — byte-identical to a real empty view. Probing with the
  // intrinsic `.at` (whose ValidateTypedArray step throws for out-of-bounds
  // too) closes this. Guarded so the suite still runs where resizable
  // ArrayBuffers are unavailable.
  if (typeof ArrayBuffer.prototype.resize !== 'function') {
    t.pass('resizable ArrayBuffer unavailable on this engine');
    return;
  }
  const rab = new ArrayBuffer(10, { maxByteLength: 10 });
  const view = new Uint8Array(rab, 0, 10);
  view.fill(7);
  const live = crc32(view);
  t.not(live, crc32(new Uint8Array(0)));
  rab.resize(2);
  // The view is now out of bounds; its intrinsic length reads 0.
  t.is(view.length, 0);
  t.throws(() => crc32(view), { instanceOf: TypeError });
});

test('a shadowed `detached: false` own property cannot defeat the detach guard', t => {
  // The guard must not read `buffer.detached` as a plain property: an own data
  // property shadows the ES2024 accessor, and reading it directly would fail the
  // guard open on a genuinely detached buffer. Probing detachment by
  // constructing a zero-length view over the intrinsic buffer is unspoofable, so
  // this still throws.
  const view = new Uint8Array([1, 2, 3, 4]);
  const { buffer } = view;
  Object.defineProperty(buffer, 'detached', { value: false });
  structuredClone(buffer, { transfer: [buffer] });
  t.is(/** @type {any} */ (buffer).detached, false); // the planted own property
  t.throws(() => crc32(view), { instanceOf: TypeError });
});

test('a throwing .at getter surfaces as a branded TypeError', t => {
  // The untrusted `.at` property read must be wrapped like the `.length` read:
  // a throwing `.at` getter must surface as a branded `@endo/crc32:` TypeError,
  // not escape as a raw non-branded error.
  const throwingAt = Object.freeze(
    Object.defineProperty({ length: 3 }, 'at', {
      get() {
        throw Error('boom');
      },
    }),
  );
  const error = t.throws(() => crc32(/** @type {any} */ (throwingAt)), {
    instanceOf: TypeError,
  });
  t.true(error.message.startsWith('@endo/crc32:'));
});

test('exports a hardened function', t => {
  t.true(Object.isFrozen(crc32));
});
