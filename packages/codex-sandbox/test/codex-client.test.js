// @ts-check
import '@endo/init';

import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeCodexClient } from '../src/codex-client.js';

const INITIALIZE_RESULT = harden({
  codexHome: '/private/codex',
  platformFamily: 'unix',
  platformOs: 'linux',
  userAgent: 'codex-test',
});

const makeQueue = () => {
  const values = [];
  const waiters = [];
  let closed = false;
  const push = value => {
    values.push(value);
    while (waiters.length) waiters.shift()();
  };
  const close = () => {
    closed = true;
    while (waiters.length) waiters.shift()();
  };
  const messages = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (values.length) yield values.shift();
        else if (closed) return;
        else {
          // eslint-disable-next-line no-await-in-loop, @jessie.js/safe-await-separator
          await new Promise(resolve => waiters.push(resolve));
        }
      }
    },
  };
  return { messages, push, close };
};

/**
 * @param {{
 *   threadId?: string,
 *   saveThreadId?: (threadId: string) => Promise<void>,
 *   clientOptions?: Record<string, any>,
 *   interruptError?: string,
 *   interruptTerminal?: boolean,
 *   beforeTurnResponse?: any[],
 *   turnIdValue?: any,
 *   turnStatus?: any,
 *   modelListResult?: any,
 * }} [options]
 */
const makeFixture = ({
  threadId,
  saveThreadId,
  clientOptions = {},
  interruptError,
  interruptTerminal = true,
  beforeTurnResponse = [],
  turnIdValue,
  turnStatus = 'inProgress',
  modelListResult,
} = {}) => {
  const queue = makeQueue();
  const sent = [];
  let transportClosed = false;
  let turnNumber = 0;
  const send = async message => {
    sent.push(message);
    if (!('id' in message) || !('method' in message)) return;
    switch (message.method) {
      case 'initialize':
        queue.push({ id: message.id, result: INITIALIZE_RESULT });
        break;
      case 'thread/start':
        queue.push({
          id: message.id,
          result: { thread: { id: 'thread-new' } },
        });
        break;
      case 'thread/resume':
        queue.push({
          id: message.id,
          result: { thread: { id: message.params.threadId } },
        });
        break;
      case 'turn/start':
        turnNumber += 1;
        for (const event of beforeTurnResponse) queue.push(event);
        queue.push({
          id: message.id,
          result: {
            turn: {
              id:
                turnIdValue === undefined ? `turn-${turnNumber}` : turnIdValue,
              status: turnStatus,
            },
          },
        });
        break;
      case 'turn/interrupt':
        queue.push(
          interruptError
            ? { id: message.id, error: { message: interruptError } }
            : { id: message.id, result: {} },
        );
        if (!interruptError && interruptTerminal) {
          queue.push({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: { id: message.params.turnId, status: 'interrupted' },
            },
          });
        }
        break;
      case 'model/list':
        queue.push({
          id: message.id,
          result:
            modelListResult === undefined
              ? {
                  data: [
                    {
                      id: 'gpt-test',
                      displayName: 'GPT Test',
                      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                    },
                  ],
                  nextCursor: null,
                }
              : modelListResult,
        });
        break;
      default:
        throw Error(`unexpected request ${message.method}`);
    }
  };
  const transport = {
    messages: queue.messages,
    send,
    close: async () => {
      transportClosed = true;
      queue.close();
    },
  };
  const client = makeCodexClient({
    start: async () => transport,
    sessionId: 'session-1',
    threadId,
    saveThreadId,
    ...clientOptions,
  });
  return {
    client,
    push: queue.push,
    sent,
    isClosed: () => transportClosed,
  };
};

const drain = async reader => {
  /** @type {any[]} */
  const events = [];
  for await (const event of iterateReader(reader)) events.push(event);
  return events;
};

