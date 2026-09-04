// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import {
  HostedToolSetInterface,
  assertHostedBackendDescriptor,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import {
  HOSTED_AGENT_POLICY_V1,
  assertBrokerLeaseV1,
  assertHostedAgentPolicyV1,
  makeCodexBackendFactory,
  makeCodexResourceProvisioner,
  normalizeCodexModelDescriptor,
} from '../src/backend-factory.js';

const validPolicy = () =>
  harden({
    ...HOSTED_AGENT_POLICY_V1,
    sessionId: 'session-1',
    networkNamespaceId: 'netns-session-1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    mounts: harden([
      harden({
        role: 'workspace',
        destination: '/workspace',
        mode: 'rw',
        source: 'workspace:session-1',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'codex-state',
        destination: '/codex-home',
        mode: 'rw',
        source: 'codex-state:session-1',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'tmp',
        destination: '/tmp',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'run',
        destination: '/run',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
      harden({
        role: 'scratch',
        destination: '/scratch',
        mode: 'rw',
        source: 'tmpfs',
        options: harden(['nosuid', 'nodev']),
      }),
    ]),
  });

const imageDigest = `sha256:${'a'.repeat(64)}`;
const providerOrigin = 'https://api.openai.com';
const accountRef = 'operator-account-1';

const validLeaseRequirements = () => ({
  sessionId: 'session-1',
  imageDigest,
  networkNamespaceId: 'netns-session-1',
  providerOrigin,
  accountRef,
});

const validLease = () =>
  harden({
    version: 'BrokerLeaseV1',
    leaseId: 'lease-session-1',
    sessionId: 'session-1',
    imageDigest,
    networkNamespaceId: 'netns-session-1',
    providerOrigin,
    endpoint: 'http://127.0.0.1:4317/',
    accountRef,
    expiresAt: '2999-01-01T00:00:00.000Z',
    modelAllowlist: harden(['gpt-test']),
    limits: harden({
      requests: 100,
      bytes: 1_000_000n,
      costMicrounits: 1_000_000n,
    }),
  });

const makeToolSet = () =>
  makeExo('TestHostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({ dynamicTools: [], toolSetId: 'none' });
    },
    async execute() {
      return '';
    },
    help() {
      return 'Test hosted tool set.';
    },
  });

test('sandbox contract rejects a tag and an unenforced resource limit', t => {
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({ ...validPolicy(), imageDigest: 'localhost/codex:latest' }),
      ),
    { message: /pinned by SHA-256 digest/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          limits: harden({ ...validPolicy().limits, pids: null }),
        }),
      ),
    { message: /limit.*pids.*not enforced/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(validPolicy(), {
        imageDigest: `sha256:${'b'.repeat(64)}`,
      }),
    { message: /not operator-approved/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts,
            harden({
              role: 'secret',
              destination: '/secrets',
              mode: 'ro',
              source: '/home/operator',
              options: harden(['nosuid', 'nodev']),
            }),
          ]),
        }),
      ),
    { message: /undeclared mount/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts.slice(1),
            harden({
              role: '__proto__',
              destination: undefined,
              mode: undefined,
              source: undefined,
              options: harden(['nosuid', 'nodev']),
            }),
          ]),
        }),
      ),
    { message: /exact session table/ },
  );
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({ ...validPolicy(), privilegedEscapeHatch: true }),
      ),
    { message: /unknown or missing fields/ },
  );
});

test('hosted descriptors cannot smuggle authority into Floot metadata', t => {
  t.throws(
    () =>
      assertHostedBackendDescriptor(
        harden({
          id: 'bad',
          title: 'Bad backend',
          kind: 'hosted',
          continuity: 'opaque',
          toolOwnership: 'endo',
          metadata: makeToolSet(),
        }),
      ),
    { message: /must be a record/ },
  );
  t.throws(
    () =>
      normalizeHostedModelDescriptor(
        harden({
          id: 'bad-model',
          title: 'Bad model',
          description: '',
          default: false,
          defaultReasoningEffort: null,
          reasoningEfforts: harden([makeToolSet()]),
        }),
      ),
    { message: /invalid reasoning efforts/ },
  );
});

