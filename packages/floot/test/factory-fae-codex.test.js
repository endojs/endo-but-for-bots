// @ts-check
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { setImmediate } from 'node:timers';
import { make } from '../agent.js';
import { directoryHost } from './_directory-host.js';
import { makePromiseKit } from './_promise-kit.js';

/**
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {string} [options.catalogState]
 * @param {Promise<unknown>} [options.endpointGate]
 * @param {boolean} [options.forceCompaction]
 * @param {boolean} [options.development]
 * @param {number} [options.contextLength]
 * @param {string[]} [options.reasoningEfforts]
 * @param {string} [options.defaultReasoningEffort]
 * @param {(request: any, ordinal: number) => any[] | undefined} [options.responseOutput]
 * @param {(ordinal: number) => number} [options.responseStatus]
 * @param {(request: any) => any} [options.responseUsage]
 * @param {string} [options.shellOutput]
 * @param {boolean} [options.refuseCheckpoint]
 * @param {() => any} [options.executeShell]
 * @param {() => any} [options.onNativeStop]
 */
const world = (
  t,
  {
    catalogState = 'current',
    endpointGate = undefined,
    forceCompaction = false,
    development = false,
    contextLength = 128_000,
    reasoningEfforts = ['high'],
    defaultReasoningEffort = 'high',
    responseOutput = undefined,
    responseStatus = () => 200,
    responseUsage = /** @type {((request: any) => any) | undefined} */ (
      undefined
    ),
    shellOutput = 'ok',
    refuseCheckpoint = false,
    executeShell = undefined,
    onNativeStop = undefined,
  } = {},
) => {
  t.timeout(10_000);
  const requests = [];
  const endpoints = [];
  const inboxes = [];
  const shellCalls = [];
  let nativeStops = 0;
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
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, ...(responseUsage ? { usage: responseUsage(body) } : {}) } })}\n\n`,
          );
          return harden({
            status: responseStatus(requests.length),
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
                defaultReasoningEffort,
                reasoningEfforts,
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
  /** @type {Map<string, any>} */
  const store = new Map(
    /** @type {Array<[string, any]>} */ ([
      ['codex-inference', subscription],
      ['codex-backend', backend],
    ]),
  );
  /** @type {Map<string, Map<string, any>>} */
  const guests = new Map();
  let environments = 0;
  let disposals = 0;
  let refuseDisposal = false;
  if (development) store.set('environment-runner', Far('Runner'));
  const host = Far('FlootHost', {
    ...directoryHost(store, {
      beforeStore: value => {
        if (
          refuseCheckpoint &&
          value.type === 'transcript-record' &&
          value.kind === 'compaction'
        ) {
          checkpointRefusals += 1;
          throw Error('checkpoint write refused');
        }
      },
    }),
    copy: ([from], [guestName, name]) => {
      if (guests.has(guestName))
        guests.get(guestName)?.set(name, store.get(from));
    },
    provideEnvironment: (_runner, _mount, adminName, shellName) => {
      environments += 1;
      store.set(
        adminName,
        Far('EnvironmentAdmin', {
          dispose: () => {
            if (refuseDisposal) throw Error('Environment disposal refused');
            disposals += 1;
          },
          stop: () => {
            nativeStops += 1;
            return onNativeStop?.();
          },
          setNetworkPolicy: () => {},
        }),
      );
      store.set(
        shellName,
        Far('Shell', {
          exec: (...args) => {
            shellCalls.push(args);
            return (
              executeShell?.() ??
              harden({
                stdout: shellOutput,
                stderr: '',
                exitCode: 0,
                signal: null,
                truncated: false,
              })
            );
          },
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
      /** @type {Map<string, any>} */
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
          locate: () =>
            `endo://${'a'.repeat(64)}/${'b'.repeat(64)}?type=handle`,
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
    inboxes,
    shellCalls,
    nativeStops: () => nativeStops,
    cliCreates: () => cliCreates,
    guestCreates: () => guestCreates,
    environments: () => environments,
    disposals: () => disposals,
    refuseDisposal: value => {
      refuseDisposal = value;
    },
    checkpointRefusals: () => checkpointRefusals,
  };
};