test('initializes, persists a new thread, and streams normalized events', async t => {
  /** @type {string | undefined} */
  let persisted;
  const fixture = makeFixture({
    saveThreadId: async value => {
      persisted = value;
    },
  });
  const reader = await fixture.client.send('do it', {
    model: 'gpt-test',
    reasoningEffort: 'high',
  });
  fixture.push({
    method: 'item/started',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'pwd',
        cwd: '/workspace',
        status: 'inProgress',
      },
    },
  });
  fixture.push({
    method: 'item/completed',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        command: 'pwd',
        cwd: '/workspace',
        status: 'completed',
        aggregatedOutput: '/workspace',
      },
    },
  });
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'Done.',
    },
  });
  fixture.push({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } },
    },
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });

  const events = await drain(reader);
  t.is(persisted, 'thread-new');
  t.deepEqual(
    fixture.sent.slice(0, 3).map(message => message.method),
    ['initialize', 'initialized', 'thread/start'],
  );
  const turnStart = fixture.sent.find(
    message => message.method === 'turn/start',
  );
  t.is(turnStart.params.model, 'gpt-test');
  t.is(turnStart.params.effort, 'high');
  t.true(events.some(event => event.type === 'tool-call'));
  t.true(events.some(event => event.type === 'tool-result'));
  t.true(events.some(event => event.type === 'text-delta'));
  t.deepEqual(events.at(-1), { type: 'end' });
});

test('notifications arriving before turn/start response are replayed', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    beforeTurnResponse: [
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-saved',
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: 'response last',
        },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-saved',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
    ],
  });
  const reader = await fixture.client.send('go');
  const events = await drain(reader);
  t.true(events.some(event => event.text === 'response last'));
  t.deepEqual(events.at(-1), { type: 'end' });
});

test('commentary is distinct from the final answer stream', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('go');
  fixture.push({
    method: 'item/started',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'comment', phase: 'commentary' },
    },
  });
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: 'comment',
      delta: 'working',
    },
  });
  fixture.push({
    method: 'item/started',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'final', phase: 'final_answer' },
    },
  });
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: 'final',
      delta: 'answer',
    },
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  const events = await drain(reader);
  t.true(events.some(event => event.type === 'commentary-delta'));
  t.true(events.some(event => event.type === 'text-delta'));
});

test('a turn notification without an exact turn id poisons the session', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('go');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { status: 'completed' },
    },
  });
  t.regex((await drain(reader)).at(-1).reason, /without an id/);
  await t.throwsAsync(() => fixture.client.send('successor'), {
    message: 'Codex session terminated',
  });
});

test('turn/completed with a nonterminal status cannot release the session', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('go');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'inProgress' },
    },
  });
  t.regex((await drain(reader)).at(-1).reason, /nonterminal/);
  await t.throwsAsync(() => fixture.client.send('successor'), {
    message: 'Codex session terminated',
  });
});

test('unconsumed thread-scoped notifications do not poison an active turn', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('go');
  fixture.push({
    method: 'thread/status/changed',
    params: { threadId: 'thread-saved', status: 'active' },
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  t.deepEqual((await drain(reader)).at(-1), { type: 'end' });
});

test('resumes a persisted thread and lists server-provided models', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('continue');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  await drain(reader);
  t.truthy(fixture.sent.find(message => message.method === 'thread/resume'));
  t.falsy(fixture.sent.find(message => message.method === 'thread/start'));
  const models = await fixture.client.models();
  t.is(models[0].id, 'gpt-test');
});

test('malformed method results poison the pinned protocol session', async t => {
  const badTurn = makeFixture({
    threadId: 'thread-saved',
    turnIdValue: 42,
  });
  const badTurnReader = await badTurn.client.send('go');
  const badTurnEvents = await drain(badTurnReader);
  t.regex(badTurnEvents.at(-1).reason, /turn id/);
  await t.throwsAsync(() => badTurn.client.send('again'), {
    message: 'Codex session terminated',
  });

  const badTurnStatus = makeFixture({
    threadId: 'thread-saved',
    turnStatus: 'completed',
  });
  const badStatusReader = await badTurnStatus.client.send('go');
  const badStatusEvents = await drain(badStatusReader);
  t.regex(badStatusEvents.at(-1).reason, /in-progress turn id/);

  const badModels = makeFixture({ modelListResult: {} });
  await t.throwsAsync(() => badModels.client.models(), {
    message: /malformed model catalog/,
  });
  await t.throwsAsync(() => badModels.client.models(), {
    message: 'Codex session terminated',
  });
});

