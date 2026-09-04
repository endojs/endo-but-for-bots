// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { formatLocator } from '@endo/daemon/locator.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { spawnWorkerLoop } from '../agent.js';

const NODE = 'a'.repeat(64);
const SELF = 'b'.repeat(64);
const CHILD = 'c'.repeat(64);
const HOST = 'd'.repeat(64);

/** @param {string} number */
const locatorFor = number => formatLocator(`${number}:${NODE}`, 'handle');

/**
 * A guest-powers stub with a *live* mailbox: the stream stays open, and every
 * `send` is echoed back into it the way the daemon publishes a guest's own
 * outbound mail to its own topic.
 *
 * @param {object} [options]
 * @param {(message: any, mailbox: any) => void} [options.onEcho] - Called with
 *   each echoed outbound message, so a test can script a reply to it.
 */
const makeLiveMailbox = ({ onEcho } = {}) => {
  /** @type {Map<string, unknown>} */
  const directory = new Map([
    ['@self', locatorFor(SELF)],
    ['@host', locatorFor(HOST)],
    ['subagents/helper', locatorFor(CHILD)],
  ]);
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

  // A hand-rolled iterator rather than an async generator, so `return()` can
  // settle while the source is parked. Note this stub is *more* forgiving than
  // the real reader: `makeReaderPump` inspects the close signal only between
  // pulls, so on a quiet mailbox a real `return()` never reaches the source at
  // all. Nothing here may depend on a close being observed.
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

  /**
   * Deliver an inbound message from another party.
   *
   * @param {object} options
   * @param {string} options.from
   * @param {string[]} options.strings
   * @param {string} [options.replyTo]
   * @param {boolean} [options.done]
   */
  const deliver = ({ from, strings, replyTo, done = true }) => {
    nextId += 1;
    const message = harden({
      type: 'package',
      from,
      to: locatorFor(SELF),
      strings: harden([...strings]),
      names: harden([]),
      ids: harden([]),
      messageId: `in-${nextId}`,
      number: nextNumber,
      done,
      ...(replyTo ? { replyTo } : {}),
    });
    nextNumber += 1n;
    push(message);
    return message;
  };

  const keyOf = nameOrPath =>
    Array.isArray(nameOrPath) ? nameOrPath.join('/') : `${nameOrPath}`;

  const mailbox = { deliver, close, sent, dismissed, directory };

  const echoSend = (recipientKey, strings, replyTo) => {
    nextId += 1;
    const message = harden({
      type: 'package',
      from: locatorFor(SELF),
      to: directory.get(recipientKey) || recipientKey,
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
    list: async (...path) => {
      const prefix = path.length ? `${path.join('/')}/` : '';
      const names = new Set();
      for (const key of directory.keys()) {
        const rest = key.startsWith(prefix) ? key.slice(prefix.length) : '';
        if (rest !== '' && !(prefix === '' && rest.includes('/'))) {
          names.add(rest.split('/')[0]);
        }
      }
      return harden([...names].sort());
    },
    lookup: async nameOrPath => {
      const key = keyOf(nameOrPath);
      if (!directory.has(key)) throw Error(`Unknown name ${key}`);
      return directory.get(key);
    },
    has: async (...path) => directory.has(path.join('/')),
    makeDirectory: async () => undefined,
    remove: async (...path) => {
      directory.delete(path.join('/'));
    },
    copy: async () => {},
    storeValue: async (value, nameOrPath) => {
      directory.set(keyOf(nameOrPath), value);
    },
    storeLocator: async (nameOrPath, locator) => {
      directory.set(keyOf(nameOrPath), locator);
    },
    locate: async (...path) => directory.get(path.join('/')),
    send: async (recipient, strings) => {
      sent.push({ recipient: keyOf(recipient), strings: [...strings] });
      echoSend(keyOf(recipient), strings);
    },
    reply: async (number, strings) => {
      sent.push({ replyTo: number, strings: [...strings] });
      echoSend('@host', strings, `in-${number}`);
    },
    dismiss: async number => {
      dismissed.push(number);
    },
    followMessages: () => readerFromIterator(stream()),
  });

  return { ...mailbox, powers };
};

/** Timers that never fire, so a test asserts on the answer, not the deadline. */
const inertTimers = /** @type {any} */ (
  harden({
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  })
);

/**
 * Poll a predicate on a bounded schedule. Bounded rather than raced against a
 * rejection timer: an uncleared rejection timer keeps the AVA worker alive
 * until it fires, which is what made this file take ten seconds to run two
 * sub-second tests.
 *
 * @param {() => boolean} predicate
 */
const until = async predicate => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => {
      setTimeout(resolve, 5);
    });
  }
  return false;
};

/**
 * @param {Array<(messages: any[]) => any>} rounds
 */
const makeScriptedProvider = rounds => {
  let index = 0;
  return harden({
    chat: async (/** @type {any[]} */ messages) => {
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      return round(messages);
    },
  });
};

const stubSpawner = Far('SubagentSpawner', {
  spawn: async name => harden({ name, locator: locatorFor(CHILD) }),
  stop: async () => {},
  list: async () => harden(['helper']),
  help: () => 'stub',
});

