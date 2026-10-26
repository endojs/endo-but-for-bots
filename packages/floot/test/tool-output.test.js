// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';
import { boundToolOutput, MAX_TOOL_OUTPUT_CHARS } from '../src/tool-output.js';

for (const length of [0, MAX_TOOL_OUTPUT_CHARS - 1, MAX_TOOL_OUTPUT_CHARS]) {
  test(`tool output of ${length} characters is unchanged`, t => {
    const text = 'x'.repeat(length);
    t.is(boundToolOutput(text), text);
  });
}

test('cap includes notice, reports original size and preserves Unicode boundaries', t => {
  for (const text of [
    'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1),
    '😀'.repeat(100_000),
  ]) {
    const bounded = boundToolOutput(text);
    t.true(bounded.length <= MAX_TOOL_OUTPUT_CHARS);
    t.true(bounded.isWellFormed());
    t.true(bounded.includes(`truncated from ${text.length} characters`));
    t.regex(bounded, /filtering or pagination/);
  }
});

for (const kind of ['provider', 'hosted']) {
  for (const fails of [false, true]) {
    test(`${kind} bounds a 10 MB tool ${fails ? 'error' : 'result'} before journaling and the next model request`, async t => {
      t.timeout(5000);
      const values = new Map();
      const powers = harden({
        list: prefix => harden(prefix === 'tools' ? [] : [...values.keys()]),
        has: name => values.has(name),
        lookup: name => values.get(name),
        storeValue: (value, name) => {
          values.set(name, value);
        },
        remove: name => values.delete(name),
      });
      let effects = 0;
      const text = 'entry-0123456789\n'.repeat(640_000);
      const tool = harden({
        schema: () =>
          harden({
            type: 'function',
            function: {
              name: 'large',
              description: 'Return a large result',
              parameters: { type: 'object', properties: {} },
            },
          }),
        execute: () => {
          effects += 1;
          if (fails) throw Error(text);
          return text;
        },
        help: () => '',
      });
      let requests = 0;
      let seen = '';
      const provider = harden({
        chatStream: async messages => {
          requests += 1;
          if (requests === 1)
            return harden({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'large-call',
                    type: 'function',
                    function: { name: 'large', arguments: '{}' },
                  },
                ],
              },
            });
          seen = messages.findLast(message => message.role === 'tool')?.content;
          return harden({
            message: { role: 'assistant', content: 'continued' },
          });
        },
      });
      const backend =
        kind === 'provider'
          ? { kind, provideProvider: () => provider }
          : {
              kind,
              provideHostedClient: snapshot =>
                harden({
                  send: async () => {
                    requests += 1;
                    try {
                      seen = await snapshot.execute('large', harden({}));
                    } catch (error) {
                      seen = `Error: ${error.message}`;
                    }
                    const stream = makeBufferedReader();
                    stream.push(
                      harden({ type: 'text-delta', text: 'continued' }),
                    );
                    stream.push(harden({ type: 'end' }));
                    t.teardown(() => stream.close());
                    return stream.reader;
                  },
                }),
            };
      const agent = await makeStreamingAgent(
        powers,
        undefined,
        backend,
        'Test',
        {
          journalPowers: powers,
          extraTools: new Map([['large', tool]]),
        },
      );
      t.teardown(() => agent.shutdown());
      await agent.converse('run', makeReplyChannel().writer);
      t.is(effects, 1);
      t.is(requests, kind === 'provider' ? 2 : 1);
      t.true(seen.length <= MAX_TOOL_OUTPUT_CHARS);
      t.regex(seen, /Tool output truncated/);
      const outcome = [...values.values()].find(
        value => value.type === 'tool-result',
      );
      t.is(await agent.getTurnContent(outcome.resultRef), seen);
      t.is(outcome.failed, fails);
      t.is((await agent.getTurns())[0].state, 'completed');
      // A reconstructed agent reads exactly the bounded evidence; no tool replay.
      await agent.shutdown();
      const restored = await makeStreamingAgent(
        powers,
        undefined,
        backend,
        'Test',
        {
          journalPowers: powers,
          extraTools: new Map([['large', tool]]),
        },
      );
      t.teardown(() => restored.shutdown());
      t.deepEqual(await restored.getTurns(), await agent.getTurns());
      t.is(effects, 1);
    });
  }
}
