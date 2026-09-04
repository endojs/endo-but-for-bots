// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { makeStreamingAgent } from '../agent.js';

const NODE = 'a'.repeat(64);
const SELF = 'b'.repeat(64);
const CHILD = 'c'.repeat(64);
const HOST = 'd'.repeat(64);

// The locator format the daemon's `formatLocator` produces. Spelled out here
// because floot does not depend on `@endo/daemon`.
/** @param {string} number */
const locatorFor = number => `endo://${NODE}/${number}?type=handle`;

/**
 * Guest powers with a *live* mailbox: the stream stays open, and every send is
 * echoed into it the way the daemon publishes a guest's own outbound mail to
 * its own topic.
 *
 * @param {object} [options]
 * @param {(message: any, mailbox: any) => void} [options.onEcho]
 */
const makeLiveMailbox = ({ onEcho } = {}) => {
  /** @type {Map<string, unknown>} */
  const store = new Map([
    ['@self', locatorFor(SELF)],
    ['subagents/helper', locatorFor(CHILD)],
  ]);
  const nameOf = petName =>
    Array.isArray(petName) ? petName.join('/') : `${petName}`;
  /** @type {any[]} */
  const queue = [];
  /** @type {Array<(value: any) => void>} */
  const waiters = [];
  let closed = false;
  let nextNumber = 1n;
  let nextId = 0;
  /** @type {any[]} */
  const sent = [];
  /** @type {bigint[]} */
  const dismissed = [];

  const push = message => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else queue.push(message);
  };
  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  };

  async function* stream() {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift();
        // eslint-disable-next-line no-continue
        continue;
      }
      if (closed) return;
      let resolve;
      const promise = new Promise(settle => {
        resolve = settle;
      });
      waiters.push(/** @type {any} */ (resolve));
      // eslint-disable-next-line no-await-in-loop
      const next = await promise;
      if (next.done) return;
      yield next.value;
    }
  }

  const mailbox = { close, sent, dismissed, store };

  /**
   * @param {object} options
   * @param {string} options.from
   * @param {string[]} options.strings
   * @param {string} [options.replyTo]
   * @param {boolean} [options.done]
   * @param {bigint} [options.number]
   */
  const deliver = ({ from, strings, replyTo, done = true, number }) => {
    nextId += 1;
    const messageNumber = number === undefined ? nextNumber : number;
    if (number === undefined) nextNumber += 1n;
    const message = harden({
      type: 'package',
      from,
      to: locatorFor(SELF),
      strings: harden([...strings]),
      names: harden([]),
      ids: harden([]),
      messageId: `in-${nextId}`,
      number: messageNumber,
      done,
      ...(replyTo ? { replyTo } : {}),
    });
    push(message);
    return message;
  };
  mailbox.deliver = deliver;

  const echo = (to, strings, replyTo) => {
    nextId += 1;
    const message = harden({
      type: 'package',
      from: locatorFor(SELF),
      to,
      strings: harden([...strings]),
      names: harden([]),
      ids: harden([]),
      messageId: `out-${nextId}`,
      number: nextNumber,
      done: true,
      ...(replyTo ? { replyTo } : {}),
    });
    nextNumber += 1n;
    push(message);
    if (onEcho) onEcho(message, mailbox);
  };

  const powers = Far('Powers', {
    async storeValue(value, petName) {
      store.set(nameOf(petName), value);
    },
    async storeLocator(petName, locator) {
      store.set(nameOf(petName), locator);
    },
    async lookup(petName) {
      const name = nameOf(petName);
      if (!store.has(name)) throw Error(`not found: ${name}`);
      return store.get(name);
    },
    async has(...petNamePath) {
      return store.has(petNamePath.map(nameOf).join('/'));
    },
    async remove(...petNamePath) {
      store.delete(petNamePath.map(nameOf).join('/'));
    },
    async makeDirectory() {
      return undefined;
    },
    async list(...petNamePath) {
      const prefix = petNamePath.length
        ? `${petNamePath.map(nameOf).join('/')}/`
        : '';
      const names = new Set();
      for (const key of store.keys()) {
        const rest = key.startsWith(prefix) ? key.slice(prefix.length) : '';
        if (rest !== '' && !(prefix === '' && rest.includes('/'))) {
          names.add(rest.split('/')[0]);
        }
      }
      return harden([...names].sort());
    },
    async locate(...petNamePath) {
      return store.get(petNamePath.map(nameOf).join('/'));
    },
    async reverseLocate() {
      return harden([]);
    },
    async send(recipient, strings) {
      const key = nameOf(recipient);
      sent.push({ recipient: key, strings: [...strings] });
      echo(store.get(key) || key, strings);
    },
    async reply(number, strings) {
      sent.push({ replyTo: number, strings: [...strings] });
      echo(locatorFor(HOST), strings, `reply-to-${number}`);
    },
    async dismiss(number) {
      dismissed.push(number);
    },
    followMessages() {
      return readerFromIterator(stream());
    },
  });

  return { ...mailbox, deliver, powers };
};

