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
import { makeCodexBackendFactory } from '../src/codex-backend-factory.js';
import { adaptEndoTools } from '../src/endo-tools.js';
import { makeCodexSessionProvisioner } from '../src/codex-backend-module.js';

const model = harden({
  id: 'model-a',
  displayName: 'Model A',
  description: '',
  isDefault: true,
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
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
    models: [model],
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
    ['start', 'a', 'model-a', tools],
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
  for (const bad of [
    { model: 'unknown' },
    { reasoningEffort: 'unknown' },
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
    models: [model],
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

test('Codex factory resolves Floot empty thinking selection before provisioning', async t => {
  const requests = [];
  const factory = makeCodexBackendFactory({
    models: [model],
    async provisionSession(id, request) {
      requests.push(request);
      return Far('Client', {});
    },
    stopSession: async () => undefined,
    removeSession: async () => undefined,
  });
  const tools = Far('Tools', {});
  for (const spec of [
    {},
    { reasoningEffort: '' },
    { reasoningEffort: 'low' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { admin } = await E(factory).create(
      harden({ sessionId: 'default-effort', ...spec }),
      tools,
    );
    t.is(requests.at(-1).reasoningEffort, 'low');
    // eslint-disable-next-line no-await-in-loop
    await E(admin).terminate();
  }
  const count = requests.length;
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'invalid-effort', reasoningEffort: 'unknown' }),
      tools,
    ),
    { message: /Unsupported Codex reasoning effort/ },
  );
  t.is(requests.length, count, 'invalid selection cannot provision resources');
});

test('Codex placement is recorded before directories and replacement stops before revision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-owned-')));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspaces');
  const privateRoot = join(root, 'private');
  const calls = [];
  let record;
  const client = Far('Client', {});
  const dependencies = harden({
    sandboxService: 'sandbox-id',
    brokerService: 'broker-id',
    stateProvider: 'state-id',
    storage: 'storage-id',
  });
  const owner = Far('Owner', {
    async inspect() {
      return record;
    },
    async create(id, text, identities) {
      await t.throwsAsync(access(privateRoot), { code: 'ENOENT' });
      t.deepEqual(identities, dependencies);
      calls.push('create');
      record = harden({ plan: text });
    },
    async stop() {
      calls.push('stop');
    },
    async revise(id, text) {
      calls.push('revise');
      record = harden({ plan: text });
    },
    async start() {
      const plan = JSON.parse(record.plan);
      await access(plan.mounterSocketDir);
      await access(plan.workspaceDir);
      calls.push('start');
      return client;
    },
  });
  const provision = makeCodexSessionProvisioner({
    owner,
    dependencies,
    workspaceRoot,
    privateRoot,
    protectedRoots: [join(root, 'state')],
    imageRef: `example@sha256:${'a'.repeat(64)}`,
    accountRef: 'account-a',
    nativeProfile: {
      uid: 1000,
      gid: 1000,
      memoryBytes: '536870912',
      cpuQuotaMicros: '200000',
      pids: 128,
      cpuPeriodMicros: 100_000,
      maxConcurrentOperations: 1,
    },
  });
  const tools = Far('Tools', {});
  const request = harden({
    networkPolicy: 'off',
    containerMounts: [],
    model: 'model-a',
  });
  t.is(await provision('a', request, tools), client);
  t.deepEqual(calls, ['create', 'start']);
  await provision('a', { ...request, reasoningEffort: 'low' }, tools);
  t.deepEqual(calls.slice(-3), ['stop', 'revise', 'start']);
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await t.throwsAsync(
    provision('a', { ...request, workspaceHostPath: foreign }, tools),
    { message: /placement cannot change/ },
  );
  await t.throwsAsync(
    provision('b', { ...request, workspaceHostPath: privateRoot }, tools),
    { message: /overlaps/ },
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
      { message: /overlaps/ },
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
    models: [model],
    provisionSession: async () => Far('Client', {}),
    stopSession: async () => undefined,
    removeSession: async () => undefined,
  });
  const described = await E(factory).describe();
  // It passes the contract Floot validates every backend against...
  const { promptEnvironment } = assertHostedBackendDescriptor(described);
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
