// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';
import { directoryHost } from './_directory-host.js';
import { makeTestInference } from './_inference.js';
import { makePromiseKit } from './_promise-kit.js';

const self = `endo://${'a'.repeat(64)}/${'b'.repeat(64)}?type=handle`;
const sender = `endo://${'a'.repeat(64)}/${'c'.repeat(64)}?type=handle`;
const until = async predicate => {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Timed out waiting for factory fixture');
};

/**
 * Typed rather than inferred: with only `= {}` to go on, TypeScript builds the
 * options type from the bindings that carry defaults, so `executionState` --
 * which has none -- is not a known property and every caller passing it is an
 * error.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ executionState?: string, lifecycle?: string }} [options]
 */
const makeWorld = async (t, { executionState, lifecycle = 'ready' } = {}) => {
  t.timeout(5000);
  const inboxes = [];
  const streams = [];
  const policies = [];
  const events = [];
  const replies = [];
  const dismissed = [];
  const sends = [];
  let mode = 'complete';
  let stopFails = false;
  let stopBarrier = Promise.resolve();
  let policyBarrier = Promise.resolve();
  let writeFails = false;
  let journalWriteFails = false;
  let poisonedCleanup = false;
  let storedExecutionState = executionState;
  let replyText = 'done';
  /** @type {(name: string) => Promise<void>} */
  let beforeLookup = () => Promise.resolve();
  let tools;
  const key = name => (Array.isArray(name) ? name.join('/') : name);
  const guestStore = new Map([
    ['user', harden({})],
    ['shell', Far('Shell')],
    ['workspace', Far('Git')],
  ]);
  const guest = Far('NetworkGuest', {
    has: name => guestStore.has(key(name)),
    lookup: name => guestStore.get(key(name)),
    storeValue: (value, name) => {
      guestStore.set(key(name), value);
    },
    remove: name => {
      guestStore.delete(key(name));
    },
    list: prefix => harden(prefix === 'tools' ? [] : [...guestStore.keys()]),
    locate: () => self,
    reverseLocate: () => harden([]),
    reply: (number, strings) => {
      replies.push({ number, strings });
    },
    dismiss: number => {
      dismissed.push(number);
    },
    followMessages: () => {
      const inbox = makeBufferedReader();
      inboxes.push(inbox);
      return inbox.reader;
    },
  });
  const inference = makeTestInference(body => {
    tools = body.tools;
    if (body.input.at(-1)?.type === 'function_call_output') return replyText;
    sends.push(inboxes.length);
    if (mode === 'hold') {
      const held = makePromiseKit();
      streams.push(held);
      return held.promise;
    }
    if (mode === 'request')
      return [
        {
          type: 'function_call',
          name: 'requestNetworkPolicyChange',
          call_id: `request-${sends.length}`,
          arguments: JSON.stringify({
            policy: 'public-internet',
            reason: 'Fetch public documentation',
          }),
        },
      ];
    return replyText;
  });
  const admin = Far('EnvironmentAdmin', {
    stop: async () => {
      events.push('stop');
      for (const held of streams) held.resolve('stopped');
      await stopBarrier;
      if (stopFails) throw Error('shell cleanup pending');
    },
    setNetworkPolicy: async policy => {
      policies.push(policy);
      await policyBarrier;
    },
    dispose: () => {},
  });
  const hostStore = new Map(
    /** @type {[string, unknown][]} */ ([
      ['floot-private-sessions/one/guest', guest],
      ['floot-private-sessions/one/handle', harden({})],
      ['floot-private-sessions/one/environment-admin', admin],
      [
        'floot-private-sessions/one/schema',
        harden({ version: 2, sessionId: 'one' }),
      ],
      [
        'floot-sessions-v1-00000000000000000000',
        harden({
          version: 1,
          sequence: 0n,
          sessions: [
            {
              id: 'one',
              title: 'One',
              createdAt: 1,
              systemPrompt: 'Captured fixture prompt.',
              presetId: 'voice',
              lifecycle,
              ...(executionState ? { executionState } : {}),
              backendId: 'fae-codex',
              inferenceRecipe: inference.recipe,
              modelId: 'm',
            },
          ],
        }),
      ],
    ]),
  );
  const host = Far('NetworkHost', {
    ...directoryHost(hostStore, {
      onLookup: name => beforeLookup(name),
      beforeStore: (value, name) => {
        if (writeFails && name.startsWith('floot-sessions-v1-'))
          throw Error('registry write failed');
        if (journalWriteFails && name.includes('/floot-turn-event-'))
          throw Error('journal write uncertain');
      },
      afterStore: (value, name) => {
        if (name.startsWith('floot-sessions-v1-')) {
          storedExecutionState = value.sessions.find(
            entry => entry.id === 'one',
          )?.executionState;
          events.push(
            `registry:${value.sessions.find(entry => entry.id === 'one')?.lifecycle || 'absent'}`,
          );
        }
      },
    }),
    provideGuest: (_name, { agentName: agentPath }) => {
      const agentName = agentPath.join('/');
      if (!hostStore.has(_name.join('/')))
        hostStore.set(_name.join('/'), harden({}));
      hostStore.set(agentName, guest);
    },
  });
  let disposalHook;
  let disposed = false;
  const factory = make(
    host,
    Far('NetworkFactoryContext', {
      addDisposalHook: hook => {
        disposalHook = hook;
      },
    }),
  );
  t.teardown(async () => {
    for (const stream of streams) stream.resolve('done');
    for (const inbox of inboxes) inbox.close();
    stopFails = false;
    writeFails = false;
    if (disposed) return;
    if ((await E(factory).listSessions()).some(entry => entry.id === 'one')) {
      if (poisonedCleanup) {
        let refused = false;
        try {
          await E(factory).deleteSession('one');
        } catch (error) {
          if (
            !/Private journal unavailable after uncertain storage/.test(
              `${error}`,
            )
          )
            throw error;
          refused = true;
        }
        if (!refused)
          throw Error('Poisoned fixture deletion unexpectedly succeeded');
      } else await E(factory).deleteSession('one');
    }
  });
  const session = await E(factory).getSession('one');
  await E(session).getTurns();
  if (!executionState) await until(() => inboxes.length > 0);
  return {
    session,
    factory,
    host,
    dispose: async () => {
      await factory;
      disposed = true;
      await E(disposalHook)();
    },
    storedExecutionState: () => storedExecutionState,
    policies,
    events,
    sends,
    inboxes,
    replies,
    dismissed,
    setMode: value => {
      mode = value;
    },
    setReply: value => {
      replyText = value;
    },
    beforeLookup: callback => {
      beforeLookup = callback;
    },
    failStop: value => {
      stopFails = value;
    },
    blockStop: barrier => {
      stopBarrier = barrier;
    },
    blockPolicy: barrier => {
      policyBarrier = barrier;
    },
    failWrite: value => {
      writeFails = value;
    },
    failJournalWrite: value => {
      journalWriteFails = value;
      poisonedCleanup = true;
    },
    tools: () => tools,
    finish: () => streams.at(-1).resolve('completed held turn'),
    mail: () => {
      inboxes.at(-1).push(
        harden({
          type: 'package',
          from: sender,
          to: self,
          number: 1n,
          messageId: 'in-1',
          done: true,
          strings: ['Mail-only work'],
          names: [],
          ids: [],
        }),
      );
    },
  };
};

