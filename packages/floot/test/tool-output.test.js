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
      /** @type {import('../src/runtime-config.js').RuntimeConfig} */
      const backend =
        kind === 'provider'
          ? { kind: 'provider', provideProvider: () => provider }
          : {
              kind: 'hosted',
              provideHostedClient: snapshot =>
                harden({
                  send: async () => {
                    requests += 1;
                    try {
                      seen = await snapshot.execute('large', harden({}));
                    } catch (error) {
                      seen = `Error: ${error instanceof Error ? error.message : String(error)}`;
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

for (const forceCompaction of [false, true]) {
  test(`image results survive journaling before compaction=${forceCompaction}`, async t => {
    const { encodeImageResult, decodeImageResult } =
      await import('@endo/hosted-agent/image-result.js');
    const image = encodeImageResult({
      mimeType: 'image/png',
      data: 'AAAA'.repeat(forceCompaction ? 699_050 : 20_000),
    });
    t.is(boundToolOutput(image), image);
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
    let reads = 0;
    let requests = 0;
    const seen = [];
    const tool = harden({
      schema: () =>
        harden({
          type: 'function',
          function: {
            name: 'screenshot',
            description: 'Read a rendered image',
            parameters: { type: 'object', properties: {} },
          },
        }),
      execute: () => {
        reads += 1;
        return image;
      },
      help: () => '',
    });
    const runtime =
      /** @type {import('../src/runtime-config.js').RuntimeConfig} */ ({
        kind: 'provider',
        provideProvider: () =>
          harden({
            chatStream: async messages => {
              requests += 1;
              if (requests === 1)
                return harden({
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'shot',
                        type: 'function',
                        function: { name: 'screenshot', arguments: '{}' },
                      },
                    ],
                  },
                });
              seen.push(
                messages.find(message => message.role === 'tool')?.content,
              );
              return harden({
                message: { role: 'assistant', content: 'inspected' },
              });
            },
          }),
      });
    const options = {
      forceCompaction,
      journalPowers: powers,
      extraTools: new Map([['screenshot', tool]]),
    };
    const agent = await makeStreamingAgent(
      powers,
      undefined,
      runtime,
      'Test',
      options,
    );
    t.teardown(() => agent.shutdown());
    await agent.converse('inspect', makeReplyChannel().writer);
    t.is(
      decodeImageResult(seen[0])?.data.length,
      forceCompaction ? 2_796_200 : 80_000,
    );
    t.false(JSON.stringify(await agent.getHistory()).includes('AAAA'));
    const event = [...values.values()].find(
      value => value.type === 'tool-result',
    );
    t.is(await agent.getTurnContent(event.resultRef), image);
    await agent.shutdown();
    const restored = await makeStreamingAgent(
      powers,
      undefined,
      runtime,
      'Test',
      options,
    );
    t.teardown(() => restored.shutdown());
    if (forceCompaction) return;
    await restored.converse('what did you see?', makeReplyChannel().writer);
    t.is(seen[1], image);
    t.is(reads, 1);
  });
}

test('provider image rejection recovers after restart without replaying rejected bytes', async t => {
  const { encodeImageResult, decodeImageResult } =
    await import('@endo/hosted-agent/image-result.js');
  const image = encodeImageResult({
    mimeType: 'image/png',
    data: 'AAAA'.repeat(20_000),
  });
  t.is(boundToolOutput(image), image);
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
  let reads = 0;
  let requests = 0;
  const seen = [];
  const tool = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'screenshot',
          description: 'Read a rendered image',
          parameters: { type: 'object', properties: {} },
        },
      }),
    execute: () => {
      reads += 1;
      return image;
    },
    help: () => '',
  });
  const runtime =
    /** @type {import('../src/runtime-config.js').RuntimeConfig} */ ({
      kind: 'provider',
      provideProvider: () =>
        harden({
          chatStream: async messages => {
            requests += 1;
            if (requests === 1)
              return harden({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'shot',
                      type: 'function',
                      function: { name: 'screenshot', arguments: '{}' },
                    },
                  ],
                },
              });
            seen.push(
              messages.find(message => message.role === 'tool')?.content,
            );
            if (requests === 2)
              throw Error('Provider rejected invalid image data');
            return harden({
              message: { role: 'assistant', content: 'inspected' },
            });
          },
        }),
    });
  const options = {
    journalPowers: powers,
    extraTools: new Map([['screenshot', tool]]),
  };
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    runtime,
    'Test',
    options,
  );
  t.teardown(() => agent.shutdown());
  await t.throwsAsync(agent.converse('inspect', makeReplyChannel().writer), {
    message: /rejected invalid image/,
  });
  t.is(decodeImageResult(seen[0])?.data.length, 80_000);
  t.false(JSON.stringify(await agent.getHistory()).includes('AAAA'));
  const event = [...values.values()].find(
    value => value.type === 'tool-result',
  );
  t.is(await agent.getTurnContent(event.resultRef), image);
  await agent.shutdown();
  const restored = await makeStreamingAgent(
    powers,
    undefined,
    runtime,
    'Test',
    options,
  );
  t.teardown(() => restored.shutdown());
  await restored.converse('what did you see?', makeReplyChannel().writer);
  t.is(decodeImageResult(seen[1]), undefined);
  t.regex(seen[1], /Not replayed after an incomplete turn/);
  t.false(seen[1].includes('AAAA'));
  t.is(await restored.getTurnContent(event.resultRef), image);
  t.is(reads, 1);
});
