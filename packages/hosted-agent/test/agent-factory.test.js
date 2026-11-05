// @ts-check
/* eslint-disable no-await-in-loop, no-underscore-dangle */

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  AGENT_HARNESS_CATALOG,
  makeAgentFactory,
} from '../src/agent-factory.js';
import { AGENT_POWERS_PROFILES } from '../src/agent-guest-powers.js';
import { makeInferenceProviderRegistry } from '../src/inference-provider-registry.js';
import { InferenceEndpointInterface } from '../src/subscription-share.js';

const OWNER = 'g-00000000000000000000000000000001';
const OTHER_OWNER = 'g-00000000000000000000000000000002';
const MODEL = 'claude-test';

const providerLimits = harden({
  concurrentTurns: 4,
  requestsPerMinute: 100,
  dailyDollars: 50,
});

const fixed = code => makeError(X`Agent operation failed: ${q(code)}`);
const refusalFor = code => ({
  message: new RegExp(`operation failed: "${code}"`),
});

const SecretBlobInterface = M.interface('SecretBlob', {
  readBase64: M.callWhen().returns(M.string()),
  getDescription: M.callWhen().returns(M.string()),
});

/**
 * Everything that survives a crash: both journals and the participants' worlds.
 * A "restart" rebuilds the registry and factory over this same backing.
 */
const makeWorld = () => {
  const snapshots = {};
  const makeJournal = name => ({
    read: async () => snapshots[name],
    write: async value => {
      snapshots[name] = value;
    },
  });
  const secrets = new Map();
  const secretParticipant = {
    has: async name => secrets.has(name),
    provide: async (name, description, bytesBase64) => {
      const existing = secrets.get(name);
      if (existing !== undefined) return existing.blob;
      const blob = makeExo('SecretBlob', SecretBlobInterface, {
        readBase64: async () => bytesBase64,
        getDescription: async () => description,
      });
      secrets.set(name, { blob, state: 'active' });
      return blob;
    },
    revoke: async name => {
      secrets.get(name).state = 'revoked';
    },
    state: async name => secrets.get(name)?.state || 'missing',
    listNames: async () => [...secrets.keys()],
  };

  /** @type {Map<string, { handleId: string, mail: any[], provideCount: number }>} */
  /** @type {Map<string, any>} */
  const guestRecords = new Map();
  const events = [];
  const failures = {};
  const guests = {
    provide: async name => {
      if (failures.guest) throw failures.guest;
      let record = guestRecords.get(name);
      if (record === undefined) {
        record = { handleId: `handle-${name}`, mail: [], provideCount: 0 };
        guestRecords.set(name, record);
      }
      record.provideCount += 1;
      return harden({ handleId: record.handleId });
    },
    guestFor: async name =>
      makeExo(
        'FakeGuest',
        M.interface('FakeGuest', {}, { defaultGuards: 'passable' }),
        {
          list: async () => harden(['@self', '@host', 'own-note']),
          has: async () => false,
          lookup: async petName => harden({ resolvedIn: name, petName }),
          move: async () => undefined,
          remove: async () => undefined,
          followMessages: async () => undefined,
          listMessages: async () => harden([]),
          messageHistory: async () => harden([]),
          send: async () => undefined,
          reply: async () => undefined,
          dismiss: async () => undefined,
          adopt: async () => undefined,
          request: async () => undefined,
          form: async () => undefined,
          define: async () => undefined,
          submit: async () => undefined,
          resolve: async () => undefined,
          reject: async () => undefined,
          // Authority the facet must not forward.
          lookupById: async () => 'sibling',
          provideGuest: async () => 'root',
          evaluate: async () => 'root',
          storeIdentifier: async () => 'owner',
        },
      ),
    release: async name => {
      guestRecords.delete(name);
    },
    listMail: async name =>
      harden(
        (guestRecords.get(name)?.mail || []).map(number => ({
          number,
          type: 'package',
          date: '2026-11-04T00:00:00.000Z',
          text: `message ${number}`,
        })),
      ),
    dismissMail: async (name, number) => {
      const record = guestRecords.get(name);
      record.mail = record.mail.filter(candidate => candidate !== number);
    },
  };
  const deliver = (name, ...numbers) => {
    guestRecords.get(name).mail.push(...numbers);
  };

  /** @type {Map<string, Record<string, any>>} */
  /** @type {Map<string, any>} */
  const inventories = new Map();
  const inventory = {
    write: async (ownerId, name, handleId) => {
      const names = inventories.get(ownerId) || {};
      if (names[name] !== undefined && names[name] !== handleId) {
        throw fixed('agent-name-conflict');
      }
      names[name] = handleId;
      inventories.set(ownerId, names);
    },
    remove: async (ownerId, name, handleId) => {
      const names = inventories.get(ownerId) || {};
      if (names[name] === handleId) delete names[name];
    },
  };

  /** @type {Map<string, { name: string, paused: boolean, startAfter?: string, starts: number }>} */
  /** @type {Map<string, any>} */
  const responderRecords = new Map();
  const responders = {
    has: async name => responderRecords.has(name),
    provide: async ({ name, startAfter }) => {
      if (!responderRecords.has(name)) {
        responderRecords.set(name, {
          name,
          paused: true,
          startAfter,
          starts: 0,
        });
      }
    },
    setPaused: async (name, paused, startAfter) => {
      if (failures.responder) throw failures.responder;
      const record = responderRecords.get(name);
      if (record.paused && !paused) {
        record.starts += 1;
        record.startAfter = startAfter;
      }
      record.paused = paused;
    },
    remove: async (_guestName, name) => {
      responderRecords.delete(name);
    },
  };

  return {
    snapshots,
    makeJournal,
    secretParticipant,
    guestRecords,
    guests,
    deliver,
    inventories,
    inventory,
    responderRecords,
    responders,
    events,
    failures,
    catalog: { value: /** @type {any} */ (undefined) },
    ids: { next: 0 },
  };
};

const makeIssuer =
  world =>
  async ({ descriptor }) =>
    harden({
      openEndpoint: async ({ sessionId }) => {
        /** @type {Set<() => void>} */
        const cancels = new Set();
        return makeExo('Endpoint', InferenceEndpointInterface, {
          request: async message => {
            world.events.push(['request', descriptor.providerId, sessionId]);
            if (message.body.includes('wait')) {
              await new Promise((resolve, reject) => {
                cancels.add(() => reject(Error('request canceled')));
                world.events.push(['waiting', descriptor.providerId, resolve]);
              });
            }
            return harden({
              status: 200,
              headers: {},
              body: 'ok',
              usage: harden({ inputTokens: 1, outputTokens: 1 }),
            });
          },
          requestByteStream: async () => {
            throw Error('not used');
          },
          attestation: async () => harden({ version: 'test' }),
          revoke: async () => {
            for (const cancel of cancels) cancel();
          },
        });
      },
      dispose: async () => undefined,
    });

