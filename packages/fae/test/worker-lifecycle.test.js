// @ts-check

import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import { makeMockPowers } from '@endo/lal/tools/mock-powers.js';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { spawnWorkerLoop } from '../agent.js';
import { makeExecTool } from '../src/tool-makers.js';

/** @param {string} code */
const execResponse = code => ({
  message: {
    role: 'assistant',
    tool_calls: [
      {
        id: 'exec-1',
        type: 'function',
        function: {
          name: 'exec',
          arguments: JSON.stringify({ code, finishTurn: true }),
        },
      },
    ],
  },
});

test('ready notification failure does not prevent inbox processing', async t => {
  t.timeout(2000);
  const { powers: basePowers, sent } = makeMockPowers();
  let readyAttempts = 0;
  const powers = harden({
    ...basePowers,
    send: async (recipient, strings, edgeNames, petNames) => {
      if (strings.includes('Fae agent ready.')) {
        readyAttempts += 1;
        throw Error('Mail fraud: unrecognized parcel');
      }
      return basePowers.send(recipient, strings, edgeNames, petNames);
    },
  });
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        calls += 1;
        return {
          message: { role: 'assistant', content: 'The story continues.' },
        };
      },
    },
  });
  t.is(readyAttempts, 1);
  t.is(calls, 1);
  t.true(
    sent.some(message => message.strings.includes('The story continues.')),
  );
});

test('dismissed Whylip prose and failed reply delivery do not strand later inbox events', async t => {
  t.timeout(2000);
  const { powers: basePowers } = makeMockPowers();
  const book = Far('CompletedBook', {
    getContext: () => harden({ activeEventIds: [] }),
    failEvent: () => {
      throw Error('Completed event must remain complete');
    },
  });
  let replies = 0;
  const dismissed = [];
  async function* inbox() {
    for (const number of [1, 2, 3]) {
      yield harden({
        number,
        type: 'package',
        from: 'host-id',
        to: 'lal-self-id',
        messageId: `resilience-${number}`,
        names: [],
        ids: [],
        strings: [
          number === 1
            ? 'WHYLIP_EVENT\n{"id":"7","name":"choice"}\n'
            : `Ordinary message ${number}`,
        ],
      });
    }
  }
  const powers = harden({
    ...basePowers,
    lookup: name => (name === 'book' ? book : basePowers.lookup(name)),
    dismiss: number => {
      dismissed.push(number);
    },
    followMessages: () => readerFromIterator(inbox()),
    reply: () => {
      replies += 1;
      throw Error('Message was dismissed');
    },
  });
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async messages => {
        calls += 1;
        if (calls === 1) {
          t.regex(messages.at(-1).content, /finishEvent\("7"\)/);
          t.regex(messages.at(-1).content, /finishTurn:true/);
          t.false(messages.at(-1).content.includes('Use reply(messageNumber'));
          return {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'dismiss-first',
                  type: 'function',
                  function: {
                    name: 'exec',
                    arguments: JSON.stringify({
                      code: 'await E(powers).dismiss(1n);',
                    }),
                  },
                },
              ],
            },
          };
        }
        if (calls === 3)
          throw Error('Provider unavailable for ordinary message');
        return {
          message: { role: 'assistant', content: 'The story continues.' },
        };
      },
    },
  });
  t.is(calls, 4);
  t.deepEqual(dismissed, [1n]);
  t.is(replies, 2, 'only generic error and fallback replies are attempted');
});