test('thread persistence failure prevents a turn from starting', async t => {
  const fixture = makeFixture({
    saveThreadId: async () => {
      throw Error('disk full');
    },
  });
  await t.throwsAsync(() => fixture.client.send('unsafe'), {
    message: 'disk full',
  });
  t.falsy(fixture.sent.find(message => message.method === 'turn/start'));
  await fixture.client.terminate();
  t.true(fixture.isClosed());
  await t.throwsAsync(() => fixture.client.send('retry'), {
    message: 'Codex session terminated',
  });
});

test('concurrent turn is rejected and consumer close interrupts', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const first = fixture.client.send('first');
  const second = fixture.client.send('second');
  await t.throwsAsync(second, {
    message: 'Codex session already has an active turn',
  });
  const reader = await first;
  const iterator = iterateReader(reader);
  await iterator.return();
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.method === 'turn/interrupt'))
      break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  t.truthy(fixture.sent.find(message => message.method === 'turn/interrupt'));
});

test('an unconfirmed interrupt poisons the session', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    interruptError: 'cannot interrupt',
  });
  const reader = await fixture.client.send('first');
  await t.throwsAsync(() => fixture.client.interrupt(), {
    message: /cannot interrupt/,
  });
  const events = await drain(reader);
  t.is(events.at(-1).type, 'abort');
  await t.throwsAsync(() => fixture.client.send('second'), {
    message: 'Codex session terminated',
  });
  t.true(fixture.isClosed());
});

test('a failed turn reaches terminal abort without poisoning its thread', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('first');
  fixture.push({
    method: 'error',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'quota exhausted' },
    },
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'failed' },
    },
  });
  const events = await drain(reader);
  t.deepEqual(events.at(-1), { type: 'abort', reason: 'quota exhausted' });

  const second = await fixture.client.send('second');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  t.deepEqual((await drain(second)).at(-1), { type: 'end' });
});

test('a failed turn without terminal confirmation poisons the session', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    clientOptions: { requestTimeoutMs: 10 },
  });
  const reader = await fixture.client.send('first');
  fixture.push({
    method: 'error',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      willRetry: false,
      error: { message: 'upstream failed' },
    },
  });
  const events = await drain(reader);
  t.deepEqual(events.at(-1), {
    type: 'abort',
    reason: 'Codex failed turn did not reach a terminal state',
  });
  await t.throwsAsync(() => fixture.client.send('second'), {
    message: 'Codex session terminated',
  });
});

test('interrupt keeps the turn reserved until terminal confirmation', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    interruptTerminal: false,
  });
  const reader = await fixture.client.send('first');
  const interruptP = fixture.client.interrupt();
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.method === 'turn/interrupt'))
      break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  await t.throwsAsync(() => fixture.client.send('too early'), {
    message: 'Codex session already has an active turn',
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'interrupted' },
    },
  });
  await interruptP;
  const events = await drain(reader);
  t.deepEqual(events.at(-1), {
    type: 'abort',
    reason: 'Codex turn interrupted',
  });
});

test('late completion from an interrupted turn cannot end its successor', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const first = await fixture.client.send('first');
  await fixture.client.interrupt();
  await drain(first);
  const second = await fixture.client.send('second');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-2',
      itemId: 'msg-2',
      delta: 'new turn',
    },
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  const events = await drain(second);
  t.true(events.some(event => event.text === 'new turn'));
  t.deepEqual(events.at(-1), { type: 'end' });
});

test('server requests fail closed', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('first');
  fixture.push({
    id: 91,
    method: 'item/commandExecution/requestApproval',
    params: { command: 'curl example.com' },
  });
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.id === 91)) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  const response = fixture.sent.find(message => message.id === 91);
  t.is(response.error.code, -32_601);
  await fixture.client.interrupt();
  await drain(reader);
});