/**
 * (Re)build the registry and factory over one world.
 *
 * @param {ReturnType<typeof makeWorld>} world
 * @param {object} [options]
 * @param {any} [options.crashAt] A boundary to crash at, once.
 * @param {any} [options.spawners]
 * @param {(registry: any) => any} [options.wrapRegistry]
 */
const boot = async (world, { crashAt, spawners, wrapRegistry } = {}) => {
  const randomId = () => {
    world.ids.next += 1;
    return `id-${`${world.ids.next}`.padStart(8, '0')}`;
  };
  const registry = await makeInferenceProviderRegistry({
    journal: world.makeJournal('registry'),
    secrets: world.secretParticipant,
    makeIssuer: makeIssuer(world),
    discoverModels: async () => {
      if (world.catalog.value === undefined) throw Error('no list route');
      return harden({ models: world.catalog.value });
    },
    modelPrices: harden({
      [MODEL]: { inputPerMillion: 1, outputPerMillion: 1 },
      'claude-other': { inputPerMillion: 1, outputPerMillion: 1 },
    }),
    randomId,
  });
  const boundaries = [];
  let armed = crashAt;
  const factory = await makeAgentFactory({
    journal: world.makeJournal('factory'),
    registry: wrapRegistry ? wrapRegistry(registry) : registry,
    guests: world.guests,
    inventory: world.inventory,
    responders: world.responders,
    spawners,
    randomId,
    afterBoundary: boundary => {
      boundaries.push(boundary);
      if (boundary === armed) {
        armed = undefined;
        throw Error(`crash at ${boundary}`);
      }
    },
  });
  return { registry, factory, boundaries };
};

const addProvider = async (registry, ownerId, suffix, overrides = {}) => {
  const directory = await E(registry).directoryFor(ownerId);
  return E(directory).create(
    harden({
      idempotencyKey: `create-provider-${suffix}`,
      displayName: `Provider ${suffix}`,
      kind: 'anthropic',
      defaultModel: MODEL,
      limits: providerLimits,
      keyBase64: encodeBase64(encodeUtf8(`key-${suffix}`)),
      ...overrides,
    }),
  );
};

const createRequest = (providerId, overrides = {}) =>
  harden({
    idempotencyKey: 'create-agent-1',
    providerId,
    harness: 'lal',
    name: 'helper',
    model: MODEL,
    limits: {},
    wake: true,
    endowments: [],
    ...overrides,
  });

const body = (content = 'hello') =>
  JSON.stringify({
    model: MODEL,
    max_tokens: 10,
    messages: [{ role: 'user', content }],
  });
const turn = content =>
  harden({ method: 'POST', path: '/v1/messages', body: body(content) });

const activeGrants = async registry =>
  (await E(registry).listGrants()).filter(({ state }) => state === 'active');

/**
 * @param {any} t
 * @param {ReturnType<typeof makeWorld>} world
 * @param {any} registry
 */
const assertOneOfEach = async (t, world, registry) => {
  t.is(world.guestRecords.size, 1);
  t.is(world.responderRecords.size, 1);
  t.is((await activeGrants(registry)).length, 1);
};

const assertNoRunningWithoutRecord = (t, world, factory) => {
  const { agents } = factory.inspect();
  for (const responder of world.responderRecords.values()) {
    if (!responder.paused) {
      t.true(
        Object.values(agents).some(
          agent =>
            agent.names.responder === responder.name &&
            agent.lifecycle !== 'deleted',
        ),
        'a running responder has a committed AgentRecord',
      );
    }
  }
};

const setup = async (options = {}) => {
  const world = makeWorld();
  const booted = await boot(world, options);
  const provider = await addProvider(booted.registry, OWNER, 'a');
  const directory = booted.factory.directoryFor(OWNER);
  return { world, ...booted, provider, directory };
};

test('the catalog lists exactly Lal then Fae and refuses any other harness', async t => {
  const { directory, provider } = await setup();
  const { harnesses } = await E(directory).getCatalog();
  t.deepEqual(
    harnesses.map(({ id }) => id),
    ['lal', 'fae'],
  );
  t.true(harnesses[0].recommended);
  t.deepEqual(harnesses, AGENT_HARNESS_CATALOG);
  for (const harness of ['floot', 'jaine', 'agentry', 'genie']) {
    await t.throwsAsync(
      E(directory).create(createRequest(provider.providerId, { harness })),
      refusalFor('invalid-harness'),
    );
  }
});

test('creation validates its closed request', async t => {
  const { directory, provider, world } = await setup();
  const { providerId } = provider;
  const cases = [
    [{ name: 'Not A Pet Name' }, 'invalid-agent-name'],
    [{ name: '@host' }, 'invalid-agent-name'],
    [{ model: 'BAD MODEL' }, 'invalid-model'],
    [{ limits: { dailyBillions: 1 } }, 'invalid-agent-limits'],
    [{ wake: undefined }, 'invalid-request'],
    [{ endowments: undefined }, 'invalid-request'],
    [{ endowments: ['root-host'] }, 'invalid-request'],
    [{ ownerId: OTHER_OWNER }, 'invalid-request'],
    [
      { harnessConfig: { authSecretName: 'k' } },
      'invalid-harness-configuration',
    ],
    [
      {
        harnessConfig: { provider: 'brokered-messages', authToken: 'k' },
      },
      'invalid-harness-configuration',
    ],
    [
      { harnessConfig: { provider: 'anthropic' } },
      'invalid-harness-configuration',
    ],
  ];
  for (const [overrides, code] of cases) {
    await t.throwsAsync(
      E(directory).create(createRequest(providerId, overrides)),
      refusalFor(code),
    );
  }
  t.is(world.guestRecords.size, 0);
});

test('a named endowment fills the slot and an omitted one leaves no capability', async t => {
  const provided = [];
  const spawner = makeExo(
    'FakeSpawner',
    M.interface('FakeSpawner', { spawn: M.call().returns(M.string()) }),
    { spawn: () => 'spawned' },
  );
  const spawners = {
    provide: async details => {
      provided.push(details);
      return spawner;
    },
  };
  const { factory, directory, provider } = await setup({ spawners });
  const { providerId } = provider;

  const named = await E(directory).create(
    createRequest(providerId, { endowments: ['subagent-creation'] }),
  );
  t.true(named.subagentCreation);
  const held = await factory.endowmentFor(named.agentId);
  t.is(await E(held.subagentCreation).spawn(), 'spawned');
  t.is(provided.length, 1);
  t.is(provided[0].agentId, named.agentId);

  const omitted = await E(directory).create(
    createRequest(providerId, {
      idempotencyKey: 'create-agent-2',
      name: 'plain',
    }),
  );
  t.false(omitted.subagentCreation);
  const plain = await factory.endowmentFor(omitted.agentId);
  t.false(Object.hasOwn(plain, 'subagentCreation'));
  t.is(provided.length, 1, 'the server adds no default');
});