test('development Fae stop cancels a hidden inbox command and preserves stopped state on restart', async t => {
  const execution = makePromiseKit();
  t.teardown(() =>
    execution.resolve(
      harden({
        stdout: 'stopped',
        stderr: '',
        exitCode: 0,
        signal: null,
        truncated: false,
      }),
    ),
  );
  let offerTool = true;
  const subject = world(t, {
    development: true,
    executeShell: () => execution.promise,
    onNativeStop: () =>
      execution.resolve(
        harden({
          stdout: 'stopped',
          stderr: '',
          exitCode: 0,
          signal: null,
          truncated: false,
        }),
      ),
    responseOutput: () => {
      if (!offerTool) return undefined;
      offerTool = false;
      return [
        {
          type: 'function_call',
          call_id: 'native-once',
          name: 'runCommand',
          arguments: JSON.stringify({
            command: 'sh',
            args: ['-c', 'one effect'],
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
  for (let i = 0; i < 100 && subject.inboxes.length === 0; i += 1)
    await new Promise(r => setImmediate(r));
  subject.inboxes.at(-1).push(
    harden({
      number: 1n,
      type: 'package',
      from: `endo://${'a'.repeat(64)}/${'c'.repeat(64)}?type=handle`,
      strings: ['Inbox implementation work'],
      names: [],
    }),
  );
  for (let i = 0; i < 100 && subject.shellCalls.length === 0; i += 1)
    await new Promise(r => setImmediate(r));
  t.is(subject.shellCalls.length, 1);
  t.is(
    await E(session).getCurrentTurn(),
    null,
    'mail execution has no UI turn handle',
  );
  t.deepEqual(await E(session).getExecutionState(), {
    state: 'running',
    supported: true,
  });
  t.is((await E(session).emergencyStop()).state, 'stopped');
  t.true(
    subject.nativeStops() >= 2,
    'stop reaches the retained admin before and after acquisition',
  );
  t.is(subject.requests.length, 1);
  t.true(subject.endpoints.every(endpoint => endpoint.revoked));
  t.is((await E(session).getTurns()).at(-1).state, 'cancelled');
  const count = subject.requests.length;
  const restoredFactory = await subject.restart();
  const restored = await E(restoredFactory).getSession(id);
  t.is((await E(restored).getExecutionState()).state, 'stopped');
  t.is(
    subject.requests.length,
    count,
    'stopped restoration does not dispatch mail or inference',
  );
  await E(restored).resume();
  t.is(
    subject.requests.length,
    count,
    'resume alone does not replay the cancelled model request',
  );
  await E(
    await E(restored).startTurn('Fresh bounded implementation instruction'),
  ).whenFinished();
  t.is(subject.requests.length, count + 1);
  t.is(
    subject.shellCalls.length,
    1,
    'the earlier native command is not replayed',
  );
  await E(restored).emergencyStop();
  await subject.close();
});

test('development Fae stop keeps admission fenced until native cleanup succeeds', async t => {
  let refuse = true;
  const subject = world(t, {
    development: true,
    onNativeStop: () => {
      if (refuse) throw Error('native cleanup pending');
    },
  });
  const session = await E(subject.factory).createSession({
    presetId: 'development',
    backendId: 'fae-codex',
    modelId: 'luna',
    networkPolicy: 'off',
  });
  await t.throwsAsync(E(session).emergencyStop(), {
    message: /Session stop incomplete/,
  });
  t.is((await E(session).getExecutionState()).state, 'stopping');
  await t.throwsAsync(E(session).resume(), {
    message: /Finish emergency stop/,
  });
  t.is(subject.requests.length, 0);
  refuse = false;
  t.is((await E(session).emergencyStop()).state, 'stopped');
  await subject.close();
});

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

test('Fae picker projects CLI effort aliases and sends only supported wire choices', async t => {
  const subject = world(t, {
    reasoningEfforts: ['high', 'ultra', 'max', 'future-effort'],
    defaultReasoningEffort: 'ultra',
  });
  t.teardown(subject.close);
  const [fae] = await E(subject.factory).listModels('fae-codex');
  const [cli] = await E(subject.factory).listModels('codex');
  t.deepEqual(fae.reasoningEfforts, ['high', 'max']);
  t.is(fae.defaultReasoningEffort, 'max');
  t.deepEqual(cli.reasoningEfforts, ['high', 'ultra', 'max', 'future-effort']);
  t.is(cli.defaultReasoningEffort, 'ultra');
  for (const reasoningEffort of ['ultra', 'future-effort']) {
    await t.throwsAsync(
      E(subject.factory).createSession({
        backendId: 'fae-codex',
        modelId: 'luna',
        reasoningEffort,
      }),
      { message: /Unsupported reasoning effort/ },
    );
  }
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
    reasoningEffort: fae.defaultReasoningEffort,
  });
  const run = await E(session).startTurn('Android voice assistant');
  await E(run).whenFinished();
  t.falsy((await E(run).getStatus()).error);
  t.deepEqual(subject.requests[0].reasoning, { effort: 'max' });
  const id = (await E(session).getInfo()).id;
  const restored = await E(await subject.restart()).getSession(id);
  const next = await E(restored).startTurn('Continue');
  await E(next).whenFinished();
  t.falsy((await E(next).getStatus()).error);
  t.deepEqual(subject.requests[1].reasoning, { effort: 'max' });
  t.is(subject.cliCreates(), 0);
});

test('a failed Fae session with a retained ultra recipe revives and continues with max', async t => {
  const subject = world(t, {
    reasoningEfforts: ['high', 'ultra'],
    responseStatus: ordinal => (ordinal === 1 ? 400 : 200),
  });
  t.teardown(subject.close);
  const session = await E(subject.factory).createSession({
    backendId: 'fae-codex',
    modelId: 'luna',
    reasoningEffort: 'high',
  });
  const first = await E(session).startTurn('Android voice assistant');
  await E(first).whenFinished();
  t.truthy((await E(first).getStatus()).error);
  t.is((await E(session).getTurns())[0].state, 'failed');
  const { id } = await E(session).getInfo();
  await subject.close();
  // Model the on-disk recipe left by the pre-fix Tokyo factory. The new
  // picker cannot create this alias, but revival must still accept it.
  const key = [...subject.store.keys()]
    .filter(name => name.startsWith('floot-sessions-v1-'))
    .sort()
    .at(-1);
  if (key === undefined) throw Error('Missing retained session registry');
  const snapshot = subject.store.get(key);
  subject.store.set(
    key,
    harden({
      ...snapshot,
      sessions: snapshot.sessions.map(entry => ({
        ...entry,
        reasoningEffort: 'ultra',
        inferenceRecipe: { ...entry.inferenceRecipe, reasoningEffort: 'ultra' },
      })),
    }),
  );
  const restored = await E(await subject.restart()).getSession(id);
  const next = await E(restored).startTurn('Continue');
  await E(next).whenFinished();
  t.falsy((await E(next).getStatus()).error);
  t.deepEqual(subject.requests[1].reasoning, { effort: 'max' });
  t.deepEqual(
    (await E(restored).getTurns()).map(turn => turn.state),
    ['failed', 'completed'],
  );
  t.is(subject.cliCreates(), 0);
  t.true(subject.endpoints.every(endpoint => endpoint.revoked));
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
    contextLength: 40_000,
    shellOutput: 'test log\n'.repeat(1500),
    // Automatic compaction requires a provider token observation. Large
    // serialized tool results alone must not act as a token count.
    responseUsage: request => ({
      input_tokens: Math.ceil(
        (JSON.stringify(request.input).length +
          JSON.stringify(request.tools ?? []).length) /
          4,
      ),
      output_tokens: 10,
    }),
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
  if (key === undefined) throw Error('Missing retained session registry');
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
  if (key === undefined) throw Error('Missing retained session registry');
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

test('repeated session deletion releases private journals, network audit and environment roots', async t => {
  const subject = world(t, { development: true });
  t.teardown(() => subject.close());
  for (let index = 0; index < 6; index += 1) {
    const session = await E(subject.factory).createSession({
      presetId: 'development',
      backendId: 'fae-codex',
      modelId: 'luna',
      networkPolicy: 'off',
    });
    const { id } = await E(session).getInfo();
    const turn = await E(session).startTurn('hello');
    await E(turn).whenFinished();
    t.true(subject.store.has(`floot-environment-admin-${id}`));
    t.true(
      [...subject.store.keys()].some(name =>
        name.startsWith(`floot-private-sessions/${id}/floot-network-`),
      ),
    );
    await E(subject.factory).deleteSession(id);
    t.false([...subject.store.keys()].some(name => name.includes(id)));
    t.is(subject.disposals(), index + 1);
    t.true(
      [...subject.store.keys()].filter(name =>
        name.startsWith('floot-sessions-v1-'),
      ).length <= 4,
    );
  }
  t.deepEqual(await E(subject.factory).listSessions(), []);
  t.true(subject.store.has('floot-private-sessions'));
  t.false(
    [...subject.store.keys()].some(name =>
      name.startsWith('floot-private-sessions/'),
    ),
  );
});

test('failed environment disposal retains its administrator and journal until deletion retry succeeds', async t => {
  const subject = world(t, { development: true });
  t.teardown(() => subject.close());
  const session = await E(subject.factory).createSession({
    presetId: 'development',
    backendId: 'fae-codex',
    modelId: 'luna',
    networkPolicy: 'off',
  });
  const { id } = await E(session).getInfo();
  subject.refuseDisposal(true);
  await t.throwsAsync(E(subject.factory).deleteSession(id), {
    message: /Environment disposal refused/,
  });
  t.is((await E(subject.factory).listSessions())[0].lifecycle, 'error');
  t.true(subject.store.has(`floot-environment-admin-${id}`));
  t.true(subject.store.has(`floot-private-sessions/${id}/schema`));
  subject.refuseDisposal(false);
  await E(subject.factory).deleteSession(id);
  t.deepEqual(await E(subject.factory).listSessions(), []);
  t.false([...subject.store.keys()].some(name => name.includes(id)));
  t.is(subject.disposals(), 1);
});
