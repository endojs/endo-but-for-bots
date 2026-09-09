// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import {
  HostedToolSetInterface,
  assertHostedBackendDescriptor,
  normalizeHostedModelDescriptor,
} from '@endo/hosted-agent';

import {
  HOSTED_AGENT_POLICY_V1,
  assertBrokerLeaseV1,
  assertContainerMounts,
  assertHostedAgentPolicyV1,
  makeCodexBackendFactory,
  makeCodexResourceProvisioner,
  normalizeCodexModelDescriptor,
} from '../src/backend-factory.js';
import { makeRenewingCodexBackend } from '../src/renewing-backend.js';

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
    authMode: 'api-key',
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

test('renewal with the real factory reaps before provisioning and resumes acknowledged state', async t => {
  t.timeout(5000);
  const lifecycle = [];
  const protocol = [];
  let saved = {};
  let generation = 0;
  let turnCount = 0;
  const factory = makeRenewingCodexBackend(
    makeCodexBackendFactory({
      imageDigest,
      listModels: async () => [],
      destroy: async () => undefined,
      provision: async spec => {
        generation += 1;
        const number = generation;
        lifecycle.push(`provision-${number}`);
        const inbound = [];
        const waiters = [];
        let closed = false;
        const push = value => {
          inbound.push(value);
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
            if (!('id' in message) || !('method' in message)) return;
            protocol.push(message);
            let result;
            if (message.method === 'initialize') {
              result = {
                codexHome: '/codex-home',
                platformFamily: 'unix',
                platformOs: 'linux',
                userAgent: 'test',
              };
            } else if (message.method === 'account/read') {
              result = {
                account: { type: 'apiKey' },
                requiresOpenaiAuth: true,
              };
            } else if (
              ['thread/start', 'thread/resume'].includes(message.method)
            ) {
              result = { thread: { id: 'durable-thread' } };
            } else if (message.method === 'thread/turns/list') {
              result = {
                data: turnCount ? [{ id: `turn-${turnCount}` }] : [],
                nextCursor: null,
              };
            } else if (message.method === 'turn/start') {
              turnCount += 1;
              const id = `turn-${turnCount}`;
              push({
                id: message.id,
                result: { turn: { id, status: 'inProgress' } },
              });
              push({
                method: 'turn/started',
                params: {
                  threadId: 'durable-thread',
                  turn: { id, status: 'inProgress' },
                },
              });
              push({
                method: 'turn/completed',
                params: {
                  threadId: 'durable-thread',
                  turn: { id, status: 'completed' },
                },
              });
              return;
            } else {
              throw Error(`Unexpected request ${message.method}`);
            }
            push({ id: message.id, result });
          },
          close: async () => {
            lifecycle.push(`close-${number}`);
            closed = true;
            while (waiters.length) waiters.shift()();
          },
        };
        return {
          policy: validPolicy(),
          auditWriter: harden({ append: async () => undefined }),
          threadId: saved.threadId,
          savedToolSetId: saved.toolSetId,
          savedRecovery: saved.recovery,
          saveThreadState: async value => {
            saved = value;
          },
          start: async () => transport,
          dispose: async () => {
            lifecycle.push(`dispose-${number}`);
          },
        };
      },
    }),
  );
  const session = await E(factory).create(
    harden({ sessionId: 'session-1' }),
    makeToolSet(),
  );
  t.teardown(() => E(session.admin).terminate());
  const drain = async reader => {
    const events = [];
    for await (const event of iterateReader(reader)) events.push(event);
    return events;
  };
  const first = await drain(await E(session.run).send('first'));
  t.deepEqual(first.at(-1), { type: 'end', checkpoint: 'turn-1' });
  await E(session.run).acknowledge('turn-1');
  const second = await drain(await E(session.run).send('second'));
  t.deepEqual(second.at(-1), { type: 'end', checkpoint: 'turn-2' });
  t.true(lifecycle.indexOf('close-2') < lifecycle.indexOf('dispose-2'));
  t.true(lifecycle.indexOf('dispose-2') < lifecycle.indexOf('provision-3'));
  t.is(protocol.filter(message => message.method === 'thread/start').length, 1);
  t.is(
    protocol.filter(message => message.method === 'thread/resume').length,
    1,
  );
  t.false(protocol.some(message => message.method === 'thread/revert'));
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

test('create() for a session the factory still runs stops the old instance first', async t => {
  let provisions = 0;
  let disposed = 0;
  const events = [];
  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [],
    provision: async () => {
      provisions += 1;
      return {
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
      };
    },
  });
  // A Floot factory rebuilt without a daemon restart revives the session by
  // creating it again; the instance the old factory owned must not run on
  // beside it over the same workspace and journal.
  const first = await factory.create({ sessionId: 'session-1' }, makeToolSet());
  const second = await factory.create(
    { sessionId: 'session-1' },
    makeToolSet(),
  );
  t.is(provisions, 2);
  t.is(disposed, 1, 'the first instance was torn down before the second');
  t.true(events.some(event => event.kind === 'session-closed'));
  // The superseded admin facet has nothing left to do; the new one owns the
  // session.
  await first.admin.terminate();
  t.is(disposed, 1);
  await second.admin.terminate();
  t.is(disposed, 2);
});