test('a named endowment with no spawner configured is refused, not dropped', async t => {
  const { directory, provider, world } = await setup();
  t.false((await E(directory).getCatalog()).subagentCreation);
  await t.throwsAsync(
    E(directory).create(
      createRequest(provider.providerId, {
        endowments: ['subagent-creation'],
      }),
    ),
    refusalFor('subagent-creation-unavailable'),
  );
  t.is(world.guestRecords.size, 0);
});

test('an agent holds inference only for the provider its request named', async t => {
  const { factory, directory, provider, registry, world } = await setup();
  await addProvider(registry, OWNER, 'unnamed');
  const agent = await E(directory).create(createRequest(provider.providerId));
  const grants = await activeGrants(registry);
  t.deepEqual(
    grants.map(grant => [grant.providerId, grant.agentId, grant.models]),
    [[provider.providerId, agent.agentId, [MODEL]]],
  );
  const { inference, harnessConfig } = await factory.endowmentFor(
    agent.agentId,
  );
  t.is(harnessConfig.provider, 'brokered-messages');
  await E(inference).request(turn());
  t.deepEqual(
    world.events
      .filter(([kind]) => kind === 'request')
      .map(([, providerId]) => providerId),
    [provider.providerId],
  );
});

test('initial limits equal the default agent caps', async t => {
  const { directory, provider, factory } = await setup();
  const agent = await E(directory).create(createRequest(provider.providerId));
  t.like(agent.limits, {
    concurrentTurns: 1,
    requestsPerMinute: 10,
    dailyDollars: 2,
  });
  t.like(factory.inspect().agents[agent.agentId].limits, agent.limits);
});

test('same-name, stale, foreign and excluded-model requests are refused', async t => {
  const { directory, provider, registry, world, factory } = await setup();
  const { providerId } = provider;
  await E(directory).create(createRequest(providerId));
  const sizeBefore = world.guestRecords.size;

  await t.throwsAsync(
    E(directory).create(
      createRequest(providerId, { idempotencyKey: 'create-agent-2' }),
    ),
    refusalFor('agent-name-conflict'),
  );

  const stale = await addProvider(registry, OWNER, 'stale');
  const ownerDirectory = await E(registry).directoryFor(OWNER);
  await E(E(ownerDirectory).adminFor(stale.providerId)).retire('retire-1');
  await t.throwsAsync(
    E(directory).create(
      createRequest(stale.providerId, {
        idempotencyKey: 'create-agent-3',
        name: 'stale',
      }),
    ),
    refusalFor('provider-retired'),
  );

  const foreign = await addProvider(registry, OTHER_OWNER, 'foreign');
  await t.throwsAsync(
    E(directory).create(
      createRequest(foreign.providerId, {
        idempotencyKey: 'create-agent-4',
        name: 'foreign',
      }),
    ),
    refusalFor('provider-not-found'),
  );
  await t.throwsAsync(
    E(directory).create(
      createRequest('never-existed', {
        idempotencyKey: 'create-agent-5',
        name: 'unknown',
      }),
    ),
    refusalFor('provider-not-found'),
  );

  world.catalog.value = harden([{ id: 'claude-listed' }]);
  await t.throwsAsync(
    E(directory).create(
      createRequest(providerId, {
        idempotencyKey: 'create-agent-6',
        name: 'excluded',
      }),
    ),
    refusalFor('model-not-available'),
  );
  world.catalog.value = undefined;

  t.is(world.guestRecords.size, sizeBefore);
  t.is(Object.keys(factory.inspect().agents).length, 1);
});

test('retrying an idempotency key returns the same agent and a changed request conflicts', async t => {
  const { directory, provider, world } = await setup();
  const first = await E(directory).create(createRequest(provider.providerId));
  const second = await E(directory).create(createRequest(provider.providerId));
  t.is(second.agentId, first.agentId);
  t.is(world.guestRecords.size, 1);
  await t.throwsAsync(
    E(directory).create(
      createRequest(provider.providerId, { name: 'different' }),
    ),
    refusalFor('idempotency-conflict'),
  );
});

test('an owner id and idempotency key containing colons cannot alias another owner', async t => {
  const { factory, directory, provider } = await setup();
  const created = await E(directory).create(
    createRequest(provider.providerId, { idempotencyKey: 'team:create' }),
  );
  t.is(
    (await E(directory).getOperationStatus('team:create')).agentId,
    created.agentId,
  );
  const aliased = factory.directoryFor(`${OWNER}:team`);
  t.deepEqual(await E(aliased).getOperationStatus('create'), {
    idempotencyKey: 'create',
    status: 'not-found',
  });
});

test('powers profiles hold exactly their methods and no root, secret or sibling path', async t => {
  const { factory, directory, provider } = await setup();
  const lal = await E(directory).create(createRequest(provider.providerId));
  const fae = await E(directory).create(
    createRequest(provider.providerId, {
      idempotencyKey: 'create-agent-2',
      name: 'advanced',
      harness: 'fae',
    }),
  );
  const lalPowers = (await factory.endowmentFor(lal.agentId)).powers;
  const faePowers = (await factory.endowmentFor(fae.agentId)).powers;
  const methodsOf = async powers =>
    (await E(powers).__getMethodNames__())
      .filter(name => !name.startsWith('__'))
      .sort();

  t.deepEqual(
    await methodsOf(lalPowers),
    [...AGENT_POWERS_PROFILES.lal].sort(),
  );
  t.deepEqual(
    await methodsOf(faePowers),
    [...AGENT_POWERS_PROFILES.fae].sort(),
  );
  for (const method of ['request', 'form', 'define', 'submit']) {
    t.true((await methodsOf(lalPowers)).includes(method), method);
    t.false((await methodsOf(faePowers)).includes(method), method);
  }
  for (const powers of [lalPowers, faePowers]) {
    const methods = await methodsOf(powers);
    for (const forbidden of [
      'lookupById',
      'lookupByLocator',
      'provideGuest',
      'provideHost',
      'evaluate',
      'storeIdentifier',
      'storeLocator',
      'makeUnconfined',
      'identify',
      'locate',
    ]) {
      t.false(methods.includes(forbidden), forbidden);
    }
    t.deepEqual(await E(powers).list(), ['own-note']);
    for (const name of ['@host', '@endo', '@secrets', '@pins', '@self']) {
      await t.throwsAsync(
        E(powers).lookup(name),
        refusalFor('powers-name-refused'),
      );
      await t.throwsAsync(
        E(powers).send(name, ['hi'], [], []),
        refusalFor('powers-name-refused'),
      );
      await t.throwsAsync(
        E(powers).send('friend', ['hi'], ['edge'], [name]),
        refusalFor('powers-name-refused'),
      );
    }
    await t.throwsAsync(
      E(powers).lookup(['friend', '@secrets']),
      refusalFor('powers-name-refused'),
    );
    for (const callVariadic of [
      () => E(powers).list('@host'),
      () => E(powers).list('@secrets'),
      () => E(powers).list('friend', '@protected'),
      () => E(powers).has('friend', '@secrets'),
      () => E(powers).has(['friend', '@host']),
      () => E(powers).remove('friend', '@protected'),
      () => E(powers).remove('@endo'),
    ]) {
      await t.throwsAsync(callVariadic(), refusalFor('powers-name-refused'));
    }
  }
  const own = await E(lalPowers).lookup('own-note');
  t.is(own.resolvedIn, lal.agentId, 'names resolve only within this guest');
});

