// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { E } from '@endo/eventual-send';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertHostedBackendDescriptor } from '@endo/hosted-agent';
import { makeBackendCatalog } from '@endo/hosted-agent/backend-catalog.js';
import { makeCodexBackendFactory } from '../src/codex-backend-factory.js';
import { normalizeCodexModelDescriptor } from '../src/codex-models.js';
import { adaptEndoTools } from '../src/endo-tools.js';
import {
  make as makeBackend,
  makeCodexSessionProvisioner,
} from '../src/codex-backend-module.js';

const model = harden({
  id: 'model-a',
  displayName: 'Model A',
  description: '',
  isDefault: true,
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'high' },
  ],
});
/**
 * What the broker's account lists, as its discovery reads it. `answer` can
 * be changed to script an outage after a session is recorded.
 */
const scriptedCatalog = () => {
  const state = { answer: true };
  const catalog = makeBackendCatalog({
    label: 'Codex',
    readCatalog: async () => {
      if (!state.answer) throw Error('provider catalog down');
      return harden({
        accounts: [
          {
            subscriptionId: 'default',
            state: 'current',
            observedAt: 1,
            models: [normalizeCodexModelDescriptor(model)],
          },
        ],
      });
    },
  });
  return { catalog, state };
};
const testCatalog = scriptedCatalog().catalog;

test('Codex refuses a storage owner holding another provider before creating an owner', async t => {
  const moduleUrl = new URL('../src/codex-backend-module.js', import.meta.url);
  const specifiers = {
    'native-sandbox': '../../sandbox/src/native-agent.js',
    'broker-service': './codex-broker-service-agent.js',
    'state-provider': './codex-state-provider-module.js',
    'session-storage': './codex-session-storage-module.js',
  };
  let ownerRequests = 0;
  const host = Far('Host', {
    identify: (_namespace, name) => name,
    diagnostics: () =>
      Far('Diagnostics', {
        getFormula: name =>
          harden({
            type: 'make-unconfined',
            properties: {
              specifier: {
                kind: 'literal',
                value: new URL(specifiers[name], moduleUrl).href,
              },
              powers: { kind: 'reference', identifier: 'old-state-provider' },
            },
          }),
      }),
    getFormulaEnvironment: () => harden({}),
    provideSessionOwner: () => {
      ownerRequests += 1;
      throw Error('unexpected owner');
    },
  });
  await t.throwsAsync(makeBackend(host, undefined), {
    message: /storage owner must use the selected state provider/,
  });
  t.is(ownerRequests, 0);
});

test('Codex factory delegates checkpoint operations and retains failed native stop for retry', async t => {
  const calls = [];
  let stopFails = true;
  const client = Far('Client', {
    async models() {
      return harden([model]);
    },
    async acknowledge(checkpoint) {
      calls.push(['ack', checkpoint]);
    },
  });
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    async provisionSession(id, spec, tools) {
      calls.push(['start', id, spec.model, tools]);
      return client;
    },
    async stopSession(id) {
      calls.push(['stop', id]);
      if (stopFails) throw Error('native stop pending');
    },
    async removeSession(id) {
      calls.push(['remove', id]);
    },
  });
  const tools = Far('Tools', {});
  const { run } = await E(factory).create(harden({ sessionId: 'a' }), tools);
  await E(run).acknowledge('checkpoint-a');
  t.deepEqual(calls.slice(0, 2), [
    // No model named: the provisioner admits and records one; the factory
    // hands the request on as it came.
    ['start', 'a', undefined, tools],
    ['ack', 'checkpoint-a'],
  ]);
  t.is((await E(run).models())[0].id, 'model-a');
  await t.throwsAsync(E(factory).destroy(harden({ sessionId: 'a' })), {
    message: /native stop pending/,
  });
  t.false(calls.some(call => call[0] === 'remove'));
  stopFails = false;
  await E(factory).destroy(harden({ sessionId: 'a' }));
  t.deepEqual(calls.slice(-2), [
    ['stop', 'a'],
    ['remove', 'a'],
  ]);
  // An effort a model does not offer is the provisioner's to refuse against
  // the catalog; the factory refuses what no account could make right.
  for (const bad of [
    { reasoningEffort: 'x'.repeat(65) },
    { networkPolicy: 'public-internet' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(factory).create(harden({ sessionId: 'b', ...bad }), tools),
    );
  }
});

