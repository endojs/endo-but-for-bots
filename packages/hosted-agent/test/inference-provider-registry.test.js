// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  makeEndoSecretParticipant,
  makeInferenceProviderRegistry,
} from '../src/inference-provider-registry.js';
import { makeProviderBrokerGrantIssuer } from '../src/provider-grant-issuer.js';
import { InferenceEndpointInterface } from '../src/subscription-share.js';

const limits = harden({ concurrentTurns: 1, dailyTokens: 1000 });

const TestSecretBlobInterface = M.interface('TestSecretBlob', {
  readBase64: M.callWhen().returns(M.string()),
  getDescription: M.callWhen().returns(M.string()),
});
const TestReaderInterface = M.interface('TestReader', {});
const TestOrphanBlobInterface = M.interface('TestOrphanBlob', {});

const providerRequest = (overrides = {}) =>
  harden({
    idempotencyKey: 'create-0000000001',
    displayName: 'Claude',
    kind: 'anthropic',
    defaultModel: 'claude-test',
    limits,
    keyBase64: encodeBase64(encodeUtf8('canary-secret')),
    ...overrides,
  });

const makeBacking = () => {
  let snapshot;
  const secrets = new Map();
  const journal = {
    read: async () => snapshot,
    write: async value => {
      snapshot = value;
    },
  };
  const secretParticipant = {
    has: async name => secrets.has(name),
    provide: async (name, description, bytesBase64) => {
      const existing = secrets.get(name);
      if (existing !== undefined) return existing.blob;
      if (bytesBase64 === undefined) throw Error('key needed');
      const blob = makeExo('SecretBlob', TestSecretBlobInterface, {
        readBase64: async () => bytesBase64,
        getDescription: async () => description,
      });
      secrets.set(name, { blob, state: 'active', bytesBase64 });
      return blob;
    },
    revoke: async name => {
      const secret = secrets.get(name);
      if (secret === undefined) throw Error('unknown secret');
      secret.state = 'revoked';
    },
    state: async name => secrets.get(name)?.state || 'missing',
    listNames: async () => [...secrets.keys()],
  };
  return {
    journal,
    secretParticipant,
    secrets,
    get snapshot() {
      return snapshot;
    },
  };
};

const makeIds = () => {
  let next = 0;
  return () => `id-${`${(next += 1)}`.padStart(8, '0')}`;
};

const makeIssuerFactory =
  events =>
  async ({ descriptor }) => {
    events.push(['issuer', descriptor.providerId]);
    const live = new Set();
    let disposed = false;
    return harden({
      openEndpoint: async ({ sessionId }) => {
        events.push(['open', sessionId]);
        let revoked = false;
        /** @type {Set<() => void>} */
        const cancellations = new Set();
        const endpoint = makeExo(
          'InferenceEndpoint',
          InferenceEndpointInterface,
          {
            request: async message => {
              await null;
              if (disposed || revoked) throw Error('endpoint revoked');
              events.push(['request', sessionId, message.path]);
              if (message.path === '/wait') {
                await new Promise((resolve, reject) => {
                  cancellations.add(() => reject(Error('request canceled')));
                });
              }
              return harden({ status: 200, headers: {}, body: 'ok' });
            },
            requestByteStream: async message => {
              if (disposed || revoked) throw Error('endpoint revoked');
              events.push(['stream', sessionId, message.path]);
              return harden({
                status: 200,
                headers: {},
                body: makeExo('reader', TestReaderInterface, {}),
              });
            },
            attestation: async () => harden({ version: 'fake-v1', sessionId }),
            revoke: async () => {
              revoked = true;
              for (const cancel of cancellations) cancel();
              cancellations.clear();
              live.delete(endpoint);
              events.push(['revoke', sessionId]);
            },
          },
        );
        live.add(endpoint);
        return endpoint;
      },
      dispose: async () => {
        disposed = true;
        await Promise.all([...live].map(endpoint => E(endpoint).revoke()));
        events.push(['dispose', descriptor.providerId]);
      },
    });
  };

const makeRegistry = (backing, options = {}) => {
  const events = options.events || [];
  return makeInferenceProviderRegistry({
    journal: backing.journal,
    secrets: backing.secretParticipant,
    makeIssuer: makeIssuerFactory(events),
    validateLimits: value =>
      harden({ .../** @type {Record<string, unknown>} */ (value) }),
    randomId: options.randomId || makeIds(),
    now: options.now || (() => '2026-10-27T00:00:00.000Z'),
    ...(options.afterCommit === undefined
      ? {}
      : { afterCommit: options.afterCommit }),
    ...(options.intentExpiryMs === undefined
      ? {}
      : { intentExpiryMs: options.intentExpiryMs }),
  });
};

