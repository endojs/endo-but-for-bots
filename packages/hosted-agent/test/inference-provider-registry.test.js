// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { makeInferenceProviderRegistry } from '../src/inference-provider-registry.js';
import {
  validateAnthropicInferenceRequest,
  validateInferenceLimits,
} from '../src/inference-provider-policy.js';
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
                usage: behavior.usage?.(message),
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
        'claude-test': {
          inputPerMillion: 1_000_000,
          outputPerMillion: 1_000_000,
        },
      }),
    nowMillis: options.nowMillis,
    discoverModels: options.discoverModels,
    afterCommit: options.afterCommit,
    intentExpiryMs: options.intentExpiryMs,
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
    // The first provider's budget was just lowered to 500, so 1000 is a raise.
    true,
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
      'claude-test': {
        inputPerMillion: 1_000_000,
        outputPerMillion: 1_000_000,
      },
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
  await t.throwsAsync(
    () =>
      E(use).setGrantLimits(
        'grant-defaults-1',
        harden({ dailyTokens: 100 }),
        'wrong-kind-1',
      ),
    { message: /invalid-agent-limits/ },
  );
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

test('supersede gates a raised cap atomically and inherits unedited caps', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing);
  const directory = registry.directoryFor('owner-alice');
  const old = await E(directory).create(
    providerRequest({
      limits: harden({
        concurrentTurns: 2,
        requestsPerMinute: 10,
        dailyTokens: 1000,
        maxOutputTokens: 512,
      }),
    }),
  );
  const admin = await E(directory).adminFor(old.providerId);
  const replacing = (idempotencyKey, replacementLimits) =>
    providerRequest({
      idempotencyKey,
      limits: harden(replacementLimits),
      keyBase64: encodeBase64(encodeUtf8('replacement-secret')),
    });

  const unchanged = await E(admin).supersede(
    replacing('replace-000000001', {
      concurrentTurns: 2,
      requestsPerMinute: 10,
      dailyTokens: 1000,
    }),
  );
  t.is(
    unchanged.limits.maxOutputTokens,
    512,
    'a cap the request omits comes from the superseded provider',
  );

  const raised = replacing('replace-000000002', {
    concurrentTurns: 3,
    requestsPerMinute: 10,
    dailyTokens: 1000,
  });
  await t.throwsAsync(() => E(admin).supersede(raised), {
    message: /limit-raise-unconfirmed/,
  });
  await t.throwsAsync(
    () =>
      E(admin).supersede(
        replacing('replace-000000002', {
          concurrentTurns: 2,
          requestsPerMinute: 10,
          dailyDollars: 5,
        }),
      ),
    { message: /limit-raise-unconfirmed/ },
    'switching the budget kind is a raise',
  );
  t.false(
    (await E(directory).list()).some(item => item.limits.concurrentTurns === 3),
    'a refused raise commits nothing',
  );

  // The gate reads the lifecycle inside the mutation queue, so a lowering queued
  // ahead of the replacement is the prior the replacement is checked against.
  const lowering = E(admin).setLimits(
    harden({ concurrentTurns: 1, requestsPerMinute: 10, dailyTokens: 1000 }),
    'limits-0000000001',
  );
  const racing = E(admin).supersede(
    replacing('replace-000000003', {
      concurrentTurns: 2,
      requestsPerMinute: 10,
      dailyTokens: 1000,
    }),
  );
  await lowering;
  await t.throwsAsync(() => racing, { message: /limit-raise-unconfirmed/ });

  const confirmed = await E(admin).supersede(raised, true);
  t.is(confirmed.limits.concurrentTurns, 3);
  const replayRequest = await E(admin).supersede(
    replacing('replace-000000001', {
      concurrentTurns: 2,
      requestsPerMinute: 10,
      dailyTokens: 1000,
      maxOutputTokens: 512,
    }),
  );
  t.is(
    replayRequest.providerId,
    unchanged.providerId,
    'a replay of a committed replacement needs no confirmation',
  );
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