test('Codex factory stop reaches absent and failed owners without removing state', async t => {
  const calls = [];
  let fails = true;
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    async provisionSession(id) {
      calls.push(['start', id]);
      return Far('Client', {});
    },
    async stopSession(id) {
      calls.push(['stop', id]);
      if (fails) throw Error('cleanup pending');
    },
    async removeSession(id) {
      calls.push(['remove', id]);
    },
  });
  const spec = harden({ sessionId: 'a' });
  const tools = Far('Tools', {});
  await t.throwsAsync(E(factory).stop(spec), { message: /cleanup pending/ });
  t.deepEqual(calls, [['stop', 'a']]);
  fails = false;
  await E(factory).stop(spec);
  const { admin } = await E(factory).create(spec, tools);
  fails = true;
  await t.throwsAsync(E(factory).stop(spec), { message: /cleanup pending/ });
  await t.throwsAsync(E(factory).create(spec, tools), {
    message: /cleanup pending/,
  });
  await E(factory).create(harden({ sessionId: 'b' }), tools);
  fails = false;
  await E(factory).stop(spec);
  const count = calls.length;
  await E(admin).terminate();
  t.is(calls.length, count, 'old admin has already completed cleanup');
  await E(factory).create(spec, tools);
  t.deepEqual(calls.at(-1), ['start', 'a']);
  await t.throwsAsync(E(factory).stop(harden({ sessionId: '../foreign' })));
  t.false(calls.some(([operation]) => operation === 'remove'));
});

test('Codex factory hands a thinking selection to the provisioner unresolved; Floot’s empty selection is absent', async t => {
  const requests = [];
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    async provisionSession(id, request) {
      requests.push(request);
      return Far('Client', {});
    },
    stopSession: async () => undefined,
    removeSession: async () => undefined,
  });
  const tools = Far('Tools', {});
  for (const [spec, expected] of [
    [{}, undefined],
    [{ reasoningEffort: '' }, undefined],
    [{ reasoningEffort: 'low' }, 'low'],
    [{ model: '' }, undefined],
  ]) {
    if (spec === null || typeof spec !== 'object')
      throw Error('Expected session spec');
    // eslint-disable-next-line no-await-in-loop
    const { admin } = await E(factory).create(
      harden({ sessionId: 'default-effort', ...spec }),
      tools,
    );
    t.is(requests.at(-1).reasoningEffort, expected);
    t.false('model' in requests.at(-1));
    // eslint-disable-next-line no-await-in-loop
    await E(admin).terminate();
  }
  // Only the shape is the factory's: what the account lists, and the
  // efforts a model takes, are the provisioner's to admit against the
  // catalog when it records the plan.
  const count = requests.length;
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'bad-shape', reasoningEffort: 'x'.repeat(65) }),
      tools,
    ),
    { message: /bounded string/ },
  );
  t.is(requests.length, count, 'invalid selection cannot provision resources');
});

