// @ts-check

import '@endo/init';

import test from 'ava';
import { Far } from '@endo/pass-style';
import { frozenBytes, thawedBytes } from '@endo/immutable-arraybuffer';
import { makeCopySet } from '@endo/patterns';

import { marshalItem, unmarshalItem } from '../index.js';

test('document values round trip without SDK objects', t => {
  const item = harden({
    text: 'value',
    integer: 42,
    large: 9_007_199_254_740_993n,
    binary: frozenBytes(new Uint8Array([1, 2, 3])),
    list: harden([true, null]),
    map: harden({ nested: 'yes' }),
    set: makeCopySet(['a', 'b']),
  });
  const { binary, ...rest } = unmarshalItem(marshalItem(item));
  const { binary: original, ...expected } = item;
  t.deepEqual(rest, expected);
  t.true(Object.isFrozen(binary), 'bytes come back passable');
  t.deepEqual(
    [...thawedBytes(/** @type {Uint8Array} */ (binary))],
    [...thawedBytes(/** @type {Uint8Array} */ (original))],
  );
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

test('number sets and fractions round trip with integer precision', t => {
  const item = harden({
    numbers: makeCopySet([1, 2.5, 9_007_199_254_740_993n]),
    fraction: -0.5,
  });
  const wire = marshalItem(item);
  t.deepEqual(wire.fraction, { N: '-0.5' });
  t.deepEqual([...wire.numbers.NS].sort(), ['1', '2.5', '9007199254740993']);
  t.deepEqual(unmarshalItem(wire), item);
  t.throws(() => marshalItem(harden({ empty: makeCopySet([]) })), {
    message: 'DynamoDB sets cannot be empty',
  });
  t.throws(() => marshalItem(harden({ mixed: makeCopySet(['a', 1]) })), {
    message: 'DynamoDB sets must contain values of one scalar type',
  });
});

test('unrecognized wire attributes and pass styles are rejected', t => {
  t.throws(() => unmarshalItem(harden({ odd: harden({ X: 'y' }) })), {
    message: 'Invalid DynamoDB AttributeValue',
  });
  t.throws(
    () => marshalItem(/** @type {any} */ (harden({ undef: undefined }))),
    {
      message: 'Unsupported DynamoDB value pass style "undefined"',
    },
  );
});
