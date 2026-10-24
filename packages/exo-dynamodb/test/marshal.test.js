// @ts-check

import '@endo/init';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { makeCopySet } from '@endo/patterns';

import { marshalItem, unmarshalItem } from '../index.js';

test('document values round trip without SDK objects', t => {
  const item = harden({
    text: 'value',
    integer: 42,
    large: 9_007_199_254_740_993n,
    binary: new Uint8Array([1, 2, 3]),
    list: harden([true, null]),
    map: harden({ nested: 'yes' }),
    set: makeCopySet(['a', 'b']),
  });
  t.deepEqual(unmarshalItem(marshalItem(item)), item);
});

test('remotables and invalid numbers are rejected', t => {
  t.throws(
    () =>
      marshalItem(/** @type {any} */ (harden({ remote: Far('remote', {}) }))),
    {
      message: 'DynamoDB items cannot contain remotables',
    },
  );
  t.throws(() => marshalItem(harden({ number: Infinity })), {
    message: 'DynamoDB numbers must be finite',
  });
});
