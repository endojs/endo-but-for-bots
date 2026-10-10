// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

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

/** @param {string} label */
const makeProvider = label =>
  harden({
    chatStream: async () =>
      harden({
        message: { role: 'assistant', content: label },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  });

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

test('a session resolves its provider per turn, so a rotation reaches it', async t => {
  let current = makeProvider('before rotation');
  let resolutions = 0;
  const agent = await makeStreamingAgent(
    makeFakePowers(),
    undefined,
    {
      provideProvider: async () => {
        resolutions += 1;
        return current;
      },
    },
    'test prompt',
  );

  const first = await say(agent, 'hello');
  t.deepEqual(first.at(-2), { type: 'final', text: 'before rotation' });

  // `refreshCredentials()` drops the factory's cached providers. A session that
  // had captured its provider at construction would keep using the token that
  // provider was built with — the rotation would reach only sessions opened
  // after it.
  current = makeProvider('after rotation');
  const second = await say(agent, 'again');
  t.deepEqual(second.at(-2), { type: 'final', text: 'after rotation' });
  t.is(resolutions, 2);
});