test('turn output bounds interrupt an excessive stream', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    clientOptions: { maxTurnEvents: 1 },
  });
  const reader = await fixture.client.send('first');
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: '1',
      delta: 'one',
    },
  });
  fixture.push({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: '1',
      delta: 'two',
    },
  });
  const events = await drain(reader);
  t.deepEqual(events.at(-1), {
    type: 'abort',
    reason: 'Codex turn exceeded configured output bounds',
  });
  t.truthy(fixture.sent.find(message => message.method === 'turn/interrupt'));
});

test('terminate closes the transport', async t => {
  const fixture = makeFixture();
  const initialStatus = await fixture.client.status();
  t.deepEqual(initialStatus, {
    sessionId: 'session-1',
    threadId: null,
    ready: false,
    active: false,
    terminated: false,
    cleanupFailures: [],
  });
  await fixture.client.models();
  t.true((await fixture.client.status()).ready);
  await fixture.client.terminate();
  t.true(fixture.isClosed());
  t.deepEqual(await fixture.client.status(), {
    sessionId: 'session-1',
    threadId: null,
    ready: false,
    active: false,
    terminated: true,
    cleanupFailures: [],
  });
});

test('terminate immediately closes an active turn without graceful waiting', async t => {
  const fixture = makeFixture({
    threadId: 'thread-saved',
    interruptTerminal: false,
  });
  const reader = await fixture.client.send('long task');
  await fixture.client.terminate();
  t.true(fixture.isClosed());
  t.falsy(fixture.sent.find(message => message.method === 'turn/interrupt'));
  t.deepEqual((await drain(reader)).at(-1), {
    type: 'abort',
    reason: 'Codex session terminated',
  });
});

test('terminate surfaces transport teardown failure', async t => {
  const queue = makeQueue();
  const client = makeCodexClient({
    sessionId: 'failed-close',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: INITIALIZE_RESULT });
        } else if (message.method === 'model/list') {
          queue.push({
            id: message.id,
            result: { data: [], nextCursor: null },
          });
        }
      },
      close: async () => {
        queue.close();
        throw Error('kill failed');
      },
    }),
  });
  await client.models();
  await t.throwsAsync(() => client.terminate(), { message: 'kill failed' });
});

test('automatic protocol failure reports teardown failure', async t => {
  const queue = makeQueue();
  const reported = [];
  const client = makeCodexClient({
    sessionId: 'failed-protocol-close',
    reportCleanupFailure: error => {
      reported.push(error.message);
    },
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') queue.push({ id: message.id });
      },
      close: async () => {
        queue.close();
        throw Error('automatic reap failed');
      },
    }),
  });
  await t.throwsAsync(() => client.models(), { message: /malformed response/ });
  for (let tries = 0; reported.length === 0 && tries < 20; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(reported, ['automatic reap failed']);
  t.deepEqual((await client.status()).cleanupFailures, [
    'automatic reap failed',
  ]);
});

test('a blocked write is bounded by the request deadline', async t => {
  const queue = makeQueue();
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'blocked',
    requestTimeoutMs: 10,
    start: async () => ({
      messages: queue.messages,
      send: async () => new Promise(() => {}),
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  await t.throwsAsync(() => client.models(), { message: /timed out/ });
  t.true(closed);
});

test('a blocked initialized notification is bounded and closes the session', async t => {
  const queue = makeQueue();
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'blocked-initialized',
    requestTimeoutMs: 10,
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: INITIALIZE_RESULT });
          return undefined;
        }
        return new Promise(() => {});
      },
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  await t.throwsAsync(() => client.models(), { message: /write timed out/ });
  t.true(closed);
});

test('malformed matching responses poison the session', async t => {
  const queue = makeQueue();
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'malformed-response',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') queue.push({ id: message.id });
      },
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  await t.throwsAsync(() => client.models(), { message: /malformed response/ });
  t.true(closed);
});

