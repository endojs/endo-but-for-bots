// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

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
  const creates = [];
  const events = [];
  const replies = [];
  const dismissed = [];
  const sends = [];
  let mode = 'complete';
  let stopFails = false;
  let stopBarrier = Promise.resolve();
  let createBarrier = Promise.resolve();
  let createFails = false;
  let writeFails = false;
  let tools;
  const key = name => (Array.isArray(name) ? name.join('/') : name);
  const guestStore = new Map([['user', harden({})]]);
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
  const backend = Far('NetworkBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
        supportedNetworkPolicies: ['off', 'public-internet'],
        rebindableBindings: ['image', 'account', 'provider'],
      }),
    modelCatalog: () =>
      harden({
        accounts: [
          {
            subscriptionId: 'default',
            state: 'current',
            observedAt: 1,
            models: [
              {
                id: 'm',
                title: 'Model',
                description: '',
                default: true,
                defaultReasoningEffort: null,
                reasoningEfforts: [],
              },
            ],
          },
        ],
      }),
    create: async (spec, toolSet) => {
      tools = toolSet;
      creates.push(spec);
      const generation = creates.length;
      events.push(`create:${generation}:${spec.networkPolicy}`);
      await createBarrier;
      if (createFails) throw Error('backend unavailable');
      return harden({
        run: Far('NetworkRun', {
          send: async () => {
            sends.push(generation);
            const stream = makeBufferedReader();
            streams.push(stream);
            if (mode === 'hold') return stream.reader;
            if (mode === 'request') {
              await E(toolSet).execute(
                'requestNetworkPolicyChange',
                harden({
                  policy: 'public-internet',
                  reason: 'Fetch public documentation',
                }),
              );
            }
            stream.push({ type: 'text-delta', text: 'done' });
            stream.push({ type: 'end' });
            return stream.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => undefined,
        }),
        admin: Far('NetworkAdmin', {
          terminate: () => {
            events.push(`terminate:${generation}`);
          },
        }),
      });
    },
    destroy: () => undefined,
    stop: async () => {
      events.push('stop');
      for (const stream of streams)
        stream.push({ type: 'abort', reason: 'sandbox stopped' });
      await stopBarrier;
      if (stopFails) throw Error('native cleanup pending');
    },
  });
  const hostStore = new Map(
    /** @type {[string, unknown][]} */ ([
      ['session-agent-one', guest],
      ['codex-backend', backend],
      [
        'floot-private-turn-3-one-schema',
        harden({ version: 1, sessionId: 'one' }),
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
              presetId: 'general',
              lifecycle,
              ...(executionState ? { executionState } : {}),
              backendId: 'test',
              modelId: 'm',
            },
          ],
        }),
      ],
    ]),
  );
  const host = Far('NetworkHost', {
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    list: () => harden([...hostStore.keys()]),
    storeValue: (value, name) => {
      if (writeFails && name.startsWith('floot-sessions-v1-'))
        throw Error('registry write failed');
      hostStore.set(name, value);
    },
    remove: name => hostStore.delete(name),
    provideGuest: (_name, { agentName }) => {
      hostStore.set(agentName, guest);
    },
  });
  const factory = make(host);
  t.teardown(async () => {
    for (const stream of streams) stream.push({ type: 'end' });
    for (const inbox of inboxes) inbox.close();
    stopFails = false;
    writeFails = false;
    if ((await E(factory).listSessions()).some(entry => entry.id === 'one'))
      await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  await E(session).getTurns();
  if (!executionState) await until(() => inboxes.length > 0);
  return {
    session,
    factory,
    host,
    creates,
    events,
    sends,
    inboxes,
    replies,
    dismissed,
    setMode: value => {
      mode = value;
    },
    failStop: value => {
      stopFails = value;
    },
    blockStop: barrier => {
      stopBarrier = barrier;
    },
    blockCreate: barrier => {
      createBarrier = barrier;
    },
    failCreate: value => {
      createFails = value;
    },
    failWrite: value => {
      writeFails = value;
    },
    tools: () => tools,
    finish: () => {
      const stream = streams.at(-1);
      stream.push({ type: 'text-delta', text: 'completed held turn' });
      stream.push({ type: 'end' });
    },
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
  await t.throwsAsync(
    E(world.tools()).execute('getSandboxNetworkPolicy', harden({})),
    {
      message: /stopped or stopping/,
    },
  );
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
  const count = world.creates.length;
  await E(world.session).getHistory();
  await E(world.session).getTurns();
  t.is(world.creates.length, count);
  await t.throwsAsync(E(world.session).startTurn('still blocked'), {
    message: /stopped or stopping/,
  });
  await E(world.session).resume();
  t.is(world.creates.length, count + 1);
  t.is(world.sends.length, 1, 'resume does not replay a prompt');
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

test('stopped session revival reads records without creating a sandbox or inbox', async t => {
  const world = await makeWorld(t, { executionState: 'stopped' });
  await E(world.session).getHistory();
  await E(world.session).getTurns();
  t.is(world.creates.length, 0);
  t.is(world.inboxes.length, 0);
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  await E(session).getHistory();
  t.is(world.creates.length, 0);
  t.is(world.inboxes.length, 0);
  await E(session).resume();
  t.is(world.creates.length, 1);
  await E(session).emergencyStop();
});

test('incomplete stop is retried on factory revival without starting a sandbox', async t => {
  const world = await makeWorld(t);
  world.failStop(true);
  await t.throwsAsync(E(world.session).emergencyStop());
  world.failStop(false);
  const count = world.creates.length;
  const revived = make(world.host);
  const session = await E(revived).getSession('one');
  // Joining the recovered stop observes its completion, not a new incarnation.
  t.is((await E(session).emergencyStop()).state, 'stopped');
  t.is(world.creates.length, count);
});

test('emergency stop fences resume and reaps its late acquisition before completion', async t => {
  const world = await makeWorld(t, { executionState: 'stopped' });
  /** @type {() => void} */
  let release = () => {};
  const barrier = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  t.teardown(release);
  world.blockCreate(barrier);
  const resumed = E(world.session).resume();
  await until(() => world.creates.length === 1);
  const stopped = E(world.session).emergencyStop();
  await until(() => world.events.includes('stop'));
  t.is((await E(world.session).getExecutionState()).state, 'stopping');
  await t.throwsAsync(E(world.session).startTurn('must not run'), {
    message: /stopped or stopping/,
  });
  release();
  await resumed;
  t.is((await stopped).state, 'stopped');
  t.is(world.creates.length, 1);
  t.is(world.sends.length, 0);
  t.true(world.events.filter(event => event === 'stop').length >= 2);
});

test('creation records explicit initial network policy before provisioning', async t => {
  const world = await makeWorld(t);
  const before = world.creates.length;
  const session = await E(world.factory).createSession({
    backendId: 'test',
    modelId: 'm',
    networkPolicy: 'public-internet',
  });
  t.is((await E(session).getNetworkPolicy()).policy, 'public-internet');
  t.deepEqual(
    world.creates.slice(before).map(spec => spec.networkPolicy),
    ['public-internet'],
  );
  await E(session).emergencyStop();
  const count = (await E(world.factory).listSessions()).length;
  await t.throwsAsync(
    E(world.factory).createSession({
      backendId: 'test',
      modelId: 'm',
      networkPolicy: 'all',
    }),
    { message: /does not enforce/ },
  );
  t.is((await E(world.factory).listSessions()).length, count);
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
  t.deepEqual(
    world.creates.map(spec => spec.networkPolicy),
    ['off'],
  );
  const catalog = await E(world.tools()).describe();
  t.true(
    catalog.dynamicTools.some(
      tool => tool.name === 'requestNetworkPolicyChange',
    ),
  );
  t.false(
    catalog.dynamicTools.some(tool =>
      /^(setNetworkPolicy|resolveNetworkPolicyRequest|rebind)$/.test(tool.name),
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
  t.deepEqual(
    world.creates.map(spec => spec.networkPolicy),
    ['off', 'public-internet'],
  );
  t.true(
    world.events.indexOf('terminate:1') <
      world.events.indexOf('create:2:public-internet'),
  );
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
  t.deepEqual(world.events, ['create:1:off']);
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
  t.is(snapshot.type, 'snapshot');
  t.is(snapshot.network.policy, 'off');
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
  t.deepEqual((await view.next()).value.execution, {
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
  t.is((await list.next()).value.sessions[0].activity, 'passive');
  const view = iterateReader(await E(world.session).watch());
  const snapshot = (await view.next()).value;
  t.is(snapshot.running, null);
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
  world.blockCreate(
    new Promise(resolve => {
      release = () => resolve(undefined);
    }),
  );
  t.teardown(() => release());
  const changing = E(world.session)
    .setNetworkPolicy('public-internet')
    .catch(error => error);
  await until(
    () => world.events.includes('terminate:1') || world.creates.length > 1,
  );
  await E(world.session)
    .enqueue('sent during the change')
    .catch(() => undefined);
  release();
  await changing;
  // …and runs once the session admits work again, with nobody pressing Send.
  await until(() => world.sends.length >= 1);
  t.deepEqual((await E(world.session).listPending()).entries, []);
});

test('rebind stops the incarnation and reopens it under the named bindings, once', async t => {
  const world = await makeWorld(t);
  t.is(world.creates.length, 1);
  t.false('rebind' in world.creates[0]);
  t.deepEqual(await E(world.session).rebind(['image', 'provider']), {
    rebind: ['image', 'provider'],
  });
  // The old incarnation is stopped and released before the next is
  // provisioned, and only that provisioning carries the authorization.
  t.is(world.creates.length, 2);
  t.deepEqual(world.creates[1].rebind, ['image', 'provider']);
  const created = world.events.indexOf('create:2:off');
  t.true(world.events.indexOf('terminate:1') < created);
  t.true(world.events.indexOf('stop') < created);
  const turn = await E(world.session).startTurn('hello');
  await E(turn).whenFinished();
  t.deepEqual(world.sends, [2]);
  t.is(world.creates.length, 2, 'the authorization was spent');
  // A name this backend does not declare is refused before the incarnation
  // is touched, as is a list of the wrong size.
  await t.throwsAsync(E(world.session).rebind(['imgae']), {
    message: /rebind names the bindings a reopen may change/,
  });
  await t.throwsAsync(E(world.session).rebind(['persona']), {
    message: /from \["image","account","provider"\]/,
  });
  await t.throwsAsync(E(world.session).rebind([]), {
    message: /between one and eight/,
  });
  t.is(world.creates.length, 2);
  // A turn in flight refuses a rebind.
  world.setMode('hold');
  const held = await E(world.session).startTurn('held');
  await until(() => world.sends.length === 2);
  await t.throwsAsync(E(world.session).rebind(['image']), {
    message: /active turn/,
  });
  world.finish();
  await E(held).whenFinished();
  t.is(world.creates.length, 2);
});

test('a rebind the backend refuses leaves no authorization behind for a later reopen', async t => {
  const world = await makeWorld(t);
  world.failCreate(true);
  await t.throwsAsync(E(world.session).rebind(['image']), {
    message: /backend unavailable/,
  });
  world.failCreate(false);
  t.deepEqual(world.creates[1].rebind, ['image']);
  // The next reopen carries nothing: the verb's authorization was spent by
  // the request that failed, and would have been voided with the verb had
  // no request been built.
  const turn = await E(world.session).startTurn('hello');
  await E(turn).whenFinished();
  t.is(world.creates.length, 3);
  t.false('rebind' in world.creates[2]);
});

test('a rebind refused before the incarnation is touched leaves it running and nothing behind', async t => {
  const world = await makeWorld(t);
  const backend = await E(world.host).lookup('codex-backend');
  await E(world.host).remove('codex-backend');
  await t.throwsAsync(E(world.session).rebind(['image']), {
    message: /declares no rebindable bindings|unavailable/,
  });
  t.is(world.creates.length, 1, 'the incarnation was not replaced');
  await E(world.host).storeValue(backend, 'codex-backend');
  const turn = await E(world.session).startTurn('hello');
  await E(turn).whenFinished();
  t.deepEqual(world.sends, [1], 'the turn ran on the same incarnation');
  t.is(world.creates.length, 1);
});