test('ready session revival and observation stay dormant until a turn arrives', async t => {
  const world = await makeWorld(t);
  await E(world.session).getHistory();
  await E(world.session).getTurns();
  await E(world.session).getUsage();
  await E(world.session).getNetworkPolicy();
  t.deepEqual(world.policies, []);
  t.is(world.sends.length, 0);
  t.true(world.inboxes.length > 0, 'mail delivery remains available');
  world.mail();
  await until(() => world.dismissed.includes(1n));
  t.is(world.inboxes.length, 1);
  t.deepEqual(world.sends, [1]);
  t.is(world.replies.length, 1);
});

test('emergency stop fences active turns, waits for cleanup, and requires explicit resume', async t => {
  const world = await makeWorld(t);
  world.setMode('hold');
  const turn = await E(world.session).startTurn('held');
  await until(() => world.sends.length === 1);
  // The executor runs synchronously, so this is always replaced before use --
  // but only control flow TypeScript can follow counts, so start it callable.
  /** @type {(value?: any) => void} */
  let release = () => {};
  const barrier = new Promise(resolve => {
    release = resolve;
  });
  t.teardown(() => release());
  world.blockStop(barrier);
  let completed = false;
  const stopped = E(world.session)
    .emergencyStop()
    .then(value => {
      completed = true;
      return value;
    });
  await until(() => world.events.includes('stop'));
  t.false(completed);
  t.is((await E(world.session).getExecutionState()).state, 'stopping');
  await t.throwsAsync(E(world.session).startTurn('must not run'), {
    message: /stopped or stopping/,
  });
  await t.throwsAsync(E(world.session).resume(), {
    message: /Finish emergency stop/,
  });
  release();
  t.is((await stopped).state, 'stopped');
  await E(turn).whenFinished();
  const count = world.inboxes.length;
  await E(world.session).getHistory();
  await E(world.session).getTurns();
  t.is(world.inboxes.length, count);
  await t.throwsAsync(E(world.session).startTurn('still blocked'), {
    message: /stopped or stopping/,
  });
  await E(world.session).resume();
  t.is(world.inboxes.length, count + 1);
  t.is(world.sends.length, 1, 'resume does not replay a prompt');
});

