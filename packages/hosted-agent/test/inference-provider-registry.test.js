// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeInferenceProviderRegistry } from '../src/inference-provider-registry.js';
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
  (events, behavior = {}) =>
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
              if (message.body.includes('wait')) {
                await new Promise((resolve, reject) => {
                  cancellations.add(() => reject(Error('request canceled')));
                });
              }
              return harden({
                status: behavior.status?.(message) ?? 200,
                headers: {},
                body: 'ok',
                ...(behavior.usage === undefined
                  ? {}
                  : { usage: behavior.usage(message) }),
              });
            },
            requestByteStream: async message => {
              if (disposed || revoked) throw Error('endpoint revoked');
              events.push(['stream', sessionId, message.path]);
              if (behavior.streamResponse !== undefined) {
                return harden(behavior.streamResponse(message));
              }
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
    makeIssuer: makeIssuerFactory(events, options.behavior),
    validateLimits: value => harden({ ...value }),
    randomId: options.randomId || makeIds(),
    now: options.now || (() => '2026-10-27T00:00:00.000Z'),
    modelPrices:
      options.modelPrices ||
      harden({
        'claude-test': { inputPerMillion: 1, outputPerMillion: 1 },
      }),
    ...(options.nowMillis === undefined
      ? {}
      : { nowMillis: options.nowMillis }),
    ...(options.discoverModels === undefined
      ? {}
      : { discoverModels: options.discoverModels }),
    ...(options.afterCommit === undefined
      ? {}
      : { afterCommit: options.afterCommit }),
    ...(options.intentExpiryMs === undefined
      ? {}
      : { intentExpiryMs: options.intentExpiryMs }),
  });
};

const message = marker =>
  harden({
    method: 'POST',
    path: '/v1/messages',
    body: JSON.stringify({
      model: 'claude-test',
      max_tokens: 1,
      messages: [{ role: 'user', content: marker }],
    }),
  });

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
  const use = registry.useFor('owner-alice', provider.providerId);
  const inference = await E(use).grant(
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
    validateLimits: value => harden({ ...value }),
    randomId: makeIds(),
    now: () => '2026-10-27T00:00:00.000Z',
    modelPrices: harden({
      'claude-test': { inputPerMillion: 1, outputPerMillion: 1 },
    }),
  });
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
    ).state,
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
    events.some(
      ([kind, , path]) => kind === 'stream' && path === '/v1/messages',
    ),
  );
  await registry.close();
});