test('a turn blocked on askSubagent still observes the reply', async t => {
  t.timeout(20_000);
  /** @type {string[]} */
  const toolResults = [];
  const mailbox = makeLiveMailbox({
    onEcho: (message, box) => {
      // The daemon echoes the delegation into the parent's own stream before
      // any reply to it. Script the subagent's answer right behind the echo.
      if (message.to === locatorFor(CHILD)) {
        box.deliver({
          from: locatorFor(CHILD),
          strings: ['the answer is 42'],
          replyTo: message.messageId,
        });
      }
    },
  });

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
      }),
    messages => {
      const toolMessage = messages.find(entry => entry.role === 'tool');
      toolResults.push(`${toolMessage?.content ?? ''}`);
      return harden({
        message: { role: 'assistant', content: `relayed: ${toolResults[0]}` },
      });
    },
  ]);

  const loop = spawnWorkerLoop(
    mailbox.powers,
    null,
    harden({ provider }),
    'test prompt',
    harden({ spawner: stubSpawner, timers: inertTimers }),
  );
  t.teardown(async () => {
    mailbox.close();
    await loop;
  });

  mailbox.deliver({ from: locatorFor(HOST), strings: ['please delegate'] });

  // The agent replies to the host message once the ask has been answered.
  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
    'askSubagent never resolved: the pump is blocked',
  );

  mailbox.close();
  await loop;

  // Tool results are encoded with `passableAsJustin`, so a string answer comes
  // back quoted; what matters is that the subagent's words reached the model.
  t.is(toolResults.length, 1);
  t.true(toolResults[0].includes('the answer is 42'));
  const reply = mailbox.sent.find(record => record.replyTo !== undefined);
  t.true(`${reply?.strings.join('')}`.includes('the answer is 42'));
});

test('a claimed subagent reply is dismissed so a restart cannot replay it', async t => {
  t.timeout(20_000);
  const mailbox = makeLiveMailbox({
    onEcho: (message, box) => {
      if (message.to === locatorFor(CHILD)) {
        box.deliver({
          from: locatorFor(CHILD),
          strings: ['done'],
          replyTo: message.messageId,
        });
      }
    },
  });

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
      }),
    () => harden({ message: { role: 'assistant', content: 'ok' } }),
  ]);

  const loop = spawnWorkerLoop(
    mailbox.powers,
    null,
    harden({ provider }),
    'test prompt',
    harden({ spawner: stubSpawner, timers: inertTimers }),
  );
  t.teardown(async () => {
    mailbox.close();
    await loop;
  });

  mailbox.deliver({ from: locatorFor(HOST), strings: ['please delegate'] });

  t.true(await until(() => mailbox.dismissed.length > 0));
  mailbox.close();
  await loop;

  t.is(mailbox.dismissed.length, 1);
});

test('a backlog larger than any bound is answered, not declined', async t => {
  const mailbox = makeLiveMailbox();
  let turns = 0;
  const provider = makeScriptedProvider([
    () => {
      turns += 1;
      return harden({
        message: { role: 'assistant', content: `ack ${turns}` },
      });
    },
  ]);
  const loop = spawnWorkerLoop(
    mailbox.powers,
    null,
    harden({ provider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    mailbox.close();
    await loop;
  });

  // `followMessages` drains the whole live mailbox far faster than a model
  // answers, so a bound on the queue would refuse the tail of any backlog —
  // a restart with unread mail, say — even though the agent goes idle moments
  // later. Twenty is past the bound this loop used to carry.
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
});

test('cancellation closes delegations without waiting for the reader', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
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
                arguments: JSON.stringify({
                  name: 'helper',
                  task: 'never answered',
                  timeoutSeconds: 3600,
                }),
              },
            },
          ],
        },
      }),
    messages => {
      const toolMessage = messages.find(entry => entry.role === 'tool');
      toolResults.push(`${toolMessage?.content ?? ''}`);
      return harden({ message: { role: 'assistant', content: 'gave up' } });
    },
  ]);

  /** @type {() => void} */
  let cancel = () => {};
  const cancelled = new Promise(resolve => {
    cancel = () => resolve(undefined);
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    Far('Context', { whenCancelled: () => cancelled }),
    harden({ provider }),
    'test prompt',
    harden({ spawner: stubSpawner, timers: inertTimers }),
  );
  t.teardown(() => mailbox.close());

  mailbox.deliver({ from: locatorFor(HOST), strings: ['delegate please'] });
  // Wait until the delegation is on the wire and the turn is parked on a reply
  // that will never come.
  t.true(
    await until(() =>
      mailbox.sent.some(record => record.recipient === 'subagents/helper'),
    ),
    `mailbox saw: ${JSON.stringify(
      mailbox.sent.map(record => record.recipient ?? `reply#${record.replyTo}`),
    )}`,
  );

  // The mailbox stays open and silent. `messageIterator.return()` cannot reach
  // a parked reader, so cancellation must not wait on it: the ask has to fail
  // at once rather than hold the turn for its full hour, and the loop has to
  // return.
  cancel();
  // The loop returns without draining: cancellation is prompt, and an
  // in-flight provider call can take minutes. The turn it abandoned still
  // unwinds, and what it sees is the ask failing at once rather than an hour
  // from now.
  await loop;
  t.true(await until(() => toolResults.length === 1));
  t.true(toolResults[0].includes('cancelled'), toolResults[0]);
});

test('a real daemon context does not stop the loop before it starts', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () => harden({ message: { role: 'assistant', content: 'hello back' } }),
  ]);
  // `makeFarContext` hands every unconfined caplet a `whenCancelled()` that
  // returns the cancellation promise. Returning that from an async
  // `getCancelled` adopts it, so awaiting the result did not settle until the
  // agent was cancelled — and the inbox loop never started. Every test passed
  // no context at all, so nothing showed it.
  const loop = spawnWorkerLoop(
    mailbox.powers,
    Far('Context', { whenCancelled: () => new Promise(() => {}) }),
    harden({ provider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    mailbox.close();
    await loop;
  });

  mailbox.deliver({ from: locatorFor(HOST), strings: ['are you there?'] });
  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
    'the agent never answered: its loop never started',
  );
});