const message = path => harden({ method: 'POST', path, body: '{}' });

test('first release admits only Anthropic and shape-valid model ids', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');

  await Promise.all(
    /** @type {Array<[Record<string, unknown>, string]>} */ ([
      [{ kind: 'openai-compatible' }, 'invalid-kind'],
      [{ baseUrl: 'https://api.anthropic.com' }, 'invalid-base-url'],
      [{ defaultModel: 'Claude-Test' }, 'invalid-model'],
      [{ defaultModel: 'claude/test' }, 'invalid-model'],
      [{ defaultModel: `a${'a'.repeat(128)}` }, 'invalid-model'],
    ]).map(([overrides, code], index) =>
      t.throwsAsync(
        () =>
          E(directory).create(
            providerRequest({
              idempotencyKey: `refuse-000000000${index}`,
              ...overrides,
            }),
          ),
        { message: new RegExp(code) },
      ),
    ),
  );

  const provider = await E(directory).create(
    providerRequest({
      idempotencyKey: 'create-0000000002',
      defaultModel: `a${'a'.repeat(127)}`,
    }),
  );
  t.is(provider.defaultModel.length, 128);
  await registry.close();
});

test('provider facets preserve ownership, supersession, immutable descriptors, and audit', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const alice = registry.directoryFor('owner-alice');
  const bob = registry.directoryFor('owner-bob');

  const first = await E(alice).create(providerRequest());
  t.is(first.state, 'active');
  t.deepEqual(await E(alice).list(), [first]);
  t.deepEqual(await E(bob).list(), []);
  await t.throwsAsync(() => E(bob).lookup(first.providerId), {
    message: /provider-not-found/,
  });
  await t.throwsAsync(() => E(bob).adminFor(first.providerId), {
    message: /provider-not-found/,
  });

  const admin = await E(alice).adminFor(first.providerId);
  const descriptorBefore = JSON.stringify(
    registry.inspect().descriptors[first.providerId],
  );
  const changed = await E(admin).setLimits(
    harden({ concurrentTurns: 1, dailyTokens: 500 }),
    'limits-0000000001',
  );
  t.is(changed.limits.dailyTokens, 500);
  t.is(
    JSON.stringify(registry.inspect().descriptors[first.providerId]),
    descriptorBefore,
  );
  t.is(
    registry.inspect().audit.filter(row => row.providerId === first.providerId)
      .length,
    2,
  );

  const second = await E(admin).supersede(
    providerRequest({
      idempotencyKey: 'replace-000000001',
      displayName: 'Claude replacement',
      keyBase64: encodeBase64(encodeUtf8('replacement-secret')),
    }),
  );
  t.is(second.supersedes, first.providerId);
  t.is((await E(admin).getSummary()).state, 'active');
  t.is((await E(alice).list()).length, 2);

  const use = registry.useFor('owner-alice', first.providerId);
  // CapTP introspection is the contract check: the use facet must not carry an
  // admin method.
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(use).__getMethodNames__();
  t.true(methods.includes('grant'));
  t.false(methods.includes('retire'));
  t.false(methods.includes('setLimits'));
  t.false(methods.includes('supersede'));
  await t.throwsAsync(
    () =>
      E(use).grant(
        harden({
          ownerId: 'owner-bob',
          agentId: 'agent-bob',
          model: 'claude-test',
        }),
      ),
    { message: /provider-owner-mismatch/ },
  );
});

for (const boundary of [
  'create-intent',
  'create-secret',
  'create-secret-recorded',
  'create-committed',
  'create-response',
]) {
  test(`creation recovers idempotently after ${boundary}`, async t => {
    const backing = makeBacking();
    let injected = false;
    const registry = await makeRegistry(backing, {
      afterCommit: reached => {
        if (!injected && reached === boundary) {
          injected = true;
          throw Error(`crash at ${boundary}`);
        }
      },
    });
    const request = providerRequest();
    await t.throwsAsync(
      () => E(registry.directoryFor('owner-alice')).create(request),
      { message: `crash at ${boundary}` },
    );
    await registry.close();

    const revived = await makeRegistry(backing);
    const answer = await E(revived.directoryFor('owner-alice')).create(request);
    t.is(answer.state, 'active');
    t.false(JSON.stringify(backing.snapshot).includes('canary-secret'));
    t.is((await E(revived.directoryFor('owner-alice')).list()).length, 1);
    t.is(backing.secrets.size, 1);
    const active = [...backing.secrets.values()].filter(
      secret => secret.state === 'active',
    );
    t.is(active.length, 1);
    t.is(
      Object.values(revived.inspect().operations).filter(
        operation => operation.kind === 'create',
      ).length,
      1,
    );
    await revived.close();
  });
}

