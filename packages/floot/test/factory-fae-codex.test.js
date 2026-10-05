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
  {
    catalogState = 'current',
    endpointGate = undefined,
    forceCompaction = false,
    development = false,
    contextLength = 128_000,
    responseOutput = undefined,
    shellOutput = 'ok',
    refuseCheckpoint = false,
  } = {},
) => {
  t.timeout(10_000);
  const requests = [];
  const endpoints = [];
  const inboxes = [];
  let cliCreates = 0;
  let guestCreates = 0;
  let checkpointRefusals = 0;
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
          const output = responseOutput?.(body, requests.length) ?? [
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
                contextLength,
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
  const guests = new Map();
  let environments = 0;
  if (development) store.set('environment-runner', Far('Runner'));
  const host = Far('FlootHost', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    list: () => harden([...store.keys()]),
    storeValue: (value, name) => {
      if (
        refuseCheckpoint &&
        value.type === 'transcript-record' &&
        value.kind === 'compaction'
      ) {
        checkpointRefusals += 1;
        throw Error('checkpoint write refused');
      }
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
    copy: ([from], [guestName, name]) => {
      if (guests.has(guestName))
        guests.get(guestName).set(name, store.get(from));
    },
    provideEnvironment: (_runner, _mount, adminName, shellName) => {
      environments += 1;
      store.set(
        adminName,
        Far('EnvironmentAdmin', { stop: () => {}, setNetworkPolicy: () => {} }),
      );
      store.set(
        shellName,
        Far('Shell', {
          exec: () =>
            harden({
              stdout: shellOutput,
              stderr: '',
              exitCode: 0,
              signal: null,
              truncated: false,
            }),
          inspect: () =>
            harden({
              allowedCommands: ['sh'],
              timeoutMs: 1000,
              maxOutputBytes: 4096,
            }),
        }),
      );
    },
    provideGuest: (_name, { agentName }) => {
      guestCreates += 1;
      if (store.has(agentName)) return;
      const values = new Map([['user', harden({})]]);
      guests.set(agentName, values);
      if (development)
        values.set('workspace', Far('Git', { worktree: () => Far('Mount') }));
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
  const makeFactory = (force = forceCompaction) =>
    make(
      host,
      Far('Context', {
        addDisposalHook: hook => {
          hooks.push(hook);
        },
      }),
      { env: { FLOOT_FORCE_COMPACTION: String(force) } },
    );
  return {
    factory: makeFactory(),
    restart: async (force = forceCompaction) => {
      await E(hooks.at(-1))();
      return makeFactory(force);
    },
    close: () => E(hooks.at(-1))(),
    store,
    requests,
    endpoints,
    cliCreates: () => cliCreates,
    guestCreates: () => guestCreates,
    environments: () => environments,
    checkpointRefusals: () => checkpointRefusals,
  };
};

test('development factory revival refuses a public Shell with missing private admin', async t => {
  const subject = world(t, { development: true });
  const session = await E(subject.factory).createSession({
    presetId: 'development',
    backendId: 'fae-codex',
    modelId: 'luna',
    networkPolicy: 'off',
  });
  const { id } = await E(session).getInfo();
  await E(await E(session).startTurn('seed')).whenFinished();
  t.is(subject.environments(), 1);
  const restoredFactory = await subject.restart();
  subject.store.delete(`floot-environment-admin-${id}`);
  // Incarnations are lazy after restart; the retained public Shell must not
  // bypass private cleanup-authority validation before new inference.
  const restored = await E(restoredFactory).getSession(id);
  const refused = await E(restored).startTurn('retry');
  await E(refused).whenFinished();
  t.regex((await E(refused).getStatus()).error, /private admin is missing/);
  t.is(subject.requests.length, 1);
  t.is(subject.environments(), 1);
  await t.throwsAsync(E(restoredFactory).deleteSession(id), {
    message: /private admin is missing/,
  });
  await subject.close();
});

test('Floot Fae Codex pins inference, preserves opaque journal context, and never creates a CLI', async t => {
  const subject = world(t);
  t.true(
    (await E(subject.factory).listBackends()).some(
      row => row.id === 'fae-codex',
    ),
  );
  const rows = await E(subject.factory).listModels('fae-codex');
  t.is(rows[0].contextLength, 128_000);
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

test('Fae Codex compaction is journal-owned, preserves opaque tail, and restores without summary replay', async t => {
  const subject = world(t, { forceCompaction: true });
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
  });
  const { id } = await E(session).getInfo();
  const old = 'completed old work '.repeat(500);
  for (const input of [old, 'continue']) {
    const turn = await E(session).startTurn(input);
    await E(turn).whenFinished();
    t.is((await E(turn).getStatus()).error, null);
    t.is((await E(session).getTurns()).at(-1).state, 'completed');
  }
  t.is(subject.requests.length, 3);
  t.is(subject.requests[1].tools?.length ?? 0, 0);
  t.false(
    JSON.stringify(subject.requests[1].input).includes('encrypted_content'),
  );
  t.false(JSON.stringify(subject.requests[2].input).includes(old));
  t.is(
    subject.requests[2].input.filter(
      item =>
        item.role === 'user' &&
        (item.content === 'continue' ||
          (Array.isArray(item.content) &&
            item.content.some(part => part.text === 'continue'))),
    ).length,
    1,
  );
  const history = await E(session).getHistory();
  t.true(JSON.stringify(history).includes(old));
  const factory = await subject.restart(false);
  const restored = await E(factory).getSession(id);
  const recall = await E(restored).startTurn('recall after compaction');
  await E(recall).whenFinished();
  t.is((await E(recall).getStatus()).error, null);
  t.is(subject.requests.length, 4);
  t.false(JSON.stringify(subject.requests[3].input).includes(old));
  t.true(
    subject.requests[3].input.some(
      item => item.encrypted_content === 'opaque-3',
    ),
  );
  await E(factory).deleteSession(id);
  await subject.close();
});

test('automatic first-turn compaction preserves complete recent tools and cold restoration without replaying effects', async t => {
  let effects = 0;
  const subject = world(t, {
    development: true,
    contextLength: 120_000,
    shellOutput: 'test log\n'.repeat(1500),
    responseOutput: (request, ordinal) => {
      if (!request.tools?.length || effects >= 8) return undefined;
      effects += 1;
      return [
        { type: 'reasoning', encrypted_content: `opaque-${ordinal}` },
        {
          type: 'function_call',
          call_id: `call-${effects}`,
          name: 'runCommand',
          arguments: JSON.stringify({
            command: 'sh',
            args: ['-c', 'run tests'],
          }),
        },
      ];
    },
  });
  const session = await E(subject.factory).createSession({
    presetId: 'development',
    backendId: 'fae-codex',
    modelId: 'luna',
    networkPolicy: 'off',
  });
  const { id } = await E(session).getInfo();
  const directive =
    'Install dependencies and run all tests. Failures are fine.';
  const turn = await E(session).startTurn(directive);
  await E(turn).whenFinished();
  t.is((await E(turn).getStatus()).error, null);
  const [record] = await E(session).getTurns();
  t.is(record.state, 'completed');
  t.is(record.tools.length, 8);
  t.is(
    record.tools.filter(
      tool => tool.result !== undefined || tool.resultRef !== undefined,
    ).length,
    8,
  );
  const compacted = subject.requests.findIndex(
    request => !request.tools?.length,
  );
  t.true(compacted > 0);
  const continuation = subject.requests[compacted + 1].input;
  const calls = continuation.filter(item => item.type === 'function_call');
  t.true(Number(calls.length) > 0);
  for (const call of calls)
    t.true(
      continuation.some(
        item =>
          item.type === 'function_call_output' && item.call_id === call.call_id,
      ),
    );
  t.true(continuation.some(item => item.encrypted_content));
  t.is(
    continuation.filter(
      item => item.role === 'user' && item.content === directive,
    ).length,
    1,
  );
  t.false(
    JSON.stringify(subject.requests[compacted].input).includes(
      'encrypted_content',
    ),
  );
  const requestCount = subject.requests.length;
  const factory = await subject.restart(false);
  const restored = await E(factory).getSession(id);
  const recall = await E(restored).startTurn('recall');
  await E(recall).whenFinished();
  t.is((await E(recall).getStatus()).error, null);
  t.is(subject.requests.length, requestCount + 1);
  t.is(effects, 8);
  t.true(
    subject.requests
      .at(-1)
      .input.some(item => item.encrypted_content === `opaque-${requestCount}`),
  );
  await E(factory).deleteSession(id);
  await subject.close();
});

test('failed first-turn checkpoint publication cannot dispatch continuation', async t => {
  const subject = world(t, {
    development: true,
    forceCompaction: true,
    refuseCheckpoint: true,
    shellOutput: 'completed effect '.repeat(1000),
    responseOutput: request =>
      request.tools?.length
        ? [
            {
              type: 'function_call',
              call_id: 'once',
              name: 'runCommand',
              arguments: JSON.stringify({
                command: 'sh',
                args: ['-c', 'one effect'],
              }),
            },
          ]
        : undefined,
  });
  const session = await E(subject.factory).createSession({
    presetId: 'development',
    backendId: 'fae-codex',
    modelId: 'luna',
    networkPolicy: 'off',
  });
  const turn = await E(session).startTurn('work');
  await E(turn).whenFinished();
  t.regex((await E(turn).getStatus()).error, /uncertain storage operation/);
  t.is(subject.checkpointRefusals(), 1);
  t.is(subject.requests.length, 2); // One effect and summary; no continuation.
  t.true(Number(subject.requests[0].tools.length) > 0);
  t.is(subject.requests[1].tools?.length ?? 0, 0);
  // Storage is deliberately poisoned; preserve the ambiguous journal rather
  // than pretending deletion/reconstruction could prove the write did not land.
  const cleanup = await t.throwsAsync(subject.close(), {
    instanceOf: AggregateError,
    message: /factory disposal failed/,
  });
  t.true(cleanup.errors.some(error => /uncertain storage/.test(error.message)));
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
