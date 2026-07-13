import test from '@endo/ses-ava/prepare-endo.js';

import {
  decodeBase64Url,
  encodeBase64Url,
} from '../providers/oauth/base64url.js';

test('encodeBase64Url round-trips through decodeBase64Url at every length residue', t => {
  for (let len = 0; len <= 8; len += 1) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = (i * 37 + 11) % 256;
    }
    const encoded = encodeBase64Url(bytes);
    // base64url alphabet only, and no trailing padding.
    t.regex(
      encoded,
      /^[A-Za-z0-9\-_]*$/u,
      `length ${len} uses the url alphabet`,
    );
    t.deepEqual(decodeBase64Url(encoded), bytes, `round-trip at length ${len}`);
  }
});

test('encodeBase64Url emits neither + / nor padding on bytes that force them', t => {
  // These bytes produce '+' and '/' (and padding) under standard base64; the
  // url-safe encoder must substitute '-'/'_' and drop the padding.
  const bytes = new Uint8Array([0xff, 0xff, 0xfe, 0xfb, 0xff]);
  const encoded = encodeBase64Url(bytes);
  t.false(encoded.includes('+'), 'no +');
  t.false(encoded.includes('/'), 'no /');
  t.false(encoded.includes('='), 'no padding');
  t.deepEqual(decodeBase64Url(encoded), bytes);
});

test('decodeBase64Url accepts input with or without trailing padding', t => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  t.deepEqual(decodeBase64Url('AQIDBAU'), bytes);
  t.deepEqual(decodeBase64Url('AQIDBAU='), bytes);
});
