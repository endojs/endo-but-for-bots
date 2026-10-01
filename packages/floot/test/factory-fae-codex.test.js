// @ts-check
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { setImmediate } from 'node:timers';
import { make } from '../agent.js';

const world = (
  t,
  { catalogState = 'current', endpointGate = undefined } = {},
) => {
  t.timeout(10_000);
  const requests = [];
  const endpoints = [];
  const inboxes = [];
  let cliCreates = 0;
  let guestCreates = 0;
  const subscription = Far('Pool', {
    describe: () => harden({ models: ['luna'] }),
    openEndpoint: async spec => {
      const state = { spec, revoked: false };
      endpoints.push(state);
      if (endpointGate) await endpointGate;
      return Far('Endpoint', {
        revoke: () => {
          state.revoked = true;
        },
        requestByteStream: request => {
          const body = JSON.parse(request.body);
          requests.push(body);
          const output = [
            {
              type: 'reasoning',
              encrypted_content: `opaque-${requests.length}`,
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok' }],
            },
          ];
          const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
          );
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
          });
        },
      });
    },
  });
  const backend = Far('CodexCLI', {
    describe: () =>
      harden({
        id: 'codex',
        title: 'Codex CLI',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    modelCatalog: () =>
      harden({
        accounts: [
          {
            subscriptionId: 'primary',
            state: catalogState,
            observedAt: 1,
            models: [
              {
                id: 'luna',
                title: 'Luna',
                description: '',
                default: true,
                defaultReasoningEffort: 'high',
                reasoningEfforts: ['high'],
                contextLength: 1000,
              },
            ],
          },
        ],
      }),
    create: () => {
      cliCreates += 1;
      throw Error('must not create CLI');
    },
  });
  const store = new Map([
    ['codex-inference', subscription],
    ['codex-backend', backend],
  ]);
  const host = Far('FlootHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    list: () => harden([...store.keys()]),
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
    copy: () => undefined,
    provideGuest: (_name, { agentName }) => {
      guestCreates += 1;
      if (store.has(agentName)) return;
      const values = new Map([['user', harden({})]]);
      store.set(
        agentName,
        Far('SessionGuest', {
          has: name => values.has(name),
          lookup: name => values.get(name),
          list: prefix => harden(prefix === 'tools' ? [] : [...values.keys()]),
          storeValue: (value, name) => {
            values.set(name, value);
          },
          remove: name => {
            values.delete(name);
          },
          locate: () => 'test-locator',
          followMessages: () => {
            const inbox = makeBufferedReader();
            inboxes.push(inbox);
            return inbox.reader;
          },
        }),
      );
    },
  });
  t.teardown(() => {
    for (const inbox of inboxes) inbox.close();
  });
  const hooks = [];
  const makeFactory = () =>
    make(
      host,
      Far('Context', {
        addDisposalHook: hook => {
          hooks.push(hook);
        },
      }),
    );
  return {
    factory: makeFactory(),
    restart: async () => {
      await E(hooks.at(-1))();
      return makeFactory();
    },
    close: () => E(hooks.at(-1))(),
    store,
    requests,
    endpoints,
    cliCreates: () => cliCreates,
    guestCreates: () => guestCreates,
  };
};

test('Floot Fae Codex pins inference, preserves opaque journal context, and never creates a CLI', async t => {
  const subject = world(t);
  t.true(
    (await E(subject.factory).listBackends()).some(
      row => row.id === 'fae-codex',
    ),
  );
  const rows = await E(subject.factory).listModels('fae-codex');
  t.is(rows[0].contextLength, 1000);
  await t.throwsAsync(
    E(subject.factory).createSession({
      backendId: 'fae-codex',
      modelId: 'luna',
      reasoningEffort: 'max',
    }),
    { message: /Unsupported reasoning/ },
  );
  t.is(subject.endpoints.length, 0);
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
    reasoningEffort: 'high',
  });
  const { id } = await E(session).getInfo();
  t.is(subject.endpoints.length, 0);
  const turn = await E(session).startTurn('seed');
  await E(turn).whenFinished();
  t.is(subject.cliCreates(), 0);
  t.true(subject.endpoints[0].revoked);
  // A newly bound pool must not replace this session's captured capability.
  subject.store.set(
    'codex-inference',
    Far('ReplacementPool', {
      describe: () => {
        throw Error('wrong pool');
      },
    }),
  );
  const restoredFactory = await subject.restart();
  const restored = await E(restoredFactory).getSession(id);
  const recall = await E(restored).startTurn('recall');
  await E(recall).whenFinished();
  t.true(
    subject.requests[1].input.some(
      item => item.encrypted_content === 'opaque-1',
    ),
  );
  t.is(
    subject.endpoints[0].spec.sessionId,
    subject.endpoints[1].spec.sessionId,
  );
  await E(restoredFactory).deleteSession(id);
  t.false((await E(restoredFactory).listSessions()).some(row => row.id === id));
  await subject.close();
});

