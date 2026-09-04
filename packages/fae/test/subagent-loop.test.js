// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { formatLocator } from '@endo/daemon/locator.js';
import { makePromiseKit } from '@endo/promise-kit';
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
    if (waiter) waiter({ value: message, done: false });
    else queue.push(message);
  };
  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0))
      waiter({ value: undefined, done: true });
  };

  async function* stream() {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift();
        // eslint-disable-next-line no-continue
        continue;
      }
      if (closed) return;
      const { promise, resolve } = makePromiseKit();
      waiters.push(resolve);
      // eslint-disable-next-line no-await-in-loop
      const next = await promise;
      if (next.done) return;
      yield next.value;
    }
  }

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
const inertTimers = harden({
  setTimeout: () => 0,
  clearTimeout: () => {},
});

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

  mailbox.deliver({ from: locatorFor(HOST), strings: ['please delegate'] });

  // The agent replies to the host message once the ask has been answered.
  await t.notThrowsAsync(
    Promise.race([
      (async () => {
        for (;;) {
          if (mailbox.sent.some(record => record.replyTo !== undefined)) return;
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })(),
      new Promise((_resolve, reject) => {
        setTimeout(
          () =>
            reject(Error('askSubagent never resolved: the pump is blocked')),
          10_000,
        );
      }),
    ]),
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

  mailbox.deliver({ from: locatorFor(HOST), strings: ['please delegate'] });

  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (mailbox.dismissed.length > 0) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  mailbox.close();
  await loop;

  t.is(mailbox.dismissed.length, 1);
});