test('Codex model schema is translated at the backend boundary', t => {
  t.deepEqual(
    normalizeCodexModelDescriptor(
      harden({
        id: 'gpt-test',
        displayName: 'GPT Test',
        description: 'Pinned schema fixture',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: harden([
          harden({ reasoningEffort: 'low' }),
          harden({ reasoningEffort: 'medium' }),
        ]),
      }),
    ),
    {
      id: 'gpt-test',
      title: 'GPT Test',
      description: 'Pinned schema fixture',
      default: true,
      defaultReasoningEffort: 'medium',
      reasoningEfforts: ['low', 'medium'],
    },
  );
});

test('broker lease is bound to session, namespace, model, and quotas', t => {
  t.deepEqual(
    assertBrokerLeaseV1(validLease(), {
      ...validLeaseRequirements(),
      model: 'gpt-test',
    }),
    validLease(),
  );
  t.throws(
    () =>
      assertBrokerLeaseV1(
        harden({ ...validLease(), networkNamespaceId: 'shared-netns' }),
        validLeaseRequirements(),
      ),
    { message: /identity does not match/ },
  );
  for (const endpoint of [
    'http://bearer@127.0.0.1:4317/',
    'http://user:secret@127.0.0.1:4317/',
  ]) {
    t.throws(
      () =>
        assertBrokerLeaseV1(
          harden({ ...validLease(), endpoint }),
          validLeaseRequirements(),
        ),
      { message: /provider-bound loopback/ },
    );
  }
  for (const replacement of [
    { providerOrigin: 'https://attacker.invalid' },
    { accountRef: 'wrong-account' },
  ]) {
    t.throws(
      () =>
        assertBrokerLeaseV1(
          harden({ ...validLease(), ...replacement }),
          validLeaseRequirements(),
        ),
      { message: /identity does not match/ },
    );
  }
});

test('backend factory requires an approved image and exact workspace cwd', async t => {
  t.throws(
    () =>
      makeCodexBackendFactory({
        imageDigest: '',
        destroy: async () => undefined,
        listModels: async () => [],
        provision: async () => {
          throw Error('must not provision');
        },
      }),
    { message: /operator-approved image digest/ },
  );

  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [],
    provision: async () => {
      throw Error('must not provision');
    },
  });
  await t.throwsAsync(
    () =>
      factory.create({ sessionId: 'session-1', cwd: '/etc' }, makeToolSet()),
    { message: /cwd must be \/workspace/ },
  );
  for (const sessionId of ['.', '..', '.hidden', 'a.b', 'x'.repeat(129)]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => factory.create({ sessionId }, makeToolSet()), {
      message: /bounded portable path component/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => factory.destroy({ sessionId }), {
      message: /bounded portable path component/,
    });
  }
});

test('failed attestation disposes provisioned resources', async t => {
  let disposed = 0;
  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [],
    provision: async () => ({
      start: async () => {
        throw Error('must not start');
      },
      dispose: async () => {
        disposed += 1;
      },
      policy: { ...validPolicy(), network: 'private' },
      auditWriter: harden({ append: async () => undefined }),
    }),
  });
  await t.throwsAsync(
    () => factory.create({ sessionId: 'session-1' }, makeToolSet()),
    { message: /field.*network.*not enforced/ },
  );
  t.is(disposed, 1);
});

