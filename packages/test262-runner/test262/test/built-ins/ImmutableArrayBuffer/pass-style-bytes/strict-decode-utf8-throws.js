/*---
description: >
  strictDecodeUtf8 throws a TypeError on malformed UTF-8, not substituting
  U+FFFD.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/strict-decode-utf8.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

// 0xFF is not valid UTF-8 in any context.
var invalid = frozenBytes(new Uint8Array([72, 101, 0xff, 108, 108, 111]));

assert.throws(TypeError, function () {
  strictDecodeUtf8(invalid);
}, 'TypeError thrown for malformed UTF-8');
