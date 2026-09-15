// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeSessionRecordStore } from '../src/session-record-store.js';

import { makeDirectory } from './_session-record-directory.js';

/** @import { SessionRecordDirectory } from '../src/session-record-store.js' */

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

test('release keeps the approved plan and stable dependencies for a successor', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'approved plan', { provider: 'provider-a' });
  await store.retain('session-a', 'client', 'client-a');
  const original = await store.inspect('session-a');
  await store.release('session-a', { client: 'client-a' }, async record => {
    t.deepEqual(record, original);
  });
  t.deepEqual(await store.inspect('session-a'), {
    identifier: original?.identifier,
    plan: 'approved plan',
    references: { provider: 'provider-a' },
  });
  await store.retain('session-a', 'client', 'client-b');
  t.like(await store.inspect('session-a'), {
    references: { provider: 'provider-a', client: 'client-b' },
  });
});

test('release of absent references or an empty set does not run cleanup', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  const unexpected = async () => {
    t.fail('No retained incarnation remains to clean up');
  };
  await store.release('absent', { client: 'client-a' }, unexpected);
  await store.create('session-a', 'plan', { provider: 'provider-a' });
  const original = await store.inspect('session-a');
  await store.release('session-a', {}, unexpected);
  await store.release('session-a', { client: 'client-a' }, unexpected);
  t.deepEqual(await store.inspect('session-a'), original);
});

test('release captures expected references before caller mutation', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan', { client: 'client-a' });
  const expected = { client: 'client-a' };
  const released = store.release('session-a', expected, async record => {
    t.is(record.references.client, 'client-a');
  });
  expected.client = 'client-b';
  await released;
  t.like(await store.inspect('session-a'), { references: {} });
});

test('release refuses stale expected identities before invoking cleanup', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan', {
    listener: 'listener-a',
    client: 'client-b',
  });
  const original = await store.inspect('session-a');
  await t.throwsAsync(
    store.release(
      'session-a',
      { listener: 'listener-a', client: 'client-a' },
      async () => {
        t.fail('A stale owner must not stop its successor');
      },
    ),
    { message: /client.*changed before cleanup/ },
  );
  t.deepEqual(await store.inspect('session-a'), original);
});

test('failed release cleanup retains all references and can retry', async t => {
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    client: 'client-a',
  });
  const original = await store.inspect('session-a');
  await t.throwsAsync(
    store.release('session-a', { client: 'client-a' }, async () => {
      throw Error('Client stop incomplete');
    }),
    { message: /Client stop incomplete/ },
  );
  t.deepEqual(await store.inspect('session-a'), original);
  await store.release('session-a', { client: 'client-a' }, async record => {
    t.deepEqual(record, original);
  });
  t.like(await store.inspect('session-a'), {
    references: { provider: 'provider-a' },
  });
});

test('partial reference deletion retains the rest across store reconstruction', async t => {
  const faults = { failRemove: 'client' };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  const expected = { listener: 'listener-a', client: 'client-a' };
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    ...expected,
  });
  let cleanups = 0;
  await t.throwsAsync(
    store.release('session-a', expected, async record => {
      cleanups += 1;
      t.deepEqual(record.references, { provider: 'provider-a', ...expected });
    }),
    { message: /Directory removal failed/ },
  );
  t.like(await store.inspect('session-a'), {
    plan: 'plan',
    references: { provider: 'provider-a', client: 'client-a' },
  });
  faults.failRemove = '';
  // The previous owner's operation is terminal before reconstructing the store.
  const resumedStore = makeSessionRecordStore(directory);
  await resumedStore.release('session-a', expected, async record => {
    cleanups += 1;
    t.deepEqual(record.references, {
      provider: 'provider-a',
      client: 'client-a',
    });
    t.is(
      expected.listener,
      'listener-a',
      'caller retains original identities if needed',
    );
  });
  t.is(cleanups, 2);
  await resumedStore.release('session-a', expected, async () => {
    t.fail('Completed release is an idempotent no-op');
  });
  t.like(await resumedStore.inspect('session-a'), {
    plan: 'plan',
    references: { provider: 'provider-a' },
  });
});

for (const rebound of ['record', 'references', 'client']) {
  test(`release detects a rebound ${rebound} without deleting a successor`, async t => {
    const directory = makeDirectory();
    const store = makeSessionRecordStore(directory);
    const expected = { listener: 'listener-a', client: 'client-a' };
    await store.create('session-a', 'plan', expected);
    await t.throwsAsync(
      store.release('session-a', expected, async () => {
        // Deliberately violate exclusive ownership to exercise detection.
        let record = /** @type {SessionRecordDirectory} */ (
          await E(directory).lookup('session-a')
        );
        if (rebound === 'record') {
          record = await E(directory).makeDirectory('session-a');
          await E(record).writeText('plan', 'successor plan');
        }
        const entries =
          rebound === 'client'
            ? /** @type {SessionRecordDirectory} */ (
                await E(record).lookup('references')
              )
            : await E(record).makeDirectory('references');
        await E(entries).storeIdentifier('listener', 'listener-a');
        await E(entries).storeIdentifier('client', 'client-b');
      }),
      { message: /changed during cleanup/ },
    );
    t.like(await store.inspect('session-a'), {
      references: { listener: 'listener-a', client: 'client-b' },
    });
  });
}

test('release serializes successor retention while another session proceeds', async t => {
  t.timeout(5000);
  const store = makeSessionRecordStore(makeDirectory());
  await store.create('session-a', 'plan', { client: 'client-a' });
  let enter = () => {};
  const entered = new Promise(resolve => {
    enter = () => resolve(undefined);
  });
  let finish = () => {};
  const held = new Promise(resolve => {
    finish = () => resolve(undefined);
  });
  t.teardown(finish);
  const releasing = store.release(
    'session-a',
    { client: 'client-a' },
    async () => {
      enter();
      await held;
    },
  );
  await entered;
  let retained = false;
  const successor = store.retain('session-a', 'client', 'client-b').then(() => {
    retained = true;
  });
  await store.create('session-b', 'other plan', { client: 'other-client' });
  t.false(retained);
  finish();
  await Promise.all([releasing, successor]);
  t.like(await store.inspect('session-a'), {
    references: { client: 'client-b' },
  });
});
