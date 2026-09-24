// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';
import { makePromiseKit } from './_promise-kit.js';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {{ existing?: boolean, schema?: boolean, stopped?: boolean,
 *   beforeStore?: (value: any, name: string) => Promise<void>,
 *   afterStore?: (value: any, name: string) => Promise<void>,
 *   beforeRemove?: (name: string) => Promise<void>,
 *   extraHas?: (name: string) => boolean }} [options]
 */
const makeWorld = (
  t,
  {
    existing = true,
    schema = true,
    stopped = false,
    beforeStore = async () => {},
    afterStore = async () => {},
    beforeRemove = async () => {},
    extraHas = () => false,
  } = {},
) => {
  t.timeout(5000);
  const inboxes = [];
  const guestStore = new Map([['user', harden({})]]);
  const guest = Far('PrivateJournalGuest', {
    has: name => guestStore.has(name),
    lookup: name => guestStore.get(name),
    storeValue: (value, name) => {
      guestStore.set(name, value);
    },
    list: prefix => harden(prefix === 'tools' ? [] : [...guestStore.keys()]),
    locate: () => 'test-locator',
    followMessages: () => {
      const inbox = makeBufferedReader();
      inboxes.push(inbox);
      return inbox.reader;
    },
  });
  let sends = 0;
  let creates = 0;
  const backend = Far('PrivateJournalBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
        supportedNetworkPolicies: ['off', 'public-internet'],
      }),
    modelCatalog: () =>
      harden({
        accounts: [
          {
            subscriptionId: 'default',
            state: 'current',
            observedAt: 1,
            models: [
              {
                id: 'm',
                title: 'Test',
                description: '',
                default: true,
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              },
            ],
          },
        ],
      }),
    create: () => {
      creates += 1;
      return harden({
        run: Far('MigrationRun', {
          send: () => {
            sends += 1;
            const stream = makeBufferedReader();
            stream.push(harden({ type: 'text-delta', text: 'reviewed' }));
            stream.push(harden({ type: 'end' }));
            t.teardown(() => stream.close());
            return stream.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('MigrationAdmin', { terminate: () => undefined }),
      });
    },
    destroy: () => undefined,
  });
  const hostStore = new Map(
    /** @type {[string, unknown][]} */ ([
      ['codex-backend', backend],
      [
        'floot-sessions-v1-00000000000000000000',
        harden({
          version: 1,
          sequence: 0n,
          sessions: existing
            ? [
                {
                  id: 'one',
                  title: 'One',
                  createdAt: 1,
                  systemPrompt: 'Captured fixture prompt.',
                  presetId: 'general',
                  lifecycle: 'ready',
                  ...(stopped ? { executionState: 'stopped' } : {}),
                  backendId: 'test',
                  modelId: 'm',
                },
              ]
            : [],
        }),
      ],
    ]),
  );
  if (existing && schema)
    hostStore.set(
      'floot-private-turn-3-one-schema',
      harden({ version: 1, sessionId: 'one' }),
    );
  let guests = 0;
  const host = Far('PrivateJournalHost', {
    has: name => hostStore.has(name) || extraHas(name),
    lookup: name => hostStore.get(name),
    list: () => harden([...hostStore.keys()]),
    storeValue: async (value, name) => {
      await beforeStore(value, name);
      hostStore.set(name, value);
      await afterStore(value, name);
    },
    remove: async name => {
      await beforeRemove(name);
      return hostStore.delete(name);
    },
    provideGuest: (name, { agentName }) => {
      guests += 1;
      const id = name.slice('session-'.length);
      t.deepEqual(
        hostStore.get(`floot-private-turn-${id.length}-${id}-schema`),
        { version: 1, sessionId: id },
      );
      hostStore.set(name, guest);
      hostStore.set(agentName, guest);
    },
  });
  const factory = make(host);
  t.teardown(async () => {
    for (const inbox of inboxes) inbox.close();
  });
  return {
    factory,
    host,
    hostStore,
    guestStore,
    counts: () => ({ sends, creates, guests }),
  };
};

test('terminal deletion retires journal data and schema, not unrelated namespaces', async t => {
  const world = makeWorld(t);
  const session = await E(world.factory).getSession('one');
  const turn = await E(session).startTurn('write private history');
  await E(turn).whenFinished();
  const prefix = 'floot-private-turn-3-one-';
  t.true(
    [...world.hostStore.keys()].filter(name => name.startsWith(prefix)).length >
      1,
  );
  world.hostStore.set('floot-private-turn-3-two-schema', 'preserve');
  await E(world.factory).deleteSession('one');
  t.false([...world.hostStore.keys()].some(name => name.startsWith(prefix)));
  t.is(world.hostStore.get('floot-private-turn-3-two-schema'), 'preserve');
  t.deepEqual(await E(world.factory).listSessions(), []);
});

