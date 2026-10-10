// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makeLoopback } from '@endo/captp';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { bytesReaderFromIterator } from '../bytes-reader-from-iterator.js';
import { iterateBytesReader } from '../iterate-bytes-reader.js';
import { iterateReader } from '../iterate-reader.js';
import { makeReaderPump } from '../reader-pump.js';
import { readerFromIterator } from '../reader-from-iterator.js';

/** @import { StreamNode } from '../types.js' */

for (const outcome of ['yield', 'done', 'reject']) {
  test(`close cancels a pending pull over CapTP (${outcome})`, async t => {
    t.timeout(10_000);
    await null;
    const started = makePromiseKit();
    const pending = makePromiseKit();
    const cancellationFinished = makePromiseKit();
    let inFlight = false;
    let pulls = 0;
    let cancels = 0;
    let returns = 0;
    const source = harden({
      async next() {
        await null;
        pulls += 1;
        inFlight = true;
        started.resolve(undefined);
        try {
          return await pending.promise;
        } finally {
          inFlight = false;
        }
      },
      async return(value) {
        await null;
        t.false(inFlight, 'cleanup never overlaps a pull');
        returns += 1;
        return harden({ done: true, value });
      },
    });
    const { makeFar } = makeLoopback(`cancel-${outcome}`);
    const reader = iterateReader(
      await makeFar(
        readerFromIterator(source, {
          readReturnPattern: M.string(),
          cancelPending: reason => {
            cancels += 1;
            if (outcome === 'reject') {
              pending.reject(reason);
            } else {
              pending.resolve(harden({ done: outcome === 'done', value: 123 }));
            }
            return cancellationFinished.promise;
          },
        }),
      ),
      { buffer: 64 },
    );
    await started.promise;
    let closed = false;
    const closing = reader.return('closed').then(result => {
      closed = true;
      return result;
    });
    // Wait until cancellation has actually unblocked the producer, without
    // publishing a value. Its cleanup promise still prevents acknowledgement.
    await pending.promise.catch(() => undefined);
    t.false(closed);
    t.is(returns, 0);
    cancellationFinished.resolve(undefined);
    t.deepEqual(await closing, { done: true, value: 'closed' });
    t.is(cancels, 1);
    t.is(returns, 1);
    t.is(pulls, 1);
    await reader.return('ignored');
    t.is(cancels, 1);
    t.is(returns, 1);
  });
}

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? 'rejecting' : 'throwing'} cancellation hook reports its error`, async t => {
    t.timeout(10_000);
    await null;
    const started = makePromiseKit();
    const pending = makePromiseKit();
    let returns = 0;
    const reader = iterateReader(
      readerFromIterator(
        harden({
          next() {
            started.resolve(undefined);
            return pending.promise;
          },
          async return() {
            returns += 1;
            return harden({
              done: /** @type {const} */ (true),
              value: undefined,
            });
          },
        }),
        {
          cancelPending: () => {
            pending.resolve(harden({ done: true, value: undefined }));
            const error = Error('cancellation failed');
            if (asynchronous) return Promise.reject(error);
            throw error;
          },
        },
      ),
      { buffer: 1 },
    );
    await started.promise;
    await t.throwsAsync(reader.return(), { message: 'cancellation failed' });
    t.is(returns, 1);
  });
}

test('protocol failure wins over interruption and cancellation errors', async t => {
  t.timeout(10_000);
  const started = makePromiseKit();
  const pending = makePromiseKit();
  /** @type {ReturnType<typeof makePromiseKit<StreamNode<undefined, undefined>>>} */
  const tail = makePromiseKit();
  let returns = 0;
  let cancels = 0;
  const pump = makeReaderPump(
    harden({
      next() {
        started.resolve(undefined);
        return pending.promise;
      },
      async return() {
        returns += 1;
        throw Error('cleanup also failed');
      },
    }),
    {
      cancelPending: () => {
        cancels += 1;
        pending.reject(Error('interrupted'));
        return Promise.reject(Error('cancellation also failed'));
      },
    },
  );
  const ack = pump(harden({ value: undefined, promise: tail.promise }));
  const assertion = t.throwsAsync(ack, { message: 'broken chain' });
  await started.promise;
  tail.reject(Error('broken chain'));
  await assertion;
  t.is(cancels, 1);
  t.is(returns, 1);
});

test('late close after natural completion does not cancel the source', async t => {
  t.timeout(10_000);
  /** @type {ReturnType<typeof makePromiseKit<StreamNode<undefined, undefined>>>} */
  const tail = makePromiseKit();
  let cancels = 0;
  const pump = makeReaderPump([], {
    cancelPending: () => {
      cancels += 1;
    },
  });
  const ack = await pump(harden({ value: undefined, promise: tail.promise }));
  t.is(ack.promise, null);
  tail.resolve(harden({ value: undefined, promise: null }));
  await tail.promise;
  t.is(cancels, 0);
});

test('an async generator reaches finally without another source value', async t => {
  t.timeout(10_000);
  const started = makePromiseKit();
  const cancelled = makePromiseKit();
  let finalized = false;
  async function* generate() {
    await null;
    try {
      started.resolve(undefined);
      await cancelled.promise;
      yield undefined;
    } finally {
      finalized = true;
    }
  }
  const reader = iterateReader(
    readerFromIterator(generate(), {
      cancelPending: () => cancelled.resolve(undefined),
    }),
    { buffer: 64 },
  );
  await started.promise;
  t.deepEqual(await reader.return(), { done: true, value: undefined });
  t.true(finalized);
});

for (const cooperative of [false, true]) {
  test(`a pending pull's cleanup error survives close (cooperative: ${cooperative})`, async t => {
    t.timeout(10_000);
    await null;
    const started = makePromiseKit();
    const interrupted = makePromiseKit();
    // This generator fails during next(), before it can yield.
    // eslint-disable-next-line require-yield
    async function* generate() {
      await null;
      try {
        started.resolve(undefined);
        await interrupted.promise;
      } finally {
        // Simulate a resource whose final cleanup fails.
        // eslint-disable-next-line no-unsafe-finally
        throw Error('failed to release resource');
      }
    }
    const reader = iterateReader(
      readerFromIterator(generate(), {
        ...(cooperative && {
          cancelPending: () => interrupted.resolve(undefined),
        }),
      }),
      { buffer: 64 },
    );
    await started.promise;
    const closing = reader.return();
    const assertion = t.throwsAsync(closing, {
      message: 'failed to release resource',
    });
    if (!cooperative) {
      // Allow the local synchronize walker to observe close first.
      await new Promise(resolve => setImmediate(resolve));
      interrupted.resolve(undefined);
    }
    await assertion;
  });
}

for (const reject of [false, true]) {
  test(`bytes cancellation forwards cleanup to the original source (reject: ${reject})`, async t => {
    t.timeout(10_000);
    await null;
    const started = makePromiseKit();
    const pending = makePromiseKit();
    let returns = 0;
    const reader = iterateBytesReader(
      bytesReaderFromIterator(
        harden({
          next() {
            started.resolve(undefined);
            return pending.promise;
          },
          async return() {
            returns += 1;
            return harden({
              done: /** @type {const} */ (true),
              value: undefined,
            });
          },
        }),
        {
          cancelPending: reason => {
            if (reject) pending.reject(reason);
            else pending.resolve(harden({ done: true, value: undefined }));
          },
        },
      ),
      { buffer: 64 },
    );
    await started.promise;
    t.deepEqual(await reader.return(), { done: true, value: undefined });
    t.is(returns, 1);
  });
}