test('run and admin facets separate turn authority from teardown', async t => {
  let disposed = 0;
  const events = [];
  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [
      {
        id: 'gpt-test',
        displayName: 'GPT Test',
        description: '',
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      },
    ],
    provision: async () => ({
      start: async () => {
        throw Error('not started by this lifecycle test');
      },
      dispose: async () => {
        disposed += 1;
      },
      policy: validPolicy(),
      auditWriter: harden({
        append: async (kind, payload) => {
          events.push({ kind, payload });
        },
      }),
    }),
  });
  t.deepEqual(await factory.listModels(), [
    {
      id: 'gpt-test',
      title: 'GPT Test',
      description: '',
      default: true,
      defaultReasoningEffort: 'high',
      reasoningEfforts: ['high'],
    },
  ]);
  const session = await factory.create(
    { sessionId: 'session-1' },
    makeToolSet(),
  );
  t.deepEqual(
    // eslint-disable-next-line no-underscore-dangle
    [.../** @type {any} */ (session.run).__getMethodNames__()].sort(),
    [
      '__getInterfaceGuard__',
      '__getMethodNames__',
      'acknowledge',
      'help',
      'interrupt',
      'models',
      'send',
      'status',
    ],
  );
  t.false(
    // eslint-disable-next-line no-underscore-dangle
    /** @type {any} */ (session.run).__getMethodNames__().includes('terminate'),
  );
  t.true(events.some(event => event.kind === 'sandbox-attested'));
  await session.admin.terminate();
  await session.admin.terminate();
  t.is(disposed, 1);
});

test('resource provisioner unwinds every completed stage in reverse order', async t => {
  const cleanup = [];
  const provision = makeCodexResourceProvisioner({
    imageDigest,
    providerOrigin,
    accountRef,
    makeAuditJournal: async () => ({
      writer: harden({ append: async () => undefined }),
    }),
    makeWorkspace: async () =>
      harden({
        remove: async () => {
          cleanup.push('workspace');
        },
      }),
    mountWorkspace: async () =>
      harden({
        unmount: async () => {
          cleanup.push('mount');
        },
      }),
    issueBrokerLease: async () =>
      harden({
        attestation: async () => validLease(),
        revoke: async () => {
          cleanup.push('broker');
        },
      }),
    makeSlice: async () =>
      harden({
        policy: async () => ({ ...validPolicy(), network: 'private' }),
        dispose: async () => {
          cleanup.push('slice');
        },
      }),
    startTransport: async () => {
      throw Error('not reached');
    },
    loadThreadState: async () => ({}),
    saveThreadState: async () => undefined,
  });
  await t.throwsAsync(() => provision({ sessionId: 'session-1' }), {
    message: /field.*network.*not enforced/,
  });
  t.deepEqual(cleanup, ['slice', 'broker', 'mount', 'workspace']);
});

test('resource provisioner journals rollback failures', async t => {
  const events = [];
  const provision = makeCodexResourceProvisioner({
    imageDigest,
    providerOrigin,
    accountRef,
    makeAuditJournal: async () => ({
      writer: harden({
        append: async (kind, payload) => {
          events.push({ kind, payload });
        },
      }),
    }),
    makeWorkspace: async () => harden({ remove: async () => undefined }),
    mountWorkspace: async () => harden({ unmount: async () => undefined }),
    issueBrokerLease: async () =>
      harden({
        attestation: async () => validLease(),
        revoke: async () => undefined,
      }),
    makeSlice: async () =>
      harden({
        policy: async () => ({ ...validPolicy(), network: 'private' }),
        dispose: async () => {
          throw Error('slice reap failed');
        },
      }),
    startTransport: async () => {
      throw Error('not reached');
    },
    loadThreadState: async () => ({}),
    saveThreadState: async () => undefined,
  });

  await t.throwsAsync(() => provision({ sessionId: 'session-1' }), {
    instanceOf: AggregateError,
    message: /provisioning and rollback failed/,
  });
  t.like(
    events.find(event => event.kind === 'session-provisioning-cleanup-failed'),
    {
      payload: {
        sessionId: 'session-1',
        failures: ['slice reap failed'],
      },
    },
  );
});

test('resource disposal retries only unfinished cleanup stages', async t => {
  const calls = { slice: 0, broker: 0, mount: 0, workspace: 0 };
  const provision = makeCodexResourceProvisioner({
    imageDigest,
    providerOrigin,
    accountRef,
    makeAuditJournal: async () => ({
      writer: harden({ append: async () => undefined }),
    }),
    makeWorkspace: async () =>
      harden({
        remove: async () => {
          calls.workspace += 1;
        },
      }),
    mountWorkspace: async () =>
      harden({
        unmount: async () => {
          calls.mount += 1;
        },
      }),
    issueBrokerLease: async () =>
      harden({
        attestation: async () => validLease(),
        revoke: async () => {
          calls.broker += 1;
          if (calls.broker === 1) throw Error('retry broker revoke');
        },
      }),
    makeSlice: async () =>
      harden({
        policy: async () => validPolicy(),
        dispose: async () => {
          calls.slice += 1;
        },
      }),
    startTransport: async () => {
      throw Error('not reached');
    },
    loadThreadState: async () => ({}),
    saveThreadState: async () => undefined,
  });
  const resources = await provision({ sessionId: 'session-1' });
  await t.throwsAsync(() => resources.dispose(), {
    message: /did not fully dispose/,
  });
  await resources.dispose();
  t.deepEqual(calls, { slice: 1, broker: 2, mount: 1, workspace: 1 });
});