test('resume drains retired journal reads and preserves history across repeated stops', async t => {
  const world = await makeWorld(t);
  const firstText = `${'Before stop '.repeat(900)}FIRST-END`;
  const secondText = `${'Before resume '.repeat(900)}SECOND-END`;
  world.setReply(firstText);
  await E(await E(world.session).startTurn('first')).whenFinished();
  world.setReply(secondText);
  await E(await E(world.session).startTurn('second')).whenFinished();
  await E(world.session).emergencyStop();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  let held = false;
  world.beforeLookup(name => {
    if (!held && name.includes('/floot-turn-content-')) {
      held = true;
      entered.resolve(undefined);
      return release.promise;
    }
    return Promise.resolve();
  });
  t.teardown(() => release.resolve(undefined));
  const oldHistory = E(world.session).getHistory();
  void oldHistory.catch(() => {});
  await entered.promise;
  let completed = false;
  const resumed = E(world.session)
    .resume()
    .then(value => {
      completed = true;
      return value;
    });
  void resumed.catch(() => {});
  // Observe the factory after resume admission without releasing the storage read.
  await E(world.session).getExecutionState();
  await t.throwsAsync(E(world.session).getTurns(), {
    message: /resum|stopped or stopping/i,
  });
  t.false(completed);
  t.is(world.inboxes.length, 1);
  release.resolve(undefined);
  await t.throwsAsync(oldHistory, {
    message: /Private journal incarnation is closed/,
  });
  await resumed;
  t.is(world.inboxes.length, 2);
  const history = await E(world.session).getHistory();
  t.deepEqual(
    history.filter(row => row.role === 'assistant').map(row => row.content),
    [firstText, secondText],
  );
  await E(await E(world.session).startTurn('after resume')).whenFinished();
  t.is((await E(world.session).getTurns()).at(-1).state, 'completed');
  await E(world.session).emergencyStop();
  await E(world.session).resume();
  t.is(world.inboxes.length, 3);
  t.deepEqual(
    (await E(world.session).getHistory()).slice(0, history.length),
    history,
  );
});

test('emergency stop supersedes resume while its journal closure drains', async t => {
  const world = await makeWorld(t);
  world.setReply('Retained response '.repeat(800));
  await E(await E(world.session).startTurn('first')).whenFinished();
  await E(await E(world.session).startTurn('second')).whenFinished();
  await E(world.session).emergencyStop();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  let held = false;
  world.beforeLookup(name => {
    if (!held && name.includes('/floot-turn-content-')) {
      held = true;
      entered.resolve(undefined);
      return release.promise;
    }
    return Promise.resolve();
  });
  t.teardown(() => release.resolve(undefined));
  const history = E(world.session).getHistory();
  void history.catch(() => {});
  await entered.promise;
  const resumed = E(world.session).resume();
  void resumed.catch(() => {});
  await E(world.session).getExecutionState();
  await t.throwsAsync(E(world.session).getTurns(), {
    message: /resum|stopped or stopping/i,
  });
  const stopped = E(world.session).emergencyStop();
  void stopped.catch(() => {});
  t.is((await stopped).state, 'stopped');
  // Start a successor while the old resume still waits on the same close.
  const successor = E(world.session).resume();
  void successor.catch(() => {});
  await E(world.session).getExecutionState();
  await t.throwsAsync(E(world.session).getTurns(), {
    message: /resum|stopped or stopping/i,
  });
  t.is(world.inboxes.length, 1);
  release.resolve(undefined);
  await t.throwsAsync(history, {
    message: /Private journal incarnation is closed/,
  });
  await t.throwsAsync(resumed, { message: /Resume superseded/ });
  await successor;
  t.is(world.inboxes.length, 2);
  t.is((await E(world.session).getTurns()).length, 2);
});

