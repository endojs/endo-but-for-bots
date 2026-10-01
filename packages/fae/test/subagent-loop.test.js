// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { formatLocator } from '@endo/daemon/locator.js';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';

import { spawnWorkerLoop } from '../agent.js';
import { make as makeDriver } from '../driver.js';

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
 * @param {(value: any) => Promise<void>} [options.beforeStore] - Delay or refuse a durable write.
 * @param {Map<string, unknown>} [options.storedDirectory] - Retained names from a prior incarnation.
 * @param {bigint} [options.firstNumber] - First new mailbox number after restart.
 */
const makeLiveMailbox = ({
  onEcho,
  beforeStore,
  storedDirectory,
  firstNumber = 1n,
} = {}) => {
  /** @type {Map<string, unknown>} */
  const directory = new Map([
    ['@self', locatorFor(SELF)],
    ['@host', locatorFor(HOST)],
    ['subagents/helper', locatorFor(CHILD)],
    ...(storedDirectory || []),
  ]);
  /** @type {any[]} */
  const queue = [];
  /** @type {Array<(value: any) => void>} */
  const waiters = [];
  let closed = false;
  let streamFailure;
  let nextNumber = firstNumber;
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
  const fail = error => {
    streamFailure = error;
    for (const waiter of waiters.splice(0)) waiter(Promise.reject(error));
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
        if (streamFailure) throw streamFailure;
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

  const mailbox = {
    deliver,
    close,
    fail,
    sent,
    dismissed,
    directory,
    replay: push,
  };

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
      await beforeStore?.(value);
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

/** @param {Record<string, any>} methods */
const makeContext = methods =>
  Far('Context', { addDisposalHook: () => undefined, ...methods });

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

test('a fresh inbox incarnation restores context and does not replay admitted mail', async t => {
  t.timeout(15_000);
  const first = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () =>
      harden({ message: { role: 'assistant', content: 'retained answer' } }),
  ]);
  const firstLoop = spawnWorkerLoop(
    first.powers,
    null,
    harden({ provider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    first.close();
    await firstLoop;
  });
  const admitted = first.deliver({
    from: locatorFor(HOST),
    strings: ['remember this request'],
  });
  t.true(
    await until(() => first.sent.some(record => record.replyTo !== undefined)),
  );
  first.close();
  await firstLoop;

  const second = makeLiveMailbox({
    storedDirectory: first.directory,
    firstNumber: 100n,
  });
  let calls = 0;
  const restoredProvider = makeScriptedProvider([
    messages => {
      calls += 1;
      t.true(messages.some(message => message.content === 'retained answer'));
      t.true(
        messages.some(message =>
          message.content.includes('remember this request'),
        ),
      );
      return harden({ message: { role: 'assistant', content: 'restored' } });
    },
  ]);
  const secondLoop = spawnWorkerLoop(
    second.powers,
    null,
    harden({ provider: restoredProvider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    second.close();
    await secondLoop;
  });
  second.replay(admitted);
  second.deliver({ from: locatorFor(HOST), strings: ['continue'] });
  t.true(
    await until(() => second.sent.some(record => record.replyTo !== undefined)),
  );
  t.is(calls, 1);
  t.is(second.sent.filter(record => record.replyTo !== undefined).length, 1);
});

test('cancelled inference leaves a receipt, not a request to replay', async t => {
  t.timeout(15_000);
  const first = makeLiveMailbox();
  const cancelled = makePromiseKit();
  const started = makePromiseKit();
  const provider = harden({
    chat: () => {
      started.resolve(undefined);
      return new Promise(() => {});
    },
  });
  const firstLoop = spawnWorkerLoop(
    first.powers,
    makeContext({ whenCancelled: () => cancelled.promise }),
    harden({ provider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    cancelled.reject(Error('cleanup'));
    first.close();
    await firstLoop;
  });
  const admitted = first.deliver({
    from: locatorFor(HOST),
    strings: ['effectful task'],
  });
  await started.promise;
  cancelled.reject(Error('restart'));
  await firstLoop;
  const second = makeLiveMailbox({
    storedDirectory: first.directory,
    firstNumber: 100n,
  });
  let calls = 0;
  const secondLoop = spawnWorkerLoop(
    second.powers,
    null,
    harden({
      provider: makeScriptedProvider([
        messages => {
          calls += 1;
          t.true(
            messages.some(message =>
              message.content.includes('effectful task'),
            ),
          );
          return harden({
            message: { role: 'assistant', content: 'new request only' },
          });
        },
      ]),
    }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(async () => {
    second.close();
    await secondLoop;
  });
  second.replay(admitted);
  second.deliver({ from: locatorFor(HOST), strings: ['new request'] });
  t.true(
    await until(() => second.sent.some(record => record.replyTo !== undefined)),
  );
  t.is(calls, 1);
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

for (const refuse of [false, true]) {
  test(`a ${refuse ? 'refused' : 'delayed'} claimed-reply receipt cannot clear the active turn fence`, async t => {
    t.timeout(5000);
    const entered = makePromiseKit();
    const release = makePromiseKit();
    const cancelled = makePromiseKit();
    let calls = 0;
    const mailbox = makeLiveMailbox({
      onEcho: (message, box) => {
        if (message.to === locatorFor(CHILD)) {
          box.deliver({
            from: locatorFor(CHILD),
            strings: ['delegated answer'],
            replyTo: message.messageId,
          });
        }
      },
      beforeStore: async value => {
        if (
          value.parentId === null &&
          value.metadata?.inboundNumber !== undefined
        ) {
          entered.resolve(undefined);
          await release.promise;
          if (refuse) throw Error('claimed receipt refused');
        }
      },
    });
    const provider = makeScriptedProvider([
      () => {
        calls += 1;
        return harden({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'ask',
                type: 'function',
                function: {
                  name: 'askSubagent',
                  arguments: JSON.stringify({ name: 'helper', task: 'answer' }),
                },
              },
            ],
          },
        });
      },
      () => {
        calls += 1;
        return harden({ message: { role: 'assistant', content: 'answered' } });
      },
    ]);
    const loop = spawnWorkerLoop(
      mailbox.powers,
      makeContext({ whenCancelled: () => cancelled.promise }),
      { provider },
      'test prompt',
      { spawner: stubSpawner, timers: inertTimers },
    );
    void loop.catch(() => undefined);
    let stopped = false;
    void loop.then(
      () => {
        stopped = true;
      },
      () => {
        stopped = true;
      },
    );
    t.teardown(async () => {
      release.resolve(undefined);
      cancelled.reject(Error('cleanup'));
      mailbox.close();
      await loop.catch(() => undefined);
    });
    mailbox.deliver({ from: locatorFor(HOST), strings: ['delegate'] });
    await entered.promise;
    t.true(await until(() => calls === 2));
    cancelled.reject(Error('cancel while receipt is pending'));
    await null;
    await null;
    t.false(stopped);
    t.true(mailbox.directory.get('fae-conversation').turnActive);
    release.resolve(undefined);
    if (refuse) {
      await t.throwsAsync(() => loop, { message: /disposal failed/ });
      t.true(mailbox.directory.get('fae-conversation').turnActive);
    } else {
      await loop;
      t.false(mailbox.directory.get('fae-conversation').turnActive);
    }
  });
}

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

  // `whenCancelled` is a `Promise<never>`: the daemon *rejects* it with the
  // cancellation reason and never fulfills it. A fixture that resolved instead
  // exercised the one arm production never takes.
  /** @type {() => void} */
  let cancel = () => {};
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(Error('Cancelled'));
  });
  cancelled.catch(() => undefined);
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({ whenCancelled: () => cancelled }),
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
  // The loop returns without draining. The interrupted ask cannot start a
  // follow-up inference call after cancellation, even as the turn unwinds.
  await loop;
  t.deepEqual(toolResults, []);
});

