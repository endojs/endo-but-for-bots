/*---
description: >
  encodeUtf8 followed by decodeUtf8 round-trips ASCII and multi-byte Unicode
  strings without loss.
  Validates XS+SES / Node.js+SES parity for the encodeUtf8/decodeUtf8 pair.
features: [ses-xs-parity,immutable-arraybuffer,pass-style-bytes]
---*/

function roundTrip(s) {
  return decodeUtf8(encodeUtf8(s));
}

assert.sameValue(roundTrip(''), '', 'empty string');
assert.sameValue(roundTrip('Hello, world!'), 'Hello, world!', 'ASCII string');
assert.sameValue(roundTrip('café'), 'café', 'U+00E9 two-byte');
assert.sameValue(roundTrip('中文'), '中文', 'CJK three-byte');
assert.sameValue(
  roundTrip('😀'),
  '😀',
  'emoji four-byte surrogate pair'
);
