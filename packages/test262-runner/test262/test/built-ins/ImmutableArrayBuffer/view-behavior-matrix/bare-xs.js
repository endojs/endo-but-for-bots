/*---
description: mutable and immutable ArrayBuffer view behavior in bare XS
includes: [immutableArrayBufferViewMatrix.js]
features: [xs-bare-arraybuffer-matrix]
---*/

// Moddable 9.0.0 supplies native immutable ArrayBuffer and freezable view
// support. This case exercises the engine without the Endo shim.
assertImmutableArrayBufferViewMatrix({
  environment: 'bare XS',
  hasImmutableAccessor: true,
  hasImmutableArrayBuffer: true,
  immutableBufferTag: '[object ArrayBuffer]',
  immutableArrayViewIsEmulated: false,
  immutableArrayViewCanBeFrozen: true,
  immutableDataViewConstructs: true,
  immutableDataViewIsEmulated: false,
});
