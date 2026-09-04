/*---
description: mutable and immutable ArrayBuffer view behavior across Hardened JavaScript agents
includes: [immutableArrayBufferViewMatrix.js]
flags: [onlyRaw]
---*/

// This test pins the native XS surface only. The `onlyRaw` harness flag keeps
// the emulated SES hosts out of this engine-conformance matrix.
assertImmutableArrayBufferViewMatrix({
  environment: 'bare XS',
  immutableBufferTag: '[object ArrayBuffer]',
  immutableArrayViewIsEmulated: false,
  immutableDataViewIsEmulated: false,
});