test('phase 2 defaults and limit raises require explicit confirmation', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(
    providerRequest({ limits: undefined }),
  );
  t.like(provider.limits, {
    concurrentTurns: 2,
    requestsPerMinute: 20,
    dailyDollars: 5,
  });
  t.like(await E(directory).getOwnerLimits(), {
    concurrentTurns: 2,
    requestsPerMinute: 20,
    dailyDollars: 5,
  });

  const use = registry.useFor('owner-alice', provider.providerId);
  const inference = await E(use).grant(
    harden({
      grantId: 'grant-defaults-1',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  t.truthy(inference);
  t.like(registry.inspect().grants['grant-defaults-1'].caps, {
    concurrentTurns: 1,
    requestsPerMinute: 10,
    dailyDollars: 2,
  });
  t.is(
    (
      await E(use).setGrantLimits(
        'grant-defaults-1',
        harden({ dailyDollars: 1 }),
        'lower-agent-1',
      )
    ).caps.dailyDollars,
    1,
  );
  await t.throwsAsync(
    () =>
      E(use).setGrantLimits(
        'grant-defaults-1',
        harden({ dailyDollars: 2 }),
        'raise-agent-1',
      ),
    { message: /limit-raise-unconfirmed/ },
  );
  t.is(registry.inspect().grants['grant-defaults-1'].caps.dailyDollars, 1);
  t.is(
    (
      await E(use).setGrantLimits(
        'grant-defaults-1',
        harden({ dailyDollars: 2 }),
        'raise-agent-2',
        true,
      )
    ).caps.dailyDollars,
    2,
  );

  const admin = await E(directory).adminFor(provider.providerId);
  await t.throwsAsync(
    () => E(admin).setLimits(harden({ dailyDollars: 6 }), 'raise-provider-1'),
    { message: /limit-raise-unconfirmed/ },
  );
  t.is((await E(admin).getSummary()).limits.dailyDollars, 5);
  t.is(
    (
      await E(admin).setLimits(
        harden({ dailyDollars: 6 }),
        'raise-provider-2',
        true,
      )
    ).limits.dailyDollars,
    6,
  );
  await t.throwsAsync(
    () =>
      E(directory).setOwnerLimits(
        harden({ requestsPerMinute: 21 }),
        'raise-owner-1',
      ),
    { message: /limit-raise-unconfirmed/ },
  );
  t.is(
    (
      await E(directory).setOwnerLimits(
        harden({ requestsPerMinute: 21 }),
        'raise-owner-2',
        true,
      )
    ).requestsPerMinute,
    21,
  );

  // Changing the daily budget's unit is not comparable, so it is a raise.
  await t.throwsAsync(
    () => E(admin).setLimits(harden({ dailyTokens: 1 }), 'switch-kind-1'),
    { message: /limit-raise-unconfirmed/ },
  );
  t.is((await E(admin).getSummary()).limits.dailyDollars, 6);
  const switched = (
    await E(admin).setLimits(harden({ dailyTokens: 1 }), 'switch-kind-2', true)
  ).limits;
  t.is(switched.dailyTokens, 1);
  t.false(Object.hasOwn(switched, 'dailyDollars'));
  await registry.close();
});

test('raw requests are refused before opening the secret-backed issuer', async t => {
  const backing = makeBacking();
  const events = [];
  const registry = await makeRegistry(backing, { events });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'grant-validation-1',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  const invalid = [
    harden({ method: 'GET', path: '/v1/messages', body: '{}' }),
    harden({ method: 'POST', path: '/v1/complete', body: '{}' }),
    harden({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'x-api-key': 'stolen' },
      body: message('valid').body,
    }),
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-other","max_tokens":1,"messages":[]}',
    }),
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-test","messages":[]}',
    }),
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-test","max_tokens":1,"messages":[],"key":"secret"}',
    }),
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-test","max_tokens":5000,"messages":[]}',
    }),
  ];
  for (const request of invalid) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(inference).request(request), {
      message: /inference-request-refused/,
    });
  }
  t.deepEqual(events, []);
  const usage = await E(directory).getUsage();
  t.is(usage.turns.length, 0);
  t.is(usage.refusals.length, invalid.length);
  await registry.close();
});

test('owner-wide admission spans providers and cancellation releases its slot', async t => {
  const backing = makeBacking();
  const events = [];
  const registry = await makeRegistry(backing, { events });
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden({ concurrentTurns: 1, dailyTokens: 1000 }),
    'owner-token-limits-1',
    true,
  );
  const firstProvider = await E(directory).create(providerRequest());
  const secondProvider = await E(directory).create(
    providerRequest({
      idempotencyKey: 'create-owner-wide-2',
      displayName: 'Claude second',
    }),
  );
  const grant = async (providerId, suffix) =>
    E(registry.useFor('owner-alice', providerId)).grant(
      harden({
        grantId: `grant-owner-${suffix}`,
        ownerId: 'owner-alice',
        agentId: `agent-${suffix}`,
        model: 'claude-test',
      }),
    );
  const first = await grant(firstProvider.providerId, 'first');
  const second = await grant(secondProvider.providerId, 'second');
  const waiting = E(first).request(message('wait'));
  for (
    let turn = 0;
    turn < 20 && !events.some(event => event[0] === 'request');
    turn += 1
  ) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await t.throwsAsync(() => E(second).request(message('second')), {
    message: /inference-request-refused/,
  });
  const firstAdmin = await E(directory).adminFor(firstProvider.providerId);
  await E(firstAdmin).retire('retire-owner-wide-1');
  await t.throwsAsync(waiting, { message: 'request canceled' });
  const usage = await E(directory).getUsage();
  t.true(
    usage.turns.some(
      turn =>
        turn.disposition === 'estimated' &&
        turn.chargedTokens === turn.reservedTokens,
    ),
  );
  t.true(
    usage.refusals.some(
      refusal => refusal.reason === 'owner-concurrency-exhausted',
    ),
  );
  await registry.close();
});