test('an admitted account read cannot recreate a journal while deletion is retiring it', async t => {
  const refreshEntered = makePromiseKit();
  const releaseRefresh = makePromiseKit();
  const removalEntered = makePromiseKit();
  const releaseRemoval = makePromiseKit();
  t.teardown(() => {
    releaseRefresh.resolve(undefined);
    releaseRemoval.resolve(undefined);
  });
  const world = makeWorld(t, {
    beforeRemove: async name => {
      if (name === 'floot-private-turn-3-one-schema') {
        removalEntered.resolve(undefined);
        await releaseRemoval.promise;
      }
    },
  });
  const session = await E(world.factory).getSession('one');
  await E(session).getTurns();
  const oracle = Far('HeldOracle', {
    refresh: async () => {
      refreshEntered.resolve(undefined);
      await releaseRefresh.promise;
    },
    getPlan: () => harden({}),
    getRateLimits: () => harden({}),
    getRateCard: () => harden({}),
  });
  world.hostStore.set(
    'account-bindings',
    Far('AccountBindings', {
      list: () => harden(['arbitrary-source']),
      lookup: () =>
        harden({
          version: 1,
          accounts: [
            {
              accountId: 'test-account',
              providerId: 'test-provider',
              title: 'Test',
              oracle,
              uses: [{ backendId: 'test' }],
            },
          ],
        }),
    }),
  );
  const reading = E(session).getAccount(true);
  void reading.catch(() => {});
  await refreshEntered.promise;
  const deleting = E(world.factory).deleteSession('one');
  void deleting.catch(() => {});
  await removalEntered.promise;
  const before = world.counts();
  releaseRefresh.resolve(undefined);
  await t.throwsAsync(reading, {
    message: /not operable while lifecycle is deleting/,
  });
  t.deepEqual(world.counts(), before);
  releaseRemoval.resolve(undefined);
  await deleting;
});

test('session account reporting follows explicit backend publications, never the factory oracle', async t => {
  // A stopped entry does not undergo background startup reconstruction.
  const world = makeWorld(t, { stopped: true });
  world.hostStore.set(
    'account-oracle',
    Far('WrongDirectOracle', {
      getPlan: () => {
        throw Error('Wrong account selected');
      },
    }),
  );
  const makeBinding = accountId =>
    harden({
      version: 1,
      accounts: [
        {
          accountId,
          providerId: 'test-provider',
          title: accountId,
          oracle: Far('SessionOracle', {
            getPlan: () => harden({ title: accountId }),
            getRateLimits: () => harden({ windows: [] }),
            getRateCard: () => harden({ rates: [] }),
            estimateCost: () => {
              throw Error('No billing attribution');
            },
          }),
          uses: [{ backendId: 'test' }],
        },
      ],
    });
  let binding = makeBinding('first');
  world.hostStore.set(
    'account-bindings',
    Far('SessionBindings', {
      list: () => harden(['unrelated-petname']),
      lookup: () => binding,
    }),
  );
  const session = await E(world.factory).getSession('one');
  const first = await E(session).getAccount();
  t.deepEqual(
    first.accounts.map(row => row.accountId),
    ['first'],
  );
  t.false('usage' in first);
  t.regex(first.usageUnavailable, /does not open an agent/);
  t.false('cost' in first);
  binding = makeBinding('replacement');
  const next = await E(session).getAccount();
  t.deepEqual(
    next.accounts.map(row => row.accountId),
    ['replacement'],
  );
  t.is(world.counts().sends, 0);
  t.is(world.counts().creates, 0);
  world.hostStore.delete('account-bindings');
  const unavailable = await E(session).getAccount();
  t.false(unavailable.available);
  t.false('usage' in unavailable);
  t.is(world.counts().creates, 0);
  await E(session).getTurns();
  const opened = await E(session).getAccount();
  t.is(opened.usage.turns, 0);
});

test('failed durable deletion intent leaves private journal intact', async t => {
  let fail = false;
  const removed = [];
  const world = makeWorld(t, {
    beforeStore: async value => {
      if (fail && value?.sessions?.some(row => row.lifecycle === 'deleting'))
        throw Error('intent write failed');
    },
    beforeRemove: async name => {
      removed.push(name);
    },
  });
  const session = await E(world.factory).getSession('one');
  await E(session).getTurns();
  fail = true;
  await t.throwsAsync(E(world.factory).deleteSession('one'), {
    message: /intent write failed/,
  });
  t.deepEqual(removed, []);
  t.true(world.hostStore.has('floot-private-turn-3-one-schema'));
  fail = false;
  await E(world.factory).deleteSession('one');
  t.false(world.hostStore.has('floot-private-turn-3-one-schema'));
});