test('a real daemon context does not stop the loop before it starts', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () => harden({ message: { role: 'assistant', content: 'hello back' } }),
  ]);
  // Two things went wrong here at once. `getCancelled` duck-typed the context
  // by property access, and a caplet's context arrives over CapTP as a
  // *presence* — an empty Far object — so it always answered "no cancellation
  // signal" and the loop could not be stopped. And returning `whenCancelled()`
  // from an async function adopts it, so the shape below (a local Far object,
  // which does have the property) blocked `runAgent` before its inbox loop.
  // Every test passed no context at all, so neither showed.
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({ whenCancelled: () => new Promise(() => {}) }),
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

test('a context that cannot report cancellation stops the loop', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const provider = makeScriptedProvider([
    () => harden({ message: { role: 'assistant', content: 'hello back' } }),
  ]);
  // Not being able to *observe* cancellation is not the same event as
  // cancellation, but for an agent loop the safe collapse is the same one
  // `packages/sandbox/src/factory.js` makes: a caplet that cannot tell whether
  // its owner is alive should stop, and a context missing the method is a
  // construction bug better surfaced as a stopped loop than as a loop nothing
  // can stop.
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({ id: () => 'no-cancellation-method' }),
    harden({ provider }),
    'test prompt',
    harden({ timers: inertTimers }),
  );
  t.teardown(() => mailbox.close());
  await loop;
  mailbox.deliver({ from: locatorFor(HOST), strings: ['are you there?'] });
  t.false(await until(() => mailbox.sent.some(r => r.replyTo !== undefined)));
});