test('Codex placement is recorded before directories and replacement stops before revision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-owned-')));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspaces');
  const privateRoot = join(root, 'private');
  const calls = [];
  /** @type {Map<string, { plan: string }>} */
  /** @type {Map<string, { plan: string, references?: Record<string, string> }>} */
  const records = new Map();
  const recorded = () => {
    const record = records.get('a');
    if (record === undefined) throw Error('no record');
    return JSON.parse(record.plan);
  };
  const client = Far('Client', {});
  const dependencies = harden({
    sandboxService: 'sandbox-id',
    brokerService: 'broker-id',
    stateProvider: 'state-id',
    storage: 'storage-id',
  });
  const owner = Far('Owner', {
    async inspect(id) {
      return records.get(id);
    },
    async create(id, text, identities) {
      await t.throwsAsync(access(privateRoot), { code: 'ENOENT' });
      t.deepEqual(identities, dependencies);
      calls.push('create');
      records.set(id, harden({ plan: text, references: identities }));
    },
    async stop() {
      calls.push('stop');
    },
    /**
     * @param {string} id
     * @param {string} text
     * @param {Record<string, string>} [references]
     */
    async revise(id, text, references = undefined) {
      calls.push('revise');
      const record = records.get(id);
      records.set(
        id,
        harden({
          plan: text,
          references: { ...(record?.references ?? {}), ...(references ?? {}) },
        }),
      );
    },
    async start() {
      const plan = recorded();
      await access(plan.mounterSocketDir);
      await access(plan.workspaceDir);
      calls.push('start');
      return client;
    },
  });
  const scripted = scriptedCatalog();
  const provision = makeCodexSessionProvisioner({
    stateRoot: join(root, 'state'),
    owner,
    dependencies,
    workspaceRoot,
    privateRoot,
    protectedRoots: [join(root, 'state')],
    imageRef: `example@sha256:${'a'.repeat(64)}`,
    accountRef: 'account-a',
    catalog: scripted.catalog,
  });
  const tools = Far('Tools', {});
  const request = harden({
    networkPolicy: 'off',
    containerMounts: [],
    model: 'model-a',
  });
  // A new pin is admitted by the catalog, with the model's default effort.
  await t.throwsAsync(
    () => provision('a', { ...request, model: 'model-z' }, tools),
    { message: /Unknown "Codex" model "model-z"/ },
  );
  await t.throwsAsync(
    () => provision('a', { ...request, reasoningEffort: 'ultra' }, tools),
    { message: /Unsupported "Codex" reasoning effort/ },
  );
  t.deepEqual(calls, [], 'a refused pin records nothing');
  t.is(await provision('a', request, tools), client);
  t.deepEqual(calls, ['create', 'start']);
  t.like(recorded(), { model: 'model-a', reasoningEffort: 'low' });
  // A reopen that names the recorded pin, or nothing, keeps it without
  // asking the catalog: the provider being down does not keep a recorded
  // session from starting, and no other model is put in its place.
  scripted.state.answer = false;
  await provision('a', { ...request, model: '', reasoningEffort: '' }, tools);
  t.deepEqual(calls.slice(-2), ['stop', 'start']);
  t.like(recorded(), { model: 'model-a', reasoningEffort: 'low' });
  await t.throwsAsync(
    () => provision('a', { ...request, reasoningEffort: 'high' }, tools),
    { message: /"Codex" model catalog is unavailable/ },
  );
  scripted.state.answer = true;
  // A changed pin is a new pin, admitted and revised in place.
  await provision('a', { ...request, reasoningEffort: 'high' }, tools);
  t.deepEqual(calls.slice(-3), ['stop', 'revise', 'start']);
  t.like(recorded(), {
    model: 'model-a',
    reasoningEffort: 'high',
  });
  // An effort changed on its own keeps the recorded model: the catalog is
  // asked about that model, and no other is put in its place.
  const { model: _named, ...unnamed } = request;
  await provision('a', { ...unnamed, reasoningEffort: 'low' }, tools);
  t.deepEqual(calls.slice(-3), ['stop', 'revise', 'start']);
  t.like(recorded(), { model: 'model-a', reasoningEffort: 'low' });
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await t.throwsAsync(
    provision('a', { ...request, workspaceHostPath: foreign }, tools),
    { message: /workspace cannot change/ },
  );
  await t.throwsAsync(
    provision('b', { ...request, workspaceHostPath: privateRoot }, tools),
    { message: /must be disjoint from the session storage roots/ },
  );
  const hostState = join(root, 'state');
  await mkdir(join(hostState, 'session-records'), { recursive: true });
  const before = [...calls];
  for (const workspaceHostPath of [
    hostState,
    join(hostState, 'session-records'),
    root,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      provision('b', { ...request, workspaceHostPath }, tools),
      { message: /must be disjoint from the session storage roots/ },
    );
  }
  // An alias above a fresh session leaf must not turn owned workspace
  // allocation into host-record allocation either.
  await rm(workspaceRoot, { recursive: true, force: true });
  await symlink(hostState, workspaceRoot);
  await t.throwsAsync(provision('b', request, tools), {
    message: /overlaps protected/,
  });
  t.deepEqual(calls, before, 'rejected before owner mutation');
});

