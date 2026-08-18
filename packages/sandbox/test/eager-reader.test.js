// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeEagerReader } from '../src/eager-reader.js';

const options = harden({
  label: /** @type {const} */ ('stdout'),
  byteLimit: 16n,
  onFailure: () => undefined,
});

test('concurrent eager-reader next calls fail instead of queuing', async t => {
  const eager = makeEagerReader(undefined, options);
  const first = eager.iterator.next();
  await t.throwsAsync(() => eager.iterator.next(), {
    message: /single-consumer.*concurrent next/,
  });
  t.deepEqual(await first, { done: true, value: undefined });
});

test('sequential eager-reader pulls preserve ordinary output', async t => {
  const source = (async function* eagerSource() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
  })();
  const eager = makeEagerReader(source, options);
  const first = await eager.iterator.next();
  const second = await eager.iterator.next();
  const done = await eager.iterator.next();
  t.deepEqual(first, { done: false, value: new Uint8Array([1, 2]) });
  t.deepEqual(second, { done: false, value: new Uint8Array([3]) });
  t.deepEqual(done, { done: true, value: undefined });
  await eager.finished;
});