test('the Fae loop uses a subscription for tools and preserves opaque Responses context', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const requests = [];
  let revocations = 0;
  let secretReads = 0;
  const opaque = harden({
    type: 'reasoning',
    id: 'reason-1',
    encrypted_content: 'opaque-context',
  });
  const subscription = Far('Subscription', {
    describe: () => harden({ models: ['test-luna'] }),
    openEndpoint: spec => {
      t.is(spec.sessionId, 'persistent-agent');
      return Far('Endpoint', {
        requestByteStream: request => {
          const body = JSON.parse(request.body);
          requests.push(body);
          const output =
            requests.length === 1
              ? [
                  opaque,
                  {
                    type: 'function_call',
                    id: 'item-1',
                    call_id: 'call-1',
                    name: 'list',
                    arguments: '{}',
                    status: 'completed',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      { type: 'output_text', text: 'Inventory checked.' },
                    ],
                  },
                ];
          const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`,
          );
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
          });
        },
        revoke: () => {
          revocations += 1;
        },
      });
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    undefined,
    harden({
      kind: 'subscription-responses',
      subscription,
      model: 'test-luna',
    }),
    'test prompt',
    {
      sessionId: 'persistent-agent',
      provideAuthToken: async () => {
        secretReads += 1;
        throw Error('unused');
      },
    },
  );
  t.teardown(async () => {
    mailbox.close();
    await loop;
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['check the inventory'] });
  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
  );
  t.is(requests.length, 2);
  t.is(revocations, 2);
  t.is(secretReads, 0);
  t.true(
    requests[1].input.some(
      item =>
        item.encrypted_content === 'opaque-context' && item.id === 'reason-1',
    ),
  );
  t.true(
    requests[1].input.some(
      item => item.type === 'function_call_output' && item.call_id === 'call-1',
    ),
  );
  const nodes = [...mailbox.directory.values()].filter(
    value => value && typeof value === 'object' && 'messages' in value,
  );
  t.true(
    nodes.some(node =>
      node.messages.some(message =>
        message.responsesOutput?.items.some(
          item => item.encrypted_content === 'opaque-context',
        ),
      ),
    ),
  );
  mailbox.close();
  await loop;
  const restoredMailbox = makeLiveMailbox({
    storedDirectory: mailbox.directory,
    firstNumber: 100n,
  });
  const restoredLoop = spawnWorkerLoop(
    restoredMailbox.powers,
    undefined,
    harden({
      kind: 'subscription-responses',
      subscription,
      model: 'test-luna',
    }),
    'test prompt',
    { sessionId: 'persistent-agent' },
  );
  t.teardown(async () => {
    restoredMailbox.close();
    await restoredLoop;
  });
  restoredMailbox.deliver({
    from: locatorFor(HOST),
    strings: ['continue after restart'],
  });
  t.true(
    await until(() =>
      restoredMailbox.sent.some(record => record.replyTo !== undefined),
    ),
  );
  t.is(requests.length, 3);
  t.true(
    requests[2].input.some(
      item =>
        item.encrypted_content === 'opaque-context' && item.id === 'reason-1',
    ),
  );
  t.true(
    requests[2].input.some(
      item => item.type === 'function_call_output' && item.call_id === 'call-1',
    ),
  );
  t.is(revocations, 3);
});

test('formula disposal drains startup publication and never announces readiness after cancellation', async t => {
  t.timeout(5000);
  const entered = makePromiseKit();
  const release = makePromiseKit();
  const cancelled = makePromiseKit();
  const hooks = [];
  let acknowledged = false;
  let writesAfterAcknowledgement = 0;
  const mailbox = makeLiveMailbox({
    beforeStore: async value => {
      if (value.parentId === null) {
        entered.resolve(undefined);
        await release.promise;
      }
      if (acknowledged) writesAfterAcknowledgement += 1;
    },
  });
  const context = Far('Context', {
    whenCancelled: () => cancelled.promise,
    addDisposalHook: hook => hooks.push(hook),
  });
  const subscription = Far('Subscription', {
    describe: () => {
      throw Error('must not infer');
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    context,
    harden({
      kind: 'subscription-responses',
      subscription,
      model: 'test-luna',
    }),
    'test prompt',
    { sessionId: 'persistent-agent' },
  );
  t.teardown(async () => {
    release.resolve(undefined);
    cancelled.reject(Error('cleanup'));
    mailbox.close();
    await loop;
  });
  await entered.promise;
  const disposal = E(hooks[0])().then(() => {
    acknowledged = true;
  });
  await null;
  await null;
  t.false(acknowledged);
  release.resolve(undefined);
  await disposal;
  await loop;
  t.true(acknowledged);
  t.is(writesAfterAcknowledgement, 0);
  t.deepEqual(mailbox.sent, []);
});

test('failed head publication keeps tool evidence and blocks restart inference', async t => {
  t.timeout(5000);
  let effects = 0;
  let calls = 0;
  const mailbox = makeLiveMailbox({
    beforeStore: async value => {
      const selected = mailbox.directory.get(`ct-${value.leafId}`);
      if (selected?.messages?.some(message => message.role === 'tool')) {
        throw Error('tool head publication refused');
      }
    },
  });
  mailbox.directory.set('tools', Far('Directory', {}));
  mailbox.directory.set(
    'tools/effect',
    Far('EffectTool', {
      schema: () =>
        harden({
          type: 'function',
          function: {
            name: 'effect',
            parameters: { type: 'object', properties: {} },
          },
        }),
      help: () => 'effect',
      execute: () => {
        effects += 1;
        return 'known completed effect';
      },
    }),
  );
  const provider = harden({
    chat: () => {
      calls += 1;
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'one',
              type: 'function',
              function: { name: 'effect', arguments: '{}' },
            },
          ],
        },
      };
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    null,
    { provider },
    'test prompt',
  );
  void loop.catch(() => undefined);
  t.teardown(() => mailbox.close());
  mailbox.deliver({ from: locatorFor(HOST), strings: ['perform effect'] });
  await t.throwsAsync(() => loop, { message: /disposal failed/ });
  t.is(effects, 1);
  t.true(
    [...mailbox.directory.values()].some(node =>
      node?.messages?.some(message =>
        message.content?.includes('known completed effect'),
      ),
    ),
  );
  const restored = makeLiveMailbox({
    storedDirectory: mailbox.directory,
    firstNumber: 100n,
  });
  const restoredLoop = spawnWorkerLoop(
    restored.powers,
    null,
    { provider },
    'test prompt',
  );
  void restoredLoop.catch(() => undefined);
  t.teardown(() => restored.close());
  restored.deliver({ from: locatorFor(HOST), strings: ['continue'] });
  const failure = await t.throwsAsync(() => restoredLoop, {
    message: /disposal failed/,
  });
  t.true(
    failure.errors.some(error =>
      error.message.includes('Interrupted inbox turn'),
    ),
  );
  t.is(calls, 1);
  t.is(effects, 1);
});

test('formula disposal waits for a late subscription endpoint and never sends inference', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const entered = makePromiseKit();
  const endpoint = makePromiseKit();
  const cancelled = makePromiseKit();
  void cancelled.promise.catch(() => undefined);
  const hooks = [];
  let requests = 0;
  let revocations = 0;
  const context = Far('Context', {
    whenCancelled: () => cancelled.promise,
    addDisposalHook: hook => {
      hooks.push(hook);
    },
  });
  const subscription = Far('Subscription', {
    describe: () => harden({ models: ['test-luna'] }),
    openEndpoint: () => {
      entered.resolve(undefined);
      return endpoint.promise;
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    context,
    harden({
      kind: 'subscription-responses',
      subscription,
      model: 'test-luna',
    }),
    'test prompt',
    { sessionId: 'persistent-agent' },
  );
  const finish = () =>
    endpoint.resolve(
      Far('Endpoint', {
        requestByteStream: () => {
          requests += 1;
          throw Error('must not send');
        },
        revoke: () => {
          revocations += 1;
        },
      }),
    );
  t.teardown(async () => {
    finish();
    cancelled.reject(Error('test teardown'));
    mailbox.close();
    await loop;
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['hello'] });
  await entered.promise;
  t.is(hooks.length, 1);
  cancelled.reject(Error('Cancelled'));
  let disposed = false;
  const disposal = E(hooks[0])().then(() => {
    disposed = true;
  });
  await null;
  t.false(disposed);
  finish();
  await disposal;
  await loop;
  t.true(disposed);
  t.is(revocations, 1);
  t.is(requests, 0);
  t.false(mailbox.sent.some(record => record.replyTo !== undefined));
});

test('the durable driver derives pool affinity from the retained agent locator without a Secret', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const cancelled = makePromiseKit();
  void cancelled.promise.catch(() => undefined);
  const hooks = [];
  const opened = [];
  const context = Far('Context', {
    whenCancelled: () => cancelled.promise,
    addDisposalHook: hook => {
      hooks.push(hook);
    },
  });
  const subscription = Far('Subscription', {
    describe: () => harden({ models: ['test-luna'] }),
    openEndpoint: spec => {
      opened.push(spec);
      return Far('Endpoint', {
        requestByteStream: () => {
          const bytes = new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Driver connected.' }] }] } })}\n\n`,
          );
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: bytesReaderFromIterator([bytes][Symbol.iterator]()),
          });
        },
        revoke: () => undefined,
      });
    },
  });
  const driverPowers = Far('DriverPowers', {
    lookup: name => {
      if (name === 'llm-provider')
        return harden({
          kind: 'subscription-responses',
          subscription,
          model: 'test-luna',
        });
      if (name === 'agent') return mailbox.powers;
      throw Error(`Unexpected driver lookup ${name}`);
    },
    has: name => {
      t.is(name, 'subagent-spawner');
      return false;
    },
    locate: name => {
      t.is(name, 'agent');
      return locatorFor(SELF);
    },
  });
  t.teardown(async () => {
    cancelled.reject(Error('test teardown'));
    mailbox.close();
    await Promise.all(hooks.map(hook => E(hook)()));
  });
  const driver = await makeDriver(driverPowers, context);
  t.regex(await E(driver).help(), /Fae agent driver/);
  mailbox.deliver({ from: locatorFor(HOST), strings: ['hello'] });
  t.true(
    await until(() =>
      mailbox.sent.some(record => record.replyTo !== undefined),
    ),
  );
  t.deepEqual(opened, [{ sessionId: `${SELF}${NODE}` }]);
});