for (const rejection of [
  Error('terminal publication unavailable'),
  undefined,
  null,
  false,
]) {
  test(`creation rollback preserves journal without terminal intent: ${String(rejection)}`, async t => {
    const removed = [];
    const world = makeWorld(t, {
      existing: false,
      beforeStore: async value => {
        if (
          value?.sessions?.some(row =>
            ['ready', 'error', 'deleting'].includes(row.lifecycle),
          )
        ) {
          throw rejection;
        }
      },
      beforeRemove: async name => {
        removed.push(name);
      },
    });
    await t.throwsAsync(
      E(world.factory).createSession({ backendId: 'test', modelId: 'm' }),
      {
        message: /creation and rollback failed/,
      },
    );
    const [entry] = await E(world.factory).listSessions();
    const prefix = `floot-private-turn-${entry.id.length}-${entry.id}-`;
    t.true(world.hostStore.has(`${prefix}schema`));
    t.false(removed.some(name => name.startsWith(prefix)));
    t.false(
      world.hostStore.has(`session-agent-${entry.id}`),
      'failed publication must not skip ordinary cleanup',
    );
    const snapshots = [...world.hostStore.entries()].filter(([name]) =>
      name.startsWith('floot-sessions-v1-'),
    );
    const latest = /** @type {any} */ (
      snapshots.sort(([a], [b]) => a.localeCompare(b)).at(-1)?.[1]
    );
    t.is(latest.sessions[0].lifecycle, 'creating');
  });
}

test('failed journal retirement keeps terminal intent and retries after factory reconstruction', async t => {
  let fail = true;
  const world = makeWorld(t, {
    beforeRemove: async name => {
      if (fail && name === 'floot-private-turn-3-one-schema')
        throw Error('retirement unavailable');
    },
  });
  const session = await E(world.factory).getSession('one');
  await E(session).getTurns();
  await t.throwsAsync(E(world.factory).deleteSession('one'), {
    message: /retirement unavailable/,
  });
  t.is((await E(world.factory).listSessions())[0].lifecycle, 'error');
  t.true(world.hostStore.has('floot-private-turn-3-one-schema'));
  fail = false;
  const revived = make(world.host);
  for (let i = 0; i < 100; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await E(revived).listSessions()).length === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  t.deepEqual(await E(revived).listSessions(), []);
  t.false(world.hostStore.has('floot-private-turn-3-one-schema'));
});

for (const binding of [undefined, 'session-one', 'session-agent-one']) {
  test(`factory refuses missing private schema with guest binding ${binding}`, async t => {
    const world = makeWorld(t, { schema: false });
    if (binding) world.hostStore.set(binding, harden({}));
    const before = [...world.hostStore.keys()];
    const session = await E(world.factory).getSession('one');
    await t.throwsAsync(E(session).getTurns(), { message: /schema|reset/i });
    t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
    t.deepEqual([...world.hostStore.keys()], before);
  });
}

test('factory private journal ignores guest forgeries across revival', async t => {
  const { factory, host, guestStore, counts } = makeWorld(t);
  const session = await E(factory).getSession('one');
  t.is((await E(session).getJournalStatus()).storage, 'private');
  t.deepEqual(await E(session).getArchivedTurnsPage(), {
    records: [],
    next: null,
  });
  await t.throwsAsync(E(session).getArchivedTurnsPage('0:1'), {
    message: /Invalid.*cursor/,
  });
  guestStore.set(
    'floot-turn-event-00000000000000000001',
    harden({ type: 'forged' }),
  );
  const accepted = await E(session).startTurn('now review');
  await E(accepted).whenFinished();
  t.falsy((await E(accepted).getStatus()).error);
  t.is(counts().sends, 1);
  t.like((await E(session).getTurns())[0], {
    state: 'completed',
    output: 'reviewed',
  });
  // Revive against the same private anchors; never adopt model-written copies.
  const revived = await E(make(host)).getSession('one');
  t.deepEqual(await E(revived).getTurns(), await E(session).getTurns());
  t.deepEqual(await E(revived).getArchivedTurnsPage('0:0'), {
    records: [],
    next: null,
  });
});

test('schema publication failure creates neither a registry entry nor a guest', async t => {
  const world = makeWorld(t, {
    existing: false,
    beforeStore: async (_value, name) => {
      if (name.endsWith('-schema')) throw Error('Schema write failed');
    },
  });
  await t.throwsAsync(
    E(world.factory).createSession({ backendId: 'test', modelId: 'm' }),
    { message: /Schema write failed/ },
  );
  t.deepEqual(await E(world.factory).listSessions(), []);
  t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
});