const inertTimers = harden({
  setTimeout: () => 0,
  clearTimeout: () => {},
});

const stubSpawner = Far('SubagentSpawner', {
  spawn: async name => harden({ name, locator: locatorFor(CHILD) }),
  stop: async () => {},
  list: async () => harden(['helper']),
  help: () => 'stub',
});

/** @param {Array<(context: any[]) => any>} rounds */
const makeScriptedProvider = rounds => {
  let index = 0;
  return harden({
    chatStream: async (/** @type {any[]} */ context) => {
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      return round(context);
    },
  });
};

/** @param {() => boolean} predicate */
const until = async predicate => {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
};

test('a mail turn blocked on askSubagent still observes the reply', async t => {
  t.timeout(20_000);
  const mailbox = makeLiveMailbox({
    onEcho: (message, box) => {
      if (message.to === locatorFor(CHILD)) {
        box.deliver({
          from: locatorFor(CHILD),
          strings: ['the answer is 42'],
          replyTo: message.messageId,
        });
      }
    },
  });
  /** @type {string[]} */
  const toolResults = [];
  const provider = makeScriptedProvider([
    () =>
      harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'askSubagent',
                arguments: JSON.stringify({ name: 'helper', task: 'do it' }),
              },
            },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    context => {
      const toolMessage = [...context]
        .reverse()
        .find(entry => entry.role === 'tool');
      toolResults.push(`${toolMessage?.content ?? ''}`);
      return harden({
        message: { role: 'assistant', content: 'relayed' },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  ]);

  const agent = await makeStreamingAgent(
    mailbox.powers,
    undefined,
    { provider },
    'test prompt',
    harden({ spawner: stubSpawner, timers: inertTimers }),
  );
  agent.startInbox();
  mailbox.deliver({ from: locatorFor(HOST), strings: ['please delegate'] });

  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
    'askSubagent never resolved: the inbox loop is blocked',
  );
  t.is(toolResults.length, 1);
  t.true(toolResults[0].includes('the answer is 42'));

  mailbox.close();
  await agent.shutdown();
});

test('a partial message does not swallow its settled revision', async t => {
  t.timeout(20_000);
  const mailbox = makeLiveMailbox();
  /** @type {string[]} */
  const prompts = [];
  const provider = makeScriptedProvider([
    context => {
      const userMessage = [...context]
        .reverse()
        .find(entry => entry.role === 'user');
      prompts.push(`${userMessage?.content ?? ''}`);
      return harden({
        message: { role: 'assistant', content: 'ack' },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  ]);

  const agent = await makeStreamingAgent(
    mailbox.powers,
    undefined,
    { provider },
    'test prompt',
    harden({ timers: inertTimers }),
  );
  agent.startInbox();
  mailbox.deliver({
    from: locatorFor(HOST),
    strings: ['half a th'],
    done: false,
    number: 1n,
  });
  mailbox.deliver({
    from: locatorFor(HOST),
    strings: ['half a thought, now complete'],
    number: 1n,
  });

  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
    'the settled revision was never answered',
  );
  t.deepEqual(prompts, ['half a thought, now complete']);

  mailbox.close();
  await agent.shutdown();
});