test('cancellation inside the first tool preserves its result and never admits the second', async t => {
  t.timeout(15_000);
  const mailbox = makeLiveMailbox();
  const cancelled = makePromiseKit();
  void cancelled.promise.catch(() => undefined);
  let effects = 0;
  let skippedEffects = 0;
  let inferences = 0;
  mailbox.directory.set('tools', Far('Directory', {}));
  for (const name of ['firstEffect', 'secondEffect']) {
    mailbox.directory.set(
      `tools/${name}`,
      Far('EffectTool', {
        schema: () =>
          harden({
            type: 'function',
            function: {
              name,
              description: 'test effect',
              parameters: { type: 'object', properties: {} },
            },
          }),
        help: () => 'test',
        execute: () => {
          if (name === 'firstEffect') {
            effects += 1;
            cancelled.reject(Error('Cancelled during first tool'));
            return 'completed first effect';
          }
          skippedEffects += 1;
          return 'second effect';
        },
      }),
    );
  }
  const provider = harden({
    chat: async () => {
      inferences += 1;
      return harden({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: ['firstEffect', 'secondEffect'].map((name, index) => ({
            id: `effect-${index}`,
            type: 'function',
            function: { name, arguments: '{}' },
          })),
        },
      });
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({ whenCancelled: () => cancelled.promise }),
    { provider },
    'test prompt',
  );
  t.teardown(async () => {
    cancelled.reject(Error('test teardown'));
    mailbox.close();
    await loop;
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['do both effects'] });
  await loop;
  t.is(effects, 1);
  t.is(skippedEffects, 0);
  t.is(inferences, 1);
  const nodes = [...mailbox.directory.values()].filter(
    value => value && typeof value === 'object' && 'messages' in value,
  );
  const toolStep = nodes.find(node =>
    node.messages.some(message => message.tool_call_id === 'effect-0'),
  );
  t.truthy(toolStep);
  t.true(toolStep.messages.some(message => message.tool_calls?.length === 2));
  t.regex(
    toolStep.messages.find(message => message.tool_call_id === 'effect-0')
      .content,
    /completed first effect/,
  );
  const second = toolStep.messages.find(
    message => message.tool_call_id === 'effect-1',
  );
  t.true(second.failed);
  t.regex(second.content, /Not executed/);
});

test('cancellation does not wait for borrowed inference that ignores its signal', async t => {
  t.timeout(5000);
  const mailbox = makeLiveMailbox();
  const entered = makePromiseKit();
  const answer = makePromiseKit();
  const cancelled = makePromiseKit();
  void cancelled.promise.catch(() => undefined);
  const provider = harden({
    chat: () => {
      entered.resolve(undefined);
      return answer.promise;
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({ whenCancelled: () => cancelled.promise }),
    { provider },
    'test prompt',
  );
  t.teardown(() => {
    mailbox.close();
    answer.resolve({ message: { role: 'assistant', content: 'late' } });
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['hello'] });
  await entered.promise;
  cancelled.reject(Error('cancelled while inference stalled'));
  await loop;
  answer.resolve({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'late',
          type: 'function',
          function: {
            name: 'send',
            arguments: JSON.stringify({
              recipient: '@host',
              strings: ['must not send'],
            }),
          },
        },
      ],
    },
  });
  await null;
  await null;
  t.false(
    mailbox.sent.some(record => record.strings.includes('must not send')),
  );
  t.false(mailbox.sent.some(record => record.replyTo !== undefined));
});