test('destroy() stops a live instance before removing durable state', async t => {
  let disposed = 0;
  const destroyed = [];
  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async spec => {
      destroyed.push({ sessionId: spec.sessionId, stoppedFirst: disposed });
    },
    listModels: async () => [],
    provision: async () => ({
      start: async () => {
        throw Error('not started by this lifecycle test');
      },
      dispose: async () => {
        disposed += 1;
      },
      policy: validPolicy(),
      auditWriter: harden({ append: async () => undefined }),
    }),
  });
  await factory.create({ sessionId: 'session-1' }, makeToolSet());
  await factory.destroy({ sessionId: 'session-1' });
  t.is(disposed, 1);
  t.deepEqual(destroyed, [{ sessionId: 'session-1', stoppedFirst: 1 }]);
  // Lifecycle replay with nothing live is an idempotent destroy.
  await factory.destroy({ sessionId: 'session-1' });
  t.is(disposed, 1);
  t.is(destroyed.length, 2);
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
  // The workspace is durable: a session revived after a restart reopens the
  // one it had, so a failure past that point must not remove it. Its removal
  // belongs to the factory's destroy.
  t.deepEqual(cleanup, ['slice', 'broker', 'mount']);
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
        failures: [
          'slice reap failed',
          'Workspace remains leased until slice is reaped',
        ],
      },
    },
  );
});