/**
 * Every boundary a clean run crosses, discovered rather than hand-listed.
 * @param run
 */
const boundariesOf = async run => {
  const { world, factory, directory, provider, registry, boundaries } =
    await setup();
  await run({ world, factory, directory, provider, registry });
  return [...boundaries];
};

test('a crash at each creation boundary converges on one guest, grant and responder', async t => {
  const create = ({ directory, provider }) =>
    E(directory).create(createRequest(provider.providerId));
  const boundaries = await boundariesOf(create);
  for (const expected of [
    'create-intent',
    'create-guest-effect',
    'create-guest-created',
    'create-inference-effect',
    'create-inference-bound',
    'create-responder-effect',
    'create-responder-ready',
    'create-name-effect',
    'create-named',
    'create-committed',
    'create-activate-effect',
    'create-completed',
  ]) {
    t.true(boundaries.includes(expected), expected);
  }
  for (const recovery of ['retry', 'reconcile']) {
    for (const crashAt of boundaries) {
      const crashed = await setup({ crashAt });
      const { world, provider } = crashed;
      const label = `${recovery} after ${crashAt}`;
      await t.throwsAsync(create(crashed), { message: /crash at/ }, label);
      assertNoRunningWithoutRecord(t, world, crashed.factory);
      const restarted = await boot(world);
      const directory = restarted.factory.directoryFor(OWNER);
      if (recovery === 'retry') {
        const agent = await E(directory).create(
          createRequest(provider.providerId),
        );
        t.is(agent.status, 'awake', label);
      } else {
        await restarted.factory.reconcile();
      }
      await assertOneOfEach(t, world, restarted.registry);
      const [responder] = world.responderRecords.values();
      t.false(responder.paused, `${label}: running`);
      t.is(responder.starts, 1, `${label}: started once`);
      const agents = Object.values(restarted.factory.inspect().agents);
      t.is(agents.length, 1, label);
      t.is(agents[0].lifecycle, 'active', label);
      t.is(world.inventories.get(OWNER).helper, agents[0].handleId, label);
      t.is(
        Object.values(restarted.factory.inspect().operations)[0].state,
        'completed',
        label,
      );
    }
  }
});

test('no success returns before activation, and a failed activation shows waking', async t => {
  const { world, directory, provider, factory } = await setup();
  world.failures.responder = Error('responder failed to start');
  await t.throwsAsync(E(directory).create(createRequest(provider.providerId)), {
    message: /responder failed to start/,
  });
  const [record] = Object.values(factory.inspect().agents);
  const before = await E(directory).get(record.agentId);
  t.is(before.status, 'waking');
  delete world.failures.responder;
  await factory.reconcile();
  const after = await E(directory).get(record.agentId);
  t.is(after.status, 'awake');
  t.false([...world.responderRecords.values()][0].paused);
});

test('a permanent failure before commit leaves no residue, even across a crash in the abort', async t => {
  // Discover the abort boundaries from one uninterrupted abort.
  const failing = world => {
    world.inventories.set(OWNER, { helper: 'handle-of-something-else' });
  };
  const clean = await setup();
  failing(clean.world);
  await t.throwsAsync(
    E(clean.directory).create(createRequest(clean.provider.providerId)),
    refusalFor('agent-name-conflict'),
  );
  const boundaries = clean.boundaries.filter(name => /abort/.test(name));
  t.true(boundaries.includes('create-aborting'));
  t.true(boundaries.includes('create-aborted'));

  for (const crashAt of [undefined, ...boundaries]) {
    const crashed = await setup({ crashAt });
    failing(crashed.world);
    await t.throwsAsync(
      E(crashed.directory).create(createRequest(crashed.provider.providerId)),
    );
    const restarted = await boot(crashed.world);
    await restarted.factory.reconcile();
    t.is(crashed.world.guestRecords.size, 0, `guest ${crashAt}`);
    t.is(crashed.world.responderRecords.size, 0, `responder ${crashAt}`);
    t.is(
      (await activeGrants(restarted.registry)).length,
      0,
      `grant ${crashAt}`,
    );
    t.is(
      crashed.world.inventories.get(OWNER).helper,
      'handle-of-something-else',
      'the abort leaves a name this operation did not write',
    );
    const { agents, names, operations } = restarted.factory.inspect();
    t.deepEqual(Object.keys(agents), []);
    t.deepEqual(Object.keys(names), [], 'the bot name is released');
    t.is(Object.values(operations)[0].state, 'aborted');
    // The fixed refusal, not a generic one, answers a retry.
    await t.throwsAsync(
      E(restarted.factory.directoryFor(OWNER)).create(
        createRequest(crashed.provider.providerId),
      ),
      refusalFor('agent-name-conflict'),
    );
  }
});

test('an abort after naming removes the name this operation wrote', async t => {
  const world = makeWorld();
  let hideGrants = false;
  const wrapRegistry = registry =>
    harden({
      ...registry,
      listGrants: async () => (hideGrants ? harden([]) : registry.listGrants()),
    });
  const { registry, factory } = await boot(world, { wrapRegistry });
  const provider = await addProvider(registry, OWNER, 'a');
  hideGrants = true;
  await t.throwsAsync(
    E(factory.directoryFor(OWNER)).create(createRequest(provider.providerId)),
    refusalFor('agent-not-found'),
  );
  t.deepEqual(world.inventories.get(OWNER), {});
  t.is(world.guestRecords.size, 0);
  t.is(world.responderRecords.size, 0);
  t.is((await activeGrants(registry)).length, 0);
});

