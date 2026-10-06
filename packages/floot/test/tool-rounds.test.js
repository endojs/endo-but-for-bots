// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

const TOOL_STEP_FALLBACK =
  "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?";

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
 * Request an absent tool whose failure comes back as an ordinary tool result.
 * Without a finalAfter value, the loop can only end at the ceiling.
 * @param {number} [finalAfter] Tool rounds before a normal final answer.
 */
const makeToolLoopProvider = finalAfter => {
  let calls = 0;
  const provider = harden({
    chatStream: async () => {
      calls += 1;
      if (finalAfter !== undefined && calls > finalAfter) {
        return harden({
          message: { role: 'assistant', content: 'done' },
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
      return harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${calls}`,
              type: 'function',
              function: { name: 'nonexistent', arguments: '{}' },
            },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  return harden({ provider, calls: () => calls });
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

test('a turn ends on the tool-step fallback at the configured ceiling', async t => {
  const insatiable = makeToolLoopProvider();
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    {
      kind: 'provider',
      provideProvider: () => insatiable.provider,
    },
    'test prompt',
    { journalPowers: makeFakePowers(), maxToolRounds: 3 },
  );
  const events = await say(agent, 'loop forever');
  // Exactly the ceiling: one provider call per round, and no call after the
  // fallback is chosen in the model's place.
  t.is(insatiable.calls(), 3);
  t.is(events.filter(event => event.type === 'tool_call').length, 3);
  t.deepEqual(events.at(-2), { type: 'final', text: TOOL_STEP_FALLBACK });
  t.deepEqual(events.at(-1), { type: 'end' });
  // The fallback is persisted as the turn's answer, not left as a dangling
  // tool result.
  const history = await agent.getHistory();
  t.is(history.at(-1)?.role, 'assistant');
  t.is(history.at(-1)?.content, TOOL_STEP_FALLBACK);
});

test('the shared default stops an endless turn at exactly 1024 rounds', async t => {
  t.timeout(60_000);
  const insatiable = makeToolLoopProvider();
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    {
      kind: 'provider',
      provideProvider: () => insatiable.provider,
    },
    'test prompt',
    { journalPowers: makeFakePowers() },
  );
  await say(agent, 'loop forever');
  t.is(insatiable.calls(), 1024);
});

test('a default turn can answer normally after more than 48 tool rounds', async t => {
  const looping = makeToolLoopProvider(50);
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { kind: 'provider', provideProvider: () => looping.provider },
    'test prompt',
    { journalPowers: makeFakePowers() },
  );
  const events = await say(agent, 'finish the long task');
  t.is(looping.calls(), 51);
  t.is(events.filter(event => event.type === 'tool_call').length, 50);
  t.deepEqual(events.at(-2), { type: 'final', text: 'done' });
  t.deepEqual(events.at(-1), { type: 'end' });
  t.is((await agent.getHistory()).at(-1)?.content, 'done');
});