test('the descriptor says what a system prompt must know about Codex', async t => {
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    provisionSession: async () => Far('Client', {}),
    stopSession: async () => undefined,
    removeSession: async () => undefined,
  });
  const described = await E(factory).describe();
  // It passes the contract Floot validates every backend against...
  const { promptEnvironment } = assertHostedBackendDescriptor(described);
  if (promptEnvironment === undefined)
    throw Error('Expected Codex prompt environment');
  t.deepEqual(promptEnvironment, {
    toolNamePrefix: '',
    toolNames: { exec: 'endo_exec' },
    nativeTools: true,
    workspacePath: '/workspace',
  });
  // ...and the rename it declares is the one the adapter performs, so the
  // prompt names the tool the model will actually find in its list.
  const adapted = adaptEndoTools({
    dynamicTools: [{ name: 'exec' }, { name: 'lookup' }],
    toolSetId: 'x',
  });
  t.deepEqual(
    adapted.dynamicTools.map(tool => tool.name),
    ['exec', 'lookup'].map(name => promptEnvironment.toolNames[name] || name),
  );
});

test('a backend over several subscriptions says which, and pins a session only to one of them', async t => {
  /** @type {any[]} */
  const requests = [];
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    provisionSession: async (_id, request) => {
      requests.push(request);
      return Far('Client', {});
    },
    stopSession: async () => undefined,
    removeSession: async () => undefined,
    listSubscriptions: async () => [
      { id: 'work', label: 'Work Pro', weight: 20 },
      { id: 'home', label: 'Home Plus', weight: 1 },
    ],
  });
  const described = assertHostedBackendDescriptor(await E(factory).describe());
  t.is(described.providerId, 'codex');
  t.deepEqual(described.subscriptions, [
    { id: 'work', label: 'Work Pro' },
    { id: 'home', label: 'Home Plus' },
  ]);
  const tools = Far('Tools', {});
  await E(factory).create(
    harden({ sessionId: 'a', subscription: 'home' }),
    tools,
  );
  t.is(requests[0].subscription, 'home');
  // `auto` is the default and is not recorded in the session's plan.
  await E(factory).create(
    harden({ sessionId: 'b', subscription: 'auto' }),
    tools,
  );
  await E(factory).create(harden({ sessionId: 'c' }), tools);
  t.false('subscription' in requests[1]);
  t.false('subscription' in requests[2]);
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'd', subscription: 'spare' }), tools),
    { message: /Unknown Codex subscription "spare"/ },
  );
  t.is(requests.length, 3);
});

test('a backend over one credential offers nothing to choose', async t => {
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    provisionSession: async () => Far('Client', {}),
    stopSession: async () => undefined,
    removeSession: async () => undefined,
  });
  const described = assertHostedBackendDescriptor(await E(factory).describe());
  t.is(described.providerId, 'codex');
  t.false('subscriptions' in described);
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'a', subscription: 'work' }),
      Far('Tools', {}),
    ),
    { message: /Unknown Codex subscription/ },
  );
});

test('a pinned session is refused for the right reason when the broker cannot be asked', async t => {
  const factory = makeCodexBackendFactory({
    catalog: testCatalog,
    provisionSession: async () => Far('Client', {}),
    stopSession: async () => undefined,
    removeSession: async () => undefined,
    listSubscriptions: async () => {
      throw Error('broker worker is restarting');
    },
  });
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'a', subscription: 'work' }),
      Far('Tools', {}),
    ),
    { message: /cannot be listed right now/ },
  );
  // The descriptor is not the place to fail.
  const described = assertHostedBackendDescriptor(await E(factory).describe());
  t.false('subscriptions' in described);
  // A session that pins nothing is unaffected.
  await t.notThrowsAsync(
    E(factory).create(harden({ sessionId: 'b' }), Far('Tools', {})),
  );
});