test('factory disposal fences resume while its journal closure drains', async t => {
  const world = await makeWorld(t);
  world.setReply('Retained response '.repeat(800));
  await E(await E(world.session).startTurn('first')).whenFinished();
  await E(await E(world.session).startTurn('second')).whenFinished();
  await E(world.session).emergencyStop();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  let held = false;
  world.beforeLookup(name => {
    if (!held && name.includes('/floot-turn-content-')) {
      held = true;
      entered.resolve(undefined);
      return release.promise;
    }
    return Promise.resolve();
  });
  t.teardown(() => release.resolve(undefined));
  const history = E(world.session).getHistory();
  void history.catch(() => {});
  await entered.promise;
  const resumed = E(world.session).resume();
  void resumed.catch(() => {});
  await E(world.session).getExecutionState();
  await t.throwsAsync(E(world.session).getTurns(), {
    message: /resum|stopped or stopping/i,
  });
  const disposed = world.dispose();
  void disposed.catch(() => {});
  await t.throwsAsync(E(world.factory).listSessions(), {
    message: /disposed|closed/i,
  });
  release.resolve(undefined);
  await t.throwsAsync(history, {
    message: /Private journal incarnation is closed/,
  });
  await t.throwsAsync(resumed, { message: /disposed|closed/i });
  const disposalError = await t.throwsAsync(disposed, {
    instanceOf: AggregateError,
    message: 'Floot factory disposal failed',
  });
  t.true(
    disposalError.errors.some(
      error =>
        error.message === 'Floot factory admitted work failed during disposal',
    ),
  );
  t.is(world.inboxes.length, 1);
  t.is(world.storedExecutionState(), 'stopped');
});

test('uncertain journal closure leaves resume stopped without new acquisition', async t => {
  const world = await makeWorld(t);
  world.failJournalWrite(true);
  const turn = await E(world.session).startTurn('fails before inference');
  await E(turn).whenFinished();
  world.failJournalWrite(false);
  t.truthy((await E(turn).getStatus()).error);
  await E(world.session).emergencyStop();
  await t.throwsAsync(E(world.session).resume(), {
    message: /Private journal unavailable after uncertain storage/,
  });
  t.is((await E(world.session).getExecutionState()).state, 'stopped');
  t.is(world.inboxes.length, 1);
  t.is(world.sends.length, 0);
  await t.throwsAsync(E(world.session).resume(), {
    message: /Private journal unavailable after uncertain storage/,
  });
  t.is((await E(world.session).getExecutionState()).state, 'stopped');
  t.is(world.inboxes.length, 1);
});

test('failed stop remains fenced and retryable without deleting records', async t => {
  const world = await makeWorld(t);
  world.failStop(true);
  await t.throwsAsync(E(world.session).emergencyStop(), {
    message: /stop incomplete/,
  });
  t.is((await E(world.session).getExecutionState()).state, 'stopping');
  t.is((await E(world.factory).listSessions()).length, 1);
  world.failStop(false);
  t.is((await E(world.session).emergencyStop()).state, 'stopped');
});

test('failed stop-intent persistence still withdraws native authority', async t => {
  const world = await makeWorld(t);
  world.failWrite(true);
  await t.throwsAsync(E(world.session).emergencyStop(), {
    message: /stop incomplete/,
  });
  t.true(world.events.includes('stop'));
  await t.throwsAsync(E(world.session).startTurn('blocked'), {
    message: /stopped or stopping/,
  });
  world.failWrite(false);
  t.is((await E(world.session).emergencyStop()).state, 'stopped');
});