test('canonical task notifications review and dismiss without reader-event settlement or fallback mail', async t => {
  t.timeout(2000);
  await Promise.all(
    ['completed', 'failed'].map(async status => {
      const { powers: basePowers, sent } = makeMockPowers({
        initialMessage: harden({
          number: 12,
          type: 'package',
          from: 'host-id',
          to: 'lal-self-id',
          messageId: `notification-${status}`,
          names: [],
          ids: [],
          strings: [
            `WHYLIP_TASK_${status.toUpperCase()}\n${JSON.stringify({ id: '3', status })}\nReview the result.`,
          ],
        }),
      });
      const settlementLookups = [];
      const powers = harden({
        ...basePowers,
        lookup: name => {
          if (name === 'book' || name === 'task') settlementLookups.push(name);
          return basePowers.lookup(name);
        },
      });
      await spawnWorkerLoop(powers, undefined, {
        provider: {
          chat: async messages => {
            const instruction = messages.at(-1).content;
            t.regex(instruction, /Review task "3"/);
            t.regex(instruction, /Apply a completed draft if appropriate/);
            t.regex(instruction, /dismiss\(12n\)/);
            t.regex(instruction, /finishTurn:true/);
            t.false(instruction.includes('finishEvent'));
            t.false(instruction.includes('Use reply(messageNumber'));
            return { message: { role: 'assistant', content: 'Reviewed.' } };
          },
        },
      });
      t.deepEqual(settlementLookups, []);
      t.false(sent.some(message => message.replyTo !== undefined));
    }),
  );
});

test('ordinary, malformed and reference-bearing task notification mail retains generic reply behavior', async t => {
  t.timeout(2000);
  const canonical = 'WHYLIP_TASK_COMPLETED\n{"id":"3","status":"completed"}\n';
  await Promise.all(
    [
      { text: 'Hello from the reader.' },
      { text: `Example: ${canonical}` },
      { text: 'WHYLIP_TASK_COMPLETED\nnot-json' },
      { text: 'WHYLIP_TASK_COMPLETED\n{"id":"3","status":"failed"}' },
      { text: 'WHYLIP_TASK_COMPLETED\n{"status":"completed"}' },
      { text: canonical, names: ['attachment'], ids: ['ref-id'] },
    ].map(async ({ text, names = [], ids = [] }) => {
      const { powers, sent } = makeMockPowers({
        initialMessage: harden({
          number: 2,
          type: 'package',
          from: 'host-id',
          to: 'lal-self-id',
          messageId: 'ordinary-notification',
          names,
          ids,
          strings: [text],
        }),
      });
      await spawnWorkerLoop(powers, undefined, {
        provider: {
          chat: async messages => {
            t.regex(messages.at(-1).content, /Use reply\(messageNumber: 2/);
            return {
              message: { role: 'assistant', content: 'Ordinary response.' },
            };
          },
        },
      });
      t.true(sent.some(message => message.replyTo === 'ordinary-notification'));
    }),
  );
});

for (const contextKind of ['direct', 'promised']) {
  test(`worker consumes inbox while ${contextKind} cancellation is still pending`, async t => {
    t.timeout(2000);
    const { powers, sent } = makeMockPowers();
    let cancel;
    const cancelled = new Promise(resolve => {
      cancel = resolve;
    });
    t.teardown(() => cancel());
    const context = Far('TestWorkerContext', {
      whenCancelled: () => cancelled,
      addDisposalHook: () => undefined,
    });
    let calls = 0;
    await spawnWorkerLoop(
      powers,
      contextKind === 'promised' ? Promise.resolve(context) : context,
      {
        provider: {
          chat: async () => {
            calls += 1;
            return {
              message: {
                role: 'assistant',
                content: 'The story is listening.',
              },
            };
          },
        },
      },
    );
    t.is(calls, 1);
    t.true(
      sent.some(
        message =>
          message.replyTo !== undefined &&
          message.strings.includes('The story is listening.'),
      ),
    );
  });
}

test('successful final exec ends the Fae turn after one model call', async t => {
  t.timeout(2000);
  const { powers } = makeMockPowers();
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        calls += 1;
        return calls === 1
          ? execResponse('return "scene published";')
          : {
              message: {
                role: 'assistant',
                content: 'unnecessary extra round',
              },
            };
      },
    },
  });
  t.is(calls, 1);
});