for (const boundary of [
  'retire-intent',
  'retire-secret',
  'retire-secret-recorded',
  'retire-committed',
]) {
  test(`retirement recovers fail-closed after ${boundary}`, async t => {
    const backing = makeBacking();
    let armed = false;
    let injected = false;
    const registry = await makeRegistry(backing, {
      afterCommit: reached => {
        if (armed && !injected && reached === boundary) {
          injected = true;
          throw Error(`crash at ${boundary}`);
        }
      },
    });
    const directory = registry.directoryFor('owner-alice');
    const provider = await E(directory).create(providerRequest());
    armed = true;
    const admin = await E(directory).adminFor(provider.providerId);
    await t.throwsAsync(() => E(admin).retire('retire-000000001'), {
      message: `crash at ${boundary}`,
    });
    await registry.close();

    const revived = await makeRegistry(backing);
    const summary = await E(
      await E(revived.directoryFor('owner-alice')).adminFor(
        provider.providerId,
      ),
    ).getSummary();
    t.is(summary.state, 'retired');
    t.true(
      [...backing.secrets.values()].every(secret => secret.state === 'revoked'),
    );
    const revokedNames = new Set(
      [...backing.secrets.entries()]
        .filter(([, secret]) => secret.state === 'revoked')
        .map(([name]) => name),
    );
    for (const descriptor of Object.values(revived.inspect().descriptors)) {
      const lifecycle = revived.inspect().lifecycles[descriptor.providerId];
      t.false(
        lifecycle.state === 'active' &&
          revokedNames.has(descriptor.secretGrantFormulaId),
      );
    }
    await revived.close();
  });
}

test('restart lazily rebinds active grants and keeps revoked grants fenced', async t => {
  const backing = makeBacking();
  const firstEvents = [];
  const registry = await makeRegistry(backing, { events: firstEvents });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const use = registry.useFor('owner-alice', provider.providerId);
  const inference = await E(use).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  t.deepEqual(firstEvents, [], 'grant creation is inert');
  t.is((await E(inference).request(message('/v1/messages'))).status, 200);
  t.deepEqual(firstEvents.slice(0, 2), [
    ['issuer', provider.providerId],
    ['open', 'grant-000000001'],
  ]);
  await registry.close();

  const revivedEvents = [];
  const revived = await makeRegistry(backing, { events: revivedEvents });
  t.deepEqual(revivedEvents, [], 'restart does not eagerly open an endpoint');
  const revivedInference = revived.inferenceFor('grant-000000001');
  t.is(
    (await E(revivedInference).request(message('/v1/messages'))).status,
    200,
  );
  t.deepEqual(revivedEvents.slice(0, 2), [
    ['issuer', provider.providerId],
    ['open', 'grant-000000001'],
  ]);
  await revived.revokeGrant('grant-000000001');
  await revived.close();

  const afterRevoke = await makeRegistry(backing);
  await t.throwsAsync(
    () =>
      E(afterRevoke.inferenceFor('grant-000000001')).request(
        message('/v1/messages'),
      ),
    { message: /agent-deleted/ },
  );
  await afterRevoke.close();
});

test('retirement cancels an in-flight grant and fences it across restart', async t => {
  const backing = makeBacking();
  const events = [];
  const registry = await makeRegistry(backing, { events });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  const waiting = E(inference).request(message('/wait'));
  for (
    let turn = 0;
    turn < 20 && !events.some(event => event[0] === 'request');
    turn += 1
  ) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  const admin = await E(directory).adminFor(provider.providerId);
  await E(admin).retire('retire-000000001');
  await t.throwsAsync(waiting, { message: 'request canceled' });
  await t.throwsAsync(() => E(inference).request(message('/v1/messages')), {
    message: /provider-retired/,
  });
  await registry.close();

  const revived = await makeRegistry(backing);
  await t.throwsAsync(
    () =>
      E(revived.inferenceFor('grant-000000001')).request(
        message('/v1/messages'),
      ),
    { message: /provider-retired/ },
  );
  await revived.close();
});