test('the validated body is what gets forwarded', t => {
  const checked = validateAnthropicInferenceRequest(
    harden({
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-other","max_tokens":4000,"messages":[],"model":"claude-test","max_tokens":1}',
    }),
    { model: 'claude-test', maxOutputTokens: 10, maxRequestBytes: 1024 },
  );
  t.deepEqual(JSON.parse(checked.message.body), {
    model: 'claude-test',
    max_tokens: 1,
    messages: [],
  });
  t.is(checked.inputBytes, encodeUtf8(checked.message.body).length);
  t.is(checked.maxOutputTokens, 1);
});

test('limit fields without an enforcement site are refused', t => {
  for (const name of ['maxTurns', 'maxResponseBytes']) {
    t.throws(() => validateInferenceLimits(harden({ [name]: 1 })), {
      message: /Invalid inference limit field/,
    });
  }
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

  // A token-budgeted provider does not exempt an unpriced model from the
  // owner's dollar budget, which aggregates every provider the owner holds.
  const ownerBacking = makeBacking();
  const ownerEvents = [];
  const ownerRegistry = await makeRegistry(ownerBacking, {
    events: ownerEvents,
    modelPrices: harden({}),
  });
  const ownerDirectory = ownerRegistry.directoryFor('owner-alice');
  const ownerProvider = await E(ownerDirectory).create(
    providerRequest({ limits: { ...limits, dailyTokens: 20_000 } }),
  );
  const ownerInference = await E(
    ownerRegistry.useFor('owner-alice', ownerProvider.providerId),
  ).grant(
    harden({
      ownerId: 'owner-alice',
      agentId: 'agent-owner-dollars',
      model: 'claude-test',
    }),
  );
  await t.throwsAsync(() => E(ownerInference).request(message('owner')), {
    message: /inference-request-refused/,
  });
  t.deepEqual(ownerEvents, []);
  const ownerUsage = await E(ownerDirectory).getUsage();
  t.true(
    ownerUsage.refusals.some(refusal => refusal.reason === 'unpriced-model'),
  );
  await ownerRegistry.close();
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
  // An unpriced model needs a token budget at every scope, owner included.
  await E(directory).setOwnerLimits(
    harden({ dailyTokens: 100_000 }),
    `owner-tokens-${agentId}`,
    true,
  );
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

test('reservations hold across midnight and complete facts compact', async t => {
  const backing = makeBacking();
  let clock = Date.parse('2026-10-27T23:59:59.000Z');
  /** @type {(usage: any) => void} */
  let settleHeld = () => {};
  const held = new Promise(resolve => {
    settleHeld = resolve;
  });
  const registry = await makeRegistry(backing, {
    modelPrices: harden({}),
    nowMillis: () => clock,
    behavior: {
      streamResponse: () => ({
        status: 200,
        headers: {},
        body: makeExo('reader', TestReaderInterface, {}),
        usage: held,
      }),
    },
  });
  const { directory, inference } = await tokenGrant(registry, 'agent-midnight');
  await E(inference).request(message('settled-yesterday'));
  const stream = await E(inference).requestByteStream(message('held'));

  clock = Date.parse('2026-10-28T00:00:01.000Z');
  await t.throwsAsync(() => E(inference).request(message('midnight')), {
    message: /inference-request-refused/,
  });
  clock = Date.parse('2026-10-28T06:00:00.000Z');
  await t.throwsAsync(() => E(inference).request(message('still-held')), {
    message: /inference-request-refused/,
  });
  const refused = await E(directory).getUsage();
  t.is(
    refused.refusals.filter(refusal =>
      refusal.reason.endsWith('-concurrency-exhausted'),
    ).length,
    2,
  );

  settleHeld(undefined);
  await stream.usage;
  await E(inference).request(message('after-settlement'));
  const inspected = registry.inspect();
  const turns = Object.values(inspected.turns);
  t.deepEqual(
    turns.map(turn => turn.day),
    ['2026-10-28'],
  );
  t.is(
    inspected.turnEvents.filter(event => event.type === 'reserved').length,
    1,
  );
  t.is(
    inspected.turnEvents.filter(event => event.type === 'settled').length,
    1,
  );
  await registry.close();
});

test('create status answers each lost-response state without key bytes', async t => {
  const backing = makeBacking();
  let crashAt;
  const registry = await makeRegistry(backing, {
    intentExpiryMs: 1000,
    afterCommit: boundary => {
      if (boundary === crashAt) {
        crashAt = undefined;
        throw Error(`crash at ${boundary}`);
      }
    },
  });
  const directory = registry.directoryFor('owner-alice');
  t.deepEqual(await E(directory).getOperationStatus('create-0000000001'), {
    idempotencyKey: 'create-0000000001',
    status: 'not-found',
  });

  crashAt = 'create-intent';
  await t.throwsAsync(() => E(directory).create(providerRequest()), {
    message: 'crash at create-intent',
  });
  const keyNeeded = await E(directory).getOperationStatus('create-0000000001');
  t.is(keyNeeded.status, 'key-needed');
  t.is(keyNeeded.state, 'intent');
  t.is(keyNeeded.displayName, 'Claude');
  t.is(keyNeeded.expiresAt, '2026-10-27T00:00:01.000Z');
  const pending = await E(directory).listPendingOperations();
  t.deepEqual(pending, [keyNeeded], 'the pending row matches status');
  t.deepEqual(
    await E(registry.directoryFor('owner-bob')).listPendingOperations(),
    [],
    'pending operations are owner-scoped',
  );
  const visible = JSON.stringify([keyNeeded, pending]);
  t.false(visible.includes(providerRequest().keyBase64));
  t.false(visible.includes('inference-provider-'));

  const { keyBase64: _key, ...withoutKey } = providerRequest();
  await t.throwsAsync(() => E(directory).create(harden(withoutKey)), {
    message: /key-needed/,
  });
  crashAt = 'create-secret';
  await t.throwsAsync(() => E(directory).create(providerRequest()), {
    message: 'crash at create-secret',
  });
  t.is(
    (await E(directory).getOperationStatus('create-0000000001')).status,
    'in-progress',
    'a stored secret never asks for the key again',
  );

  crashAt = 'create-response';
  await t.throwsAsync(() => E(directory).create(harden(withoutKey)), {
    message: 'crash at create-response',
  });
  const committed = await E(directory).getOperationStatus('create-0000000001');
  t.is(committed.status, 'committed');
  t.is(committed.expiresAt, undefined);
  const retried = await E(directory).create(harden(withoutKey));
  t.is(retried.providerId, committed.providerId);
  t.is((await E(directory).list()).length, 1, 'one provider was created');
  t.deepEqual(await E(directory).listPendingOperations(), []);
  await registry.close();
});

test('restart reports a secret-stored intent as committed by recovery', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    afterCommit: boundary => {
      if (boundary === 'create-secret') throw Error('crash after secret');
    },
  });
  await t.throwsAsync(
    () => E(registry.directoryFor('owner-alice')).create(providerRequest()),
    { message: 'crash after secret' },
  );
  t.is(
    (
      await E(registry.directoryFor('owner-alice')).getOperationStatus(
        'create-0000000001',
      )
    ).status,
    'in-progress',
  );
  await registry.close();
  const revived = await makeRegistry(backing);
  const directory = revived.directoryFor('owner-alice');
  t.is(
    (await E(directory).getOperationStatus('create-0000000001')).status,
    'committed',
  );
  t.deepEqual(await E(directory).listPendingOperations(), []);
  await revived.close();
});

