/*---
description: >
  strictDecodeUtf8 decodes well-formed UTF-8 to a string without substitution.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/strict-decode-utf8.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

var encoded = encodeUtf8('Hello');
var result = strictDecodeUtf8(encoded);

assert.sameValue(result, 'Hello', 'valid UTF-8 decoded without error');
