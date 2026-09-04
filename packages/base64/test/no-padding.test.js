import test from 'ava';

import { decodeBase64NoPadding } from '@endo/base64/no-padding-decode';
import { encodeBase64NoPadding } from '@endo/base64/no-padding-encode';

/** @type {Array<[number[], string]>} */
const examples = [
  [[], ''],
  [[102], 'Zg'],
  [[102, 111], 'Zm8'],
  [[102, 111, 111], 'Zm9v'],
  [[102, 111, 111, 98], 'Zm9vYg'],
  [[102, 111, 111, 98, 97], 'Zm9vYmE'],
  [[102, 111, 111, 98, 97, 114], 'Zm9vYmFy'],
];

test('encodes Base64 without padding', t => {
  for (const [numbers, encoded] of examples) {
    t.is(encodeBase64NoPadding(new Uint8Array(numbers)), encoded);
  }
});

test('decodes Base64 with omitted or canonical padding', t => {
  for (const [numbers, encoded] of examples) {
    const expected = new Uint8Array(numbers);
    t.deepEqual(decodeBase64NoPadding(encoded), expected);
    const paddingLength = (4 - (encoded.length % 4)) % 4;
    const padded = `${encoded}${'='.repeat(paddingLength)}`;
    t.deepEqual(decodeBase64NoPadding(padded), expected);
  }
});

test('rejects invalid unpadded Base64', t => {
  t.throws(() => decodeBase64NoPadding('Z'), {
    message: 'Invalid base64 string length 1 for string <unknown>',
  });
  t.throws(() => decodeBase64NoPadding('Zm%'), {
    message: /Invalid base64 character %/,
  });
});
