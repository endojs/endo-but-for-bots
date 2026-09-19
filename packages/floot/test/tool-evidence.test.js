// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';
import { sameToolArgs, sameToolResult } from '../src/tool-evidence.js';

test('the same arguments are the same however they were written down', t => {
  // The tree keeps the provider's string; the journal re-serializes it.
  t.true(
    sameToolArgs(
      { text: '{"code": "return 1;"}' },
      { text: '{"code":"return 1;"}' },
    ),
  );
  t.true(
    sameToolArgs(
      { text: '{ "a": 1,\n  "b": [1, 2] }' },
      { text: '{"a":1,"b":[1,2]}' },
    ),
  );
  // Escapes are JSON's business too.
  t.true(
    sameToolArgs({ text: '{"s":"caf\\u00e9"}' }, { text: '{"s":"café"}' }),
  );
  // Different arguments are different.
  t.false(
    sameToolArgs(
      { text: '{"code":"return 1;"}' },
      { text: '{"code":"return 2;"}' },
    ),
  );
  t.false(sameToolArgs({ text: '{"a":1}' }, { text: '{"a":1,"b":2}' }));
  // Whitespace inside a string value is content, not spacing.
  t.false(sameToolArgs({ text: '{"code":"a b"}' }, { text: '{"code":"ab"}' }));
  t.false(sameToolArgs({ text: '{}' }, { text: undefined }));
  // Arguments that never parsed were run, and journaled, as `{}`.
  t.true(sameToolArgs({ text: '{"code": "return 1;' }, { text: '{}' }));
  t.true(sameToolArgs({ text: '' }, { text: '{}' }));
  t.false(sameToolArgs({ text: '{"code": "return 1;' }, { text: '{"a":1}' }));
  t.false(sameToolArgs({ text: 'not json' }, { text: 'also not json' }));
});

test('a preview matches the whole it was cut from, and nothing else', t => {
  const whole = JSON.stringify({ code: `const html = '${'x'.repeat(200)}';` });
  const spaced = whole.replace('{"code":', '{"code": ');
  const preview = whole.slice(0, 64);
  t.true(sameToolArgs({ text: spaced }, { text: preview, cut: true }));
  t.true(sameToolArgs({ text: preview, cut: true }, { text: spaced }));
  t.false(
    sameToolArgs(
      { text: spaced.replace('const html', 'const page') },
      { text: preview, cut: true },
    ),
  );
  // Two previews of one call differ only in JSON's spacing; spacing inside a
  // value is code, and Python or YAML would not survive losing it.
  const indented = `{"code": "if a:\\n  b = 1\\n${'z'.repeat(100)}`;
  const compact = indented.replace('{"code": ', '{"code":');
  t.true(
    sameToolArgs(
      { text: indented.slice(0, 80), cut: true },
      { text: compact.slice(0, 80), cut: true },
    ),
  );
  t.false(
    sameToolArgs(
      { text: indented.slice(0, 80), cut: true },
      {
        text: compact.replace('if a:\\n  b', 'if a:\\nb').slice(0, 80),
        cut: true,
      },
    ),
  );
  // A preview of the string as it arrived, against the whole as JSON writes it.
  t.true(
    sameToolArgs({ text: spaced.slice(0, 64), cut: true }, { text: whole }),
  );
  // A whole that is shorter than the preview was not cut from it.
  t.false(sameToolArgs({ text: '{"code":"x"}' }, { text: preview, cut: true }));
  // Without the mark, a prefix is just a shorter, different string.
  t.false(sameToolArgs({ text: spaced }, { text: preview }));

  t.true(sameToolResult({ text: 'abcdef' }, { text: 'abc', cut: true }));
  t.false(sameToolResult({ text: 'abcdef' }, { text: 'abd', cut: true }));
  // A preview is a prefix of the whole, never the other way round.
  t.false(sameToolResult({ text: 'ab' }, { text: 'abc', cut: true }));
  t.false(sameToolResult({ text: 'abcdef' }, { text: 'abc' }));
  t.true(sameToolResult({ text: 'same' }, { text: 'same' }));
});

const makeFakePowers = () => {
  const store = new Map();
  const nameOf = petName =>
    Array.isArray(petName) ? petName.join('.') : petName;
  return harden({
    async storeValue(value, petName) {
      store.set(nameOf(petName), value);
    },
    async lookup(petName) {
      const name = nameOf(petName);
      if (!store.has(name)) throw Error(`not found: ${name}`);
      return store.get(name);
    },
    async has(petName) {
      return store.has(nameOf(petName));
    },
    async remove(petName) {
      store.delete(nameOf(petName));
    },
    async list() {
      return harden([...store.keys()]);
    },
    async followMessages() {
      return harden({ [Symbol.asyncIterator]: () => harden({}) });
    },
  });
};

