/*---
description: immutable pass-style bytes match the native or winning-shim shape
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var bytes = frozenBytes(new Uint8Array([9, 8, 7]));

if (ArrayBuffer.isView(bytes)) {
  assert.sameValue(Reflect.ownKeys(bytes).length, bytes.length);
} else {
  assert.sameValue(Reflect.ownKeys(bytes).length, 0);
}
