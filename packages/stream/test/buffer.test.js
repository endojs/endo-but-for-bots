// @ts-check
/** @import { Buffer } from '../buffer.js' */

import test from '@endo/ses-ava/test.js';

import { makeBuffer } from '../buffer.js';
import { makeUnboundedBuffer } from '../unbounded-buffer.js';

test('buffer transports values without acknowledgement', async t => {
  const { spring, sink } = makeBuffer();

  t.is(spring.next(1), undefined);
  t.is(spring.next(Promise.resolve(2)), undefined);

  // eslint-disable-next-line @jessie.js/safe-await-separator
  t.deepEqual(await sink.next(), { value: 1, done: false });
  t.deepEqual(await sink.next(), { value: 2, done: false });
});

test('buffer permits the sink to wait before the spring writes', async t => {
  const { spring, sink } = makeBuffer();

  const next = sink.next();
  spring.next('value');

  // eslint-disable-next-line @jessie.js/safe-await-separator
  t.deepEqual(await next, { value: 'value', done: false });
});

test('buffer transports return and throw terminal operations', async t => {
  const { spring, sink } = /** @type {Buffer<string, string>} */ (makeBuffer());

  spring.next('value');
  spring.return('finished');

  // eslint-disable-next-line @jessie.js/safe-await-separator
  t.deepEqual(await sink.next(), { value: 'value', done: false });
  t.deepEqual(await sink.next(), { value: 'finished', done: true });

  const { spring: failingSpring, sink: failingSink } = makeBuffer();
  failingSpring.throw(Error('failed'));
  await t.throwsAsync(failingSink.next(), { message: 'failed' });
});

test('buffer sink supports async iteration', async t => {
  const { spring, sink } = makeUnboundedBuffer();
  spring.next('one');
  spring.next('two');
  spring.return(undefined);

  const values = [];
  for await (const value of sink) {
    values.push(value);
  }
  t.deepEqual(values, ['one', 'two']);
});
