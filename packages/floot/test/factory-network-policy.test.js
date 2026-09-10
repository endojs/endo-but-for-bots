// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
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

const makeWorld = async t => {
  t.timeout(5000);
  const inboxes = [];
  const streams = [];
  const creates = [];
  const events = [];
  const replies = [];
  const dismissed = [];
  const sends = [];
  let mode = 'complete';
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
      }),
    listModels: () => harden([{ id: 'm', title: 'Model' }]),
    create: (spec, toolSet) => {
      tools = toolSet;
      creates.push(spec);
      const generation = creates.length;
      events.push(`create:${generation}:${spec.networkPolicy}`);
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
  });
  const hostStore = new Map(
    /** @type {[string, unknown][]} */ ([
      ['session-agent-one', guest],
      ['codex-backend', backend],
      [
        'floot-sessions',
        harden([
          {
            id: 'one',
            title: 'One',
            createdAt: 1,
            presetId: 'general',
            lifecycle: 'ready',
            backendId: 'test',
            modelId: 'm',
          },
        ]),
      ],
    ]),
  );
  const host = Far('NetworkHost', {
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    list: () => harden([...hostStore.keys()]),
    storeValue: (value, name) => {
      hostStore.set(name, value);
    },
    remove: name => hostStore.delete(name),
    provideGuest: () => undefined,
  });
  const factory = make(host);
  t.teardown(async () => {
    for (const stream of streams) stream.push({ type: 'end' });
    for (const inbox of inboxes) inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  await E(session).getTurns();
  await E(session).resolveTurn(
    'legacy-import',
    'Fixture legacy evidence checked',
  );
  await until(() => inboxes.length > 0);
  return {
    session,
    creates,
    events,
    sends,
    inboxes,
    replies,
    dismissed,
    setMode: value => {
      mode = value;
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