for (const fail of [false, true]) {
  test(`initial registry publication fences access, rejected=${fail}`, async t => {
    let release = () => {};
    const barrier = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let started;
    const waiting = new Promise(resolve => {
      started = resolve;
    });
    const world = makeWorld(t, {
      existing: false,
      afterStore: async (_value, name) => {
        if (name === 'floot-sessions-v1-00000000000000000001') {
          started();
          await barrier;
          if (fail) throw Error('Registry acknowledgement lost');
        }
      },
    });
    t.teardown(() => release());
    const creation = E(world.factory).createSession({
      backendId: 'test',
      modelId: 'm',
    });
    const result = creation.then(
      value => ({ value }),
      error => ({ error }),
    );
    await waiting;
    const [entry] = await E(world.factory).listSessions();
    t.is(entry.lifecycle, 'creating');
    t.truthy(
      world.hostStore.get(
        `floot-private-turn-${entry.id.length}-${entry.id}-schema`,
      ),
    );
    await t.throwsAsync(E(world.factory).getSession(entry.id), {
      message: /publication/,
    });
    await t.throwsAsync(E(world.factory).renameSession(entry.id, 'race'), {
      message: /publication/,
    });
    await t.throwsAsync(E(world.factory).deleteSession(entry.id), {
      message: /publication/,
    });
    t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
    release();
    const outcome = await result;
    if ('error' in outcome) {
      t.true(fail);
      t.regex(outcome.error.message, /acknowledgement lost/);
      await t.throwsAsync(E(world.factory).getSession(entry.id), {
        message: /publication/,
      });
      t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
      const revived = make(world.host);
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const sessions = await E(revived).listSessions();
        if (sessions[0]?.lifecycle === 'ready') {
          ready = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      t.true(ready);
      t.is(world.counts().guests, 1);
      await E(revived).deleteSession(entry.id);
    } else {
      t.false(fail);
      t.is((await E(outcome.value).getInfo()).lifecycle, 'ready');
      t.is(world.counts().guests, 1);
      await E(world.factory).deleteSession(entry.id);
    }
  });
}

for (const prefix of ['session-agent-', 'session-']) {
  test(`fresh creation refuses an existing ${prefix} binding before schema publication`, async t => {
    const world = makeWorld(t, {
      existing: false,
      extraHas: name => name.startsWith(prefix),
    });
    await t.throwsAsync(
      E(world.factory).createSession({ backendId: 'test', modelId: 'm' }),
      { message: /bindings already exist/ },
    );
    t.false([...world.hostStore.keys()].some(name => name.endsWith('-schema')));
    t.deepEqual(await E(world.factory).listSessions(), []);
    t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
  });
}

test('lost schema acknowledgement leaves evidence but cannot admit a session', async t => {
  const world = makeWorld(t, {
    existing: false,
    afterStore: async (_value, name) => {
      if (name.endsWith('-schema')) throw Error('Schema acknowledgement lost');
    },
  });
  await t.throwsAsync(
    E(world.factory).createSession({ backendId: 'test', modelId: 'm' }),
    { message: /Schema acknowledgement lost/ },
  );
  t.is(
    [...world.hostStore.keys()].filter(name => name.endsWith('-schema')).length,
    1,
  );
  t.deepEqual(await E(world.factory).listSessions(), []);
  t.deepEqual(await E(make(world.host)).listSessions(), []);
  t.deepEqual(world.counts(), { sends: 0, creates: 0, guests: 0 });
});

test('concurrent creation has distinct identities before schema acknowledgement', async t => {
  let release = () => {};
  const barrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const ids = [];
  const world = makeWorld(t, {
    existing: false,
    beforeStore: async (value, name) => {
      if (name.endsWith('-schema')) {
        ids.push(value.sessionId);
        if (ids.length === 1) {
          started();
          await barrier;
        }
      }
    },
  });
  t.teardown(() => release());
  const first = E(world.factory).createSession({
    backendId: 'test',
    modelId: 'm',
  });
  await waiting;
  const second = await E(world.factory).createSession({
    backendId: 'test',
    modelId: 'm',
  });
  t.is(ids.length, 2);
  t.not(ids[0], ids[1]);
  t.true(ids[0].endsWith('-0'));
  t.true(ids[1].endsWith('-1'));
  t.is(world.counts().guests, 1);
  release();
  await first;
  t.is((await E(second).getInfo()).lifecycle, 'ready');
  t.is(world.counts().guests, 2);
  for (const id of ids) {
    t.deepEqual(
      world.hostStore.get(`floot-private-turn-${id.length}-${id}-schema`),
      { version: 1, sessionId: id },
    );
    // eslint-disable-next-line no-await-in-loop
    await E(world.factory).deleteSession(id);
  }
});