test('a guest refusal aborts with its fixed code', async t => {
  const { world, directory, provider } = await setup();
  world.failures.guest = fixed('guest-refused');
  await t.throwsAsync(
    E(directory).create(createRequest(provider.providerId)),
    refusalFor('guest-refused'),
  );
  t.is(world.guestRecords.size, 0);
});

test('a transient participant failure stays resumable', async t => {
  const { world, directory, provider, factory } = await setup();
  world.failures.guest = Error('daemon busy');
  await t.throwsAsync(E(directory).create(createRequest(provider.providerId)), {
    message: /daemon busy/,
  });
  const listed = await E(directory).list();
  t.is(listed[0].status, 'creating');
  delete world.failures.guest;
  await factory.reconcile();
  const [agent] = await E(directory).list();
  t.is(agent.status, 'awake');
});

test('wake toggles survive a crash at each boundary', async t => {
  const toggle = async ({ directory, provider }) => {
    const agent = await E(directory).create(createRequest(provider.providerId));
    await E(directory).setWake(agent.agentId, {
      idempotencyKey: 'wake-off',
      wake: false,
    });
  };
  const boundaries = (await boundariesOf(toggle)).filter(name =>
    name.startsWith('set-wake'),
  );
  t.true(boundaries.length >= 4);
  for (const crashAt of boundaries) {
    const crashed = await setup({ crashAt });
    await t.throwsAsync(toggle(crashed), { message: /crash at/ });
    const restarted = await boot(crashed.world);
    await restarted.factory.reconcile();
    const [record] = Object.values(restarted.factory.inspect().agents);
    const [responder] = crashed.world.responderRecords.values();
    t.is(responder.paused, !record.wake, crashAt);
    if (crashAt !== 'set-wake-intent') {
      t.false(record.wake, `desired state committed at ${crashAt}`);
    }
    await assertOneOfEach(t, crashed.world, restarted.registry);
  }
});

test('the reconciler reapplies desired wake when the applied state drifted', async t => {
  const { world, directory, provider, factory } = await setup();
  await E(directory).create(createRequest(provider.providerId));
  const [responder] = world.responderRecords.values();
  responder.paused = true;
  await factory.reconcile();
  t.false(responder.paused);
});

test('mail while wake is off stays unread and enabling needs a queued-mail decision', async t => {
  const { world, directory, provider, factory } = await setup();
  const agent = await E(directory).create(
    createRequest(provider.providerId, { wake: false }),
  );
  t.is(world.responderRecords.size, 0, 'wake off has no responder');
  t.is(agent.status, 'asleep');
  world.deliver(agent.agentId, '1', '2');

  const queued = await E(directory).get(agent.agentId);
  t.is(queued.unreadCount, 2);
  t.is(queued.lastMessage, '2');
  t.deepEqual(
    queued.unread.map(({ number }) => number),
    ['1', '2'],
  );

  await t.throwsAsync(
    E(directory).setWake(agent.agentId, {
      idempotencyKey: 'wake-no-decision',
      wake: true,
    }),
    refusalFor('wake-confirmation-required'),
  );
  t.is(world.responderRecords.size, 0, 'nothing runs until confirmed');
  t.false(factory.inspect().agents[agent.agentId].wake);

  // A cursor must name queued mail the owner was shown.
  for (const confirmedCursor of ['0', '4', '9'.repeat(31)]) {
    for (const queuedMail of ['skip', 'process']) {
      await t.throwsAsync(
        E(directory).setWake(agent.agentId, {
          idempotencyKey: `wake-${queuedMail}-${confirmedCursor}`,
          wake: true,
          queuedMail,
          confirmedCursor,
        }),
        refusalFor('wake-confirmation-required'),
        confirmedCursor,
      );
    }
  }
  t.false(factory.inspect().agents[agent.agentId].wake);
  t.is(factory.inspect().agents[agent.agentId].mailCursor, undefined);

  // Mail after the dialog opened is new mail, not part of the confirmed skip.
  world.deliver(agent.agentId, '3');
  const skipped = await E(directory).setWake(agent.agentId, {
    idempotencyKey: 'wake-skip',
    wake: true,
    queuedMail: 'skip',
    confirmedCursor: '2',
  });
  const [responder] = world.responderRecords.values();
  t.false(responder.paused);
  t.is(responder.startAfter, '2', 'only later mail is processed');
  t.deepEqual(
    skipped.unread.map(({ number }) => number),
    ['3'],
  );
});

test('confirming process starts from the stored cursor, oldest first', async t => {
  const { world, directory, provider } = await setup();
  const agent = await E(directory).create(
    createRequest(provider.providerId, { wake: false }),
  );
  world.deliver(agent.agentId, '1');
  await E(directory).setWake(agent.agentId, {
    idempotencyKey: 'wake-process',
    wake: true,
    queuedMail: 'process',
    confirmedCursor: '1',
  });
  const [responder] = world.responderRecords.values();
  t.false(responder.paused);
  t.is(responder.startAfter, undefined);
});

test('enabling wake with no queued mail applies immediately, and dismissed mail is skipped', async t => {
  const { world, directory, provider } = await setup();
  const agent = await E(directory).create(
    createRequest(provider.providerId, { wake: false }),
  );
  world.deliver(agent.agentId, '1');
  const after = await E(directory).dismissMail(agent.agentId, '1');
  t.is(after.unreadCount, 0);
  await E(directory).setWake(agent.agentId, {
    idempotencyKey: 'wake-empty',
    wake: true,
  });
  t.false([...world.responderRecords.values()][0].paused);
});

test('limit changes reach the grant, gate raises, and apply one operation', async t => {
  const { directory, provider, registry } = await setup();
  const agent = await E(directory).create(createRequest(provider.providerId));
  const lowered = await E(directory).setLimits(agent.agentId, {
    idempotencyKey: 'lower',
    limits: { dailyDollars: 1 },
  });
  t.is(lowered.limits.dailyDollars, 1);
  t.is((await activeGrants(registry))[0].caps.dailyDollars, 1);
  await t.throwsAsync(
    E(directory).setLimits(agent.agentId, {
      idempotencyKey: 'raise',
      limits: { dailyDollars: 3 },
    }),
    refusalFor('limit-raise-unconfirmed'),
  );
  t.is((await activeGrants(registry))[0].caps.dailyDollars, 1);
  const raised = await E(directory).setLimits(agent.agentId, {
    idempotencyKey: 'raise-confirmed',
    limits: { dailyDollars: 3 },
    confirmed: true,
  });
  t.is(raised.limits.dailyDollars, 3);
});

