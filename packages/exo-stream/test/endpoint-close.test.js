// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeLoopback } from '@endo/captp';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { bytesReaderFromIterator } from '../bytes-reader-from-iterator.js';
import { bytesWriterFromIterator } from '../bytes-writer-from-iterator.js';
import { iterateBytesReader } from '../iterate-bytes-reader.js';
import { iterateBytesWriter } from '../iterate-bytes-writer.js';
import { iterateReader } from '../iterate-reader.js';
import { iterateWriter } from '../iterate-writer.js';
import { readerFromIterator } from '../reader-from-iterator.js';
import { writerFromIterator } from '../writer-from-iterator.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const done = harden({ done: true, value: undefined });
const families = harden([
  {
    name: 'reader',
    make: readerFromIterator,
    iterate: iterateReader,
    value: undefined,
  },
  {
    name: 'bytes reader',
    make: bytesReaderFromIterator,
    iterate: iterateBytesReader,
    value: undefined,
  },
  {
    name: 'writer',
    make: writerFromIterator,
    iterate: iterateWriter,
    value: 'x',
  },
  {
    name: 'bytes writer',
    make: bytesWriterFromIterator,
    iterate: iterateBytesWriter,
    value: Uint8Array.of(1),
  },
]);

for (const family of families) {
  test(`${family.name} close separates source failure from successful cleanup`, async t => {
    t.timeout(5000);
    let returns = 0;
    const source = harden({
      next: async () => {
        throw Error('source failed');
      },
      return: async () => {
        returns += 1;
        return done;
      },
    });
    const { makeFar } = makeLoopback(family.name);
    const endpoint = await makeFar(/** @type {any} */ (family.make)(source));
    // The fixture intentionally exercises the same lifecycle across generic
    // and bytes protocols, whose application next argument types differ.
    const iterator = /** @type {any} */ (family.iterate)(endpoint);
    await t.throwsAsync(iterator.next(family.value), {
      message: /source failed/,
    });
    await E(endpoint).close();
    await E(endpoint).close();
    t.is(returns, 1);
    await t.throwsAsync(iterator.return(), { message: /source failed/ });
  });

  test(`${family.name} close retries source cleanup independently of terminal failure`, async t => {
    t.timeout(5000);
    let returns = 0;
    const source = harden({
      next: async () => done,
      return: async () => {
        returns += 1;
        if (returns === 1) throw Error('cleanup failed');
        return done;
      },
    });
    const endpoint = /** @type {any} */ (family.make)(source);
    const iterator = /** @type {any} */ (family.iterate)(endpoint);
    await t.throwsAsync(iterator.return(), { message: /cleanup failed/ });
    await E(endpoint).close();
    t.is(returns, 2);
    await E(endpoint).close();
    t.is(returns, 2);
    await t.throwsAsync(iterator.return(), { message: /cleanup failed/ });
  });
}

test('endpoint close waits for cleanup after local validation has already rejected', async t => {
  t.timeout(5000);
  const returning = makePromiseKit();
  const released = makePromiseKit();
  t.teardown(() => released.resolve(undefined));
  const endpoint = readerFromIterator(
    harden({
      next: async () => harden({ done: false, value: 'invalid' }),
      return: async () => {
        returning.resolve(undefined);
        await released.promise;
        return done;
      },
    }),
  );
  const iterator = iterateReader(endpoint, { readPattern: M.number() });
  await t.throwsAsync(iterator.next(), { message: /number/ });
  await returning.promise;
  let closed = false;
  const closing = E(endpoint)
    .close()
    .then(() => {
      closed = true;
    });
  await tick();
  t.false(closed);
  released.resolve(undefined);
  await closing;
  await t.throwsAsync(iterator.return(), { message: /number/ });
});

