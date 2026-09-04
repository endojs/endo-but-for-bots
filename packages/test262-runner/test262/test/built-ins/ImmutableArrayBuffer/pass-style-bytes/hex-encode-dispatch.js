/*---
description: encodeHex handles genuine (mutable and immutable) and emulated views by dispatching on ArrayBuffer.isView, matching the known hex the polyfill produces
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

// `encodeHex` chooses the native `Uint8Array.prototype.toHex` fast path for
// every genuine `Uint8Array` view — mutable or backed by a genuine immutable
// ArrayBuffer — discriminating on `ArrayBuffer.isView`, never on buffer
// immutability. An emulated `@endo/immutable-arraybuffer` wrapper
// (`isView === false`) that native C++ cannot read falls through to the
// pure-JavaScript polyfill, which thaws it. Across all three shapes the encoder
// must produce the same lowercase hex the polyfill produces for these bytes.

var sample = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x41];
var expected = '00017f80ff41';

var mutable = new Uint8Array(sample);
var frozen = frozenBytes(mutable);
var thawed = thawedBytes(frozen);

// The native intrinsic, when the host provides it. It is the fast path
// `encodeHex` selects for genuine views; probing it directly is what makes
// this test sensitive to the genuine-vs-emulated distinction rather than
// merely to output correctness (native and polyfill agree on output).
var toHex = Uint8Array.prototype.toHex;
var nativeToHex = typeof toHex === 'function' ? toHex : undefined;
var nativeHandles = function (view) {
  try {
    return Reflect.apply(nativeToHex, view, []) === expected;
  } catch (error) {
    return false;
  }
};

// Plain mutable genuine view: dispatched output matches the known hex, and the
// native intrinsic (when present) reads it directly.
assert.sameValue(encodeHex(mutable), expected, 'dispatched mutable');
assert.sameValue(ArrayBuffer.isView(mutable), true, 'mutable is a genuine view');
if (nativeToHex !== undefined) {
  assert.sameValue(nativeHandles(mutable), true, 'native reads mutable view');
}

// A thawed view is a plain mutable genuine Uint8Array again.
assert.notSameValue(thawed.buffer.immutable, true);
assert.sameValue(encodeHex(thawed), expected, 'dispatched thawed');

// The frozen byteArray form is a genuine immutable view on hosts with native
// immutable ArrayBuffers and an emulated wrapper otherwise.
assert.sameValue(frozen.buffer.immutable, true);
assert.sameValue(Object.isFrozen(frozen), true);

if (ArrayBuffer.isView(frozen)) {
  // Genuine immutable view: the native fast path must read it directly and
  // still produce the correct hex. A regression that re-added an immutability
  // gate here would wrongly divert this genuine view to the polyfill.
  assert.sameValue(encodeHex(frozen), expected, 'genuine immutable frozen');
  if (nativeToHex !== undefined) {
    assert.sameValue(
      nativeHandles(frozen),
      true,
      'native reads genuine immutable view',
    );
  }
} else {
  // Emulated wrapper: native C++ cannot read it (it has no TypedArray internal
  // slots), so the native intrinsic fails on it — which is exactly why
  // encodeHex must dispatch on `isView` and fall through to the polyfill here
  // rather than to the intrinsic.
  assert.sameValue(encodeHex(frozen), expected, 'emulated frozen');
  if (nativeToHex !== undefined) {
    assert.sameValue(
      nativeHandles(frozen),
      false,
      'native cannot read emulated wrapper',
    );
  }
}