test('a crash at each deletion boundary converges and usage rows remain', async t => {
  const run = async context => {
    const { directory, provider, factory } = context;
    const agent = await E(directory).create(createRequest(provider.providerId));
    const { inference } = await factory.endowmentFor(agent.agentId);
    await E(inference).request(turn());
    await E(directory).delete(agent.agentId, { idempotencyKey: 'delete-1' });
  };
  const boundaries = (await boundariesOf(run)).filter(name =>
    name.startsWith('delete'),
  );
  t.true(boundaries.includes('delete-committed'));
  t.true(boundaries.includes('delete-guest-effect'));
  for (const crashAt of [undefined, ...boundaries]) {
    const crashed = await setup({ crashAt });
    if (crashAt === undefined) {
      await run(crashed);
    } else {
      await t.throwsAsync(run(crashed), { message: /crash at/ });
    }
    const restarted = await boot(crashed.world);
    await restarted.factory.reconcile();
    const label = String(crashAt);
    const [record] = Object.values(restarted.factory.inspect().agents);
    if (crashAt === 'delete-intent') {
      t.is(record.lifecycle, 'deleted', label);
    }
    t.is(record.lifecycle, 'deleted', label);
    t.is(crashed.world.guestRecords.size, 0, label);
    t.is(crashed.world.responderRecords.size, 0, label);
    t.is((await activeGrants(restarted.registry)).length, 0, label);
    t.deepEqual(crashed.world.inventories.get(OWNER), {}, label);
    t.deepEqual(restarted.factory.inspect().names, {}, 'the name is free');
    const directory = await E(restarted.registry).directoryFor(OWNER);
    const usage = await E(directory).getUsage();
    t.is(usage.turns.length, 1, `usage survives deletion at ${label}`);
    t.is(usage.turns[0].agentId, record.agentId);
    await t.throwsAsync(
      E(await restarted.factory.inferenceFor(record.agentId)).request(turn()),
      refusalFor('agent-deleted'),
    );
  }
});

test('deleting frees the name and refuses further changes', async t => {
  const { directory, provider } = await setup();
  const agent = await E(directory).create(createRequest(provider.providerId));
  await E(directory).delete(agent.agentId, { idempotencyKey: 'delete-1' });
  await t.throwsAsync(
    E(directory).get(agent.agentId),
    refusalFor('agent-deleted'),
  );
  await t.throwsAsync(
    E(directory).setWake(agent.agentId, {
      idempotencyKey: 'wake-after',
      wake: false,
    }),
    refusalFor('agent-deleted'),
  );
  const again = await E(directory).create(
    createRequest(provider.providerId, { idempotencyKey: 'create-agent-2' }),
  );
  t.not(again.agentId, agent.agentId);
});

const setupReattach = async (options = {}) => {
  const context = await setup(options);
  const { registry, directory, provider } = context;
  const target = await addProvider(registry, OWNER, 'b', {
    limits: { concurrentTurns: 1, requestsPerMinute: 5, dailyDollars: 1 },
  });
  const agent = await E(directory).create(createRequest(provider.providerId));
  return { ...context, target, agent };
};

test('reattach options list only eligible providers with their effective limits', async t => {
  const { directory, registry, agent, target, provider } =
    await setupReattach();
  const retired = await addProvider(registry, OWNER, 'retired');
  const ownerDirectory = await E(registry).directoryFor(OWNER);
  await E(E(ownerDirectory).adminFor(retired.providerId)).retire('retire-1');
  await addProvider(registry, OTHER_OWNER, 'foreign');

  const options = await E(directory).reattachOptions(agent.agentId);
  t.deepEqual(
    options.map(({ providerId }) => providerId),
    [target.providerId],
  );
  t.false(options.some(({ providerId }) => providerId === provider.providerId));
  const [option] = options;
  t.like(option.effectiveLimits, {
    concurrentTurns: 1,
    requestsPerMinute: 5,
    dailyDollars: 1,
  });
  t.deepEqual(option.lowered, [
    { name: 'requestsPerMinute', from: 10, to: 5 },
    { name: 'dailyDollars', from: 2, to: 1 },
  ]);
});

test('a running turn finishes on the old provider while the next uses the new one', async t => {
  const { factory, directory, registry, agent, target, provider, world } =
    await setupReattach();
  const { inference } = await factory.endowmentFor(agent.agentId);
  const running = E(inference).request(turn('wait'));
  while (!world.events.some(([kind]) => kind === 'waiting')) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }

  const moved = await E(directory).reattach(agent.agentId, {
    idempotencyKey: 'reattach-1',
    providerId: target.providerId,
  });
  t.is(moved.providerId, target.providerId);
  t.is(moved.limits.dailyDollars, 1, 'limits are clamped to the new provider');
  t.is(moved.model, MODEL);

  // The reference the driver already holds now reaches the new provider.
  await E(inference).request(turn());
  const requests = world.events.filter(([kind]) => kind === 'request');
  t.deepEqual(requests.at(-1)?.slice(0, 2), ['request', target.providerId]);

  const operation = Object.values(factory.inspect().operations).find(
    ({ kind }) => kind === 'reattach',
  );
  t.is(operation.state, 'committed', 'the prior grant waits for its turn');
  const [, , finish] = world.events.find(([kind]) => kind === 'waiting');
  finish();
  const finished = await running;
  t.is(finished.status, 200, 'the running turn was not canceled');

  await factory.reconcile();
  const grants = await E(registry).listGrants();
  t.deepEqual(
    grants
      .map(({ providerId, state }) => [providerId, state])
      .sort((left, right) => left[1].localeCompare(right[1])),
    [
      [target.providerId, 'active'],
      [provider.providerId, 'revoked'],
    ],
  );
  const detail = await E(directory).get(agent.agentId);
  t.deepEqual(
    detail.usage.map(({ providerId, turns }) => [providerId, turns]).sort(),
    [
      [provider.providerId, 1],
      [target.providerId, 1],
    ].sort(),
    'usage stays attributed per provider',
  );
  t.is(
    Object.values(factory.inspect().operations).find(
      ({ kind }) => kind === 'reattach',
    ).state,
    'completed',
  );
});

test('a crash at each reattach boundary leaves one provider and one active grant', async t => {
  const reattach = ({ directory, agent, target }) =>
    E(directory).reattach(agent.agentId, {
      idempotencyKey: 'reattach-1',
      providerId: target.providerId,
    });
  const clean = await setupReattach();
  await reattach(clean);
  const boundaries = clean.boundaries.filter(name =>
    name.startsWith('reattach'),
  );
  t.true(boundaries.includes('reattach-committed'));
  for (const crashAt of boundaries) {
    const crashed = await setupReattach({ crashAt });
    await t.throwsAsync(reattach(crashed), { message: /crash at/ }, crashAt);
    const restarted = await boot(crashed.world);
    await restarted.factory.reconcile();
    const [record] = Object.values(restarted.factory.inspect().agents);
    const active = await activeGrants(restarted.registry);
    t.is(active.length, 1, crashAt);
    t.is(active[0].grantId, record.grantId, crashAt);
    t.is(active[0].providerId, record.providerId, crashAt);
    if (crashAt !== 'reattach-intent') {
      t.is(record.providerId, crashed.target.providerId, crashAt);
    }
    await E(restarted.factory.inferenceFor(record.agentId)).request(turn());
    t.is(crashed.world.guestRecords.size, 1, 'the guest is kept');
  }
});