test('cancel aborts only an operation still at intent', async t => {
  const backing = makeBacking();
  let crashAt;
  const registry = await makeRegistry(backing, {
    afterCommit: boundary => {
      if (boundary === crashAt) {
        crashAt = undefined;
        throw Error(`crash at ${boundary}`);
      }
    },
  });
  const directory = registry.directoryFor('owner-alice');
  await t.throwsAsync(() => E(directory).cancelOperation('create-0000000001'), {
    message: /operation-not-found/,
  });

  crashAt = 'create-intent';
  await t.throwsAsync(() => E(directory).create(providerRequest()), {
    message: 'crash at create-intent',
  });
  await t.throwsAsync(
    () =>
      E(registry.directoryFor('owner-bob')).cancelOperation(
        'create-0000000001',
      ),
    { message: /operation-not-found/ },
    'another owner cannot cancel it',
  );
  crashAt = 'cancel-secret-fenced';
  await t.throwsAsync(() => E(directory).cancelOperation('create-0000000001'), {
    message: 'crash at cancel-secret-fenced',
  });
  t.is(
    (await E(directory).getOperationStatus('create-0000000001')).status,
    'key-needed',
    'a crash before the abort commit leaves the intent',
  );
  const cancelled = await E(directory).cancelOperation('create-0000000001');
  t.is(cancelled.status, 'aborted');
  t.deepEqual(
    await E(directory).cancelOperation('create-0000000001'),
    cancelled,
    'cancel is idempotent',
  );
  t.deepEqual(await E(directory).listPendingOperations(), []);
  await t.throwsAsync(() => E(directory).create(providerRequest()), {
    message: /operation-aborted/,
  });
  t.is(backing.secrets.size, 0, 'no secret was stored');

  crashAt = 'create-secret';
  await t.throwsAsync(
    () =>
      E(directory).create(
        providerRequest({ idempotencyKey: 'create-0000000002' }),
      ),
    { message: 'crash at create-secret' },
  );
  await t.throwsAsync(() => E(directory).cancelOperation('create-0000000002'), {
    message: /operation-in-progress/,
  });
  await E(directory).create(
    providerRequest({ idempotencyKey: 'create-0000000002' }),
  );
  await t.throwsAsync(() => E(directory).cancelOperation('create-0000000002'), {
    message: /operation-committed/,
  });
  await registry.close();
});

