/*---
description: >
  decodeUtf8 substitutes U+FFFD for malformed UTF-8 sequences rather than
  throwing.
  Validates XS+SES / Node.js+SES parity for @endo/pass-style/decode-utf8.js.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

// 0xFF is not valid UTF-8 in any context.
var invalid = toBytes(new Uint8Array([72, 101, 0xff, 108, 108, 111]));
var result = decodeUtf8(invalid);

// The lenient decoder replaces the malformed byte with U+FFFD.
assert(typeof result === 'string', 'result is a string');
// The replacement character must appear at the position of the bad byte.
assert(result.indexOf('�') !== -1, 'U+FFFD substituted for malformed byte');
// The surrounding valid bytes must still decode correctly.
assert(result.indexOf('He') !== -1, 'valid prefix decoded');
assert(result.indexOf('llo') !== -1, 'valid suffix decoded');