test('model discovery is optional and typed fallback is verified on success', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    discoverModels: async () =>
      harden({
        observedAt: 1234,
        models: [{ id: 'claude-catalog', title: 'Catalog Claude' }],
      }),
  });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const admin = await E(directory).adminFor(provider.providerId);
  t.deepEqual(await E(admin).discoverModels(), {
    catalogState: 'current',
    observedAt: 1234,
    models: [{ id: 'claude-catalog', title: 'Catalog Claude' }],
    verification: {
      'claude-test': 'unverified',
      'claude-catalog': 'verified',
    },
  });
  const fallback = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      grantId: 'grant-typed-fallback-1',
      ownerId: 'owner-alice',
      agentId: 'agent-fallback',
      model: 'claude-typed-fallback',
    }),
  );
  t.truthy(fallback);
  t.is(
    registry.inspect().modelStates[provider.providerId].verification[
      'claude-typed-fallback'
    ],
    'unverified',
  );
  await registry.close();
});

test('admission refuses worst-case reservations and unpriced dollar models before secret read', async t => {
  const tokenBacking = makeBacking();
  const tokenEvents = [];
  const tokenRegistry = await makeRegistry(tokenBacking, {
    events: tokenEvents,
  });
  const tokenDirectory = tokenRegistry.directoryFor('owner-alice');
  await E(tokenDirectory).setOwnerLimits(
    harden({ dailyTokens: 1000 }),
    'owner-token-budget-1',
    true,
  );
  const tokenProvider = await E(tokenDirectory).create(
    providerRequest({ limits: { ...limits, dailyTokens: 50 } }),
  );
  const tokenInference = await E(
    tokenRegistry.useFor('owner-alice', tokenProvider.providerId),
  ).grant(
    harden({
      ownerId: 'owner-alice',
      agentId: 'agent-token-budget',
      model: 'claude-test',
    }),
  );
  await t.throwsAsync(
    () => E(tokenInference).request(message('reservation is conservative')),
    { message: /inference-request-refused/ },
  );
  t.deepEqual(tokenEvents, []);
  await tokenRegistry.close();

  const dollarBacking = makeBacking();
  const dollarEvents = [];
  const dollarRegistry = await makeRegistry(dollarBacking, {
    events: dollarEvents,
    modelPrices: harden({}),
  });
  const dollarDirectory = dollarRegistry.directoryFor('owner-alice');
  const dollarProvider = await E(dollarDirectory).create(
    providerRequest({ limits: undefined }),
  );
  const dollarInference = await E(
    dollarRegistry.useFor('owner-alice', dollarProvider.providerId),
  ).grant(
    harden({
      ownerId: 'owner-alice',
      agentId: 'agent-dollar-budget',
      model: 'claude-unpriced',
    }),
  );
  await t.throwsAsync(
    () =>
      E(dollarInference).request(
        harden({
          ...message('unpriced'),
          body: message('unpriced').body.replace(
            'claude-test',
            'claude-unpriced',
          ),
        }),
      ),
    { message: /inference-request-refused/ },
  );
  t.deepEqual(dollarEvents, []);
  const dollarUsage = await E(dollarDirectory).getUsage();
  t.true(
    dollarUsage.refusals.some(refusal => refusal.reason === 'unpriced-model'),
  );
  await dollarRegistry.close();
});

test('settlement records unknown usage, late reports, overruns, and model 404', async t => {
  const backing = makeBacking();
  /** @type {(value: any) => void} */
  let resolveLate = () => {};
  const lateUsage = new Promise(resolve => {
    resolveLate = resolve;
  });
  const registry = await makeRegistry(backing, {
    behavior: {
      status: request => (request.body.includes('missing') ? 404 : 200),
      usage: request =>
        request.body.includes('overrun')
          ? harden({ inputTokens: 5000, outputTokens: 1 })
          : undefined,
      streamResponse: () => ({
        status: 200,
        headers: {},
        body: makeExo('reader', TestReaderInterface, {}),
        usage: lateUsage,
      }),
    },
  });
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden({ dailyTokens: 20_000 }),
    'settlement-owner-1',
    true,
  );
  const provider = await E(directory).create(
    providerRequest({ limits: { ...limits, dailyTokens: 20_000 } }),
  );
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      ownerId: 'owner-alice',
      agentId: 'agent-settlement',
      model: 'claude-test',
      caps: { dailyTokens: 20_000 },
    }),
  );
  await E(inference).request(message('unknown'));
  await E(inference).request(message('overrun'));
  const stream = await E(inference).requestByteStream(message('late'));
  let usage = await E(directory).getUsage();
  t.true(usage.turns.some(turn => turn.state === 'reserved'));
  resolveLate(harden({ inputTokens: 7, outputTokens: 2 }));
  await stream.usage;
  await t.throwsAsync(() => E(inference).request(message('missing')), {
    message: /model-not-available/,
  });
  usage = await E(directory).getUsage();
  t.true(
    usage.turns.some(
      turn =>
        turn.disposition === 'estimated' &&
        turn.chargedTokens === turn.reservedTokens,
    ),
  );
  t.true(usage.turns.some(turn => turn.overrun === true));
  t.true(
    usage.turns.some(
      turn => turn.disposition === 'reported' && turn.chargedTokens === 9,
    ),
  );
  t.true(
    usage.refusals.some(refusal => refusal.reason === 'model-not-available'),
  );
  await registry.close();
});