test('AgentInference uses the existing issuer in-process without a listener', async t => {
  const backing = makeBacking();
  let requests = 0;
  const registry = await makeInferenceProviderRegistry({
    journal: backing.journal,
    secrets: backing.secretParticipant,
    makeIssuer: ({ descriptor, secret }) =>
      makeProviderBrokerGrantIssuer({
        runtime: {},
        secret,
        fetch: async (_input, init) => {
          requests += 1;
          t.is(init?.headers['x-api-key'], 'canary-secret');
          return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        policy: harden({
          origin: 'https://api.anthropic.test',
          routes: [{ method: 'POST', path: '/v1/messages' }],
          credentialHeader: 'x-api-key',
          maxConcurrentRequests: 1,
          maxRequestBytes: 1024n,
          maxResponseBytes: 1024n,
        }),
        imageDigest: `sha256:${'a'.repeat(64)}`,
        accountRef: descriptor.providerId,
        admits: model => model === descriptor.defaultModel,
      }),
    validateLimits: value =>
      harden({ .../** @type {Record<string, unknown>} */ (value) }),
    randomId: makeIds(),
    now: () => '2026-10-27T00:00:00.000Z',
  });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  const response = await E(inference).request(
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-test","max_tokens":1,"messages":[]}',
    }),
  );
  t.is(response.status, 200);
  t.is(requests, 1);
  await registry.close();
});

test('expired intent aborts and reconciliation revokes orphan registry secrets', async t => {
  const backing = makeBacking();
  let injected = false;
  const registry = await makeRegistry(backing, {
    now: () => '2026-10-27T00:00:00.000Z',
    intentExpiryMs: 1000,
    afterCommit: boundary => {
      if (!injected && boundary === 'create-intent') {
        injected = true;
        throw Error('crash after intent');
      }
    },
  });
  await t.throwsAsync(
    () => E(registry.directoryFor('owner-alice')).create(providerRequest()),
    { message: 'crash after intent' },
  );
  await registry.close();
  const orphanBlob = makeExo('SecretBlob', TestOrphanBlobInterface, {});
  backing.secrets.set('inference-provider-orphan', {
    blob: orphanBlob,
    state: 'active',
    bytesBase64: 'ignored',
  });

  const revived = await makeRegistry(backing, {
    now: () => '2026-10-27T00:00:02.000Z',
    intentExpiryMs: 1000,
  });
  t.is(
    Object.values(revived.inspect().operations).find(
      operation => operation.kind === 'create',
    )?.state,
    'aborted',
  );
  t.is(backing.secrets.get('inference-provider-orphan').state, 'revoked');
  t.deepEqual(await E(revived.directoryFor('owner-alice')).list(), []);
  await revived.close();
});

test('re-granting is idempotent, conflicts are refused, and attestation names the grant', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const use = registry.useFor('owner-alice', provider.providerId);
  const request = harden({
    grantId: 'grant-000000001',
    ownerId: 'owner-alice',
    agentId: 'agent-alice',
    model: 'claude-test',
  });
  const inference = await E(use).grant(request);
  t.is(await E(use).grant(request), inference);
  await t.throwsAsync(
    () => E(use).grant(harden({ ...request, agentId: 'agent-bob' })),
    { message: /grant-conflict/ },
  );

  const attestation = await E(inference).attestation();
  t.like(attestation, {
    version: 'fake-v1',
    grantId: 'grant-000000001',
    providerId: provider.providerId,
    agentId: 'agent-alice',
  });
  t.is(typeof attestation.generation, 'number');

  await E(inference).revoke();
  await t.throwsAsync(() => E(use).grant(request), {
    message: /agent-deleted/,
  });
  await registry.close();
});

test('grants validate owner, agent, and model, and streams flow through', async t => {
  const backing = makeBacking();
  const events = [];
  const registry = await makeRegistry(backing, { events });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const use = registry.useFor('owner-alice', provider.providerId);
  const request = harden({
    ownerId: 'owner-alice',
    agentId: 'agent-alice',
    model: 'claude-test',
  });
  await Promise.all(
    /** @type {const} */ ([
      [{ ownerId: 'owner-bob' }, 'provider-owner-mismatch'],
      [{ agentId: 'not an id!' }, 'invalid-agent'],
      [{ model: 'not a model!' }, 'invalid-model'],
      [{ model: 'claude-other' }, 'invalid-model'],
    ]).map(([overrides, code]) =>
      t.throwsAsync(() => E(use).grant(harden({ ...request, ...overrides })), {
        message: new RegExp(code),
      }),
    ),
  );
  const inference = await E(use).grant(request);
  const response = await E(inference).requestByteStream(message('/stream'));
  t.is(response.status, 200);
  t.true(
    events.some(([kind, , path]) => kind === 'stream' && path === '/stream'),
  );
  await registry.close();
});