test('cancellation waits for admitted tool evidence publication, not just model disposal', async t => {
  t.timeout(5000);
  const enteredWrite = makePromiseKit();
  const finishWrite = makePromiseKit();
  const cancelled = makePromiseKit();
  const hooks = [];
  void cancelled.promise.catch(() => undefined);
  const mailbox = makeLiveMailbox({
    beforeStore: async value => {
      if (value.messages?.some(message => message.role === 'tool')) {
        enteredWrite.resolve(undefined);
        await finishWrite.promise;
      }
    },
  });
  mailbox.directory.set('tools', Far('Directory', {}));
  mailbox.directory.set(
    'tools/effect',
    Far('EffectTool', {
      schema: () =>
        harden({
          type: 'function',
          function: {
            name: 'effect',
            parameters: { type: 'object', properties: {} },
          },
        }),
      help: () => 'test',
      execute: () => {
        cancelled.reject(Error('cancel after effect'));
        return 'completed effect';
      },
    }),
  );
  const provider = makeScriptedProvider([
    () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'effect-1',
            type: 'function',
            function: { name: 'effect', arguments: '{}' },
          },
        ],
      },
    }),
  ]);
  let stopped = false;
  const loop = spawnWorkerLoop(
    mailbox.powers,
    makeContext({
      whenCancelled: () => cancelled.promise,
      addDisposalHook: hook => hooks.push(hook),
    }),
    { provider },
    'test prompt',
  ).then(() => {
    stopped = true;
  });
  t.teardown(async () => {
    finishWrite.resolve(undefined);
    cancelled.reject(Error('test teardown'));
    mailbox.close();
    await loop;
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['do the effect'] });
  await enteredWrite.promise;
  t.is(hooks.length, 1, 'non-subscription routes also own their tree writes');
  let acknowledged = false;
  const disposal = E(hooks[0])().then(() => {
    acknowledged = true;
  });
  await null;
  t.false(acknowledged);
  t.false(
    stopped,
    'cleanup cannot acknowledge before the tool outcome is durable',
  );
  finishWrite.resolve(undefined);
  await disposal;
  await loop;
  t.true(acknowledged);
  t.true(stopped);
  t.true(
    [...mailbox.directory.values()].some(
      value =>
        value &&
        typeof value === 'object' &&
        'messages' in value &&
        value.messages.some(
          message =>
            message.tool_call_id === 'effect-1' &&
            message.content.includes('completed effect'),
        ),
    ),
  );
});