test('hardened provider response supports textual tool-call normalization', async t => {
  t.timeout(2000);
  const { powers } = makeMockPowers();
  const text = `<tool_call>${JSON.stringify({
    name: 'exec',
    arguments: {
      code: 'return "published from remote provider";',
      finishTurn: true,
    },
  })}</tool_call>`;
  const response = harden({ message: { role: 'assistant', content: text } });
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        calls += 1;
        if (calls > 1)
          throw Error('Successful final exec should end this turn');
        return response;
      },
    },
  });
  t.is(calls, 1);
  t.is(response.message.content, text);
  t.false(Object.hasOwn(response.message, 'tool_calls'));
});

test('a failed final exec is followed by a repair model call', async t => {
  t.timeout(2000);
  const { powers } = makeMockPowers();
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        calls += 1;
        return calls === 1
          ? execResponse('throw Error("repair this scene");')
          : execResponse('return "fixed scene";');
      },
    },
  });
  t.is(calls, 2);
});

test('finishTurn is advertised only by callers that support the lifecycle option', t => {
  const { powers } = makeMockPowers();
  const plain = makeExecTool(powers).schema().function.parameters;
  const fae = makeExecTool(powers, { supportsFinishTurn: true }).schema()
    .function.parameters;
  t.false(Object.hasOwn(plain.properties, 'finishTurn'));
  t.true(Object.hasOwn(fae.properties, 'finishTurn'));
});

test('cancellation ends an idle worker even while the mailbox read is pending', async t => {
  t.timeout(2000);
  const { powers: basePowers } = makeMockPowers();
  const { promise: cancelled, resolve: cancel } = makePromiseKit();
  const { promise: subscription, resolve: subscribed } = makePromiseKit();
  const { promise: mailboxResult, resolve: closeMailbox } = makePromiseKit();
  const powers = harden({
    ...basePowers,
    followMessages: () =>
      Far('PendingMailbox', {
        stream: () => {
          subscribed(undefined);
          return mailboxResult;
        },
      }),
  });
  t.teardown(() => {
    cancel(undefined);
    closeMailbox(harden({ value: undefined, promise: null }));
  });
  let calls = 0;
  const running = spawnWorkerLoop(
    powers,
    Far('Context', {
      whenCancelled: () => cancelled,
      addDisposalHook: () => undefined,
    }),
    {
      provider: {
        chat: async () => {
          calls += 1;
          return { message: {} };
        },
      },
    },
  );
  await subscription;
  cancel(undefined);
  await running;
  t.is(calls, 0);
});

/**
 * @param {string} text
 * @param {object} capability
 * @param {string} [reason]
 */
const runFailedWhylipTurn = async (
  text,
  capability,
  reason = 'Provider offline',
) => {
  const { powers: basePowers, sent } = makeMockPowers({
    initialMessage: harden({
      number: 1,
      type: 'package',
      from: 'host-id',
      to: 'lal-self-id',
      messageId: 'whylip-turn',
      strings: [text],
      names: [],
      ids: [],
    }),
  });
  const lookedUp = [];
  const powers = harden({
    ...basePowers,
    lookup: name => {
      if (name === 'book' || name === 'task') {
        lookedUp.push(name);
        return capability;
      }
      return basePowers.lookup(name);
    },
  });
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        throw Error(reason);
      },
    },
  });
  return { sent, lookedUp };
};

test('provider failure settles the exact Whylip event without exposing provider diagnostics', async t => {
  t.timeout(2000);
  const failures = [];
  const book = Far('Book', {
    failEvent: (id, reason) => {
      failures.push({ id, reason });
    },
  });
  const { sent, lookedUp } = await runFailedWhylipTurn(
    'WHYLIP_EVENT\n{"id":"7","name":"choose-path"}\n\nUpdate the book.',
    book,
  );
  t.deepEqual(failures, [
    {
      id: '7',
      reason:
        'This agent could not complete that request. The reason is in its log.',
    },
  ]);
  t.deepEqual(lookedUp, ['book']);
  t.true(
    sent.some(
      message =>
        message.replyTo !== undefined &&
        message.strings.includes(
          'This agent could not complete that request. The reason is in its log.',
        ),
    ),
  );
});

