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
