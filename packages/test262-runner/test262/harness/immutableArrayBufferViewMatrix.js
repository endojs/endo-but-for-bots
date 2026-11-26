// Copyright (C) 2026 Endo contributors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
description: |
    Assert the observable mutable/immutable, genuine/emulated, and
    TypedArray/DataView behavior matrix for immutable ArrayBuffer hosts.
defines: [assertImmutableArrayBufferViewMatrix]
---*/

function assertImmutableArrayBufferViewMatrix(expected) {
  var mutableBuffer = new ArrayBuffer(4);
  var mutableArrayView = new Uint8Array(mutableBuffer);
  mutableArrayView.set([11, 22, 33, 44]);
  var mutableDataView = new DataView(mutableBuffer);

  assert.sameValue(
    'immutable' in mutableBuffer,
    expected.hasImmutableAccessor,
    expected.environment + ': immutable accessor presence',
  );
  if (expected.hasImmutableAccessor) {
    assert.sameValue(
      mutableBuffer.immutable,
      false,
      expected.environment + ': mutable buffer is mutable',
    );
  }
  assert.sameValue(
    Object.prototype.toString.call(mutableBuffer),
    '[object ArrayBuffer]',
    expected.environment + ': mutable buffer is genuine',
  );
  assert.sameValue(
    ArrayBuffer.isView(mutableArrayView),
    true,
    expected.environment + ': mutable array view is genuine',
  );
  assert.sameValue(
    mutableArrayView[1],
    22,
    expected.environment + ': mutable array view supports indexed reads',
  );
  mutableArrayView[1] = 23;
  assert.sameValue(
    mutableArrayView[1],
    23,
    expected.environment + ': mutable array view supports indexed writes',
  );
  assert.sameValue(
    ArrayBuffer.isView(mutableDataView),
    true,
    expected.environment + ': mutable DataView is genuine',
  );
  assert.sameValue(
    mutableDataView.getUint8(1),
    23,
    expected.environment + ': mutable DataView reads bytes',
  );
  Object.freeze(mutableDataView);
  mutableDataView.setUint8(1, 24);
  assert.sameValue(
    mutableDataView.getUint8(1),
    24,
    expected.environment + ': freezing a DataView does not freeze its buffer',
  );

  if (!expected.hasImmutableArrayBuffer) {
    assert.sameValue(
      typeof ArrayBuffer.prototype.sliceToImmutable,
      'undefined',
      expected.environment + ': bare host has no immutable-buffer constructor',
    );
    return;
  }

  var immutableBuffer = mutableBuffer.sliceToImmutable();
  var immutableArrayView = new Uint8Array(immutableBuffer);

  assert.sameValue(
    immutableBuffer.immutable,
    true,
    expected.environment + ': immutable buffer is branded immutable',
  );
  assert.sameValue(
    Object.prototype.toString.call(immutableBuffer),
    expected.immutableBufferTag,
    expected.environment + ': immutable buffer implementation shape',
  );

  // Immutable buffer read accessors report a fixed, non-resizable shape.
  assert.sameValue(
    immutableBuffer.byteLength,
    mutableBuffer.byteLength,
    expected.environment + ': immutable buffer reports its byteLength',
  );
  assert.sameValue(
    immutableBuffer.maxByteLength,
    immutableBuffer.byteLength,
    expected.environment + ': immutable buffer maxByteLength equals byteLength',
  );
  assert.sameValue(
    immutableBuffer.resizable,
    false,
    expected.environment + ': immutable buffer is not resizable',
  );
  assert.sameValue(
    immutableBuffer.detached,
    false,
    expected.environment + ': immutable buffer is not detached',
  );

  // The mutating ArrayBuffer methods reject an immutable receiver.
  assert.throws(
    TypeError,
    function () {
      immutableBuffer.resize(immutableBuffer.byteLength + 4);
    },
    expected.environment + ': immutable buffer rejects resize',
  );
  assert.throws(
    TypeError,
    function () {
      immutableBuffer.transfer();
    },
    expected.environment + ': immutable buffer rejects transfer',
  );
  assert.throws(
    TypeError,
    function () {
      immutableBuffer.transferToFixedLength();
    },
    expected.environment + ': immutable buffer rejects transferToFixedLength',
  );

  // `slice` on an immutable buffer produces a genuine, mutable copy.
  var immutableSlice = immutableBuffer.slice(0);
  assert.sameValue(
    immutableSlice.immutable,
    false,
    expected.environment + ': slice of an immutable buffer is mutable',
  );
  assert.sameValue(
    Object.prototype.toString.call(immutableSlice),
    '[object ArrayBuffer]',
    expected.environment + ': slice of an immutable buffer is genuine',
  );
  assert.sameValue(
    immutableSlice.byteLength,
    immutableBuffer.byteLength,
    expected.environment + ': slice of an immutable buffer copies the length',
  );
  assert.sameValue(
    new Uint8Array(immutableSlice)[1],
    24,
    expected.environment + ': slice of an immutable buffer copies the bytes',
  );

  // `transferToImmutable` yields an immutable buffer and detaches its source.
  assert.sameValue(
    typeof ArrayBuffer.prototype.transferToImmutable,
    'function',
    expected.environment +
      ': transferToImmutable is present, genuine or emulated',
  );
  var transferSource = new ArrayBuffer(4);
  new Uint8Array(transferSource).set([5, 6, 7, 8]);
  var transferred = transferSource.transferToImmutable();
  assert.sameValue(
    transferred.immutable,
    true,
    expected.environment + ': transferToImmutable yields an immutable buffer',
  );
  assert.sameValue(
    Object.prototype.toString.call(transferred),
    expected.immutableBufferTag,
    expected.environment + ': transferToImmutable result implementation shape',
  );
  assert.sameValue(
    transferSource.detached,
    true,
    expected.environment + ': transferToImmutable detaches its source',
  );
  assert.sameValue(
    new Uint8Array(transferred).at(0),
    5,
    expected.environment + ': transferToImmutable preserves the bytes',
  );

  assert.sameValue(
    ArrayBuffer.isView(immutableArrayView),
    !expected.immutableArrayViewIsEmulated,
    expected.environment + ': immutable array view genuineness',
  );
  assert.sameValue(
    immutableArrayView[1],
    expected.immutableArrayViewIsEmulated ? undefined : 24,
    expected.environment + ': immutable array view indexed read',
  );
  assert.sameValue(
    immutableArrayView.at(1),
    24,
    expected.environment + ': immutable array view method read',
  );
  if (expected.immutableArrayViewCanBeFrozen) {
    assert.sameValue(
      Object.freeze(immutableArrayView),
      immutableArrayView,
      expected.environment + ': immutable array view can be frozen',
    );
    assert.sameValue(
      Object.isFrozen(immutableArrayView),
      true,
      expected.environment + ': immutable array view reports frozen',
    );
  } else {
    assert.throws(
      TypeError,
      function () {
        Object.freeze(immutableArrayView);
      },
      expected.environment + ': immutable array view cannot be frozen',
    );
  }
  assert.throws(
    TypeError,
    function () {
      immutableArrayView.set([99], 1);
    },
    expected.environment + ': immutable array view rejects method writes',
  );

  // The mutating TypedArray methods reject an immutable-backed view.
  assert.throws(
    TypeError,
    function () {
      immutableArrayView.copyWithin(0, 1);
    },
    expected.environment + ': immutable array view rejects copyWithin',
  );
  assert.throws(
    TypeError,
    function () {
      immutableArrayView.fill(0);
    },
    expected.environment + ': immutable array view rejects fill',
  );
  assert.throws(
    TypeError,
    function () {
      immutableArrayView.reverse();
    },
    expected.environment + ': immutable array view rejects reverse',
  );
  assert.throws(
    TypeError,
    function () {
      immutableArrayView.sort();
    },
    expected.environment + ': immutable array view rejects sort',
  );

  // `subarray` stays backed by the immutable buffer and stays read-only.
  var immutableSubarray = immutableArrayView.subarray(1, 3);
  assert.sameValue(
    immutableSubarray.buffer.immutable,
    true,
    expected.environment +
      ': subarray of an immutable view stays immutable-backed',
  );
  assert.sameValue(
    ArrayBuffer.isView(immutableSubarray),
    !expected.immutableArrayViewIsEmulated,
    expected.environment + ': subarray of an immutable view genuineness',
  );
  assert.sameValue(
    immutableSubarray.at(0),
    24,
    expected.environment + ': subarray of an immutable view reads through',
  );
  assert.throws(
    TypeError,
    function () {
      immutableSubarray.fill(0);
    },
    expected.environment + ': subarray of an immutable view rejects writes',
  );

  if (expected.immutableDataViewConstructs) {
    var immutableDataView = new DataView(immutableBuffer);
    assert.sameValue(
      ArrayBuffer.isView(immutableDataView),
      !expected.immutableDataViewIsEmulated,
      expected.environment + ': immutable DataView implementation shape',
    );
    assert.sameValue(
      Object.prototype.toString.call(immutableDataView),
      '[object DataView]',
      expected.environment + ': immutable DataView preserves its brand',
    );
    assert.sameValue(
      immutableDataView.buffer,
      immutableBuffer,
      expected.environment + ': immutable DataView exposes its buffer',
    );
    assert.sameValue(
      immutableDataView.getUint8(1),
      24,
      expected.environment + ': immutable DataView reads bytes',
    );
    assert.sameValue(
      Object.freeze(immutableDataView),
      immutableDataView,
      expected.environment + ': immutable DataView can be frozen',
    );
    assert.sameValue(
      Object.isFrozen(immutableDataView),
      true,
      expected.environment + ': immutable DataView reports frozen',
    );
    assert.throws(
      TypeError,
      function () {
        immutableDataView.setUint8(1, 99);
      },
      expected.environment + ': immutable DataView rejects writes',
    );

    // Non-Uint8 DataView accessors read through but reject writes.
    var expectedInt16 =
      (immutableDataView.getUint8(0) << 8) | immutableDataView.getUint8(1);
    assert.sameValue(
      immutableDataView.getInt16(0),
      expectedInt16,
      expected.environment + ': immutable DataView reads Int16',
    );
    assert.throws(
      TypeError,
      function () {
        immutableDataView.setInt16(0, 0);
      },
      expected.environment + ': immutable DataView rejects Int16 writes',
    );
    assert.throws(
      TypeError,
      function () {
        immutableDataView.setFloat32(0, 1.5);
      },
      expected.environment + ': immutable DataView rejects Float32 writes',
    );
  } else {
    assert.throws(
      TypeError,
      function () {
        new DataView(immutableBuffer);
      },
      expected.environment + ': immutable DataView is unavailable',
    );
  }
}
