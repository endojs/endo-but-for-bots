// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import {
  makeDelegatedRunner,
  normalizeRunnerLimits,
  runnerSessionId,
} from '../src/delegated-runner.js';

const makeStore = () => {
  /** @type {any[]} */
  const written = [];
  return {
    written,
    read: async () => written[written.length - 1],
    write: async record => {
      written.push(record);
    },
  };
};

/** A backend factory beneath, recording what reaches it. */
const makeBeneath = () => {
  /** @type {any[]} */
  const calls = [];
  const state = {
    failCreate: '',
    failDestroy: false,
    bounded: false,
    /** @type {Promise<void> | undefined} */
    hang: undefined,
    stopped: new Set(),
  };
  const factory = Far('beneath', {
    describe: async () =>
      harden({
        id: 'codex',
        title: 'Codex',
        kind: 'hosted',
        continuity: 'opaque-reconciled',
        toolOwnership: 'endo',
        providerId: 'codex',
        subscriptions: [{ id: 'work', label: 'Work' }],
        supportedNetworkPolicies: ['off', 'public-internet'],
        ...(state.bounded ? { enforcesStorageBound: true } : {}),
      }),
    listModels: async () => harden([{ id: 'small' }, { id: 'large' }]),
    create: async (spec, toolSet) => {
      calls.push({ verb: 'create', spec, toolSet });
      if (state.hang) await state.hang;
      if (state.failCreate) throw Error(state.failCreate);
      return harden({
        run: Far('run', {
          send: async (prompt, options) => {
            calls.push({ verb: 'send', id: spec.sessionId, prompt, options });
            if (state.stopped.has(spec.sessionId)) throw Error('stopped');
            return 'a turn';
          },
          models: async () => harden([{ id: 'small' }, { id: 'large' }]),
          interrupt: async () => {},
          acknowledge: async () => {},
          status: async () => harden({ state: 'idle' }),
        }),
        admin: Far('admin', { terminate: async () => {} }),
      });
    },
    stop: async spec => {
      calls.push({ verb: 'stop', spec });
      state.stopped.add(spec.sessionId);
    },
    destroy: async spec => {
      calls.push({ verb: 'destroy', spec });
      if (state.failDestroy) throw Error('cleanup pending at /var/lib/endo/x');
    },
  });
  return { factory, calls, state };
};

const tools = Far('HostedToolSet', {});

/**
 * @param {object} [options]
 * @param options.runnerId
 * @param options.limits
 * @param options.store
 * @param options.beneath
 */
const makeHarness = ({
  runnerId = 'alice',
  limits = {},
  store = makeStore(),
  beneath = makeBeneath(),
  ...rest
} = {}) => {
  const state = {
    now: Date.parse('2026-09-20T00:00:00Z'),
    limits: {
      subscription: 'lane-alice',
      maxSessions: 2,
      storage: 'unbounded',
      ...limits,
    },
  };
  /** @type {string[]} */
  const logged = [];
  const kit = makeDelegatedRunner({
    runnerId,
    provideFactory: async () => beneath.factory,
    provideLimits: async () => state.limits,
    journal: store,
    now: () => state.now,
    log: (...args) => logged.push(args.join(' ')),
    ...rest,
  });
  return { ...kit, beneath, store, state, logged };
};

test('limits are validated, and storage is said one way or the other', t => {
  t.deepEqual(
    normalizeRunnerLimits({
      subscription: 'lane',
      maxSessions: 3,
      storage: { maxSessionBytes: 1_000_000, other: 1 },
      models: ['small'],
      expiresAt: '2026-10-01T00:00:00Z',
      anything: 'else',
    }),
    {
      subscription: 'lane',
      maxSessions: 3,
      networkPolicies: ['off'],
      models: ['small'],
      storage: { maxSessionBytes: 1_000_000 },
      expiresAt: '2026-10-01T00:00:00.000Z',
    },
  );
  for (const bad of [
    null,
    {},
    { subscription: 'auto', maxSessions: 1, storage: 'unbounded' },
    { subscription: 'lane', maxSessions: 0, storage: 'unbounded' },
    { subscription: 'lane', maxSessions: 1 },
    { subscription: 'lane', maxSessions: 1, storage: {} },
    {
      subscription: 'lane',
      maxSessions: 1,
      storage: 'unbounded',
      networkPolicies: ['lan'],
    },
    // `off` is what a session gets by default, so it is always allowed.
    {
      subscription: 'lane',
      maxSessions: 1,
      storage: 'unbounded',
      networkPolicies: ['public-internet'],
    },
    { subscription: 'lane', maxSessions: 1, storage: 'unbounded', models: [] },
  ]) {
    t.throws(() => normalizeRunnerLimits(bad));
  }
});

