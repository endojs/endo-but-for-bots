// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makePromiseKit } from './_promise-kit.js';
import { makeAccountsWatch } from '../src/account-watch.js';

const entry = oracle => ({
  accountId: 'test',
  providerId: 'test',
  uses: [{ backendId: 'test' }],
  sources: ['test'],
  title: 'Test',
  oracle,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('historical stream failure does not replace reader cleanup acknowledgement', async t => {
  t.timeout(5000);
  let returned = false;
  const observed = makePromiseKit();
  const remote = Far('FailedStream', {
    stream: () => {
      throw Error('historical stream error');
    },
    close: () => {
      returned = true;
      observed.resolve(undefined);
    },
  });
  const oracle = Far('Oracle', { watch: () => remote });
  const watch = makeAccountsWatch({
    listOracles: async () => ({ entries: [entry(oracle)], unknown: [] }),
    log: () => {},
  });
  watch.watch();
  await observed.promise;
  await watch.close();
  t.true(returned);
});

test('failed reader close is retained for an explicit retry', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const channel = makeBufferedReader();
  let fail = true;
  const remote = Far('RetryReader', {
    stream: syn => {
      entered.resolve(undefined);
      return channel.reader.stream(syn);
    },
    close: () => {
      if (fail) throw Error('close failed');
      channel.close();
    },
  });
  const oracle = Far('Oracle', { watch: () => remote });
  const watch = makeAccountsWatch({
    listOracles: async () => ({ entries: [entry(oracle)], unknown: [] }),
  });
  t.teardown(() => {
    fail = false;
    return watch.close();
  });
  watch.watch();
  await entered.promise;
  await t.throwsAsync(watch.close(), { message: /readers remain open/ });
  t.false(channel.isClosed());
  fail = false;
  await watch.close();
  t.true(channel.isClosed());
});

test('close drains held oracle lookup without starting a late follower', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const gate = makePromiseKit();
  t.teardown(() => gate.resolve(undefined));
  let watches = 0;
  const oracle = Far('Oracle', {
    watch: () => {
      watches += 1;
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => {
      entered.resolve(undefined);
      await gate.promise;
      return { entries: [entry(oracle)], unknown: [] };
    },
  });
  watch.watch();
  await entered.promise;
  let done = false;
  const closing = watch.close().then(() => {
    done = true;
  });
  await tick();
  t.false(done);
  t.throws(() => watch.watch(), { message: /closed/ });
  t.throws(() => watch.refresh(), { message: /closed/ });
  gate.resolve(undefined);
  await closing;
  t.is(watches, 0);
});

for (const late of [false, true]) {
  test(`close returns quiet oracle reader, including late acquisition: ${late}`, async t => {
    t.timeout(5000);
    const gate = makePromiseKit();
    const entered = makePromiseKit();
    t.teardown(() => gate.resolve(undefined));
    const channel = makeBufferedReader();
    let returned = false;
    channel.setOnClose(() => {
      returned = true;
    });
    const oracle = Far('QuietOracle', {
      watch: async () => {
        entered.resolve(undefined);
        if (late) await gate.promise;
        return Far('CloseableReader', {
          stream: syn => channel.reader.stream(syn),
          close: () => channel.close(),
        });
      },
    });
    const watch = makeAccountsWatch({
      listOracles: async () => ({ entries: [entry(oracle)], unknown: [] }),
    });
    watch.watch();
    await entered.promise;
    if (!late) await tick();
    let done = false;
    const closing = watch.close().then(() => {
      done = true;
    });
    if (late) {
      await tick();
      t.false(done);
    }
    gate.resolve(undefined);
    await closing;
    t.true(returned);
  });
}

test('close drains an admitted reset and preserves its result', async t => {
  t.timeout(5000);
  const gate = makePromiseKit();
  const entered = makePromiseKit();
  t.teardown(() => gate.resolve(undefined));
  const channel = makeBufferedReader();
  const oracle = Far('Oracle', {
    watch: () =>
      Far('CloseableReader', {
        stream: syn => channel.reader.stream(syn),
        close: () => channel.close(),
      }),
  });
  const admin = Far('Admin', {
    getResetState: () => ({}),
    consumeResetCredit: async () => {
      entered.resolve(undefined);
      await gate.promise;
      return 'redeemed';
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => ({
      entries: [{ ...entry(oracle), admin, adminId: 'admin-1' }],
      unknown: [],
    }),
  });
  const resetting = watch.redeemReset(JSON.stringify(['test', 'admin-1']));
  await entered.promise;
  let done = false;
  const closing = watch.close().then(() => {
    done = true;
  });
  await tick();
  t.false(done);
  t.throws(() => watch.redeemReset(JSON.stringify(['test', 'admin-1'])), {
    message: /closed/,
  });
  gate.resolve(undefined);
  t.is(await resetting, 'redeemed');
  await closing;
});

test('close cancels retries and stale timer callbacks cannot reconcile', async t => {
  t.timeout(5000);
  const scheduled = makePromiseKit();
  /** @type {() => void} */
  let callback = () => {
    throw Error('Expected a retry callback');
  };
  const cleared = [];
  let lists = 0;
  const oracle = Far('UnavailableOracle', {
    watch: () => {
      throw Error('offline');
    },
  });
  const watch = makeAccountsWatch({
    listOracles: async () => {
      lists += 1;
      return { entries: [entry(oracle)], unknown: [] };
    },
    setTimer: fn => {
      callback = fn;
      scheduled.resolve(undefined);
      return 7;
    },
    clearTimer: handle => {
      cleared.push(handle);
    },
    log: () => {},
  });
  watch.watch();
  await scheduled.promise;
  await watch.close();
  t.deepEqual(cleared, [7]);
  callback();
  await tick();
  t.is(lists, 1);
});