test('a refused reattachment leaves the agent on its old provider', async t => {
  const { directory, agent, registry, world, provider, target } =
    await setupReattach();
  const foreign = await addProvider(registry, OTHER_OWNER, 'foreign');
  await t.throwsAsync(
    E(directory).reattach(agent.agentId, {
      idempotencyKey: 'reattach-foreign',
      providerId: foreign.providerId,
    }),
    refusalFor('provider-not-found'),
  );
  world.catalog.value = harden([{ id: 'claude-listed' }]);
  await t.throwsAsync(
    E(directory).reattach(agent.agentId, {
      idempotencyKey: 'reattach-model',
      providerId: target.providerId,
    }),
    refusalFor('model-not-available'),
  );
  world.catalog.value = undefined;
  const ownerDirectory = await E(registry).directoryFor(OWNER);
  await E(E(ownerDirectory).adminFor(target.providerId)).retire('retire-1');
  await t.throwsAsync(
    E(directory).reattach(agent.agentId, {
      idempotencyKey: 'reattach-retired',
      providerId: target.providerId,
    }),
    refusalFor('provider-not-found'),
  );
  const detail = await E(directory).get(agent.agentId);
  t.is(detail.providerId, provider.providerId);
  t.is((await activeGrants(registry)).length, 1);
});

test('the owner binding attaches the owner provider at creation, reattachment and restart', async t => {
  const { world, factory, registry, directory, provider, agent, target } =
    await setupReattach();
  t.is(factory.inspect().agents[agent.agentId].ownerId, OWNER);
  t.is(world.guestRecords.get(agent.agentId).provideCount, 1);
  await E(directory).reattach(agent.agentId, {
    idempotencyKey: 'reattach-1',
    providerId: target.providerId,
  });
  t.not(provider.providerId, target.providerId);
  const ownerBefore = factory.inspect().agents[agent.agentId].ownerId;
  t.is(ownerBefore, OWNER, 'reattachment never changes the binding');

  const restarted = await boot(world);
  await restarted.factory.reconcile();
  const after = await E(restarted.factory.directoryFor(OWNER)).get(
    agent.agentId,
  );
  t.is(after.providerId, target.providerId);
  await E(restarted.factory.inferenceFor(agent.agentId)).request(turn());
  t.is(restarted.factory.inspect().reports.length, 0);
  t.is((await activeGrants(registry)).length, 1);
});

test('another principal cannot see or change an owner agent', async t => {
  const { factory, agent } = await setupReattach();
  const other = factory.directoryFor(OTHER_OWNER);
  await t.throwsAsync(
    E(other).get(agent.agentId),
    refusalFor('agent-not-found'),
  );
  await t.throwsAsync(
    E(other).delete(agent.agentId, { idempotencyKey: 'stolen-delete' }),
    refusalFor('agent-not-found'),
  );
  t.deepEqual(await E(other).list(), []);
});

test('a foreign provider capability is refused at creation and reattachment before any effect', async t => {
  const { world, factory, registry, provider, agent } = await setupReattach();
  const foreign = await addProvider(registry, OTHER_OWNER, 'foreign');
  const foreignUse = await E(registry).useFor(OTHER_OWNER, foreign.providerId);
  const guestsBefore = world.guestRecords.size;
  await t.throwsAsync(
    factory.createWithUse(
      OWNER,
      createRequest(foreign.providerId, {
        idempotencyKey: 'create-foreign',
        name: 'foreign',
      }),
      foreignUse,
    ),
    refusalFor('provider-owner-mismatch'),
  );
  t.is(world.guestRecords.size, guestsBefore);
  await t.throwsAsync(
    factory.reattachWithUse(
      OWNER,
      agent.agentId,
      { idempotencyKey: 'reattach-foreign', providerId: foreign.providerId },
      foreignUse,
    ),
    refusalFor('provider-owner-mismatch'),
  );
  t.is(factory.inspect().agents[agent.agentId].providerId, provider.providerId);
  t.is(Object.keys(factory.inspect().agents).length, 1);

  const ownUse = await E(registry).useFor(OWNER, provider.providerId);
  const accepted = await factory.createWithUse(
    OWNER,
    createRequest(provider.providerId, {
      idempotencyKey: 'create-own',
      name: 'second',
    }),
    ownUse,
  );
  t.is(/** @type {any} */ (accepted).providerId, provider.providerId);
});

test('a provider capability authorizes only the provider it designates', async t => {
  const { world, factory, registry, provider, agent, target } =
    await setupReattach();
  const useA = await E(registry).useFor(OWNER, provider.providerId);
  const guestsBefore = world.guestRecords.size;
  await t.throwsAsync(
    factory.createWithUse(
      OWNER,
      createRequest(target.providerId, {
        idempotencyKey: 'create-sibling',
        name: 'sibling',
      }),
      useA,
    ),
    refusalFor('provider-use-mismatch'),
  );
  t.is(world.guestRecords.size, guestsBefore);
  await t.throwsAsync(
    factory.reattachWithUse(
      OWNER,
      agent.agentId,
      { idempotencyKey: 'reattach-sibling', providerId: target.providerId },
      useA,
    ),
    refusalFor('provider-use-mismatch'),
  );
  t.is(factory.inspect().agents[agent.agentId].providerId, provider.providerId);

  const useB = await E(registry).useFor(OWNER, target.providerId);
  await factory.reattachWithUse(
    OWNER,
    agent.agentId,
    { idempotencyKey: 'reattach-designated', providerId: target.providerId },
    useB,
  );
  t.is(factory.inspect().agents[agent.agentId].providerId, target.providerId);
});

test('a look-alike that describes a provider conveys no authority over it', async t => {
  const { factory, provider } = await setup();
  const forged = harden({
    describe: async () =>
      harden({ ownerId: OWNER, providerId: provider.providerId }),
  });
  await t.throwsAsync(
    factory.createWithUse(OWNER, createRequest(provider.providerId), forged),
    refusalFor('provider-use-mismatch'),
  );
  t.deepEqual(factory.inspect().operations, {});
});