for (const failedStage of [
  'slice',
  'broker',
  'mount',
  'slice-creation',
  'slice-creation-and-broker',
]) {
  test(`failed provisioning retains ${failedStage} cleanup before admission`, async t => {
    t.timeout(5000);
    const calls = { workspace: 0, slice: 0, broker: 0, mount: 0 };
    let failing = true;
    let hiddenSlice = false;
    const provision = makeCodexResourceProvisioner({
      imageDigest,
      providerOrigin,
      accountRef,
      makeAuditJournal: async () => ({
        writer: harden({ append: async () => undefined }),
      }),
      makeWorkspace: async () => {
        calls.workspace += 1;
        return harden({});
      },
      mountWorkspace: async () =>
        harden({
          unmount: async () => {
            calls.mount += 1;
            if (failing && failedStage === 'mount') throw Error('mount failed');
          },
        }),
      issueBrokerLease: async () =>
        harden({
          attestation: async () => validLease(),
          revoke: async () => {
            calls.broker += 1;
            if (failing && failedStage === 'broker')
              throw Error('broker failed');
            if (
              failedStage === 'slice-creation-and-broker' &&
              calls.broker === 1
            ) {
              throw Error('broker transiently failed');
            }
          },
        }),
      makeSlice: async () => {
        if (failedStage.startsWith('slice-creation')) {
          hiddenSlice = true;
          throw Error('slice creation failed');
        }
        return harden({
          policy: async () => ({ ...validPolicy(), network: 'private' }),
          dispose: async () => {
            calls.slice += 1;
            if (failing && failedStage === 'slice') throw Error('slice failed');
          },
        });
      },
      retrySliceCleanup: async () => {
        if (!hiddenSlice) return;
        if (failing) throw Error('hidden slice remains');
        hiddenSlice = false;
      },
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
    if (failedStage.startsWith('slice')) {
      t.is(calls.mount, 0, 'workspace lease survives incomplete slice cleanup');
      t.is(calls.broker, 1, 'orphan inference authority is revoked promptly');
    }
    await t.throwsAsync(() => provision({ sessionId: 'session-2' }), {
      message: /cleanup remains pending|hidden slice remains/,
    });
    t.is(calls.workspace, 1, 'no acquisition can overtake failed cleanup');
    if (failedStage === 'slice-creation-and-broker') {
      t.is(
        calls.broker,
        2,
        'revocation retries despite persistent slice failure',
      );
      t.is(calls.mount, 0, 'workspace still remains leased');
    }
    failing = false;
    await Promise.all([provision.retryCleanup(), provision.retryCleanup()]);
    t.false(hiddenSlice);
    t.is(calls.mount, failedStage === 'mount' ? 3 : 1);
    const expectedBrokerCalls = {
      slice: 1,
      broker: 3,
      mount: 1,
      'slice-creation': 1,
      'slice-creation-and-broker': 2,
    };
    t.is(calls.broker, expectedBrokerCalls[failedStage]);
    const afterCleanup = { ...calls };
    await provision.retryCleanup();
    t.deepEqual(calls, afterCleanup, 'settled inverses are not repeated');
  });
}

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
  t.deepEqual(calls, { slice: 1, broker: 2, mount: 1, workspace: 0 });
});

test('an unsettled tool call blocks teardown without destroying the session', async t => {
  t.timeout(10_000);
  /** @type {() => Promise<void>} */
  let shutdown = async () => {
    throw Error('shutdown not registered');
  };
  let disposed = 0;
  /** @type {(value: string) => void} */
  let releaseTool = () => {};
  const toolRunning = new Promise(resolve => {
    releaseTool = resolve;
  });
  /** @type {(value?: any) => void} */
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
      } else if (message.method === 'account/read') {
        push({
          id: message.id,
          result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
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
    registerShutdown: stop => {
      shutdown = stop;
    },
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
  await E(session.run).send('do the slow thing', harden({}));
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
  await t.throwsAsync(() => shutdown(), { message: /shutdown pending/ });
  t.is(disposed, 0, 'host shutdown also honors the pending tool barrier');
  await t.throwsAsync(
    () => E(factory).create({ sessionId: 'other' }, toolSet),
    {
      message: /shutting down/,
    },
  );

  releaseTool('done');
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const status = await E(session.run).status();
    if (status.pendingToolCalls === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await shutdown();
  t.is(disposed, 1, 'and the retry tears it down');
});

// ---------------------------------------------------------------------------
// Runtime attaches at the attested boundary
// (designs/runtime-container-fs-mount.md)
// ---------------------------------------------------------------------------

const ATTACH_DECLARED = harden({
  key: 'a1',
  source: '/host/mounts/claude-attach-a1',
  destination: '/mnt/project',
  mode: 'rw',
});
const attachRow = (overrides = {}) =>
  harden({
    role: 'attach-a1',
    destination: '/mnt/project',
    mode: 'rw',
    source: 'attach:a1',
    options: harden(['nosuid', 'nodev']),
    ...overrides,
  });

test('assertContainerMounts admits a bounded declaration and nothing else', t => {
  t.deepEqual(assertContainerMounts(undefined), []);
  t.deepEqual(assertContainerMounts([ATTACH_DECLARED]), [ATTACH_DECLARED]);
  /** @type {[string, unknown, RegExp][]} */
  const rejected = [
    ['not an array', {}, /must be an array/],
    [
      'an extra field',
      { ...ATTACH_DECLARED, cap: {} },
      /unknown or missing fields/,
    ],
    [
      'a key outside the alphabet',
      { ...ATTACH_DECLARED, key: '../x' },
      /not a portable key/,
    ],
    [
      'a relative source',
      { ...ATTACH_DECLARED, source: 'x' },
      /host mountpoint/,
    ],
    [
      'a destination outside /mnt/',
      { ...ATTACH_DECLARED, destination: '/workspace' },
      /under \/mnt\//,
    ],
    ['an unknown mode', { ...ATTACH_DECLARED, mode: 'rwx' }, /mode must be/],
  ];
  for (const [label, bad, message] of rejected) {
    // The first row hands the non-array in directly; every other row is one
    // malformed entry inside an otherwise well-formed list.
    const candidates =
      typeof bad === 'object' && bad !== null && Object.keys(bad).length === 0
        ? bad
        : [bad];
    t.throws(() => assertContainerMounts(candidates), { message }, label);
  }
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        {
          ...ATTACH_DECLARED,
          destination: '/mnt/other',
          source: '/host/mounts/other',
        },
      ]),
    { message: /key.*duplicated/ },
  );
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        { ...ATTACH_DECLARED, key: 'a2', source: '/host/mounts/other' },
      ]),
    { message: /destination.*duplicated/ },
  );
});