test('failed failure-report persistence still sends the generic error and does not stop the worker', async t => {
  t.timeout(2000);
  const book = Far('OfflineBook', {
    failEvent: () => {
      throw Error('Storage offline');
    },
  });
  const { sent } = await runFailedWhylipTurn(
    'WHYLIP_EVENT\n{"id":"7","name":"choose-path"}\n',
    book,
  );
  t.true(
    sent.some(
      message =>
        message.replyTo !== undefined &&
        message.strings.includes(
          'This agent could not complete that request. The reason is in its log.',
        ),
    ),
  );
});

test('failure handling ignores ordinary text and malformed event envelopes', async t => {
  t.timeout(2000);
  const book = Far('Book', {
    failEvent: () => {
      throw Error('Should not be called');
    },
  });
  for (const text of [
    'Here is an example: WHYLIP_EVENT\n{"id":"7","name":"choice"}',
    'WHYLIP_EVENT\nnot-json',
    '  WHYLIP_EVENT\n{"id":"7","name":"choice"}',
    'WHYLIP_EVENT\n{"id":"7"}',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { lookedUp } = await runFailedWhylipTurn(text, book);
    t.deepEqual(lookedUp, []);
  }
});

test('background helper provider failure closes only its matching draft task with a bounded reason', async t => {
  t.timeout(2000);
  const failures = [];
  const task = Far('Task', {
    getContext: () => harden({ id: '4', status: 'running' }),
    fail: reason => {
      failures.push(reason);
    },
  });
  const { lookedUp } = await runFailedWhylipTurn(
    'WHYLIP_DRAFT_TASK 4\nDevelop the owl.',
    task,
    'x'.repeat(1100),
  );
  t.deepEqual(lookedUp, ['task']);
  t.is(failures.length, 1);
  t.is(
    failures[0],
    'This agent could not complete that request. The reason is in its log.',
  );
  await runFailedWhylipTurn('WHYLIP_DRAFT_TASK 5\nAnother task.', task);
  t.is(
    failures.length,
    1,
    'a mismatched task ID cannot close the assigned draft',
  );
});

test('conversation preparation failure settles the book before any provider call', async t => {
  t.timeout(2000);
  const { powers: basePowers } = makeMockPowers({
    initialMessage: harden({
      number: 1,
      type: 'package',
      from: 'host-id',
      to: 'lal-self-id',
      messageId: 'prepare-failure',
      strings: ['WHYLIP_EVENT\n{"id":"8","name":"choice"}\n'],
      names: [],
      ids: [],
    }),
  });
  const failures = [];
  const book = Far('Book', {
    failEvent: (id, reason) => {
      failures.push({ id, reason });
    },
  });
  const powers = harden({
    ...basePowers,
    lookup: name => (name === 'book' ? book : basePowers.lookup(name)),
    storeValue: (value, name) => {
      if (value.messages?.some(message => message.role === 'user'))
        throw Error('Conversation storage offline');
      return basePowers.storeValue(value, name);
    },
  });
  let calls = 0;
  await t.throwsAsync(
    spawnWorkerLoop(powers, undefined, {
      provider: {
        chat: async () => {
          calls += 1;
          return { message: {} };
        },
      },
    }),
    { instanceOf: AggregateError, message: /evidence disposal failed/ },
  );
  t.is(calls, 0);
  t.deepEqual(failures, [
    {
      id: '8',
      reason:
        'The storyteller could not save this turn. Try again once storage is available.',
    },
  ]);
});

/**
 * @param {string} text
 * @param {object} capability
 * @param {object} response
 */
const runWhylipResponse = async (text, capability, response) => {
  const { powers: basePowers } = makeMockPowers({
    initialMessage: harden({
      number: 1,
      type: 'package',
      from: 'host-id',
      to: 'lal-self-id',
      messageId: 'post-turn',
      strings: [text],
      names: [],
      ids: [],
    }),
  });
  const powers = harden({
    ...basePowers,
    lookup: name =>
      name === 'book' || name === 'task' ? capability : basePowers.lookup(name),
  });
  let calls = 0;
  await spawnWorkerLoop(powers, undefined, {
    provider: {
      chat: async () => {
        calls += 1;
        return response;
      },
    },
  });
  return calls;
};

test('prose-only Whylip turn fails its still-active event without another model round', async t => {
  t.timeout(2000);
  const failures = [];
  const book = Far('UnfinishedBook', {
    getContext: () => harden({ activeEventIds: ['7'] }),
    failEvent: (id, reason) => {
      failures.push({ id, reason });
    },
  });
  const calls = await runWhylipResponse(
    'WHYLIP_EVENT\n{"id":"7","name":"choice"}\n',
    book,
    { message: { role: 'assistant', content: 'Let us continue the story.' } },
  );
  t.is(calls, 1);
  t.is(failures.length, 1);
  t.is(failures[0].id, '7');
  t.regex(failures[0].reason, /Try again/);
});

test('successful final exec that omits event completion becomes retryable', async t => {
  t.timeout(2000);
  const failures = [];
  const book = Far('UnfinishedBook', {
    getContext: () => harden({ activeEventIds: ['7'] }),
    failEvent: (id, reason) => {
      failures.push({ id, reason });
    },
  });
  const calls = await runWhylipResponse(
    'WHYLIP_EVENT\n{"id":"7","name":"choice"}\n',
    book,
    execResponse('return "forgot to finish the event";'),
  );
  t.is(calls, 1);
  t.is(failures.length, 1);
});

test('post-turn settlement leaves completed events and closed draft tasks untouched', async t => {
  t.timeout(2000);
  const failures = [];
  const book = Far('CompletedBook', {
    getContext: () =>
      harden({ activeEventIds: ['8'], completedEventIds: ['7'] }),
    failEvent: id => {
      failures.push(id);
    },
  });
  await runWhylipResponse('WHYLIP_EVENT\n{"id":"7","name":"choice"}\n', book, {
    message: { role: 'assistant', content: 'The page is ready.' },
  });
  const task = Far('ClosedTask', {
    getContext: () => harden({ id: '4', status: 'applied' }),
    fail: reason => {
      failures.push(reason);
    },
  });
  await runWhylipResponse('WHYLIP_DRAFT_TASK 4\nDraw an owl.', task, {
    message: { role: 'assistant', content: 'The illustration is ready.' },
  });
  t.deepEqual(failures, []);
});

test('prose-only helper turn fails its matching running draft', async t => {
  t.timeout(2000);
  const failures = [];
  const task = Far('RunningTask', {
    getContext: () => harden({ id: '4', status: 'running' }),
    fail: reason => {
      failures.push(reason);
    },
  });
  const calls = await runWhylipResponse(
    'WHYLIP_DRAFT_TASK 4\nDraw an owl.',
    task,
    { message: { role: 'assistant', content: 'I would draw a purple owl.' } },
  );
  t.is(calls, 1);
  t.is(failures.length, 1);
  t.regex(failures[0], /Try again/);
});

test('runaway successful tools stop after 20 model rounds and settle the helper draft', async t => {
  t.timeout(3000);
  const failures = [];
  const task = Far('RunawayTask', {
    getContext: () => harden({ id: '4', status: 'running' }),
    fail: reason => {
      failures.push(reason);
    },
  });
  const calls = await runWhylipResponse(
    'WHYLIP_DRAFT_TASK 4\nDraw an owl.',
    task,
    harden({
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'repeat',
            type: 'function',
            function: {
              name: 'exec',
              arguments: JSON.stringify({ code: 'return "still inspecting";' }),
            },
          },
        ],
      },
    }),
  );
  t.is(calls, 20);
  t.is(failures.length, 1);
  t.regex(failures[0], /exceeded 20 tool rounds/);
});