test('a retry with its fields in another order is the same request', async t => {
  const { factory, directory, provider } = await setup();
  const limits = { concurrentTurns: 1, requestsPerMinute: 2 };
  const created = await E(directory).create(
    createRequest(provider.providerId, { limits }),
  );
  const { idempotencyKey, providerId, name, model, harness } = createRequest(
    provider.providerId,
  );
  const retried = await E(directory).create(
    harden({
      limits: { requestsPerMinute: 2, concurrentTurns: 1 },
      endowments: [],
      wake: true,
      harness,
      model,
      name,
      providerId,
      idempotencyKey,
    }),
  );
  t.is(retried.agentId, created.agentId);
  t.is(Object.keys(factory.inspect().agents).length, 1);

  await E(directory).setLimits(created.agentId, {
    idempotencyKey: 'limits-1',
    limits: { concurrentTurns: 1, requestsPerMinute: 1 },
  });
  await E(directory).setLimits(created.agentId, {
    limits: { requestsPerMinute: 1, concurrentTurns: 1 },
    idempotencyKey: 'limits-1',
  });
  await t.throwsAsync(
    E(directory).setLimits(created.agentId, {
      idempotencyKey: 'limits-1',
      limits: { concurrentTurns: 1, requestsPerMinute: 2 },
    }),
    refusalFor('idempotency-conflict'),
  );
});

test('a retry that spells an omitted field as undefined survives a restart', async t => {
  const { world, directory, agent, target } = await setupReattach();
  const asked = {
    idempotencyKey: 'reattach-1',
    providerId: target.providerId,
    model: undefined,
  };
  await E(directory).reattach(agent.agentId, harden(asked));
  const restarted = await boot(world);
  const summary = await E(restarted.factory.directoryFor(OWNER)).reattach(
    agent.agentId,
    harden({ idempotencyKey: 'reattach-1', providerId: target.providerId }),
  );
  t.is(summary.providerId, target.providerId);
});

test('nested type confusion in a creation request gets a fixed refusal', async t => {
  const { directory, provider, world } = await setup();
  for (const limits of [null, false, 0, '', []]) {
    await t.throwsAsync(
      E(directory).create(createRequest(provider.providerId, { limits })),
      refusalFor('invalid-agent-limits'),
      String(limits),
    );
  }
  for (const harnessConfig of [null, false, 'brokered-messages', []]) {
    await t.throwsAsync(
      E(directory).create(
        createRequest(provider.providerId, { harnessConfig }),
      ),
      refusalFor('invalid-harness-configuration'),
      String(harnessConfig),
    );
  }
  t.is(world.guestRecords.size, 0);
});

test('a prior grant survives reconciliation while its reattachment is unfinished', async t => {
  const crashed = await setupReattach({ crashAt: 'reattach-grant-effect' });
  const [{ grantId: priorGrantId }] = await activeGrants(crashed.registry);
  await t.throwsAsync(
    E(crashed.directory).reattach(crashed.agent.agentId, {
      idempotencyKey: 'reattach-1',
      providerId: crashed.target.providerId,
    }),
    { message: /crash at/ },
  );

  // The registry has fenced the prior grant, its checkpoint is lost, and replay
  // cannot advance: nothing yet records the operation as past its intent.
  const blocked = await boot(crashed.world, {
    wrapRegistry: registry =>
      harden({
        ...registry,
        directoryFor: () => {
          throw Error('registry unavailable');
        },
      }),
  });
  const { failures, revoked } = await blocked.factory.reconcile();
  t.is(failures.length, 1);
  t.deepEqual(revoked, []);
  const grants = await E(blocked.registry).listGrants();
  t.is(
    grants.find(({ grantId }) => grantId === priorGrantId)?.state,
    'reattached',
  );

  const recovered = await boot(crashed.world);
  await recovered.factory.reconcile();
  const [record] = Object.values(recovered.factory.inspect().agents);
  t.is(record.providerId, crashed.target.providerId);
  const after = await E(recovered.registry).listGrants();
  t.is(
    after.find(({ grantId }) => grantId === priorGrantId)?.state,
    'revoked',
  );
});

test('deleting an agent evicts its inference facet, which still refuses', async t => {
  const { factory, directory, provider } = await setup();
  const agent = await E(directory).create(createRequest(provider.providerId));
  const facet = factory.inferenceFor(agent.agentId);
  t.is(factory.inferenceFor(agent.agentId), facet, 'cached while live');
  await E(directory).delete(agent.agentId, { idempotencyKey: 'delete-1' });

  await t.throwsAsync(E(facet).request(turn()), refusalFor('agent-deleted'));
  const afterDelete = factory.inferenceFor(agent.agentId);
  t.not(afterDelete, facet, 'the deleted agent is not retained');
  t.not(factory.inferenceFor(agent.agentId), afterDelete, 'nor cached anew');
  await t.throwsAsync(
    E(afterDelete).request(turn()),
    refusalFor('agent-deleted'),
  );
});

test('recovery revokes and reports a grant recorded against another owner provider', async t => {
  const world = makeWorld();
  const tampered = new Set();
  const wrapRegistry = registry =>
    harden({
      ...registry,
      listGrants: async () =>
        harden(
          (await registry.listGrants()).map(grant =>
            tampered.has(grant.grantId)
              ? { ...grant, providerOwnerId: OTHER_OWNER }
              : grant,
          ),
        ),
    });
  const { registry, factory } = await boot(world, { wrapRegistry });
  const provider = await addProvider(registry, OWNER, 'a');
  const directory = factory.directoryFor(OWNER);
  const agent = await E(directory).create(createRequest(provider.providerId));
  const [grant] = await activeGrants(registry);
  tampered.add(grant.grantId);

  const { revoked } = await factory.reconcile();
  t.deepEqual(revoked, [grant.grantId]);
  const { reports } = factory.inspect();
  t.is(reports.length, 1);
  t.like(reports[0], {
    code: 'provider-owner-mismatch',
    agentId: agent.agentId,
    grantId: grant.grantId,
  });
  t.is(
    factory.inspect().agents[agent.agentId].ownerId,
    OWNER,
    'never repaired',
  );
  await t.throwsAsync(
    E(factory.inferenceFor(agent.agentId)).request(turn()),
    refusalFor('agent-deleted'),
  );
});

test('the reconciler revokes grant residue and never creates one', async t => {
  const { world, factory, directory, registry, provider } = await setup();
  const agent = await E(directory).create(createRequest(provider.providerId));
  await E(directory).delete(agent.agentId, { idempotencyKey: 'delete-1' });
  const countBefore = (await E(registry).listGrants()).length;
  await factory.reconcile();
  t.is((await E(registry).listGrants()).length, countBefore);
  t.is((await activeGrants(registry)).length, 0);
  t.is(world.responderRecords.size, 0);
});