test('the attested table is the five roles plus exactly the declared attaches', t => {
  const withAttach = harden({
    ...validPolicy(),
    mounts: harden([...validPolicy().mounts, attachRow()]),
  });
  // Declared and present: attested, in its declared mode.
  const policy = assertHostedAgentPolicyV1(withAttach, {
    containerMounts: [ATTACH_DECLARED],
  });
  t.is(policy.mounts.length, 6);
  const ro = assertHostedAgentPolicyV1(
    harden({
      ...validPolicy(),
      mounts: harden([...validPolicy().mounts, attachRow({ mode: 'ro' })]),
    }),
    { containerMounts: [{ ...ATTACH_DECLARED, mode: 'ro' }] },
  );
  t.is(ro.mounts.at(-1)?.mode, 'ro');

  // Present but not declared: the undeclared mount the check exists for.
  t.throws(() => assertHostedAgentPolicyV1(withAttach), {
    message: /undeclared mount/,
  });
  // Declared but absent from the table.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(validPolicy(), {
        containerMounts: [ATTACH_DECLARED],
      }),
    { message: /undeclared mount/ },
  );
  // Declared read-only, attested read-write: the mode is part of the claim.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(withAttach, {
        containerMounts: [{ ...ATTACH_DECLARED, mode: 'ro' }],
      }),
    { message: /exact session table/ },
  );
  // A row under a declared key at the wrong destination.
  t.throws(
    () =>
      assertHostedAgentPolicyV1(
        harden({
          ...validPolicy(),
          mounts: harden([
            ...validPolicy().mounts,
            attachRow({ destination: '/mnt/elsewhere' }),
          ]),
        }),
        { containerMounts: [ATTACH_DECLARED] },
      ),
    { message: /exact session table/ },
  );
});

test('the provisioner declares attaches to the slice and keeps them out of the lease', async t => {
  /** @type {{ makeSlice?: any, lease?: any }} */
  const seen = {};
  const provision = makeCodexResourceProvisioner({
    imageDigest,
    providerOrigin,
    accountRef,
    makeAuditJournal: async () => ({
      writer: harden({ append: async () => undefined }),
    }),
    makeWorkspace: async () => harden({}),
    mountWorkspace: async () => harden({ unmount: async () => undefined }),
    issueBrokerLease: async spec => {
      seen.lease = spec;
      return harden({
        revoke: async () => undefined,
        attestation: async () => validLease(),
      });
    },
    makeSlice: async options => {
      seen.makeSlice = options;
      return harden({
        policy: async () =>
          harden({
            ...validPolicy(),
            mounts: harden([...validPolicy().mounts, attachRow()]),
          }),
        dispose: async () => undefined,
      });
    },
    startTransport: async () => harden({}),
    loadThreadState: async () => harden({}),
    saveThreadState: async () => undefined,
  });
  const resources = await provision(
    harden({ sessionId: 'session-1', containerMounts: [ATTACH_DECLARED] }),
  );
  t.teardown(() => resources.dispose());
  t.deepEqual(seen.makeSlice.spec.containerMounts, [ATTACH_DECLARED]);
  t.false('containerMounts' in seen.lease);
  t.is(resources.policy.mounts.length, 6);

  // A slice that came back without the declared attach is refused at this
  // boundary, before app-server can start.
  const refusing = makeCodexResourceProvisioner({
    imageDigest,
    providerOrigin,
    accountRef,
    makeAuditJournal: async () => ({
      writer: harden({ append: async () => undefined }),
    }),
    makeWorkspace: async () => harden({}),
    mountWorkspace: async () => harden({ unmount: async () => undefined }),
    issueBrokerLease: async () =>
      harden({
        revoke: async () => undefined,
        attestation: async () => validLease(),
      }),
    makeSlice: async () =>
      harden({
        policy: async () => validPolicy(),
        dispose: async () => undefined,
      }),
    startTransport: async () => harden({}),
    loadThreadState: async () => harden({}),
    saveThreadState: async () => undefined,
  });
  await t.throwsAsync(
    () =>
      refusing(
        harden({ sessionId: 'session-1', containerMounts: [ATTACH_DECLARED] }),
      ),
    { message: /undeclared mount/ },
  );
});