test('validators refuse non-string values rather than their stringification', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');

  await Promise.all(
    /** @type {Array<[Record<string, unknown>, string]>} */ ([
      [{ idempotencyKey: undefined }, 'invalid-idempotency-key'],
      [{ idempotencyKey: null }, 'invalid-idempotency-key'],
      [{ idempotencyKey: ['create-0000000009'] }, 'invalid-idempotency-key'],
      [{ displayName: undefined }, 'invalid-display-name'],
      [{ displayName: null }, 'invalid-display-name'],
      [{ defaultModel: undefined }, 'invalid-model'],
      [{ defaultModel: ['claude-test'] }, 'invalid-model'],
    ]).map(([overrides, code], index) =>
      t.throwsAsync(
        () =>
          E(directory).create(
            providerRequest({
              idempotencyKey: `coerce-000000000${index}`,
              ...overrides,
            }),
          ),
        { message: new RegExp(code) },
      ),
    ),
  );
  t.deepEqual(Object.keys(registry.inspect().operations), []);

  const provider = await E(directory).create(providerRequest());
  const use = registry.useFor('owner-alice', provider.providerId);
  const request = harden({
    ownerId: 'owner-alice',
    agentId: 'agent-alice',
    model: 'claude-test',
  });
  await t.throwsAsync(
    () => E(use).grant(harden({ ...request, agentId: null })),
    { message: /invalid-agent/ },
  );
  await t.throwsAsync(
    () => E(use).grant(harden({ ...request, model: ['claude-test'] })),
    { message: /invalid-model/ },
  );
  await t.throwsAsync(() => E(use).grant(harden({ ...request, grantId: '' })), {
    message: /invalid-generated-id/,
  });
  await t.throwsAsync(
    () => E(use).grant(harden({ ...request, caps: { budget: NaN } })),
    { message: /invalid-caps/ },
  );
  await registry.close();
});

test('idempotency compares canonical data, not key order', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  t.like(
    await E(directory).create(
      providerRequest({
        limits: harden({ dailyTokens: 1000, concurrentTurns: 1 }),
      }),
    ),
    { providerId: provider.providerId },
  );
  await t.throwsAsync(
    () =>
      E(directory).create(
        providerRequest({
          limits: harden({ concurrentTurns: -0, dailyTokens: 1000 }),
        }),
      ),
    { message: /idempotency-conflict/ },
  );

  const use = registry.useFor('owner-alice', provider.providerId);
  const request = harden({
    grantId: 'grant-000000001',
    ownerId: 'owner-alice',
    agentId: 'agent-alice',
    model: 'claude-test',
    caps: { a: 1, b: 2 },
  });
  const inference = await E(use).grant(request);
  t.is(
    await E(use).grant(harden({ ...request, caps: { b: 2, a: 1 } })),
    inference,
  );
  await registry.close();
});

test('retiring a retired provider under a fresh key is a no-op', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const admin = await E(directory).adminFor(provider.providerId);
  t.is((await E(admin).retire('retire-000000001')).state, 'retired');
  const before = registry.inspect();
  t.is((await E(admin).retire('retire-000000002')).state, 'retired');
  t.is(registry.inspect(), before);
  await registry.close();
});

test('the Endo participant reports absence only for an absent secret', async t => {
  const stableIds = harden({
    secretId: 'secret-000000001',
    grantId: 'grant-000000001',
    operationId: 'operation-00001',
  });
  /** @type {string} */
  let summaryState = 'provisioning';
  let fault = false;
  const importer = harden({
    provideBase64: async () => harden({ state: summaryState }),
  });
  const participant = makeEndoSecretParticipant(
    harden({
      has: async (...path) => {
        if (fault) throw Error('connection lost');
        return path.length === 1;
      },
      lookup: async () => importer,
    }),
  );
  t.false(await participant.has('inference-provider-x'));
  t.false(
    await /** @type {NonNullable<typeof participant.recover>} */ (
      participant.recover
    )('inference-provider-x', 'Inference provider x', stableIds),
  );
  summaryState = 'active';
  t.true(
    await /** @type {NonNullable<typeof participant.recover>} */ (
      participant.recover
    )('inference-provider-x', 'Inference provider x', stableIds),
  );
  // A transient fault must not read as "the user must re-enter the key".
  fault = true;
  await t.throwsAsync(() => participant.has('inference-provider-x'), {
    message: /connection lost/,
  });
});