test('no two runners’ session names coincide, whatever ids their holders choose', t => {
  t.is(runnerSessionId('alice', 's1'), 'r-alice-s1');
  // A runner id has no dash, so `a` + `b-x` and `a-b` + `x` cannot meet.
  t.throws(() => runnerSessionId('a-b', 'x'));
  t.throws(() => makeHarness({ runnerId: 'alice-2' }));
  t.not(runnerSessionId('a', 'b-x'), runnerSessionId('a_b', 'x'));
  const long = runnerSessionId('alice', 'x'.repeat(128));
  t.true(long.length <= 128);
  t.regex(long, /^r-alice-h[0-9a-f]{48}$/);
  // Another runner cannot spell that either: its names begin `r-<its id>-`.
  t.false(
    runnerSessionId('bob', long.slice('r-alice-'.length)).startsWith(
      'r-alice-',
    ),
  );
});

test('a session is the runner’s own, pinned to its subscription, with no network and nothing of the host', async t => {
  const { factory, beneath } = makeHarness();
  await E(factory).create(
    harden({
      sessionId: 's1',
      model: 'small',
      reasoningEffort: 'low',
      systemPrompt: 'be brief',
    }),
    tools,
  );
  t.deepEqual(beneath.calls[0].spec, {
    sessionId: 'r-alice-s1',
    model: 'small',
    reasoningEffort: 'low',
    systemPrompt: 'be brief',
    networkPolicy: 'off',
    subscription: 'lane-alice',
  });
  t.is(beneath.calls[0].toolSet, tools, 'the holder’s own tools');
  // What a holder may not name, or may not make huge or strange.
  for (const [extra, message] of [
    [{ workspaceHostPath: '/home/operator' }, /does not take that/],
    [{ containerMounts: [{ hostPath: '/etc' }] }, /does not take that/],
    [{ accountRef: 'x' }, /does not take that/],
    [{ cwd: '/' }, /work in \/workspace/],
    [{ subscription: 'work' }, /chooses the subscription/],
    [
      { networkPolicy: 'public-internet' },
      /does not allow that network policy/,
    ],
    [{ networkPolicy: 7 }, /does not allow that network policy/],
    [{ model: { id: 'small' } }, /Invalid session model/],
    [{ reasoningEffort: 'x'.repeat(200) }, /Invalid session reasoning effort/],
    [{ systemPrompt: 'x'.repeat(300_000) }, /Invalid session system prompt/],
    [{ systemPrompt: 7 }, /Invalid session system prompt/],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(factory).create(harden({ sessionId: 's2', ...extra }), tools),
      { message },
    );
  }
  t.is(beneath.calls.length, 1);
});

test('the descriptor is the runner’s own: its id, no pinning, its policies, and nothing a backend adds later', async t => {
  const { factory } = makeHarness();
  t.deepEqual(await E(factory).describe(), {
    id: 'codex-alice',
    title: 'Codex (alice)',
    kind: 'hosted',
    continuity: 'opaque-reconciled',
    toolOwnership: 'endo',
    supportedNetworkPolicies: ['off'],
  });
});

test('stop and destroy reach only this runner’s sessions', async t => {
  const { factory, beneath } = makeHarness();
  await E(factory).create(harden({ sessionId: 's1' }), tools);
  // The operator's own session id, or another runner's, maps into this
  // runner's names and is not one of its sessions.
  for (const sessionId of ['operators-session', 'r-bob-s1', 'r-alice-s1']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(factory).stop(harden({ sessionId })), {
      message: /Not a session of this runner/,
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(factory).destroy(harden({ sessionId })), {
      message: /Not a session of this runner/,
    });
  }
  await E(factory).stop(harden({ sessionId: 's1' }));
  t.deepEqual(beneath.calls.at(-1), {
    verb: 'stop',
    spec: { sessionId: 'r-alice-s1' },
  });
});

test('two runners over one backend cannot reach each other’s sessions', async t => {
  const beneath = makeBeneath();
  const alice = makeHarness({ runnerId: 'alice', beneath });
  const bob = makeHarness({
    runnerId: 'bob',
    beneath,
    limits: { subscription: 'lane-bob' },
  });
  await E(alice.factory).create(harden({ sessionId: 'x' }), tools);
  // Whatever bob calls its session, it is created under bob's name, pinned
  // to bob's lane, and never stops or takes over alice's.
  for (const sessionId of ['x', 'r-alice-x', 'alice-x']) {
    // eslint-disable-next-line no-await-in-loop
    await E(bob.factory)
      .create(harden({ sessionId }), tools)
      .catch(() => {});
  }
  const created = beneath.calls.filter(call => call.verb === 'create');
  t.deepEqual(
    created.filter(call => call.spec.sessionId === 'r-alice-x').length,
    1,
  );
  t.true(
    created
      .slice(1)
      .every(
        call =>
          call.spec.sessionId.startsWith('r-bob-') &&
          call.spec.subscription === 'lane-bob',
      ),
  );
});