test('stopped session revival reads records without opening an inbox', async t => {
  const world = await makeWorld(t, { executionState: 'stopped' });
  await E(world.session).getHistory();
  await E(world.session).getTurns();
  t.is(world.inboxes.length, 0);
  t.is(world.inboxes.length, 0);
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  await E(session).getHistory();
  t.is(world.inboxes.length, 0);
  t.is(world.inboxes.length, 0);
  await E(session).resume();
  t.is(world.inboxes.length, 1);
  await E(session).emergencyStop();
});

test('incomplete stop is retried on factory revival without reopening the agent', async t => {
  const world = await makeWorld(t);
  world.failStop(true);
  await t.throwsAsync(E(world.session).emergencyStop());
  world.failStop(false);
  const count = world.inboxes.length;
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  // Joining the recovered stop observes its completion, not a new incarnation.
  t.is((await E(session).emergencyStop()).state, 'stopped');
  t.is(world.inboxes.length, count);
});

test('fresh stopped factory resumes without a prior journal observer', async t => {
  const world = await makeWorld(t, { executionState: 'stopped' });
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  t.is(world.inboxes.length, 0);
  await E(session).resume();
  t.is(world.inboxes.length, 1);
  await E(await E(session).startTurn('fresh resume')).whenFinished();
  t.is((await E(session).getTurns()).at(-1).state, 'completed');
  await E(session).emergencyStop();
});

test('failed stopped-observer guest lookup retries without losing journal history', async t => {
  const world = await makeWorld(t);
  const reply = `${'Persisted before setup failure '.repeat(500)}RETAINED-END`;
  world.setReply(reply);
  await E(await E(world.session).startTurn('durable seed')).whenFinished();
  const before = await E(world.session).getHistory();
  await E(world.session).emergencyStop();
  let failGuestLookup = true;
  world.beforeLookup(name => {
    if (failGuestLookup && name === 'floot-private-sessions/one/guest')
      return Promise.reject(Error('guest lookup temporarily unavailable'));
    return Promise.resolve();
  });
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  await t.throwsAsync(E(session).getHistory(), {
    message: /guest lookup temporarily unavailable/,
  });
  t.is(world.inboxes.length, 1);
  failGuestLookup = false;
  t.deepEqual(await E(session).getHistory(), before);
  t.is(world.inboxes.length, 1, 'records-only retry never opens another inbox');
  await E(session).resume();
  await E(await E(session).startTurn('after setup retry')).whenFinished();
  t.is(world.inboxes.length, 2);
  t.is((await E(session).getTurns()).at(-1).state, 'completed');
  t.deepEqual((await E(session).getHistory()).slice(0, before.length), before);
  await E(session).emergencyStop();
});

test('failed resume publication stays fenced until explicit emergency stop', async t => {
  const world = await makeWorld(t, { executionState: 'stopped' });
  world.failWrite(true);
  await t.throwsAsync(E(world.session).resume(), {
    message: /registry write failed/,
  });
  t.is(world.inboxes.length, 0);
  await t.throwsAsync(E(world.session).resume(), {
    message: /Finish emergency stop/,
  });
  await t.throwsAsync(E(world.session).startTurn('blocked'), {
    message: /stopped or stopping/,
  });
  world.failWrite(false);
  await E(world.session).emergencyStop();
  await E(world.session).resume();
  t.is(world.inboxes.length, 1);
});