test('reattach moves an agent to another provider of the same kind idempotently', async t => {
  const backing = makeBacking();
  let crashAt;
  const options = {
    afterCommit: boundary => {
      if (boundary === crashAt) {
        crashAt = undefined;
        throw Error(`crash at ${boundary}`);
      }
    },
  };
  const registry = await makeRegistry(backing, options);
  const directory = registry.directoryFor('owner-alice');
  const old = await E(directory).create(providerRequest());
  const oldInference = await E(
    registry.useFor('owner-alice', old.providerId),
  ).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
      caps: { dailyTokens: 500 },
    }),
  );
  const oldAdmin = await E(directory).adminFor(old.providerId);
  // Replace key: supersede, then reattach through the same operation.
  const replacement = await E(oldAdmin).supersede(
    providerRequest({ idempotencyKey: 'create-0000000002' }),
  );
  const bob = registry.directoryFor('owner-bob');
  const foreign = await E(bob).create(
    providerRequest({ idempotencyKey: 'create-0000000003' }),
  );
  await t.throwsAsync(
    () =>
      E(directory).reattach(
        harden({
          idempotencyKey: 'reattach-0000001',
          grantId: 'grant-000000001',
          providerId: foreign.providerId,
        }),
      ),
    { message: /provider-not-found/ },
  );
  await t.throwsAsync(
    () =>
      E(bob).reattach(
        harden({
          idempotencyKey: 'reattach-0000001',
          grantId: 'grant-000000001',
          providerId: foreign.providerId,
        }),
      ),
    { message: /agent-not-found/ },
  );

  const request = harden({
    idempotencyKey: 'reattach-0000002',
    grantId: 'grant-000000001',
    providerId: replacement.providerId,
  });
  crashAt = 'reattach-response';
  await t.throwsAsync(() => E(directory).reattach(request), {
    message: 'crash at reattach-response',
  });
  const moved = await E(directory).reattach(request);
  t.is(moved.agentId, 'agent-alice', 'the agent identity is kept');
  t.is(moved.priorGrantId, 'grant-000000001');
  t.is(moved.providerId, replacement.providerId);
  t.is(moved.model, 'claude-test', 'the model is kept');
  t.is(moved.caps.dailyTokens, 500, 'caps carry over within provider limits');
  t.deepEqual(await E(directory).reattach(request), moved, 'retry is stable');
  await t.throwsAsync(
    () =>
      E(directory).reattach(harden({ ...request, providerId: old.providerId })),
    { message: /idempotency-conflict/ },
  );
  await t.throwsAsync(() => E(oldInference).request(message('old')), {
    message: /agent-deleted/,
  });
  t.is((await E(moved.inference).request(message('new'))).status, 200);
  const active = Object.values(registry.inspect().grants).filter(
    grant => grant.agentId === 'agent-alice' && grant.state === 'active',
  );
  t.deepEqual(
    active.map(grant => grant.providerId),
    [replacement.providerId],
  );
  t.true(
    registry
      .inspect()
      .audit.some(
        entry =>
          entry.change === 'reattached' &&
          entry.newValue.grantId === moved.grantId,
      ),
  );
  await registry.close();
});