test('the allowance is durable: a restart neither forgets sessions nor frees their slots', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const first = makeHarness({ store, beneath });
  await E(first.factory).create(harden({ sessionId: 's1' }), tools);
  await E(first.factory).create(harden({ sessionId: 's2' }), tools);
  await t.throwsAsync(
    () => E(first.factory).create(harden({ sessionId: 's3' }), tools),
    { message: /no free session slot/ },
  );
  // Creating one that exists again is not a new slot (a session is revived
  // by creating it again).
  await E(first.factory).create(harden({ sessionId: 's1' }), tools);

  const revived = makeHarness({ store, beneath });
  await t.throwsAsync(
    () => E(revived.factory).create(harden({ sessionId: 's3' }), tools),
    { message: /no free session slot/ },
  );
  await E(revived.factory).destroy(harden({ sessionId: 's2' }));
  await E(revived.factory).create(harden({ sessionId: 's3' }), tools);
  t.deepEqual((await E(revived.admin).getStatus()).sessions, [
    'r-alice-s1',
    'r-alice-s3',
  ]);
});

test('two sessions created together cannot both take the last slot', async t => {
  const { factory } = makeHarness({ limits: { maxSessions: 1 } });
  const results = await Promise.allSettled([
    E(factory).create(harden({ sessionId: 'a' }), tools),
    E(factory).create(harden({ sessionId: 'b' }), tools),
  ]);
  t.deepEqual(results.map(result => result.status).sort(), [
    'fulfilled',
    'rejected',
  ]);
});

test('a creation that fails gives its slot back once what was made is removed, and what went wrong beneath is not repeated', async t => {
  const { factory, admin, beneath, logged } = makeHarness({
    limits: { maxSessions: 1 },
  });
  beneath.state.failCreate = 'EACCES: mkdir /var/lib/endo/private/r-alice-a';
  const error = await t.throwsAsync(() =>
    E(factory).create(harden({ sessionId: 'a' }), tools),
  );
  t.is(error.message, 'Runner unavailable');
  t.true(
    logged.some(line => line.includes('/var/lib/endo')),
    'said to the operator',
  );
  t.deepEqual((await E(admin).getStatus()).sessions, []);
  // Cleanup beneath is pending: the slot stays taken until a destroy works.
  beneath.state.failDestroy = true;
  await t.throwsAsync(() =>
    E(factory).create(harden({ sessionId: 'b' }), tools),
  );
  t.deepEqual((await E(admin).getStatus()).sessions, ['r-alice-b']);
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 'c' }), tools),
    {
      message: /no free session slot/,
    },
  );
  const pending = await t.throwsAsync(() =>
    E(factory).destroy(harden({ sessionId: 'b' })),
  );
  t.is(pending.message, 'Runner unavailable');
  beneath.state.failDestroy = false;
  await E(factory).destroy(harden({ sessionId: 'b' }));
  t.deepEqual((await E(admin).getStatus()).sessions, []);
});

test('revoking takes effect at once: turns of sessions made earlier are refused, and nothing is destroyed', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const { factory, admin } = makeHarness({ store, beneath });
  const session = await E(factory).create(harden({ sessionId: 's1' }), tools);
  t.is(await E(session.run).send('hello'), 'a turn');
  t.deepEqual(await E(admin).revoke(), {
    stopped: ['r-alice-s1'],
    notStopped: [],
  });
  t.false(beneath.calls.some(call => call.verb === 'destroy'));
  const sends = beneath.calls.filter(call => call.verb === 'send').length;
  await t.throwsAsync(() => E(session.run).send('again'), {
    message: 'Runner revoked',
  });
  t.is(beneath.calls.filter(call => call.verb === 'send').length, sends);
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 's1' }), tools),
    { message: 'Runner revoked' },
  );
  // A holder's Floot asks every backend it knows at once: a runner that is
  // over still says what it is, and offers nothing to start.
  t.is((await E(factory).describe()).id, 'codex-alice');
  t.deepEqual(await E(factory).listModels(), []);
  // After a restart too.
  const revived = makeHarness({ store, beneath });
  await t.throwsAsync(
    () => E(revived.factory).create(harden({ sessionId: 's9' }), tools),
    { message: 'Runner revoked' },
  );
  t.true((await E(revived.admin).getStatus()).revoked);
  // The holder can still clear away its own.
  await E(revived.factory).destroy(harden({ sessionId: 's1' }));
});