test('replaying setLimits under one operation id records it once', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const admin = await E(directory).adminFor(provider.providerId);
  const raised = harden({ concurrentTurns: 2, dailyTokens: 2000 });
  await E(admin).setLimits(raised, 'limits-000000001');
  const before = registry.inspect();
  t.deepEqual(
    (await E(admin).setLimits(raised, 'limits-000000001')).limits,
    raised,
  );
  t.is(registry.inspect(), before);
  await t.throwsAsync(() => E(admin).setLimits(limits, 'limits-000000001'), {
    message: /idempotency-conflict/,
  });
  t.is(
    registry.inspect().audit.filter(event => event.change === 'limits').length,
    1,
  );
  await registry.close();
});

test('a retire retry under a fresh key drives the in-flight retirement', async t => {
  const backing = makeBacking();
  const { revoke } = backing.secretParticipant;
  let fail = true;
  backing.secretParticipant.revoke = async name => {
    if (fail) {
      fail = false;
      throw Error('revoke unavailable');
    }
    return revoke(name);
  };
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const admin = await E(directory).adminFor(provider.providerId);
  await t.throwsAsync(() => E(admin).retire('retire-000000001'), {
    message: 'revoke unavailable',
  });
  t.is((await E(admin).getSummary()).state, 'retiring');

  t.is((await E(admin).retire('retire-000000002')).state, 'retired');
  const { operations, audit } = registry.inspect();
  t.deepEqual(
    Object.keys(operations).filter(key => key.startsWith('retire:')),
    ['retire:owner-alice:retire-000000001'],
  );
  t.deepEqual(
    audit.map(event => event.change),
    ['created', 'retiring', 'retired'],
  );
  await registry.close();
});

test('revoking a grant whose endpoint fails while opening still succeeds', async t => {
  const backing = makeBacking();
  let releaseOpen;
  const opening = new Promise(resolve => {
    releaseOpen = resolve;
  });
  const registry = await makeInferenceProviderRegistry({
    journal: backing.journal,
    secrets: backing.secretParticipant,
    makeIssuer: async () =>
      harden({
        openEndpoint: async () => {
          await opening;
          return makeExo('InferenceEndpoint', InferenceEndpointInterface, {
            request: async () => harden({ status: 200, headers: {}, body: '' }),
            requestByteStream: async () => {
              throw Error('unused');
            },
            attestation: async () => harden({}),
            revoke: async () => {},
          });
        },
        dispose: async () => {},
      }),
    validateLimits: value =>
      harden({ .../** @type {Record<string, unknown>} */ (value) }),
    randomId: makeIds(),
    now: () => '2026-10-27T00:00:00.000Z',
  });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  const pending = E(inference).request(message('/v1/messages'));
  const revoked = registry.revokeGrant('grant-000000001');
  releaseOpen();
  await t.notThrowsAsync(revoked);
  await t.throwsAsync(pending, { message: /agent-deleted/ });
  t.is(registry.inspect().grants['grant-000000001'].state, 'revoked');
  await registry.close();
});

test('grant ids that name Object.prototype members are refused or absent', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const before = registry.inspect();

  await t.throwsAsync(() => registry.revokeGrant('__proto__'), {
    message: /invalid-grant/,
  });
  t.throws(() => registry.inferenceFor('__proto__'), {
    message: /invalid-grant/,
  });
  await registry.revokeGrant('constructor');
  await registry.revokeGrant('toString');
  t.is(registry.inspect(), before);
  await t.throwsAsync(
    () => E(registry.inferenceFor('constructor')).request(message('/x')),
    { message: /agent-deleted/ },
  );
  await t.throwsAsync(() => E(directory).lookup('constructor'), {
    message: /provider-not-found/,
  });

  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'constructor',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  t.is((await E(inference).request(message('/v1/messages'))).status, 200);
  const { grants } = registry.inspect();
  t.true(Object.hasOwn(grants, 'constructor'));
  t.is(Object.getPrototypeOf(grants), Object.prototype);
  await registry.revokeGrant('constructor');
  t.is(registry.inspect().grants.constructor.state, 'revoked');
  await registry.close();
});