test('a reattach interrupted after intent converges on exactly one grant', async t => {
  const backing = makeBacking();
  let crash = false;
  const registry = await makeRegistry(backing, {
    afterCommit: boundary => {
      if (crash && boundary === 'reattach-intent') {
        crash = false;
        throw Error('crash after reattach intent');
      }
    },
  });
  const directory = registry.directoryFor('owner-alice');
  const first = await E(directory).create(providerRequest());
  const second = await E(directory).create(
    providerRequest({ idempotencyKey: 'create-0000000002' }),
  );
  await E(registry.useFor('owner-alice', first.providerId)).grant(
    harden({
      grantId: 'grant-000000001',
      ownerId: 'owner-alice',
      agentId: 'agent-alice',
      model: 'claude-test',
    }),
  );
  crash = true;
  const request = harden({
    idempotencyKey: 'reattach-0000001',
    grantId: 'grant-000000001',
    providerId: second.providerId,
  });
  await t.throwsAsync(() => E(directory).reattach(request), {
    message: 'crash after reattach intent',
  });
  t.is(registry.inspect().grants['grant-000000001'].state, 'active');
  await registry.close();

  const revived = await makeRegistry(backing);
  const grants = Object.values(revived.inspect().grants).filter(
    grant => grant.agentId === 'agent-alice' && grant.state === 'active',
  );
  t.deepEqual(
    grants.map(grant => grant.providerId),
    [second.providerId],
    'recovery commits the reattachment',
  );
  const moved = await E(revived.directoryFor('owner-alice')).reattach(request);
  t.is(
    moved.grantId,
    grants[0].grantId,
    'the retry adopts the recovered grant',
  );

  // A target retired before recovery aborts and leaves the agent in place.
  const third = await E(revived.directoryFor('owner-alice')).create(
    providerRequest({ idempotencyKey: 'create-0000000003' }),
  );
  await revived.close();
  let crashAgain = true;
  const again = await makeRegistry(backing, {
    randomId: () => `id-x${Math.random().toString(36).slice(2, 10)}`,
    afterCommit: boundary => {
      if (crashAgain && boundary === 'reattach-intent') {
        crashAgain = false;
        throw Error('crash after second intent');
      }
    },
  });
  const later = harden({
    idempotencyKey: 'reattach-0000002',
    grantId: moved.grantId,
    providerId: third.providerId,
  });
  await t.throwsAsync(
    () => E(again.directoryFor('owner-alice')).reattach(later),
    { message: 'crash after second intent' },
  );
  const thirdAdmin = await E(again.directoryFor('owner-alice')).adminFor(
    third.providerId,
  );
  await E(thirdAdmin).retire('retire-000000001');
  await again.close();
  const settled = await makeRegistry(backing);
  t.is(settled.inspect().grants[moved.grantId].state, 'active');
  await t.throwsAsync(
    () => E(settled.directoryFor('owner-alice')).reattach(later),
    { message: /provider-not-found/ },
  );
  await settled.close();
});