test('a holder whose tool set never answers holds up its own create, and not a revocation', async t => {
  const beneath = makeBeneath();
  const { factory, admin } = makeHarness({
    beneath,
    beneathDeadlineMs: 150,
    stopDeadlineMs: 50,
  });
  const live = await E(factory).create(harden({ sessionId: 'live' }), tools);
  beneath.state.hang = new Promise(() => {});
  const hung = E(factory).create(harden({ sessionId: 'hung' }), tools);
  void hung.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20));
  // The operator withdraws the runner while that create is still out.
  const started = Date.now();
  const outcome = await E(admin).revoke();
  t.true(Date.now() - started < 1000, 'revoke did not wait for the holder');
  t.true(outcome.stopped.includes('r-alice-live'));
  await t.throwsAsync(() => E(live.run).send('more'), {
    message: 'Runner revoked',
  });
  await t.throwsAsync(() => hung, { message: /Runner (unavailable|revoked)/ });
});

test('an expired runner refuses turns on sessions it made, and stops them itself', async t => {
  const { factory, beneath, state, close } = makeHarness({
    limits: { expiresAt: '2026-09-20T00:00:00.200Z' },
  });
  const session = await E(factory).create(harden({ sessionId: 's1' }), tools);
  t.is(await E(session.run).send('hello'), 'a turn');
  state.now += 300;
  await t.throwsAsync(() => E(session.run).send('again'), {
    message: 'Runner revoked',
  });
  // Nobody asked: the runner's own timer stops what was running.
  await new Promise(resolve => setTimeout(resolve, 350));
  t.true(beneath.calls.some(call => call.verb === 'stop'));
  close();
});

test('models are the operator’s allowlist, in a session’s spec and on every turn', async t => {
  const { factory } = makeHarness({ limits: { models: ['small'] } });
  t.deepEqual(await E(factory).listModels(), [{ id: 'small' }]);
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 's', model: 'large' }), tools),
    { message: /does not allow that model/ },
  );
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 's' }), tools),
    {
      message: /needs a model named/,
    },
  );
  const session = await E(factory).create(
    harden({ sessionId: 's', model: 'small' }),
    tools,
  );
  t.deepEqual(await E(session.run).models(), [{ id: 'small' }]);
  await t.throwsAsync(
    () => E(session.run).send('hi', harden({ model: 'large' })),
    {
      message: /does not allow that model/,
    },
  );
  t.is(await E(session.run).send('hi', harden({ model: 'small' })), 'a turn');
});

test('a storage bound needs a backend that enforces one', async t => {
  const { factory, beneath } = makeHarness({
    limits: { storage: { maxSessionBytes: 5_000_000 } },
  });
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 't' }), tools),
    {
      message: /cannot bound a session’s storage/,
    },
  );
  beneath.state.bounded = true;
  await E(factory).create(harden({ sessionId: 't' }), tools);
  t.is(beneath.calls.at(-1).spec.storageBoundBytes, 5_000_000);
});

test('a second kit’s revocation reaches the first', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const first = makeHarness({ store, beneath });
  const session = await E(first.factory).create(
    harden({ sessionId: 's1' }),
    tools,
  );
  const second = makeHarness({ store, beneath });
  await E(second.admin).revoke();
  // The first kit's memory is stale for a few seconds at most.
  first.state.now += 6000;
  await t.throwsAsync(() => E(session.run).send('more'), {
    message: 'Runner revoked',
  });
});

