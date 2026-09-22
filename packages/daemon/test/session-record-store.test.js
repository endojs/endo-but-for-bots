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

test("a revision replaces the plan and stable dependency edges as one transition, adds a role, and never an incarnation's own", async t => {
  /** @type {{ failRemove: string }} */
  const faults = { failRemove: '' };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', { provider: 'provider-a' });
  await store.retain('session-a', 'client', 'client-a');
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { client: 'client-b' }),
    { message: /incarnation's own/ },
  );
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { worker: 'worker-b' }),
    { message: /incarnation's own/ },
  );
  await store.revise('session-a', 'plan 2', {
    provider: 'provider-b',
    storage: 'storage-a',
  });
  const revised = await store.inspect('session-a');
  t.like(revised, {
    plan: 'plan 2',
    references: {
      provider: 'provider-b',
      storage: 'storage-a',
      client: 'client-a',
    },
  });
  t.false(revised !== undefined && 'revising' in revised);
  // A role named with the identity it already holds keeps it; a plan-only
  // revision keeps every edge and stages nothing (a staging could not be
  // dropped while its removal fails).
  await store.revise('session-a', 'plan 3', { provider: 'provider-b' });
  faults.failRemove = 'revision';
  await store.revise('session-a', 'plan 4', {});
  faults.failRemove = '';
  t.like(await store.inspect('session-a'), {
    plan: 'plan 4',
    references: {
      provider: 'provider-b',
      storage: 'storage-a',
      client: 'client-a',
    },
  });
  t.false((await published(directory)).staged);
  await t.throwsAsync(store.revise('absent', 'plan', { provider: 'p' }), {
    message: /Missing session record/,
  });
  // A record whose creation never published its plan is not revised.
  const partial = makeSessionRecordStore(makeDirectory({ failPlan: true }));
  await t.throwsAsync(partial.create('session-b', 'plan', { provider: 'p' }), {
    message: /Plan write failed/,
  });
  await t.throwsAsync(
    partial.revise('session-b', 'plan 2', { provider: 'q' }),
    {
      message: /incomplete/,
    },
  );
});

/**
 * What the record publishes, read under the store: the plan and two edges,
 * and whether a revision is staged.
 * @param {SessionRecordDirectory} directory
 */
const published = async directory => {
  const record = /** @type {SessionRecordDirectory} */ (
    await E(directory).lookup('session-a')
  );
  const entries = /** @type {SessionRecordDirectory} */ (
    await E(record).lookup('references')
  );
  return {
    plan: await E(record).maybeReadText('plan'),
    provider: await E(entries).identify('provider'),
    sandbox: await E(entries).identify('sandbox'),
    staged: (await E(record).identify('revision')) !== undefined,
  };
};

test('a revision interrupted after its intent is durable is shown whole and finished by the next mutation', async t => {
  /** @type {{ failReference: string, passReferenceWrites: number }} */
  const faults = { failReference: '', passReferenceWrites: 0 };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    storage: 'storage-a',
    sandbox: 'sandbox-a',
  });
  // The staged sandbox edge is written; the published one is not.
  faults.failReference = 'sandbox';
  faults.passReferenceWrites = 1;
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', {
      provider: 'provider-b',
      sandbox: 'sandbox-b',
    }),
    { message: /Reference write failed/ },
  );
  // Published edges are between two bindings under the old plan, and the
  // intent is durable.
  t.deepEqual(await published(directory), {
    plan: 'plan',
    provider: 'provider-b',
    sandbox: 'sandbox-a',
    staged: true,
  });
  const whole = {
    plan: 'plan 2',
    references: {
      provider: 'provider-b',
      storage: 'storage-a',
      sandbox: 'sandbox-b',
    },
  };
  t.like(await store.inspect('session-a'), { ...whole, revising: true });
  // A reconstructed store reads the same intent.
  t.like(await makeSessionRecordStore(directory).inspect('session-a'), {
    ...whole,
    revising: true,
  });
  // Nothing mutates the record around the unfinished revision.
  await t.throwsAsync(store.retain('session-a', 'client', 'client-a'), {
    message: /Reference write failed/,
  });
  await t.throwsAsync(
    store.remove('session-a', async () => t.fail('cleanup ran unsettled')),
    { message: /Reference write failed/ },
  );
  t.like(await store.inspect('session-a'), { ...whole, revising: true });
  faults.failReference = '';
  await store.settle('session-a');
  const settled = await store.inspect('session-a');
  t.like(settled, whole);
  t.false(settled !== undefined && 'revising' in settled);
  t.deepEqual(await published(directory), {
    plan: 'plan 2',
    provider: 'provider-b',
    sandbox: 'sandbox-b',
    staged: false,
  });
  await store.settle('session-a');
  t.deepEqual(await store.inspect('session-a'), settled);
});