test('shutdown retains late endpoint cleanup and never sends a cancelled request', async t => {
  const gate = Promise.withResolvers();
  const subject = world(t, { endpointGate: gate.promise });
  t.teardown(() => gate.resolve(undefined));
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
  });
  const turn = await E(session).startTurn('cancel while acquiring');
  const finished = E(turn).whenFinished();
  finished.catch(() => {});
  for (let i = 0; i < 100 && subject.endpoints.length === 0; i += 1)
    await new Promise(resolve => setImmediate(resolve));
  t.is(subject.endpoints.length, 1);
  let acknowledged = false;
  const stopped = subject.close().then(() => {
    acknowledged = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  t.false(acknowledged);
  gate.resolve(undefined);
  await stopped;
  t.true(subject.endpoints[0].revoked);
  t.is(subject.requests.length, 0);
});

test('invalid retained inference recipe is refused before guest acquisition', async t => {
  const subject = world(t);
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
  });
  await E(session).getInfo();
  await subject.close();
  const key = [...subject.store.keys()]
    .filter(name => name.startsWith('floot-sessions-v1-'))
    .sort()
    .at(-1);
  const snapshot = subject.store.get(key);
  subject.store.set(
    key,
    harden({
      ...snapshot,
      sessions: snapshot.sessions.map(entry => ({
        ...entry,
        inferenceRecipe: {
          ...entry.inferenceRecipe,
          reasoningEffort: 'high\n',
        },
      })),
    }),
  );
  const acquiredBefore = subject.guestCreates();
  const factory = await subject.restart();
  await t.throwsAsync(E(factory).listSessions(), {
    message: /Invalid subscription Responses recipe/,
  });
  t.is(subject.guestCreates(), acquiredBefore);
  t.is(subject.endpoints.length, 0);
  await subject.close();
});

for (const catalogState of ['unavailable', 'unsupported']) {
  test(`Fae Codex refuses remembered models without usable discovery: ${catalogState}`, async t => {
    const subject = world(t, { catalogState });
    await t.throwsAsync(
      E(subject.factory).createSession({
        backendId: 'fae-codex',
        modelId: 'luna',
      }),
      { message: /Unknown model/ },
    );
    t.is(subject.endpoints.length, 0);
    await subject.close();
  });
}

test('creating cleanup retains the captured inference recipe', async t => {
  const subject = world(t);
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
  });
  const { id } = await E(session).getInfo();
  await subject.close();
  const key = [...subject.store.keys()]
    .filter(name => name.startsWith('floot-sessions-v1-'))
    .sort()
    .at(-1);
  const snapshot = subject.store.get(key);
  subject.store.set(
    key,
    harden({
      ...snapshot,
      sessions: snapshot.sessions.map(entry => ({
        ...entry,
        lifecycle: 'creating',
      })),
    }),
  );
  const factory = await subject.restart();
  for (
    let i = 0;
    i < 100 && (await E(factory).listSessions())[0].lifecycle !== 'ready';
    i += 1
  )
    await new Promise(resolve => setImmediate(resolve));
  const restored = await E(factory).getSession(id);
  const turn = await E(restored).startTurn('after interrupted creation');
  await E(turn).whenFinished();
  t.is(subject.requests.length, 1);
  await E(factory).deleteSession(id);
  await subject.close();
});
