// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { makeSubscriptionResponsesProvider } from '@endo/lal/providers/index.js';
import { setImmediate } from 'node:timers/promises';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

test('owned provider shutdown waits for admitted tool evidence', async t => {
  t.timeout(5000);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let effects = 0;
  let requests = 0;
  let revoked = 0;
  let closed = false;
  const subscription = Far('Pool', {
    describe: () => harden({ models: ['luna'] }),
    openEndpoint: () =>
      Far('Endpoint', {
        revoke() {
          revoked += 1;
        },
        requestByteStream() {
          requests += 1;
          const output = [
            { type: 'reasoning', encrypted_content: 'opaque' },
            {
              type: 'function_call',
              call_id: 'native-call',
              name: 'effect',
              arguments: '{}',
            },
          ];
          const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
          );
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
          });
        },
      }),
  });
  const provider = makeSubscriptionResponsesProvider({
    subscription,
    model: 'luna',
    sessionId: 'shutdown-evidence',
  });
  const store = new Map();
  const powers = harden({
    list: prefix => harden(prefix === 'tools' ? [] : [...store.keys()]),
    has: name => store.has(name),
    lookup: name => {
      if (!store.has(name)) throw Error('Not found');
      return store.get(name);
    },
    remove: name => store.delete(name),
    async storeValue(value, name) {
      // Gate the effect outcome, not the transcript projection.
      if (value.type === 'tool-result') {
        entered.resolve(undefined);
        await gate.promise;
      }
      if (store.has(name)) throw Error('No overwrite');
      store.set(name, value);
    },
  });
  const effect = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'effect',
          description: 'Effect',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute() {
      effects += 1;
      return 'performed';
    },
    help: () => '',
  });
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    {
      kind: 'provider',
      providerFormat: 'responses-output-v1',
      provideProvider: () => provider,
      disposeProvider: () => provider.dispose(),
    },
    'Test',
    { journalPowers: powers, extraTools: new Map([['effect', effect]]) },
  );
  t.teardown(async () => {
    gate.resolve(undefined);
    await agent.shutdown();
  });
  const running = agent.converse('seed', makeReplyChannel().writer);
  await entered.promise;
  const closing = agent.shutdown().then(() => {
    closed = true;
  });
  await setImmediate();
  t.false(closed);
  t.is(effects, 1);
  gate.resolve(undefined);
  await Promise.all([running, closing]);
  t.is(requests, 1);
  t.is(revoked, 1);
  t.is((await agent.getTurns())[0].state, 'cancelled');
  t.true(
    (await agent.getTranscript()).some(
      r => r.kind === 'tool-result' && r.content === 'performed',
    ),
  );
});

for (const cleanupFails of [false, true]) {
  test(`development cancellation drains native stop and quarantines cleanup failure (${cleanupFails})`, async t => {
    t.timeout(5000);
    const toolEntered = Promise.withResolvers();
    const toolReleased = Promise.withResolvers();
    const stopEntered = Promise.withResolvers();
    const stopReleased = Promise.withResolvers();
    const store = new Map();
    const powers = harden({
      list: prefix => harden(prefix === 'tools' ? [] : [...store.keys()]),
      has: name => store.has(name),
      lookup: name => store.get(name),
      remove: name => store.delete(name),
      storeValue: (value, name) => {
        store.set(name, value);
      },
    });
    const tool = harden({
      schema: () =>
        harden({
          type: 'function',
          function: {
            name: 'effect',
            description: 'Test',
            parameters: { type: 'object', properties: {} },
          },
        }),
      execute: async () => {
        toolEntered.resolve();
        await toolReleased.promise;
        return 'stopped';
      },
      help: () => '',
    });
    let requests = 0;
    const provider = harden({
      chatStream: async () => {
        requests += 1;
        return harden({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call',
                type: 'function',
                function: { name: 'effect', arguments: '{}' },
              },
            ],
          },
        });
      },
    });
    const agent = await makeStreamingAgent(
      powers,
      undefined,
      { kind: 'provider', provideProvider: () => provider },
      'Test',
      {
        journalPowers: powers,
        extraTools: new Map([['effect', tool]]),
        stopEnvironment: async () => {
          stopEntered.resolve();
          toolReleased.resolve();
          await stopReleased.promise;
          if (cleanupFails) throw Error('Stop acknowledgement refused');
        },
      },
    );
    t.teardown(async () => {
      stopReleased.resolve();
      toolReleased.resolve();
      await agent.shutdown(true);
    });
    const abort = new AbortController();
    let finished = false;
    const running = agent
      .converse('run', makeReplyChannel().writer, undefined, abort.signal)
      .finally(() => {
        finished = true;
      });
    await toolEntered.promise;
    abort.abort();
    await stopEntered.promise;
    await setImmediate();
    t.false(finished);
    stopReleased.resolve();
    await running.catch(() => {});
    t.is(requests, 1);
    t.is(
      (await agent.getTurns())[0].state,
      cleanupFails ? 'outcome-unknown' : 'cancelled',
    );
    if (cleanupFails) {
      await t.throwsAsync(agent.converse('retry', makeReplyChannel().writer), {
        message: /cleanup remains pending/,
      });
      t.is(requests, 1);
    }
  });
}
