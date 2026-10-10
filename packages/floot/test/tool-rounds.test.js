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
 * A provider that never stops asking for a tool. Every round names a tool the
 * session does not have, whose failure comes back as an ordinary tool result,
 * so the loop can only end at the ceiling.
 */
const makeInsatiableProvider = () => {
  let calls = 0;
  const provider = harden({
    chatStream: async () => {
      calls += 1;
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
  const insatiable = makeInsatiableProvider();
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider: insatiable.provider },
    'test prompt',
    harden({ maxToolRounds: 3 }),
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

test('the ceiling defaults to a coding-sized budget, not a voice-sized one', async t => {
  const insatiable = makeInsatiableProvider();
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    { provider: insatiable.provider },
    'test prompt',
  );
  await say(agent, 'loop forever');
  t.is(insatiable.calls(), 48);
});