/**
 * @param {any} agent
 * @param {string} text
 */
const say = async (agent, text) => {
  const { writer, reader } = makeReplyChannel();
  const events = (async () => {
    const collected = [];
    for await (const event of iterateReader(reader)) collected.push(event);
    return collected;
  })();
  await agent.converse(text, writer);
  return events;
};

test('a completed turn shows each tool call once, however the provider wrote it', async t => {
  // What OpenRouter's free models actually sent: a space after the colon in
  // most calls, none in others, and one argument far longer than the journal
  // keeps inline. Each of the spaced or long ones used to appear twice.
  const long = `return '${'y'.repeat(20_000)}'.length;`;
  const scripted = [
    `{"code": "return 1 + 1;"}`,
    `{"code":"return 2 + 2;"}`,
    `{"code": ${JSON.stringify(long)}}`,
  ];
  let round = 0;
  const provider = harden({
    chatStream: async () => {
      const args = scripted[round];
      round += 1;
      if (args === undefined) {
        return harden({ message: { role: 'assistant', content: 'Done.' } });
      }
      return harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${round}`,
              type: 'function',
              function: { name: 'exec', arguments: args },
            },
          ],
        },
        servedBy: { model: `vendor/model-${round}:free`, provider: 'Host' },
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  });
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider },
    'test prompt',
  );
  await say(agent, 'do three things');
  const history = await agent.getHistory();
  const tools = history.filter(message => message.role === 'tool');
  t.is(
    tools.length,
    3,
    JSON.stringify(tools.map(tool => `${tool.args}`.slice(0, 40))),
  );
  t.is(history.at(-1)?.content, 'Done.');
  // The turn records which models served it.
  const [turn] = await agent.getTurns();
  t.deepEqual(turn.servedBy, [
    'vendor/model-1:free via Host',
    'vendor/model-2:free via Host',
    'vendor/model-3:free via Host',
  ]);
});

test('a failed turn’s tokens are counted, and it records what served it', async t => {
  let round = 0;
  const provider = harden({
    chatStream: async () => {
      round += 1;
      if (round === 1) {
        return harden({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'exec', arguments: '{"code": "return 1;"}' },
              },
            ],
          },
          servedBy: { model: 'vendor/first:free' },
          usage: { inputTokens: 100, outputTokens: 7 },
        });
      }
      throw Error(
        'OpenRouter returned no successful assistant message (finish_reason error), after 3 attempts',
      );
    },
  });
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider },
    'test prompt',
  );
  await t.throwsAsync(say(agent, 'fail on the second round'));
  const [turn] = await agent.getTurns();
  t.is(turn.state, 'failed');
  t.deepEqual(turn.servedBy, ['vendor/first:free']);
  // Spent is spent: the session's usage includes the turn that failed.
  t.like(await agent.getUsage(), {
    inputTokens: 100,
    outputTokens: 7,
    turns: 0,
    incompleteTurns: 1,
  });
});

test('a call whose arguments never parsed is still shown once', async t => {
  // A free model's truncated JSON, and no arguments at all. Both run as `{}`,
  // which is what the journal records; the tree keeps what was sent.
  const scripted = ['{"code": "return 1;', ''];
  let round = 0;
  const provider = harden({
    chatStream: async () => {
      const args = scripted[round];
      round += 1;
      if (args === undefined) {
        return harden({ message: { role: 'assistant', content: 'Done.' } });
      }
      return harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${round}`,
              type: 'function',
              function: { name: 'list', arguments: args },
            },
          ],
        },
      });
    },
  });
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider },
    'test prompt',
  );
  await say(agent, 'two malformed calls');
  const tools = (await agent.getHistory()).filter(
    message => message.role === 'tool',
  );
  t.is(tools.length, 2, JSON.stringify(tools.map(tool => tool.args)));
});

test('the usage a view is told is the usage the session reports', async t => {
  let turn = 0;
  const provider = harden({
    chatStream: async () => {
      turn += 1;
      if (turn === 1) throw Error('OpenRouter request failed (HTTP 502)');
      return harden({
        message: { role: 'assistant', content: 'Fine.' },
        usage: { inputTokens: 20, outputTokens: 4 },
      });
    },
  });
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider },
    'test prompt',
  );
  await t.throwsAsync(say(agent, 'this one fails'));
  const events = await say(agent, 'this one completes');
  const told = events.filter(event => event.type === 'usage').at(-1);
  // Not the completed totals alone: the figure must not drop at the end of a
  // turn because an earlier one failed.
  t.like(told, { ...(await agent.getUsage()) });
  t.is(told.inputTokens, 20);
  t.like(await agent.getUsage(), { turns: 1, incompleteTurns: 1 });
});