test('a destroy and a create of one id, sent together, never leave a live session the runner does not count', async t => {
  // A backend shaped like Codex's: something awaited, then one queue per id.
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();
  const live = new Set();
  const inOrder = (id, operation) => {
    const result = (queues.get(id) ?? Promise.resolve()).then(operation);
    queues.set(
      id,
      result.catch(() => {}),
    );
    return result;
  };
  const beneath = makeBeneath();
  const factory = Far('queued beneath', {
    describe: () => E(beneath.factory).describe(),
    listModels: () => E(beneath.factory).listModels(),
    create: async (spec, toolSet) => {
      await null;
      return inOrder(spec.sessionId, async () => {
        if (spec.model === 'bogus') throw Error('Unknown model');
        live.add(spec.sessionId);
        return E(beneath.factory).create(spec, toolSet);
      });
    },
    stop: async spec => inOrder(spec.sessionId, async () => {}),
    destroy: async spec =>
      inOrder(spec.sessionId, async () => {
        live.delete(spec.sessionId);
      }),
  });
  const store = makeStore();
  const { factory: runner, admin } = makeDelegatedRunner({
    runnerId: 'alice',
    provideFactory: async () => factory,
    provideLimits: async () => ({
      subscription: 'lane-alice',
      maxSessions: 1,
      storage: 'unbounded',
    }),
    journal: store,
    log: () => {},
  });
  for (let round = 0; round < 4; round += 1) {
    const sessionId = `x${round}`;
    // eslint-disable-next-line no-await-in-loop
    await E(runner)
      .create(harden({ sessionId }), tools)
      .catch(() => {});
    // Back to back: the destroy's slot must not be given back under a
    // create that then succeeds.
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled([
      E(runner).destroy(harden({ sessionId })),
      E(runner).create(harden({ sessionId }), tools),
    ]);
    // And a create that fails beside one that succeeds.
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled([
      E(runner).create(
        harden({ sessionId: `y${round}`, model: 'bogus' }),
        tools,
      ),
      E(runner).create(harden({ sessionId: `y${round}` }), tools),
    ]);
    // eslint-disable-next-line no-await-in-loop
    const { sessions } = await E(admin).getStatus();
    t.deepEqual(
      [...live].sort(),
      [...sessions].sort(),
      'what is live beneath is what the runner counts',
    );
    t.true(sessions.length <= 1, 'and never more than its allowance');
    for (const counted of sessions) {
      // eslint-disable-next-line no-await-in-loop
      await E(runner).destroy(
        harden({ sessionId: counted.slice('r-alice-'.length) }),
      );
    }
  }
});

test('a create that ran out of time keeps its slot: it may yet complete beneath', async t => {
  const beneath = makeBeneath();
  const { factory, admin } = makeHarness({
    beneath,
    limits: { maxSessions: 1 },
    beneathDeadlineMs: 40,
    stopDeadlineMs: 40,
  });
  beneath.state.hang = new Promise(() => {});
  await t.throwsAsync(
    () => E(factory).create(harden({ sessionId: 'slow' }), tools),
    {
      message: 'Runner unavailable',
    },
  );
  t.false(beneath.calls.some(call => call.verb === 'destroy'));
  t.deepEqual((await E(admin).getStatus()).sessions, ['r-alice-slow']);
});

test('a revocation that cannot be written still stops what runs, and says so', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const { factory, admin } = makeHarness({
    store,
    beneath,
    stopDeadlineMs: 100,
  });
  const session = await E(factory).create(harden({ sessionId: 's1' }), tools);
  store.write = async () => {
    throw Error('store is down');
  };
  await t.throwsAsync(() => E(admin).revoke(), {
    message: /could not be written/,
  });
  t.true(beneath.calls.some(call => call.verb === 'stop'));
  await t.throwsAsync(() => E(session.run).send('more'), {
    message: 'Runner revoked',
  });
});

test('a revived runner stops its sessions at expiry without anybody calling it', async t => {
  const store = makeStore();
  const beneath = makeBeneath();
  const first = makeHarness({ store, beneath });
  await E(first.factory).create(harden({ sessionId: 's1' }), tools);
  first.close();
  // The daemon restarts with the session restored and an expiry just ahead.
  const revived = makeHarness({
    store,
    beneath,
    limits: { expiresAt: '2026-09-20T00:00:00.100Z' },
  });
  revived.state.now += 50;
  await new Promise(resolve => setTimeout(resolve, 60));
  revived.state.now += 100;
  await new Promise(resolve => setTimeout(resolve, 120));
  t.true(beneath.calls.some(call => call.verb === 'stop'));
  revived.close();
});

test('a turn’s options are checked like a session’s spec', async t => {
  const { factory, beneath } = makeHarness();
  const session = await E(factory).create(harden({ sessionId: 's' }), tools);
  for (const [options, message] of [
    [{ developerInstructions: 'x' }, /does not take that in a turn/],
    [{ systemPrompt: 'x'.repeat(300_000) }, /Invalid session system prompt/],
    [{ reasoningEffort: 'x'.repeat(100) }, /Invalid session reasoning effort/],
    [{ model: 'not a model' }, /Invalid session model/],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(session.run).send('hi', harden(options)), {
      message,
    });
  }
  t.is(
    await E(session.run).send(
      'hi',
      harden({
        model: 'small',
        reasoningEffort: 'low',
        systemPrompt: 'be brief',
        acknowledgedCheckpoint: 'c1',
        transcript: [],
      }),
    ),
    'a turn',
  );
  t.is(beneath.calls.filter(call => call.verb === 'send').length, 1);
});