test('malformed initialize results poison the pinned protocol session', async t => {
  const queue = makeQueue();
  const client = makeCodexClient({
    sessionId: 'malformed-initialize',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: {} });
        }
      },
      close: async () => queue.close(),
    }),
  });
  await t.throwsAsync(() => client.models(), {
    message: /malformed initialize result/,
  });
  await t.throwsAsync(() => client.models(), {
    message: 'Codex session terminated',
  });
});

test('ambiguous turn-start write failure poisons the session', async t => {
  const queue = makeQueue();
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'failed-turn-write',
    threadId: 'thread-saved',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: INITIALIZE_RESULT });
        } else if (message.method === 'thread/resume') {
          queue.push({
            id: message.id,
            result: { thread: { id: 'thread-saved' } },
          });
        } else if (message.method === 'turn/start') {
          throw Error('stdin failed after write');
        }
      },
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  const events = await drain(await client.send('first'));
  t.regex(events.at(-1).reason, /stdin failed after write/);
  await client.terminate();
  t.true(closed);
  await t.throwsAsync(() => client.send('second'), {
    message: 'Codex session terminated',
  });
});

test('interrupt during deferred turn start closes the ambiguous session', async t => {
  const queue = makeQueue();
  /** @type {any[]} */
  const sent = [];
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'deferred-turn-start',
    threadId: 'thread-saved',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        sent.push(message);
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: INITIALIZE_RESULT });
        } else if (message.method === 'thread/resume') {
          queue.push({
            id: message.id,
            result: { thread: { id: 'thread-saved' } },
          });
        }
      },
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  const readerP = client.send('first');
  await null;
  for (let tries = 0; tries < 50; tries += 1) {
    if (sent.some(message => message.method === 'turn/start')) break;
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await t.throwsAsync(() => client.interrupt(), {
    message: /id was confirmed/,
  });
  t.true(closed);
  t.regex((await drain(await readerP)).at(-1).reason, /id was confirmed/);
});

test('interrupt during thread startup is a terminating barrier', async t => {
  const queue = makeQueue();
  /** @type {any[]} */
  const sent = [];
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'deferred-thread-start',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        sent.push(message);
        if (message.method === 'initialize') {
          queue.push({ id: message.id, result: INITIALIZE_RESULT });
        }
      },
      close: async () => {
        closed = true;
        queue.close();
      },
    }),
  });
  const sendP = client.send('first');
  sendP.catch(() => undefined);
  await null;
  for (let tries = 0; tries < 50; tries += 1) {
    if (sent.some(message => message.method === 'thread/start')) break;
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  await client.interrupt();
  t.true(closed);
  await t.throwsAsync(sendP, { message: /interrupted during startup/ });
  await t.throwsAsync(() => client.send('second'), {
    message: 'Codex session terminated',
  });
});

test('an idle interrupt cannot terminate a turn that starts afterward', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const stopP = fixture.client.interrupt();
  const readerP = fixture.client.send('starts after idle interrupt');
  await stopP;
  const reader = await readerP;
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  t.deepEqual((await drain(reader)).at(-1), { type: 'end' });
  t.false((await fixture.client.status()).terminated);
});

test('JSON-RPC error metadata is preserved without unsafe replay', async t => {
  const queue = makeQueue();
  let sends = 0;
  const client = makeCodexClient({
    sessionId: 'overloaded',
    start: async () => ({
      messages: queue.messages,
      send: async (/** @type {any} */ message) => {
        sends += 1;
        if (message.method === 'initialize') {
          queue.push({
            id: message.id,
            error: {
              code: -32_001,
              message: 'Server overloaded',
              data: { retryAfterMs: 50 },
            },
          });
        }
      },
      close: async () => queue.close(),
    }),
  });

  const error = await t.throwsAsync(() => client.models(), {
    message: /code -32001.*Server overloaded/,
  });
  t.truthy(error);
  t.is(sends, 1);
});

