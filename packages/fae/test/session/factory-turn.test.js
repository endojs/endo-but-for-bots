// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { make } from '../../session-factory.js';
import { makeTestInference } from './_inference.js';
import { makePromiseKit } from './_promise-kit.js';
import { directoryHost } from './_directory-host.js';

test('factory facets retain disconnected turns, commit history, and provision delegation tools', async t => {
  t.timeout(5000);
  const inbox = makeBufferedReader();

  const store = new Map();
  store.set('user', harden({}));
  const handoffs = [];
  store.set(
    'dev-review',
    Far('DevReviewConnection', {
      start: options => {
        handoffs.push(options);
        return harden({ runId: 'review-run' });
      },
    }),
  );
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
  const request = makePromiseKit();
  const response = makePromiseKit();
  const argumentsText = JSON.stringify({
    name: 'design',
    title: 'Design',
    design: 'Agreed acceptance criteria',
    base: 'main',
    rounds: '2',
  });
  let round = 0;
  const inference = makeTestInference(async body => {
    round += 1;
    if (round === 1) {
      request.resolve(body);
      await response.promise;
      return [
        {
          type: 'function_call',
          name: 'handoffDesign',
          call_id: 'call-1',
          arguments: argumentsText,
        },
      ];
    }
    return 'hello back';
  });
  /** @type {Map<string, unknown>} */
  const hostStore = new Map();
  for (const sessionId of ['one']) {
    hostStore.set(
      `floot-private-sessions/${sessionId}/schema`,
      harden({ version: 2, sessionId }),
    );
  }
  hostStore.set(
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
          presetId: 'general',
          lifecycle: 'ready',
          backendId: 'fae-codex',
          inferenceRecipe: inference.recipe,
          modelId: 'm',
        },
      ],
    }),
  );
  const lookups = [];
  hostStore.set('codex-inference', inference.subscription);
  hostStore.set('codex-model-catalog', inference.catalog);
  const host = Far('TestHost', {
    ...directoryHost(hostStore),
    lookup: (...names) => {
      lookups.push(names.flat().join('/'));
      return hostStore.get(names.flat().join('/'));
    },
    provideGuest: (_name, { agentName: agentPath }) => {
      const agentName = agentPath.join('/');
      if (!hostStore.has(_name.join('/')))
        hostStore.set(_name.join('/'), harden({}));
      hostStore.set(agentName, guest);
    },
    remove: (...path) => {
      hostStore.delete(path.join('/'));
    },
  });
  const factory = make(host);
  t.teardown(async () => {
    response.resolve();
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
  const { tools } = await request.promise;
  t.true(tools.some(tool => tool.name === 'spawnSubagent'));
  t.true(tools.some(tool => tool.name === 'handoffDesign'));
  response.resolve();
  await E(turn).whenFinished();
  t.deepEqual(handoffs, [
    {
      requestId: 'design',
      params: {
        title: 'Design',
        summary: 'Agreed acceptance criteria',
        base: 'main',
        rounds: 2n,
      },
    },
  ]);
  t.deepEqual(store.get('review-design'), { runId: 'review-run' });
  t.is(await E(session).getCurrentTurn(), null);
  t.false(lookups.some(name => name.endsWith('-backend')));
  const history = await E(session).getHistory();
  t.is(history[0].content, 'hello');
  t.like(
    history.find(message => message.role === 'tool'),
    {
      name: 'handoffDesign',
      args: argumentsText,
      failed: false,
    },
  );
  t.is(history.at(-1).content, 'hello back');
});