test('endpoint close interrupts and drains every admitted reader invocation', async t => {
  t.timeout(5000);
  const bothPulling = makePromiseKit();
  const interrupted = makePromiseKit();
  const release = makePromiseKit();
  t.teardown(() => {
    interrupted.resolve(undefined);
    release.resolve(undefined);
  });
  let pulls = 0;
  let active = 0;
  let returns = 0;
  let cancellations = 0;
  const endpoint = readerFromIterator(
    harden({
      next: async () => {
        pulls += 1;
        active += 1;
        if (active === 2) bothPulling.resolve(undefined);
        await interrupted.promise;
        active -= 1;
        return done;
      },
      return: async () => {
        t.is(active, 0, 'source cleanup cannot overlap any admitted pull');
        returns += 1;
        await release.promise;
        return done;
      },
    }),
    {
      cancelPending: () => {
        cancellations += 1;
        interrupted.resolve(undefined);
      },
    },
  );
  const first = iterateReader(endpoint);
  const second = iterateReader(endpoint);
  const reads = [first.next(), second.next()];
  await bothPulling.promise;
  const closing = E(endpoint).close();
  await interrupted.promise;
  await t.throwsAsync(E(endpoint).stream(new Promise(() => {})), {
    message: /closed/,
  });
  await tick();
  t.is(pulls, 2);
  t.is(cancellations, 2);
  t.is(returns, 1);
  release.resolve(undefined);
  await closing;
  t.deepEqual(await Promise.all(reads), [done, done]);
});

test('endpoint close releases idle streams and refuses new admission', async t => {
  t.timeout(5000);
  let pulls = 0;
  let returns = 0;
  const endpoint = writerFromIterator(
    harden({
      next: async () => {
        pulls += 1;
        return done;
      },
      return: async () => {
        returns += 1;
        return done;
      },
    }),
  );
  const a = E(endpoint).stream(new Promise(() => {}));
  const b = E(endpoint).stream(new Promise(() => {}));
  await E(endpoint).close();
  t.deepEqual(await a, { value: undefined, promise: null });
  t.deepEqual(await b, { value: undefined, promise: null });
  t.is(pulls, 0);
  t.is(returns, 1);
  await t.throwsAsync(E(endpoint).stream(new Promise(() => {})), {
    message: /closed/,
  });
});

test('endpoint close retains a return result that did not finish the source', async t => {
  t.timeout(5000);
  let returns = 0;
  const endpoint = readerFromIterator(
    harden({
      next: async () => done,
      return: async () => {
        returns += 1;
        return harden({ done: returns > 1, value: undefined });
      },
    }),
  );
  await t.throwsAsync(E(endpoint).close(), { message: /did not finish/ });
  await t.throwsAsync(E(endpoint).stream(new Promise(() => {})), {
    message: /closed/,
  });
  await E(endpoint).close();
  await E(endpoint).close();
  t.is(returns, 2);
});

test('source next ownership observes a native promise through its intrinsic then', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  /** @type {(value: typeof done) => void} */
  let finish = () => {};
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  t.teardown(() => finish(done));
  let thenCalls = 0;
  let returns = 0;
  Object.defineProperty(pending, 'then', {
    value: (/** @type {(value: unknown) => void} */ resolve) => {
      thenCalls += 1;
      resolve(done);
    },
  });
  const endpoint = readerFromIterator(
    harden({
      next: () => {
        entered.resolve(undefined);
        return pending;
      },
      return: async () => {
        returns += 1;
        return done;
      },
    }),
  );
  const iterator = iterateReader(endpoint);
  const reading = iterator.next();
  await entered.promise;
  let closed = false;
  const closing = E(endpoint)
    .close()
    .then(() => {
      closed = true;
    });
  await tick();
  t.is(thenCalls, 0);
  t.is(returns, 0);
  t.false(closed);
  finish(done);
  await closing;
  await reading;
  t.is(returns, 1);
});

for (const family of families) {
  for (const consumed of [false, true]) {
    test(`${family.name} close observes cleanup failure with an abandoned ${consumed ? 'tail' : 'head'}`, async t => {
      t.timeout(5000);
      let refuses = true;
      const value = family.name === 'bytes reader' ? Uint8Array.of(1) : 'chunk';
      const endpoint = /** @type {any} */ (family.make)(
        harden({
          next: async () => harden({ done: false, value }),
          return: async () => {
            if (refuses) throw Error('source cleanup failed');
            return done;
          },
        }),
      );
      t.teardown(async () => {
        refuses = false;
        await E(endpoint).close();
      });
      // Only close() is observed after abandoning the iterator's hidden
      // acknowledgement head or the tail after a consumed value.
      const iterator = /** @type {any} */ (family.iterate)(endpoint);
      if (consumed) await iterator.next(family.value);
      await t.throwsAsync(E(endpoint).close(), {
        message: /source cleanup failed/,
      });
      await tick();
    });
  }
}
