// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

const makeWorld = (
  t,
  {
    existing = true,
    schema = true,
    beforeStore = async () => {},
    afterStore = async () => {},
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
    listModels: () =>
      harden([
        {
          id: 'm',
          title: 'Test',
          description: '',
          default: true,
          defaultReasoningEffort: null,
          reasoningEfforts: [],
        },
      ]),
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
                  presetId: 'general',
                  lifecycle: 'ready',
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
    remove: name => hostStore.delete(name),
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
    let release;
    const barrier = new Promise(resolve => {
      release = resolve;
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
  let release;
  const barrier = new Promise(resolve => {
    release = resolve;
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