test('the owner records an upstream-revocation assertion once', async t => {
  const backing = makeBacking();
  let clock = '2026-10-27T00:00:00.000Z';
  const registry = await makeRegistry(backing, { now: () => clock });
  const directory = registry.directoryFor('owner-alice');
  const provider = await E(directory).create(providerRequest());
  const admin = await E(directory).adminFor(provider.providerId);
  t.is(provider.upstreamRevocationAssertedAt, undefined);
  await E(admin).retire('retire-000000001');
  clock = '2026-10-28T00:00:00.000Z';
  const asserted = await E(admin).assertUpstreamRevoked();
  t.is(asserted.state, 'retired');
  t.is(asserted.upstreamRevocationAssertedAt, '2026-10-28T00:00:00.000Z');
  clock = '2026-10-29T00:00:00.000Z';
  t.deepEqual(await E(admin).assertUpstreamRevoked(), asserted, 'idempotent');
  t.is(
    registry
      .inspect()
      .audit.filter(entry => entry.change === 'upstream-revocation-asserted')
      .length,
    1,
  );
  await t.throwsAsync(
    () => E(registry.directoryFor('owner-bob')).adminFor(provider.providerId),
    { message: /provider-not-found/ },
  );
  await registry.close();
  const revived = await makeRegistry(backing);
  t.is(
    (await E(revived.directoryFor('owner-alice')).lookup(provider.providerId))
      .upstreamRevocationAssertedAt,
    '2026-10-28T00:00:00.000Z',
  );
  await revived.close();
});

test('a discovery failure accepts only a well-shaped typed model, verified by its first turn', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    discoverModels: async () => {
      throw Error('upstream unavailable');
    },
    modelPrices: harden({}),
    behavior: {
      status: request => (request.body.includes('missing') ? 404 : 200),
    },
  });
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden({ dailyTokens: 100_000 }),
    'owner-tokens-discovery',
    true,
  );
  const provider = await E(directory).create(
    providerRequest({
      limits: { concurrentTurns: 2, dailyTokens: 20_000 },
    }),
  );
  const admin = await E(directory).adminFor(provider.providerId);
  t.like(await E(admin).discoverModels(), {
    catalogState: 'unavailable',
    models: [],
  });
  const use = registry.useFor('owner-alice', provider.providerId);
  const typedGrant = (agentId, model) =>
    E(use).grant(harden({ ownerId: 'owner-alice', agentId, model }));
  await t.throwsAsync(() => typedGrant('agent-malformed', 'Not A Model!'), {
    message: /invalid-model/,
  });
  const verification = () =>
    registry.inspect().modelStates[provider.providerId].verification;
  const typed = await typedGrant('agent-typed', 'claude-typed');
  t.is(verification()['claude-typed'], 'unverified');
  const typedMessage = text =>
    harden({
      ...message(text),
      body: message(text).body.replace('claude-test', 'claude-typed'),
    });
  await t.throwsAsync(() => E(typed).request(typedMessage('missing')), {
    message: /model-not-available/,
  });
  t.is(verification()['claude-typed'], 'unverified');
  await E(typed).request(typedMessage('present'));
  t.is(verification()['claude-typed'], 'verified');
  await registry.close();
});

test('a model the catalog lists is selectable and already verified', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    discoverModels: async () =>
      harden({ models: [{ id: 'claude-catalog', title: 'Catalog Claude' }] }),
    modelPrices: harden({}),
  });
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden({ dailyTokens: 100_000 }),
    'owner-tokens-catalog',
    true,
  );
  const provider = await E(directory).create(
    providerRequest({
      limits: { concurrentTurns: 2, dailyTokens: 20_000 },
    }),
  );
  await E(await E(directory).adminFor(provider.providerId)).discoverModels();
  const inference = await E(
    registry.useFor('owner-alice', provider.providerId),
  ).grant(
    harden({
      ownerId: 'owner-alice',
      agentId: 'agent-catalog',
      model: 'claude-catalog',
    }),
  );
  t.truthy(inference);
  t.is(
    registry.inspect().modelStates[provider.providerId].verification[
      'claude-catalog'
    ],
    'verified',
  );
  await registry.close();
});