test('factory network request only asks; idle approval recreates policy and resumes mail', async t => {
  const world = await makeWorld(t);
  const { session } = world;
  t.is((await E(session).getNetworkPolicy()).policy, 'off');
  world.setMode('request');
  const turn = await E(session).startTurn('Request network');
  await E(turn).whenFinished();
  t.falsy((await E(turn).getStatus()).error);
  const requested = await E(session).getNetworkPolicy();
  t.is(requested.policy, 'off');
  t.like(requested.request, {
    policy: 'public-internet',
    reason: 'Fetch public documentation',
  });
  t.deepEqual(world.policies, []);
  t.true(
    world.tools().some(tool => tool.name === 'requestNetworkPolicyChange'),
  );
  t.false(
    world
      .tools()
      .some(tool =>
        /^(setNetworkPolicy|resolveNetworkPolicyRequest)$/.test(tool.name),
      ),
  );
  const beforeInboxes = world.inboxes.length;
  world.setMode('complete');
  await E(session).resolveNetworkPolicyRequest(
    requested.request.id,
    true,
    'Operator reviewed the documentation requirement',
  );
  t.is((await E(session).getNetworkPolicy()).policy, 'public-internet');
  t.deepEqual(world.policies, ['public-internet']);
  t.true(world.events.includes('stop'));
  await t.throwsAsync(
    E(session).resolveNetworkPolicyRequest(
      requested.request.id,
      true,
      'Stale approval',
    ),
    { message: /stale/i },
  );
  // No UI history read or turn is needed to reinstall the inbox pump.
  await until(() => world.inboxes.length > beforeInboxes);
  world.mail();
  await until(() => world.dismissed.includes(1n));
  t.deepEqual(
    world.sends,
    [1, 2],
    JSON.stringify(world.replies.map(reply => reply.strings)),
  );
  t.is(world.replies.length, 1);
});

test('factory refuses network changes during admitted UI and mail work', async t => {
  const world = await makeWorld(t);
  const { session } = world;
  world.setMode('request');
  const requestTurn = await E(session).startTurn('Request before held work');
  await E(requestTurn).whenFinished();
  const { request } = await E(session).getNetworkPolicy();
  world.setMode('hold');
  const uiTurn = await E(session).startTurn('Hold UI work');
  await until(() => world.sends.length === 2);
  await t.throwsAsync(E(session).setNetworkPolicy('public-internet'), {
    message: /active turn/,
  });
  await t.throwsAsync(
    E(session).resolveNetworkPolicyRequest(
      request.id,
      true,
      'Do not approve during UI work',
    ),
    { message: /active turn/ },
  );
  await t.throwsAsync(
    E(session).resolveNetworkPolicyRequest(
      request.id,
      false,
      'Do not decide during UI work',
    ),
    { message: /active turn/ },
  );
  t.is((await E(session).getNetworkPolicy()).policy, 'off');
  world.finish();
  await E(uiTurn).whenFinished();
  world.mail();
  await until(() => world.sends.length === 3);
  t.is(
    await E(session).getCurrentTurn(),
    null,
    'mail admission is not a UI turn slot',
  );
  await t.throwsAsync(E(session).setNetworkPolicy('public-internet'), {
    message: /work is active/,
  });
  await t.throwsAsync(
    E(session).resolveNetworkPolicyRequest(
      request.id,
      true,
      'Do not approve during mail work',
    ),
    { message: /work is active/ },
  );
  await t.throwsAsync(
    E(session).resolveNetworkPolicyRequest(
      request.id,
      false,
      'Do not decide during mail work',
    ),
    { message: /work is active/ },
  );
  t.is((await E(session).getNetworkPolicy()).policy, 'off');
  t.is((await E(session).getNetworkPolicy()).request.id, request.id);
  t.deepEqual(world.policies, [], 'no active turn changed shell policy');
  world.finish();
  await until(() => world.dismissed.includes(1n));
  await E(session).setNetworkPolicy('public-internet');
  t.is((await E(session).getNetworkPolicy()).policy, 'public-internet');
});

/**
 * Read a session view until an event of `type` arrives.
 *
 * @param {AsyncIterator<any>} view
 * @param {string} type
 */
const nextOfType = async (view, type) => {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await view.next();
    if (done) throw Error(`the view ended before a "${type}" event`);
    if (value.type === type) return value;
  }
};

test('a view hears a network request the model raised, without asking', async t => {
  const world = await makeWorld(t);
  const view = iterateReader(await E(world.session).watch());
  const snapshot = (await view.next()).value;
  t.like(snapshot, { type: 'snapshot', network: { policy: 'off' } });
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !('network' in snapshot) ||
    !snapshot.network ||
    typeof snapshot.network !== 'object'
  )
    throw Error('Expected network snapshot');
  t.false('request' in snapshot.network);
  world.setMode('request');
  const turn = await E(world.session).startTurn('look it up');
  const event = await nextOfType(view, 'network');
  t.is(event.network.request.policy, 'public-internet');
  t.is(event.network.request.reason, 'Fetch public documentation');
  await E(turn).whenFinished();
  await view.return();
});

