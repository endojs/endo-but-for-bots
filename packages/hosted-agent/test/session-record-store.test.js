// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeSessionRecordStore } from '../src/session-record-store.js';

/** @import { SessionRecordDirectory } from '../src/session-record-store.js' */

/**
 * Record directory semantics only: reference lookup would revive a formula,
 * while identify and list return stored IDs without doing so.
 * @param {{ failReference?: string, failPlan?: boolean, failRemove?: string }} [faults]
 */
const makeDirectory = (faults = {}) => {
  let nextId = 0;
  const make = () => {
    /** @type {Map<string, { identifier: string, directory?: SessionRecordDirectory, text?: string }>} */
    const entries = new Map();
    const freshId = () => {
      nextId += 1;
      return `formula-${nextId}`;
    };
    /** @type {SessionRecordDirectory} */
    const directory = harden({
      identify: async name => entries.get(name)?.identifier,
      lookup: async name => {
        const found = entries.get(name);
        if (!found?.directory) throw Error('Unexpected formula activation');
        return found.directory;
      },
      makeDirectory: async name => {
        const child = make();
        entries.set(name, { identifier: freshId(), directory: child });
        return child;
      },
      storeIdentifier: async (name, identifier) => {
        if (faults.failReference === name)
          throw Error('Reference write failed');
        entries.set(name, { identifier });
      },
      list: async () => [...entries.keys()],
      maybeReadText: async name => entries.get(name)?.text,
      writeText: async (name, text) => {
        if (faults.failPlan) throw Error('Plan write failed');
        entries.set(name, { identifier: freshId(), text });
      },
      remove: async name => {
        if (faults.failRemove === name) throw Error('Directory removal failed');
        entries.delete(name);
      },
    });
    return directory;
  };
  return make();
};

test('concurrent creation refuses replacement and preserves the first plan', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  const first = store.create('session-a', 'plan A', { provider: 'provider-a' });
  const second = store.create('session-a', 'plan B', {
    provider: 'provider-b',
  });
  await Promise.all([
    first,
    t.throwsAsync(second, { message: /already exists/ }),
  ]);
  t.like(await store.inspect('session-a'), {
    plan: 'plan A',
    references: { provider: 'provider-a' },
  });
});

test('creation captures approved identities before the caller can mutate inputs', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  const references = { provider: 'provider-a' };
  const created = store.create('session-a', 'plan A', references);
  references.provider = 'provider-b';
  await created;
  t.like(await store.inspect('session-a'), {
    plan: 'plan A',
    references: { provider: 'provider-a' },
  });
});

test('partial creation retains references and refuses record reuse', async t => {
  const store = makeSessionRecordStore(
    makeDirectory({ failReference: 'client' }),
  );
  await t.throwsAsync(
    store.create('session-a', 'plan', {
      provider: 'provider-a',
      client: 'client-a',
    }),
    { message: /Reference write failed/ },
  );
  t.like(await store.inspect('session-a'), {
    plan: undefined,
    references: { provider: 'provider-a' },
  });
  await t.throwsAsync(store.create('session-a', 'replacement', {}), {
    message: /already exists/,
  });
  await t.throwsAsync(store.retain('session-a', 'another', 'another-id'), {
    message: /incomplete/,
  });
  await store.remove('session-a', async record => {
    t.is(record.plan, undefined);
    t.deepEqual(record.references, { provider: 'provider-a' });
  });
  t.is(await store.inspect('session-a'), undefined);
});

test('failed plan publication retains all references for cleanup', async t => {
  const store = makeSessionRecordStore(makeDirectory({ failPlan: true }));
  await t.throwsAsync(
    store.create('session-a', 'plan', { provider: 'provider-a' }),
    { message: /Plan write failed/ },
  );
  t.like(await store.inspect('session-a'), {
    plan: undefined,
    references: { provider: 'provider-a' },
  });
});

test('retaining a client cannot replace a prior resource owner', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan', { provider: 'provider-a' });
  await store.retain('session-a', 'client', 'client-a');
  await t.throwsAsync(store.retain('session-a', 'client', 'client-b'), {
    message: /already exists/,
  });
  t.like(await store.inspect('session-a'), {
    references: { provider: 'provider-a', client: 'client-a' },
  });
  await t.throwsAsync(store.retain('absent', 'client', 'client-b'), {
    message: /Missing session record/,
  });
});

test('failed cleanup retains ownership for retry without blocking another session', async t => {
  t.timeout(5000);
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan A', { provider: 'provider-a' });
  const original = await store.inspect('session-a');
  let release = () => {};
  const blocked = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  const removal = store.remove('session-a', async record => {
    t.deepEqual(record, original);
    await blocked;
    throw Error('Cleanup incomplete');
  });
  const rejected = t.throwsAsync(removal, { message: /Cleanup incomplete/ });
  await store.create('session-b', 'plan B', { provider: 'provider-b' });
  release();
  await rejected;
  t.deepEqual(await store.inspect('session-a'), original);
  await store.remove('session-a', async record => {
    t.deepEqual(record, original);
  });
  t.is(await store.inspect('session-a'), undefined);
  t.like(await store.inspect('session-b'), { plan: 'plan B' });
  await store.remove('session-a', async () => {
    t.fail('An absent record has no cleanup to perform');
  });
});

test('directory removal failure retains ownership and repeats cleanup on retry', async t => {
  const faults = { failRemove: 'session-a' };
  const store = makeSessionRecordStore(makeDirectory(faults));
  await store.create('session-a', 'plan', { provider: 'provider-a' });
  const original = await store.inspect('session-a');
  let calls = 0;
  const cleanup = async record => {
    calls += 1;
    t.deepEqual(record, original);
  };
  await t.throwsAsync(store.remove('session-a', cleanup), {
    message: /Directory removal failed/,
  });
  t.is(calls, 1);
  t.deepEqual(await store.inspect('session-a'), original);
  faults.failRemove = '';
  await store.remove('session-a', cleanup);
  t.is(calls, 2);
  t.is(await store.inspect('session-a'), undefined);
});

test('cleanup refuses removal after detecting an external rebind', async t => {
  const directory = makeDirectory();
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'original', {});
  const original = await store.inspect('session-a');
  await t.throwsAsync(
    store.remove('session-a', async () => {
      // Simulate an external operator violating exclusive directory ownership.
      // The stale callback still must not erase that successor's binding.
      const successor = await E(directory).makeDirectory('session-a');
      await E(successor).writeText('plan', 'successor');
    }),
    { message: /changed during cleanup/ },
  );
  const successor = await store.inspect('session-a');
  t.not(successor?.identifier, original?.identifier);
  t.is(successor?.plan, 'successor');
});