// Two providers of one owner, each with far more room than the owner, holding
// one grant per agent so that only the owner's cap can refuse.
const twoProviderGrants = async (registry, ownerLimits, turnsPerProvider) => {
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden(ownerLimits),
    'owner-limits-two',
    true,
  );
  const roomy = {
    concurrentTurns: 50,
    requestsPerMinute: 500,
    dailyTokens: 1_000_000,
  };
  const inferences = [];
  for (const side of ['a', 'b']) {
    // eslint-disable-next-line no-await-in-loop
    const provider = await E(directory).create(
      providerRequest({
        idempotencyKey: `create-two-providers-${side}`,
        displayName: `Claude ${side}`,
        limits: roomy,
      }),
    );
    for (let turn = 0; turn < Number(turnsPerProvider); turn += 1) {
      inferences.push(
        // eslint-disable-next-line no-await-in-loop
        await E(registry.useFor('owner-alice', provider.providerId)).grant(
          harden({
            ownerId: 'owner-alice',
            agentId: `agent-${side}-${turn}`,
            model: 'claude-test',
          }),
        ),
      );
    }
  }
  return { directory, inferences };
};

test('concurrent admissions on two providers never exceed the owner concurrency', async t => {
  const backing = makeBacking();
  const events = [];
  const registry = await makeRegistry(backing, {
    events,
    modelPrices: harden({}),
  });
  const { directory, inferences } = await twoProviderGrants(
    registry,
    { concurrentTurns: 2, requestsPerMinute: 500, dailyTokens: 1_000_000 },
    3,
  );
  const outcomes = inferences.map(inference =>
    E(inference)
      .request(message('wait'))
      .then(
        () => 'served',
        error => error.message,
      ),
  );
  const refusedCount = () =>
    E(directory)
      .getUsage()
      .then(usage => usage.refusals.length);
  for (let turn = 0; turn < 200; turn += 1) {
    // eslint-disable-next-line no-await-in-loop
    if ((await refusedCount()) === inferences.length - 2) break;
  }
  const usage = await E(directory).getUsage();
  t.is(usage.turns.filter(row => row.state === 'reserved').length, 2);
  t.is(
    usage.refusals.filter(row => row.reason === 'owner-concurrency-exhausted')
      .length,
    inferences.length - 2,
  );
  t.is(events.filter(event => event[0] === 'request').length, 2);
  await registry.close();
  await Promise.all(outcomes);
});

test('concurrent admissions on two providers never exceed the owner budget', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, { modelPrices: harden({}) });
  // Find one turn's reservation, then allow the owner exactly two of them.
  const probe = await twoProviderGrants(
    registry,
    { concurrentTurns: 50, requestsPerMinute: 500, dailyTokens: 1_000_000 },
    3,
  );
  await E(probe.inferences[0]).request(message('turn'));
  const [{ reservedTokens, chargedTokens }] = (
    await E(probe.directory).getUsage()
  ).turns;
  t.true(Number(reservedTokens) > 0);
  const budget = chargedTokens + 2 * reservedTokens;
  await E(probe.directory).setOwnerLimits(
    harden({ dailyTokens: budget }),
    'owner-budget-two',
    true,
  );
  const results = await Promise.allSettled(
    probe.inferences.map(inference => E(inference).request(message('turn'))),
  );
  t.is(results.filter(result => result.status === 'fulfilled').length, 2);
  const usage = await E(probe.directory).getUsage();
  t.is(
    usage.refusals.filter(row => row.reason === 'owner-budget-exhausted')
      .length,
    probe.inferences.length - 2,
  );
  t.true(
    Number(usage.turns.reduce((total, row) => total + row.chargedTokens, 0)) <=
      Number(budget),
  );
  await registry.close();
});

