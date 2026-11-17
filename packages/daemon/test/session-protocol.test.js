// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { Far, makeTagged, PASS_STYLE } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { assertCopyData, wrapSessionReader } from '../src/session-protocol.js';

test('copy data admits nested records, arrays, tags, and atoms', t => {
  const data = harden({
    event: ['text', { count: 2n, complete: false, absent: undefined }],
    tagged: makeTagged('details', harden({ value: null })),
  });
  t.notThrows(() => assertCopyData(data));
});

test('copy data rejects capabilities, promises, and errors at every depth', t => {
  const capability = Far('Disposable', { method: () => {} });
  for (const value of [
    capability,
    harden(Promise.resolve('value')),
    harden(Error('failure')),
  ]) {
    t.throws(() => assertCopyData(value));
    t.throws(() => assertCopyData(harden({ nested: [value] })));
    t.throws(() => assertCopyData(makeTagged('nested', value)));
  }
});

test('copy data rejects nested accessors without invoking them', t => {
  let reads = 0;
  const value = harden({
    nested: {
      get text() {
        reads += 1;
        return 'bad';
      },
    },
  });
  t.throws(() => assertCopyData(value), { message: /accessors/ });
  t.is(reads, 0);
});

test('copy data rejects symbol accessors without invoking them', t => {
  let reads = 0;
  const value = harden({
    [PASS_STYLE]: 'tagged',
    get [Symbol.toStringTag]() {
      reads += 1;
      return 'bad';
    },
    payload: 'data',
  });
  t.throws(() => assertCopyData(value), { message: /accessors/ });
  t.is(reads, 0);
});

test('wrapped reader forwards good events and terminal copy data without exposing source', async t => {
  await null;
  const raw = readerFromIterator(
    (async function* events() {
      yield harden({ type: 'text', text: 'hello' });
      return harden({ complete: true });
    })(),
  );
  const outer = wrapSessionReader(raw, () => {});
  t.not(outer, raw);
  const iterator = iterateReader(outer);
  t.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text', text: 'hello' },
  });
  t.deepEqual(await iterator.next(), { done: true, value: { complete: true } });
});

for (const kind of ['capability', 'nested capability', 'nested promise']) {
  test(`wrapped reader refuses ${kind} events`, async t => {
    const capability = Far('Disposable', { method: () => {} });
    const value =
      kind === 'capability'
        ? capability
        : harden({
            nested: [
              kind === 'nested promise' ? Promise.resolve('data') : capability,
            ],
          });
    const raw = readerFromIterator(
      (async function* events() {
        yield value;
      })(),
    );
    const iterator = iterateReader(wrapSessionReader(raw, () => {}));
    await t.throwsAsync(iterator.next(), { message: /copy data/ });
  });
}

test('wrapped reader refuses a capability in its terminal acknowledgement', async t => {
  const raw = readerFromIterator(
    harden({
      next: async () =>
        harden({
          done: true,
          value: { nested: Far('Disposable', { method: () => {} }) },
        }),
    }),
  );
  const iterator = iterateReader(wrapSessionReader(raw, () => {}));
  await t.throwsAsync(iterator.next(), { message: /copy data/ });
});

test('read admission is fenced while close still reaches source cleanup', async t => {
  let closed = false;
  const fence = Error('Session stopped');
  const raw = readerFromIterator(
    harden({
      next: async () => harden({ done: false, value: 'unexpected' }),
      return: async () => {
        closed = true;
        return harden({ done: true, value: undefined });
      },
    }),
  );
  const iterator = iterateReader(
    wrapSessionReader(raw, () => {
      throw fence;
    }),
  );
  await t.throwsAsync(iterator.next(), { is: fence });
  t.true(closed);
});

test('closing after a fence interrupts a pending source pull', async t => {
  t.timeout(5000);
  const pending = makePromiseKit();
  const entered = makePromiseKit();
  let active = true;
  let closed = false;
  const raw = readerFromIterator(
    harden({
      next: async () => {
        entered.resolve(undefined);
        return pending.promise;
      },
      return: async () => {
        closed = true;
        return harden({ done: true, value: undefined });
      },
    }),
    { cancelPending: reason => pending.reject(reason) },
  );
  const iterator = iterateReader(
    wrapSessionReader(raw, () => {
      if (!active) throw Error('Session stopped');
    }),
  );
  const read = iterator.next();
  await entered.promise;
  active = false;
  t.deepEqual(await iterator.return(), { done: true, value: undefined });
  await read;
  t.true(closed);
});

test('wrapped reader preserves source read errors', async t => {
  const error = Error('Source read failed');
  const raw = readerFromIterator(
    harden({
      next: async () => {
        throw error;
      },
    }),
  );
  const iterator = iterateReader(wrapSessionReader(raw, () => {}));
  await t.throwsAsync(iterator.next(), { is: error });
});

test('wrapped reader preserves source close errors', async t => {
  const error = Error('Source close failed');
  const raw = readerFromIterator(
    harden({
      next: async () => harden({ done: false, value: 'event' }),
      return: async () => {
        throw error;
      },
    }),
  );
  const iterator = iterateReader(wrapSessionReader(raw, () => {}));
  await t.throwsAsync(iterator.return(), { is: error });
});

test('source reader patterns do not cross the wrapper', async t => {
  await null;
  const raw = readerFromIterator(harden([]), {
    readPattern: Far('Disposable pattern', {}),
  });
  const outer = wrapSessionReader(raw, () => {});
  t.is(await E(outer).readPattern(), undefined);
  t.is(await E(outer).readReturnPattern(), undefined);
  await iterateReader(outer).return();
});

for (const operation of ['next', 'return']) {
  for (const kind of ['capability', 'nested capability', 'promise']) {
    test(`wrapped reader refuses ${kind} rejection from ${operation}`, async t => {
      const capability = Far('Disposable rejection', { status: () => 'alive' });
      const rejection =
        kind === 'capability'
          ? capability
          : kind === 'nested capability'
            ? harden({ nested: capability })
            : Promise.resolve('unexpected rejection promise');
      const fail = async () => {
        throw rejection;
      };
      const raw = readerFromIterator(
        harden({
          next:
            operation === 'next'
              ? fail
              : async () => harden({ done: false, value: 'event' }),
          return: fail,
        }),
      );
      const iterator = iterateReader(wrapSessionReader(raw, () => {}));
      const result = operation === 'next' ? iterator.next() : iterator.return();
      await t.throwsAsync(result, {
        instanceOf: Error,
        message: /not throwable/,
      });
    });
  }
}