test('the backend factory attests the declared attaches at the authority handoff', async t => {
  const events = [];
  const factory = makeCodexBackendFactory({
    imageDigest,
    destroy: async () => undefined,
    listModels: async () => [],
    provision: async spec => ({
      start: async () => {
        throw Error('not started by this lifecycle test');
      },
      dispose: async () => undefined,
      policy: harden({
        ...validPolicy(),
        mounts: harden([
          ...validPolicy().mounts,
          ...(spec.containerMounts || []).map(attach =>
            attachRow({
              role: `attach-${attach.key}`,
              source: `attach:${attach.key}`,
              destination: attach.destination,
              mode: attach.mode,
            }),
          ),
        ]),
      }),
      auditWriter: harden({
        append: async (kind, payload) => {
          events.push({ kind, payload });
        },
      }),
    }),
  });
  const session = await factory.create(
    harden({ sessionId: 'session-1', containerMounts: [ATTACH_DECLARED] }),
    makeToolSet(),
  );
  t.teardown(() => session.admin.terminate());
  const attested = events.find(event => event.kind === 'sandbox-attested');
  t.deepEqual(attested?.payload.containerMounts, [
    { key: 'a1', destination: '/mnt/project', mode: 'rw' },
  ]);
  // A malformed declaration is refused before anything is provisioned.
  await t.throwsAsync(
    () =>
      factory.create(
        harden({
          sessionId: 'session-2',
          containerMounts: [{ ...ATTACH_DECLARED, destination: '/etc' }],
        }),
        makeToolSet(),
      ),
    { message: /under \/mnt\// },
  );
});

test('assertContainerMounts validates every entry it counts, and refuses nesting', t => {
  // A sparse array: `map` would skip the holes and return a list whose
  // `length` counts entries no check ever saw — and that length is what the
  // attested table is sized against, so the holes would reach the slice
  // request as `undefined` mount rows.
  t.throws(
    () => assertContainerMounts(new Array(3)),
    { message: /unknown or missing fields/ },
    'array holes are entries, not gaps',
  );
  // Built rather than written as a sparse literal, which lint forbids.
  const withHole = new Array(3);
  withHole[0] = ATTACH_DECLARED;
  withHole[2] = ATTACH_DECLARED;
  t.throws(
    () => assertContainerMounts(withHole),
    { message: /unknown or missing fields/ },
    'a hole between well-formed entries is still refused',
  );

  // Nested destinations are each declared and each attested, but the
  // attested table has no ordering, so it cannot say which projection the
  // slice sees at the shadowed path.
  t.throws(
    () =>
      assertContainerMounts([
        ATTACH_DECLARED,
        harden({
          key: 'b2',
          source: '/host/mounts/claude-attach-b2',
          destination: `${ATTACH_DECLARED.destination}/inner`,
          mode: 'ro',
        }),
      ]),
    { message: /nests with/ },
  );
});
