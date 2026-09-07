// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../agent.js';

test('factory facets retain disconnected turns, commit history, and provision delegation tools', async t => {
  t.timeout(5000);
  const inbox = makeBufferedReader();
  const backendEvents = makeBufferedReader();
  const store = new Map();
  store.set('user', harden({}));
  const guest = Far('TestGuest', {
    has: name => store.has(name),
    lookup: name => store.get(name),
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
    list: prefix => harden(prefix === 'tools' ? [] : [...store.keys()]),
    locate: () => 'test-locator',
    followMessages: () => inbox.reader,
  });
  let dispatched = false;
  let releaseAck = () => {};
  const ackBarrier = new Promise(resolve => {
    releaseAck = () => resolve(undefined);
  });
  let signalAck = () => {};
  const ackStarted = new Promise(resolve => {
    signalAck = () => resolve(undefined);
  });
  t.teardown(releaseAck);
  /** @type {{ dynamicTools: Array<{ name: string }> } | undefined} */
  let catalog;
  const backend = Far('TestBackend', {
    describe: () =>
      harden({
        id: 'test',
        title: 'Test',
        kind: 'hosted',
        continuity: 'explicit',
        toolOwnership: 'endo',
      }),
    create: async (options, toolSet) => {
      catalog = await E(toolSet).describe();
      return harden({
        run: Far('TestRun', {
          send: () => {
            dispatched = true;
            return backendEvents.reader;
          },
          interrupt: () => undefined,
          acknowledge: () => {
            signalAck();
            return ackBarrier;
          },
        }),
        admin: Far('TestAdmin', { terminate: () => undefined }),
      });
    },
    destroy: () => undefined,
  });
  /** @type {Map<string, unknown>} */
  const hostStore = new Map();
  hostStore.set(
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
  );
  hostStore.set('codex-backend', backend);
  hostStore.set('session-agent-one', guest);
  const host = Far('TestHost', {
    list: () => harden([...hostStore.keys()]),
    has: name => hostStore.has(name),
    lookup: name => hostStore.get(name),
    provideGuest: () => undefined,
    storeValue: (value, name) => {
      hostStore.set(name, value);
    },
    remove: name => {
      hostStore.delete(name);
    },
  });
  const factory = make(host);
  t.teardown(async () => {
    backendEvents.push(harden({ type: 'end' }));
    inbox.close();
    await E(factory).deleteSession('one');
  });
  const session = await E(factory).getSession('one');
  const turn = await E(session).startTurn('hello');
  const view = iterateReader(await E(turn).watch());
  await view.next();
  await view.return();
  const rediscovered = await E(
    await E(factory).getSession('one'),
  ).getCurrentTurn();
  t.is(rediscovered.turn, turn);
  t.is(rediscovered.input, 'hello');
  await t.throwsAsync(() => E(session).startTurn('overlap'), {
    message: /active turn/,
  });
  for (let tries = 0; !dispatched && tries < 1000; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.true(dispatched);
  if (!catalog) throw Error('Hosted catalog was not supplied');
  t.true(catalog.dynamicTools.some(tool => tool.name === 'spawnSubagent'));
  backendEvents.push(harden({ type: 'text-delta', text: 'hello back' }));
  backendEvents.push(harden({ type: 'end', checkpoint: 'committed' }));
  await ackStarted;
  t.false((await E(turn).getStatus()).done);
  t.is((await E(session).getHistory()).length, 2);
  t.deepEqual(await (await E(session).getCurrentTurn()).history, []);
  releaseAck();
  await E(turn).whenFinished();
  t.is(await E(session).getCurrentTurn(), null);
  t.deepEqual(await E(session).getHistory(), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hello back' },
  ]);
});