test('mailbox failure fences a late borrowed model response before admitting tools', async t => {
  t.timeout(5000);
  const mailbox = makeLiveMailbox();
  const entered = makePromiseKit();
  const answer = makePromiseKit();
  const provider = harden({
    chat: () => {
      entered.resolve(undefined);
      return answer.promise;
    },
  });
  const loop = spawnWorkerLoop(
    mailbox.powers,
    undefined,
    { provider },
    'test prompt',
  );
  const failed = t.throwsAsync(loop, { message: /mailbox failed/ });
  t.teardown(() => {
    mailbox.close();
    answer.resolve({ message: { role: 'assistant', content: 'late' } });
  });
  mailbox.deliver({ from: locatorFor(HOST), strings: ['hello'] });
  await entered.promise;
  mailbox.fail(Error('mailbox failed'));
  await failed;
  answer.resolve({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'late',
          type: 'function',
          function: {
            name: 'send',
            arguments: JSON.stringify({
              recipient: '@host',
              strings: ['must not send'],
            }),
          },
        },
      ],
    },
  });
  await null;
  await null;
  t.false(
    mailbox.sent.some(record => record.strings.includes('must not send')),
  );
});

test('cancellation around final-node publication never sends a late fallback reply', async t => {
  t.timeout(10_000);
  // These offsets stop before reply admission. A send already queued with E()
  // may be delivered after cancellation; cancellation does not retract it.
  for (let delay = 0; delay <= 9; delay += 1) {
    const cancelled = makePromiseKit();
    void cancelled.promise.catch(() => undefined);
    let signal;
    let lateReplies = 0;
    const mailbox = makeLiveMailbox({
      onEcho: message => {
        if (message.replyTo && signal?.aborted) lateReplies += 1;
      },
      beforeStore: async value => {
        if (
          value.messages?.some(message => message.content === 'final answer')
        ) {
          void (async () => {
            for (let tick = 0; tick < delay; tick += 1) {
              // eslint-disable-next-line no-await-in-loop
              await null;
            }
            cancelled.reject(Error('cancel around final publication'));
          })();
        }
      },
    });
    const provider = harden({
      chat: async (_messages, _tools, providedSignal) => {
        signal = providedSignal;
        return { message: { role: 'assistant', content: 'final answer' } };
      },
    });
    const loop = spawnWorkerLoop(
      mailbox.powers,
      makeContext({ whenCancelled: () => cancelled.promise }),
      { provider },
      'test prompt',
    );
    t.teardown(async () => {
      cancelled.reject(Error('test teardown'));
      mailbox.close();
      await loop;
    });
    mailbox.deliver({ from: locatorFor(HOST), strings: ['hello'] });
    // eslint-disable-next-line no-await-in-loop
    await loop;
    t.is(lateReplies, 0, `delay ${delay}`);
    mailbox.close();
  }
});