test('an unsettled tool call blocks teardown without destroying the session', async t => {
  let disposed = 0;
  /** @type {(value: string) => void} */
  let releaseTool = () => {};
  const toolRunning = new Promise(resolve => {
    releaseTool = resolve;
  });
  /** @type {() => void} */
  let toolStarted = () => {};
  const started = new Promise(resolve => {
    toolStarted = resolve;
  });
  // Never leave the tool pending: a failing assertion below would otherwise
  // strand the client's message pump and keep the worker alive.
  t.teardown(() => releaseTool('torn down'));

  // A transport that answers enough of the protocol to reach a live tool call.
  const outbound = [];
  const inbound = [];
  const waiters = [];
  let closed = false;
  const push = message => {
    inbound.push(message);
    while (waiters.length) waiters.shift()();
  };
  const transport = {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (inbound.length) yield inbound.shift();
          else if (closed) return;
          // eslint-disable-next-line no-await-in-loop
          else await new Promise(resolve => waiters.push(resolve));
        }
      },
    },
    send: async message => {
      outbound.push(message);
      if (!('id' in message) || !('method' in message)) return;
      if (message.method === 'initialize') {
        push({
          id: message.id,
          result: {
            codexHome: '/codex-home',
            platformFamily: 'unix',
            platformOs: 'linux',
            userAgent: 'codex-test',
          },
        });
      } else if (message.method === 'thread/start') {
        push({ id: message.id, result: { thread: { id: 'thread-1' } } });
      } else if (message.method === 'turn/start') {
        push({
          id: message.id,
          result: { turn: { id: 'turn-1', status: 'inProgress' } },
        });
      }
    },
    close: async () => {
      closed = true;
      while (waiters.length) waiters.shift()();
    },
  };

  const toolSet = makeExo('TestHostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({
        dynamicTools: harden([
          harden({
            type: 'function',
            name: 'slow',
            description: 'A tool that takes a while.',
            inputSchema: harden({
              type: 'object',
              properties: harden({}),
              required: harden([]),
            }),
          }),
        ]),
        toolSetId: 'tools-v1',
      });
    },
    async execute() {
      toolStarted();
      return toolRunning;
    },
    help() {
      return 'Test hosted tool set.';
    },
  });

  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [],
    provision: async () => ({
      start: async () => transport,
      dispose: async () => {
        disposed += 1;
      },
      policy: validPolicy(),
      auditWriter: harden({ append: async () => undefined }),
    }),
  });
  const session = await factory.create({ sessionId: 'session-1' }, toolSet);
  await E(session.run).send('do the slow thing');
  // Pushed after the turn is bound, so the request correlates to it.
  push({
    id: 7,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: 'slow',
      arguments: {},
    },
  });
  await started;

  // Teardown must refuse while an Endo tool call is unsettled — and, crucially,
  // must not have destroyed the slice, the workspace, or the broker lease on
  // the way to refusing.
  const refusal = /** @type {AggregateError} */ (
    await t.throwsAsync(session.admin.terminate())
  );
  t.regex(
    refusal.errors.map(error => `${error.message}`).join('\n'),
    /unsettled Endo tool call/,
  );
  t.is(disposed, 0, 'the session was left intact for a lifecycle retry');

  releaseTool('done');
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const status = await E(session.run).status();
    if (status.pendingToolCalls === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await session.admin.terminate();
  t.is(disposed, 1, 'and the retry tears it down');
});