test('the request rate refuses at each scope and recovers after a minute', async t => {
  const backing = makeBacking();
  let clock = Date.parse('2026-10-27T00:00:00.000Z');
  const registry = await makeRegistry(backing, {
    modelPrices: harden({}),
    nowMillis: () => clock,
  });
  const directory = registry.directoryFor('owner-alice');
  await E(directory).setOwnerLimits(
    harden({ concurrentTurns: 50, requestsPerMinute: 3, dailyTokens: 100_000 }),
    'owner-rate-1',
    true,
  );
  const provider = await E(directory).create(
    providerRequest({
      limits: {
        concurrentTurns: 50,
        requestsPerMinute: 2,
        dailyTokens: 100_000,
      },
    }),
  );
  const second = await E(directory).create(
    providerRequest({
      idempotencyKey: 'create-rate-second',
      displayName: 'Claude rate second',
      limits: {
        concurrentTurns: 50,
        requestsPerMinute: 50,
        dailyTokens: 100_000,
      },
    }),
  );
  const grant = async (providerId, agentId) => {
    const use = registry.useFor('owner-alice', providerId);
    const inference = await E(use).grant(
      harden({
        grantId: `grant-${agentId}`,
        ownerId: 'owner-alice',
        agentId,
        model: 'claude-test',
      }),
    );
    await E(use).setGrantLimits(
      `grant-${agentId}`,
      harden({ requestsPerMinute: 1 }),
      `lower-${agentId}`,
    );
    return inference;
  };
  const refusalFor = async inference => {
    await t.throwsAsync(() => E(inference).request(message('turn')), {
      message: /inference-request-refused/,
    });
    const { refusals } = await E(directory).getUsage();
    return refusals.at(-1).reason;
  };
  const first = await grant(provider.providerId, 'agent-rate-1');
  await E(first).request(message('turn'));
  t.is(await refusalFor(first), 'agent-rate-limited');
  const sibling = await grant(provider.providerId, 'agent-rate-2');
  await E(sibling).request(message('turn'));
  const third = await grant(provider.providerId, 'agent-rate-3');
  t.is(await refusalFor(third), 'provider-rate-limited');
  const elsewhere = await grant(second.providerId, 'agent-rate-4');
  await E(elsewhere).request(message('turn'));
  const further = await grant(second.providerId, 'agent-rate-5');
  t.is(await refusalFor(further), 'owner-rate-limited');
  clock += 61_000;
  await E(further).request(message('turn'));
  await registry.close();
});

test('a stream cut short is charged its reservation, not its partial usage', async t => {
  const backing = makeBacking();
  const registry = await makeRegistry(backing, {
    modelPrices: harden({}),
    behavior: {
      streamResponse: () => ({
        status: 200,
        headers: {},
        body: makeExo('reader', TestReaderInterface, {}),
        usage: Promise.resolve(
          harden({
            usage: { inputTokens: 1 },
            began: true,
            complete: false,
            responseBytes: 1,
          }),
        ),
      }),
    },
  });
  const { directory, inference } = await tokenGrant(registry, 'agent-cut');
  const stream = await E(inference).requestByteStream(message('cut'));
  await stream.usage;
  const { turns } = await E(directory).getUsage();
  t.is(turns.length, 1);
  t.like(turns[0], { state: 'settled', disposition: 'estimated' });
  t.is(turns[0].chargedTokens, turns[0].reservedTokens);
  await registry.close();
});

for (const [thrown, code] of /** @type {Array<[string, string]>} */ ([
  ['Provider credential rejected', 'provider-authentication-failed'],
  ['Provider rate limited', 'provider-rate-limited'],
  ['Provider subscription exhausted', 'provider-rate-limited'],
  ['Provider model not found', 'model-not-available'],
])) {
  test(`the upstream refusal "${thrown}" is reported as ${code}`, async t => {
    const backing = makeBacking();
    const registry = await makeRegistry(backing, {
      modelPrices: harden({}),
      behavior: {
        streamResponse: () => {
          throw Error(thrown);
        },
      },
    });
    const { directory, inference } = await tokenGrant(
      registry,
      `agent-${code}`,
    );
    await t.throwsAsync(() => E(inference).requestByteStream(message('no')), {
      message: new RegExp(code),
    });
    const { refusals, turns } = await E(directory).getUsage();
    t.true(refusals.some(row => row.reason === code));
    t.is(turns[0].disposition, 'estimated');
    await registry.close();
  });
}