test('terminate closes a transport that resolves after lazy startup', async t => {
  const queue = makeQueue();
  let resolveStart;
  const deferred = new Promise(resolve => {
    resolveStart = resolve;
  });
  let started;
  const startEntered = new Promise(resolve => {
    started = resolve;
  });
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'late-start',
    start: async () => {
      started();
      return deferred;
    },
  });
  const modelsP = client.models();
  modelsP.catch(() => undefined);
  await startEntered;
  await client.terminate();
  await t.throwsAsync(modelsP, { message: /session terminated/ });
  /** @type {any} */ (resolveStart)({
    messages: queue.messages,
    send: async () => {},
    close: async () => {
      closed = true;
      queue.close();
    },
  });
  await null;
  await null;
  t.true(closed);
});

test('startup-win termination race reports close failure', async t => {
  const queue = makeQueue();
  /** @type {(value: any) => void} */
  let resolveStart = _value => {};
  const deferred = new Promise(resolve => {
    resolveStart = resolve;
  });
  let startEntered;
  const entered = new Promise(resolve => {
    startEntered = resolve;
  });
  const reported = [];
  const client = makeCodexClient({
    sessionId: 'startup-win-termination-race',
    reportCleanupFailure: error => {
      reported.push(error.message);
    },
    start: () => {
      startEntered();
      return deferred;
    },
  });
  const modelsP = client.models();
  modelsP.catch(() => undefined);
  await entered;
  // The client's start reactions are registered synchronously after start()
  // returns. Register termination afterward: startup wins Promise.race, then
  // termination runs before the race continuation accepts the transport.
  void deferred.then(() => client.terminate()).catch(() => undefined);
  resolveStart({
    messages: queue.messages,
    send: async () => {},
    close: async () => {
      queue.close();
      throw Error('startup race reap failed');
    },
  });
  await t.throwsAsync(modelsP, { message: 'startup race reap failed' });
  t.deepEqual(reported, ['startup race reap failed']);
  t.deepEqual((await client.status()).cleanupFailures, [
    'startup race reap failed',
  ]);
});

test('startup timeout retains and closes a late transport', async t => {
  const queue = makeQueue();
  /** @type {(value: any) => void} */
  let resolveStart = _value => {};
  const deferred = new Promise(resolve => {
    resolveStart = resolve;
  });
  let closed = false;
  const client = makeCodexClient({
    sessionId: 'late-timeout',
    requestTimeoutMs: 5,
    start: async () => deferred,
  });
  await t.throwsAsync(() => client.models(), {
    message: /transport startup timed out/,
  });
  resolveStart({
    messages: queue.messages,
    send: async () => {},
    close: async () => {
      closed = true;
      queue.close();
    },
  });
  await null;
  for (let tries = 0; !closed && tries < 20; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.true(closed);
});

test('a late transport cleanup failure is operator-visible', async t => {
  const queue = makeQueue();
  /** @type {(value: any) => void} */
  let resolveStart = _value => {};
  const deferred = new Promise(resolve => {
    resolveStart = resolve;
  });
  const reported = [];
  const client = makeCodexClient({
    sessionId: 'late-cleanup-failure',
    requestTimeoutMs: 5,
    reportCleanupFailure: error => {
      reported.push(error.message);
    },
    start: async () => deferred,
  });
  await t.throwsAsync(() => client.models(), {
    message: /transport startup timed out/,
  });
  resolveStart({
    messages: queue.messages,
    send: async () => {},
    close: async () => {
      queue.close();
      throw Error('late reap failed');
    },
  });
  for (let tries = 0; reported.length === 0 && tries < 20; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.deepEqual(reported, ['late reap failed']);
  t.deepEqual((await client.status()).cleanupFailures, ['late reap failed']);
});

test('oversized prompts are rejected before transport startup', async t => {
  let starts = 0;
  const client = makeCodexClient({
    sessionId: 'bounded-input',
    maxPromptBytes: 3,
    start: async () => {
      starts += 1;
      throw Error('must not start');
    },
  });
  await t.throwsAsync(() => client.send('four'), {
    message: /prompt exceeded/,
  });
  t.is(starts, 0);
});