test('a revision retried after an interruption finishes the durable intent first, or leaves it untouched when it cannot', async t => {
  /** @type {{ failReference: string, passReferenceWrites: number, failText: string, passTextWrites: number }} */
  const faults = {
    failReference: '',
    passReferenceWrites: 0,
    failText: '',
    passTextWrites: 0,
  };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    sandbox: 'sandbox-a',
  });
  faults.failReference = 'sandbox';
  faults.passReferenceWrites = 1;
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { sandbox: 'sandbox-b' }),
    { message: /Reference write failed/ },
  );
  // A retry naming other identities cannot finish the intent while a staged
  // edge's publication still fails, and leaves the intent as it was.
  await t.throwsAsync(
    store.revise('session-a', 'plan 3', { sandbox: 'sandbox-c' }),
    { message: /Reference write failed/ },
  );
  t.like(await store.inspect('session-a'), {
    plan: 'plan 2',
    references: { provider: 'provider-a', sandbox: 'sandbox-b' },
    revising: true,
  });
  t.deepEqual(await published(directory), {
    plan: 'plan',
    provider: 'provider-a',
    sandbox: 'sandbox-a',
    staged: true,
  });
  // Once it can, a retry finishes the intent before staging its own: this
  // one fails at its own plan, after the earlier intent's plan is published.
  faults.failReference = '';
  faults.failText = 'plan';
  faults.passTextWrites = 1;
  await t.throwsAsync(
    store.revise('session-a', 'plan 3', { sandbox: 'sandbox-c' }),
    { message: /Text write failed: plan/ },
  );
  const finished = await store.inspect('session-a');
  t.like(finished, {
    plan: 'plan 2',
    references: { provider: 'provider-a', sandbox: 'sandbox-b' },
  });
  t.false(finished !== undefined && 'revising' in finished);
  t.deepEqual(await published(directory), {
    plan: 'plan 2',
    provider: 'provider-a',
    sandbox: 'sandbox-b',
    staged: true,
  });
  // The staging that never became intent is discarded by the next revision.
  faults.failText = '';
  await store.revise('session-a', 'plan 3', { sandbox: 'sandbox-c' });
  t.deepEqual(await published(directory), {
    plan: 'plan 3',
    provider: 'provider-a',
    sandbox: 'sandbox-c',
    staged: false,
  });
});

test('release finishes a durable intent before comparing the expected references', async t => {
  /** @type {{ failReference: string, passReferenceWrites: number }} */
  const faults = { failReference: '', passReferenceWrites: 0 };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', { provider: 'provider-a' });
  await store.retain('session-a', 'client', 'client-a');
  faults.failReference = 'provider';
  faults.passReferenceWrites = 1;
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { provider: 'provider-b' }),
    { message: /Reference write failed/ },
  );
  faults.failReference = '';
  // An expected identity the intent replaces is stale once it is finished.
  await t.throwsAsync(
    store.release('session-a', { provider: 'provider-a' }, async () =>
      t.fail('cleanup ran against a stale expectation'),
    ),
    { message: /changed before cleanup/ },
  );
  t.deepEqual(await published(directory), {
    plan: 'plan 2',
    provider: 'provider-b',
    sandbox: undefined,
    staged: false,
  });
  let seen;
  await store.release('session-a', { client: 'client-a' }, async record => {
    seen = record;
  });
  t.like(seen, {
    plan: 'plan 2',
    references: { provider: 'provider-b', client: 'client-a' },
  });
  t.deepEqual((await store.inspect('session-a'))?.references, {
    provider: 'provider-b',
  });
});

test('a revision interrupted at its plan publication is finished before removal reads the record', async t => {
  /** @type {{ failText: string, passTextWrites: number }} */
  const faults = { failText: '', passTextWrites: 0 };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    sandbox: 'sandbox-a',
  });
  // The staged plan is written; the published one is not.
  faults.failText = 'plan';
  faults.passTextWrites = 1;
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { provider: 'provider-b' }),
    { message: /Text write failed: plan/ },
  );
  t.deepEqual(await published(directory), {
    plan: 'plan',
    provider: 'provider-b',
    sandbox: 'sandbox-a',
    staged: true,
  });
  faults.failText = '';
  let seen;
  await store.remove('session-a', async record => {
    seen = record;
  });
  t.like(seen, {
    plan: 'plan 2',
    references: { provider: 'provider-b', sandbox: 'sandbox-a' },
  });
  t.false(seen !== undefined && 'revising' in seen);
  t.is(await store.inspect('session-a'), undefined);
});

test('a revision interrupted before its intent is durable leaves the record as it was and its staging discarded', async t => {
  /** @type {{ failText: string, passTextWrites: number }} */
  const faults = { failText: '', passTextWrites: 0 };
  const directory = makeDirectory(faults);
  const store = makeSessionRecordStore(directory);
  await store.create('session-a', 'plan', {
    provider: 'provider-a',
    sandbox: 'sandbox-a',
  });
  faults.failText = 'plan';
  await t.throwsAsync(
    store.revise('session-a', 'plan 2', { provider: 'provider-b' }),
    { message: /Text write failed: plan/ },
  );
  const before = {
    plan: 'plan',
    references: { provider: 'provider-a', sandbox: 'sandbox-a' },
  };
  t.deepEqual(await published(directory), {
    plan: 'plan',
    provider: 'provider-a',
    sandbox: 'sandbox-a',
    staged: true,
  });
  const unchanged = await store.inspect('session-a');
  t.like(unchanged, before);
  t.false(unchanged !== undefined && 'revising' in unchanged);
  t.like(await makeSessionRecordStore(directory).inspect('session-a'), before);
  faults.failText = '';
  // The next mutation drops the staging that never became intent.
  await store.retain('session-a', 'client', 'client-a');
  t.deepEqual(await published(directory), {
    plan: 'plan',
    provider: 'provider-a',
    sandbox: 'sandbox-a',
    staged: false,
  });
  t.like(await store.inspect('session-a'), {
    ...before,
    references: { ...before.references, client: 'client-a' },
  });
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
