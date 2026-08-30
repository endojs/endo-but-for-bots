/*---
description: mutable and immutable ArrayBuffer view behavior in Node+SES and XS+SES
includes: [immutableArrayBufferViewMatrix.js]
features: [ses-xs-parity,immutable-arraybuffer]
---*/

// The current observable contract is explicit rather than skipped by host:
//
// Host       Buffer                 Uint8Array                 DataView
// Node+SES   mutable, genuine       genuine, read/write        genuine, read/write
// Node+SES   immutable, emulated    emulated, frozen           emulated, frozen
// XS+SES     mutable, genuine       genuine, read/write        genuine, read/write
// XS+SES     immutable, genuine     genuine, frozen            genuine, frozen
//
// The shared harness also has the genuine-immutable branches needed when an
// engine supplies the complete proposal surface. Changing either expectation
// from emulated to genuine makes those assertions active instead.
var expectedByEnvironment = {
  'node-ses': {
    environment: 'Node+SES',
    hasImmutableAccessor: true,
    hasImmutableArrayBuffer: true,
    immutableBufferTag: '[object emulated immutable ArrayBuffer]',
    immutableArrayViewIsEmulated: true,
    immutableArrayViewCanBeFrozen: true,
    immutableDataViewConstructs: true,
    immutableDataViewIsEmulated: true,
  },
  'xs-ses': {
    environment: 'XS+SES',
    hasImmutableAccessor: true,
    hasImmutableArrayBuffer: true,
    immutableBufferTag: '[object ArrayBuffer]',
    immutableArrayViewIsEmulated: false,
    immutableArrayViewCanBeFrozen: true,
    immutableDataViewConstructs: true,
    immutableDataViewIsEmulated: false,
  },
};

assert.notSameValue(
  expectedByEnvironment[environment],
  undefined,
  'the SES host must identify its explicit behavior contract',
);
assertImmutableArrayBufferViewMatrix(
  expectedByEnvironment[environment],
);
