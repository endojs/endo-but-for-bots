// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeAccountOracleKit } from '../src/account-oracle.js';
import { makeAccountReadingSource } from '../src/account-source.js';
import { make } from '../src/account-oracle-module.js';

const deferred = () => {
  let resolve = value => {
    throw Error(`Not initialized: ${value}`);
  };
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const reading = harden({
  rateLimits: {
    windows: [
      {
        windowId: 'weekly',
        title: 'Weekly',
        usedPercent: 65,
        resetsAt: '2030-01-01T00:00:00.000Z',
      },
    ],
    limitReached: false,
  },
});

test('close drains an admitted journal write and rejects retained public calls', async t => {
  t.timeout(5000);
  const entered = deferred();
  const gate = deferred();
  let writes = 0;
  const kit = makeAccountOracleKit({
    providerId: 'codex',
    provideObserved: async () => reading,
    journal: {
      read: async () => undefined,
      write: async () => {
        writes += 1;
        entered.resolve(undefined);
        await gate.promise;
      },
    },
  });
  t.teardown(() => gate.resolve(undefined));
  const read = E(kit.account).getRateLimits();
  await entered.promise;
  let stopped = false;
  const closing = kit.close().then(() => {
    stopped = true;
  });
  await t.throwsAsync(E(kit.account).refresh(), { message: /closed/ });
  t.false(stopped);
  gate.resolve(undefined);
  await read;
  await closing;
  t.is(writes, 1);
});

test('write uncertainty refuses handoff but read errors do not', async t => {
  const kit = makeAccountOracleKit({
    providerId: 'codex',
    provideObserved: async () => reading,
    journal: {
      read: async () => undefined,
      write: async () => {
        throw Error('lost acknowledgement');
      },
    },
  });
  await E(kit.account).getRateLimits();
  await t.throwsAsync(kit.close(), { message: /persistence is uncertain/ });
  const readOnly = makeAccountOracleKit({
    providerId: 'codex',
    journal: {
      read: async () => {
        throw Error('read unavailable');
      },
      write: async () => t.fail('must not write'),
    },
  });
  await E(readOnly.account).getRateLimits();
  await t.notThrowsAsync(readOnly.close());
});

test('late source acquisition closes raw reader before acknowledging disposal', async t => {
  t.timeout(5000);
  const gate = deferred();
  const entered = deferred();
  let closes = 0;
  const kit = makeAccountOracleKit({
    providerId: 'codex',
    watchObserved: async () => {
      entered.resolve(undefined);
      return gate.promise;
    },
  });
  await E(kit.account).getPlan();
  await entered.promise;
  const closing = kit.close();
  gate.resolve(
    Far('LateReader', {
      close: () => {
        closes += 1;
      },
      read: () => {
        throw Error('closed reader must not read');
      },
    }),
  );
  await closing;
  t.is(closes, 1);
});

test('old source cannot journal after closed oracle is replaced', async t => {
  t.timeout(5000);
  const source = makeAccountReadingSource();
  let writes = 0;
  const journal = {
    read: async () => undefined,
    write: async () => {
      writes += 1;
    },
  };
  const old = makeAccountOracleKit({
    providerId: 'codex',
    journal,
    watchObserved: async () => E(source.source).watch(),
  });
  await E(old.account).getPlan();
  await old.close();
  const fresh = makeAccountOracleKit({ providerId: 'codex', journal });
  await E(fresh.account).getPlan();
  source.accept(reading);
  await new Promise(resolve => setTimeout(resolve, 10));
  t.is(writes, 0);
  await fresh.close();
});

test('module awaits disposal registration before exposing an oracle', async t => {
  t.timeout(5000);
  const gate = deferred();
  const entered = deferred();
  let hook;
  const context = Far('Context', {
    addDisposalHook: async value => {
      hook = value;
      entered.resolve(undefined);
      await gate.promise;
    },
  });
  const powers = Far('Unused', {});
  const constructing = make(powers, context);
  void constructing.catch(() => {});
  await entered.promise;
  await E(hook)();
  gate.resolve(undefined);
  await t.throwsAsync(constructing, { message: /closed/ });
});

test('failed raw source close rejects disposal without waiting for quiet read', async t => {
  t.timeout(5000);
  const entered = deferred();
  const waiting = deferred();
  const kit = makeAccountOracleKit({
    providerId: 'codex',
    watchObserved: async () =>
      Far('UnclosedReader', {
        stream: () => {
          entered.resolve(undefined);
          return waiting.promise;
        },
        close: () => {
          throw Error('close unconfirmed');
        },
      }),
  });
  t.teardown(() =>
    waiting.resolve(harden({ promise: null, value: undefined })),
  );
  await E(kit.account).getPlan();
  await entered.promise;
  await t.throwsAsync(kit.close(), { message: /close unconfirmed/ });
  await t.throwsAsync(kit.close(), { message: /close unconfirmed/ });
});

test('close cancels pending source retry and stale callbacks cannot reacquire', async t => {
  t.timeout(5000);
  const scheduled = deferred();
  let retry = () => {};
  let attempts = 0;
  let cleared = 0;
  const kit = makeAccountOracleKit({
    providerId: 'codex',
    watchObserved: async () => {
      attempts += 1;
      throw Error('unavailable');
    },
    setTimer: callback => {
      retry = callback;
      scheduled.resolve(undefined);
      return 'retry';
    },
    clearTimer: handle => {
      t.is(handle, 'retry');
      cleared += 1;
    },
  });
  await E(kit.account).watch();
  await scheduled.promise;
  await kit.close();
  retry();
  t.is(attempts, 1);
  t.is(cleared, 1);
});
