import test from '@endo/ses-ava/prepare-endo.js';

import {
  asyncIterate,
  makeIteratorRef,
  makeReaderRef,
} from '../src/fs/reader-ref.js';

test('asyncIterate handles async iterable', t => {
  const asyncIter = {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        async next() {
          n += 1;
          return n > 2
            ? { done: true, value: undefined }
            : { done: false, value: n };
        },
      };
    },
  };
  const iter = asyncIterate(asyncIter);
  t.is(typeof iter.next, 'function');
});

test('asyncIterate handles sync iterable', t => {
  const syncIter = [1, 2, 3];
  const iter = asyncIterate(syncIter);
  t.truthy(iter);
  const first = iter.next();
  t.is(first.value, 1);
});

test('asyncIterate handles raw iterator (next only)', t => {
  let n = 0;
  const rawIter = {
    next() {
      n += 1;
      return { done: n > 2, value: n <= 2 ? n : undefined };
    },
  };
  const iter = asyncIterate(rawIter);
  t.is(iter, rawIter, 'raw iterator is returned as-is');
});

test('makeIteratorRef wraps iterable as exo', async t => {
  const data = [10, 20, 30];
  const ref = makeIteratorRef(data);

  const r1 = await ref.next();
  t.is(r1.value, 10);
  t.false(r1.done);

  const r2 = await ref.next();
  t.is(r2.value, 20);

  const r3 = await ref.next();
  t.is(r3.value, 30);

  const r4 = await ref.next();
  t.true(r4.done);
});

test('makeIteratorRef return() falls back when iterator has no return', async t => {
  // Raw iterator without return method.
  const rawIter = {
    next() {
      return { done: true, value: undefined };
    },
  };
  const ref = makeIteratorRef(rawIter);
  const result = await ref.return();
  t.true(result.done);
  t.is(result.value, undefined);
});

test('makeIteratorRef throw() falls back when iterator has no throw', async t => {
  const rawIter = {
    next() {
      return { done: true, value: undefined };
    },
  };
  const ref = makeIteratorRef(rawIter);
  const result = await ref.throw(new Error('test'));
  t.true(result.done);
  t.is(result.value, undefined);
});

test('makeReaderRef encodes bytes as base64', async t => {
  const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const ref = makeReaderRef([data]);
  const { value, done } = await ref.next();
  t.false(done);
  // Value should be base64-encoded "Hello"
  t.is(typeof value, 'string');
  // Decode and verify
  const decoded = atob(value);
  t.is(decoded, 'Hello');
});
