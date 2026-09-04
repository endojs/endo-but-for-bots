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
    if (waiter) waiter(harden({ value: message, done: false }));
    else queue.push(message);
  };
  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter(harden({ value: undefined, done: true }));
    }
  };

  // A hand-rolled iterator rather than an async generator: `return()` on a
  // generator parked at an `await` does not complete until that await settles,
  // so a consumer cancelling a stream that has gone quiet would hang. The
  // daemon's reader can be closed while idle, and a stub that cannot would let
  // a shutdown bug pass unnoticed here.
  const stream = () => {
    const settleWaiters = value => {
      for (const waiter of waiters.splice(0)) waiter(value);
    };
    return harden({
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (queue.length > 0) {
          return harden({ value: queue.shift(), done: false });
        }
        if (closed) return harden({ value: undefined, done: true });
        return new Promise(resolve => {
          waiters.push(resolve);
        });
      },
      async return() {
        closed = true;
        settleWaiters(harden({ value: undefined, done: true }));
        return harden({ value: undefined, done: true });
      },
    });
  };

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

/** Timers that never fire, so a test asserts on the answer, not the deadline. */
const inertTimers = /** @type {any} */ (
  harden({
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  })
);

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
  t.teardown(async () => {
    mailbox.close();
    await agent.shutdown();
  });
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
  t.teardown(async () => {
    mailbox.close();
    await agent.shutdown();
  });
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

test('a backlog larger than any bound is answered, not declined', async t => {
  t.timeout(30_000);
  const mailbox = makeLiveMailbox();
  let turns = 0;
  const provider = makeScriptedProvider([
    () => {
      turns += 1;
      return harden({
        message: { role: 'assistant', content: `ack ${turns}` },
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
  t.teardown(async () => {
    mailbox.close();
    await agent.shutdown();
  });

  // `followMessages` first drains the whole live mailbox, far faster than the
  // model answers. A bound on the queue would decline the tail of any backlog
  // — and, worse, dismiss it, so the messages were destroyed rather than
  // deferred.
  for (let index = 0; index < 20; index += 1) {
    mailbox.deliver({
      from: locatorFor(HOST),
      strings: [`message ${index}`],
    });
  }

  t.true(
    await until(
      () =>
        mailbox.sent.filter(record => record.replyTo !== undefined).length ===
        20,
    ),
    'every queued message must eventually be answered',
  );
  t.is(turns, 20);
  t.is(mailbox.dismissed.length >= 20, true);
});

test('a completed turn is answered even if shutdown starts mid-drain', async t => {
  t.timeout(30_000);
  const mailbox = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () =>
      harden({
        message: { role: 'assistant', content: 'answered' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  ]);
  const agent = await makeStreamingAgent(
    mailbox.powers,
    undefined,
    { provider },
    'test prompt',
    harden({ timers: inertTimers }),
  );
  agent.startInbox();
  t.teardown(() => mailbox.close());

  mailbox.deliver({ from: locatorFor(HOST), strings: ['first'] });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['second'] });

  // Shutting down while the queue drains must not throw away a turn that
  // already ran: its history is committed and the model was paid for, so the
  // sender gets the answer. Only a turn shutdown aborted is left in the inbox,
  // and an aborted turn commits nothing, so replaying it duplicates nothing.
  await until(() => mailbox.sent.some(record => record.replyTo !== undefined));
  await agent.shutdown();

  const replies = mailbox.sent.filter(record => record.replyTo !== undefined);
  t.true(replies.length >= 1);
  for (const reply of replies) {
    t.false(`${reply.strings.join('')}`.startsWith('Error:'));
  }
});

test('a session with a quiet inbox shuts down without waiting for it', async t => {
  // The reader pump observes a close only *between* pulls, so once it is parked
  // in the source's `next()` on a quiet mailbox, `inboxIterator.return()` never
  // reaches the source. Shutdown must not depend on it: this test never closes
  // the mailbox, and its timeout is well under the agent's own 30s.
  t.timeout(10_000);
  const mailbox = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () =>
      harden({
        message: { role: 'assistant', content: 'ok' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  ]);
  const agent = await makeStreamingAgent(
    mailbox.powers,
    undefined,
    { provider },
    'test prompt',
    harden({ timers: inertTimers }),
  );
  agent.startInbox();
  // Let the pump reach its parked read.
  for (let tick = 0; tick < 50; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await agent.shutdown();
  t.pass();
});