test('a view hears an emergency stop and the resume that follows', async t => {
  const world = await makeWorld(t);
  const view = iterateReader(await E(world.session).watch());
  const snapshot = (await view.next()).value;
  if (!snapshot || typeof snapshot !== 'object' || !('execution' in snapshot))
    throw Error('Expected execution snapshot');
  t.deepEqual(snapshot.execution, {
    state: 'running',
    supported: true,
  });
  const stopped = E(world.session).emergencyStop();
  t.is((await nextOfType(view, 'execution')).execution.state, 'stopping');
  await stopped;
  t.is((await nextOfType(view, 'execution')).execution.state, 'stopped');
  await E(world.session).resume();
  t.is((await nextOfType(view, 'execution')).execution.state, 'running');
  await view.return();
});

test('a mail turn reaches a view: running, then the transcript it leaves', async t => {
  const world = await makeWorld(t);
  const list = iterateReader(await E(world.factory).watchSessions());
  const listed = (await list.next()).value;
  if (
    !listed ||
    typeof listed !== 'object' ||
    !('sessions' in listed) ||
    !Array.isArray(listed.sessions)
  )
    throw Error('Expected sessions snapshot');
  t.is(listed.sessions[0].activity, 'passive');
  const view = iterateReader(await E(world.session).watch());
  const snapshot = (await view.next()).value;
  t.like(snapshot, { running: null });
  world.mail();
  // No FlootTurn exists for a mail turn; `running` is how a view knows of it.
  const started = await nextOfType(view, 'running');
  t.is(started.running.input, 'Mail-only work');
  t.is(typeof started.running.from, 'string');
  t.is((await nextOfType(list, 'session')).session.activity, 'working');
  const transcript = await nextOfType(view, 'transcript');
  t.true(
    transcript.append.some(message => message.content === 'Mail-only work'),
  );
  t.is((await nextOfType(view, 'running')).running, null);
  t.is((await nextOfType(list, 'session')).session.activity, 'passive');
  await view.return();
  await list.return();
});

test('an emergency stop keeps the queue and holds it past the resume', async t => {
  const world = await makeWorld(t);
  world.setMode('hold');
  await E(world.session).enqueue('one');
  await until(() => world.sends.length === 1);
  await E(world.session).enqueue('two');
  await E(world.session).emergencyStop();
  // A stopped session takes nothing new…
  await t.throwsAsync(() => E(world.session).enqueue('three'), {
    message: /stopped or stopping/,
  });
  // …and keeps what it had, held.
  const stopped = await E(world.session).listPending();
  t.deepEqual(
    stopped.entries.map(entry => `${entry.text}:${entry.state}`),
    ['two:queued'],
  );
  t.is(stopped.hold.reason, 'stopped');
  await E(world.session).resume();
  await new Promise(resolve => setTimeout(resolve, 50));
  t.is(world.sends.length, 1, 'resume never replays a prompt, queued or not');
  t.is((await E(world.session).listPending()).hold.reason, 'stopped');
  // The user sends it.
  world.setMode('complete');
  await E(world.session).sendPending(stopped.entries[0].id);
  await until(() => world.sends.length === 2);
  t.deepEqual((await E(world.session).listPending()).entries, []);
});

test('a message that waited out a network change runs when it ends', async t => {
  const world = await makeWorld(t);
  // The change is under way when the message arrives, so it waits…
  let release = () => {};
  world.blockPolicy(
    new Promise(resolve => {
      release = () => resolve(undefined);
    }),
  );
  t.teardown(() => release());
  const changing = E(world.session)
    .setNetworkPolicy('public-internet')
    .catch(error => error);
  await until(() => world.policies.length > 0);
  await E(world.session)
    .enqueue('sent during the change')
    .catch(() => undefined);
  release();
  await changing;
  // …and runs once the session admits work again, with nobody pressing Send.
  await until(() => world.sends.length >= 1);
  t.deepEqual((await E(world.session).listPending()).entries, []);
});