const tokenGrant = async (registry, agentId, providerLimits = limits) => {
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(
    providerRequest({ limits: { ...providerLimits, dailyTokens: 20_000 } }),
  );
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(harden({ ownerId: 'owner-alice', agentId, model: 'claude-test' }));
  return { directory, inference };
};

test('a rejected usage report settles the turn and releases its slot', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    modelPrices: harden({}),
    behavior: {
      usage: request => {
        if (!request.body.includes('reject')) return undefined;
        const rejected = Promise.reject(Error('usage lost'));
        rejected.catch(() => {});
        return rejected;
      },
    },
  });
  // The owner keeps its default dollar budget; the unpriced model is governed
  // by the token-budgeted provider rather than refused at the owner scope.
  const { directory, inference } = await tokenGrant(registry, 'agent-reject');
  await t.throwsAsync(() => E(inference).request(message('reject')), {
    message: /usage lost/,
  });
  await E(inference).request(message('after'));
  const usage = await E(directory).getUsage();
  t.false(usage.turns.some(turn => turn.state === 'reserved'));
  t.true(
    usage.turns.some(
      turn =>
        turn.disposition === 'estimated' &&
        turn.chargedTokens === turn.reservedTokens,
    ),
  );
  await registry.close();
});

test('restart settles orphaned reservations as estimated', async t => {
  const backing = makeBacking();
  const pending = new Promise(() => {});
  const behavior = {
    streamResponse: () => ({
      status: 200,
      headers: {},
      body: makeExo('reader', TestReaderInterface, {}),
      usage: pending,
    }),
  };
  const first = await makeRegistry(backing, {
    modelPrices: harden({}),
    behavior,
  });
  const { inference } = await tokenGrant(first, 'agent-restart');
  await E(inference).requestByteStream(message('orphan'));
  t.true(
    Object.values(first.inspect().turns).some(
      turn => turn.state === 'reserved',
    ),
  );
  await first.close();

  const second = await makeRegistry(backing, { modelPrices: harden({}) });
  const turns = Object.values(second.inspect().turns);
  t.is(turns.length, 1);
  t.like(turns[0], { state: 'settled', disposition: 'estimated' });
  t.is(turns[0].chargedTokens, turns[0].reservedTokens);
  await second.close();
});

test('reservations hold across UTC midnight, expire, and old days are pruned', async t => {
  const backing = makeBacking();
  let clock = Date.parse('2026-10-27T23:59:59.000Z');
  const registry = await makeRegistry(backing, {
    modelPrices: harden({}),
    nowMillis: () => clock,
    behavior: {
      streamResponse: () => ({
        status: 200,
        headers: {},
        body: makeExo('reader', TestReaderInterface, {}),
        usage: new Promise(() => {}),
      }),
    },
  });
  const { directory, inference } = await tokenGrant(registry, 'agent-midnight');
  await E(inference).request(message('settled-yesterday'));
  await E(inference).requestByteStream(message('held'));

  clock = Date.parse('2026-10-28T00:00:01.000Z');
  await t.throwsAsync(() => E(inference).request(message('midnight')), {
    message: /inference-request-refused/,
  });
  const refused = await E(directory).getUsage();
  t.true(
    refused.refusals.some(refusal =>
      refusal.reason.endsWith('-concurrency-exhausted'),
    ),
  );

  clock = Date.parse('2026-10-28T00:10:00.000Z');
  await E(inference).request(message('after-expiry'));
  const turns = Object.values(registry.inspect().turns);
  t.deepEqual(
    turns.map(turn => turn.day),
    ['2026-10-28'],
  );
  await registry.close();
});
