// @ts-check
import '@endo/init';

import test from 'ava';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import { makeCodexClient } from '../src/codex-client.js';

const INITIALIZE_RESULT = harden({
  codexHome: '/codex-home',
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
 *   existingTurnIds?: string[],
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
  existingTurnIds = [],
} = {}) => {
  const queue = makeQueue();
  const sent = [];
  let transportClosed = false;
  let turnNumber = existingTurnIds.length;
  const turnIds = [...existingTurnIds];
  const push = message => {
    if (message?.method === 'turn/completed') {
      const completedId = message.params?.turn?.id;
      if (typeof completedId === 'string' && !turnIds.includes(completedId)) {
        turnIds.push(completedId);
      }
    }
    queue.push(message);
  };
  const send = async message => {
    sent.push(message);
    if (!('id' in message) || !('method' in message)) return;
    switch (message.method) {
      case 'initialize':
        push({ id: message.id, result: INITIALIZE_RESULT });
        break;
      case 'thread/start':
        push({
          id: message.id,
          result: { thread: { id: 'thread-new' } },
        });
        break;
      case 'thread/resume':
        push({
          id: message.id,
          result: { thread: { id: message.params.threadId } },
        });
        break;
      case 'thread/revert': {
        const index = turnIds.indexOf(message.params.beforeTurnId);
        if (index >= 0) turnIds.splice(index);
        push({
          id: message.id,
          result: { thread: { id: message.params.threadId, turns: [] } },
        });
        break;
      }
      case 'thread/turns/list': {
        const latest = turnIds.at(-1);
        push({
          id: message.id,
          result: {
            data: latest ? [{ id: latest }] : [],
            nextCursor: null,
            backwardsCursor: null,
          },
        });
        break;
      }
      case 'turn/start':
        turnNumber += 1;
        for (const event of beforeTurnResponse) push(event);
        push({
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
        push(
          interruptError
            ? { id: message.id, error: { message: interruptError } }
            : { id: message.id, result: {} },
        );
        if (!interruptError && interruptTerminal) {
          push({
            method: 'turn/completed',
            params: {
              threadId: message.params.threadId,
              turn: { id: message.params.turnId, status: 'interrupted' },
            },
          });
        }
        break;
      case 'model/list':
        push({
          id: message.id,
          result:
            modelListResult === undefined
              ? {
                  data: [
                    {
                      id: 'gpt-test',
                      displayName: 'GPT Test',
                      description: 'Test model',
                      isDefault: true,
                      defaultReasoningEffort: 'high',
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
    push,
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
  t.deepEqual(turnStart.params.sandboxPolicy, {
    type: 'workspaceWrite',
    writableRoots: ['/workspace', '/tmp', '/run', '/scratch'],
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  });
  t.true(events.some(event => event.type === 'tool-call'));
  t.true(events.some(event => event.type === 'tool-result'));
  t.true(events.some(event => event.type === 'text-delta'));
  t.deepEqual(events.at(-1), { type: 'end', checkpoint: 'turn-1' });
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
  t.is(events.at(-1).type, 'end');
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
  t.is((await drain(reader)).at(-1).type, 'end');
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
  const methods = fixture.sent.map(message => message.method);
  t.true(methods.lastIndexOf('thread/revert') > 0);
  t.true(
    methods.lastIndexOf('thread/revert') < methods.lastIndexOf('turn/start'),
  );
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  t.is((await drain(second)).at(-1).type, 'end');
});

test('a persisted Floot checkpoint acknowledges a completed backend turn', async t => {
  let state;
  const first = makeFixture({
    threadId: 'thread-saved',
    clientOptions: {
      saveThreadState: async next => {
        state = next;
      },
    },
  });
  const firstReader = await first.client.send('first');
  first.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  const terminal = (await drain(firstReader)).at(-1);
  t.is(terminal.checkpoint, 'turn-1');
  await first.client.terminate();

  const second = makeFixture({
    threadId: 'thread-saved',
    existingTurnIds: ['turn-1'],
    clientOptions: {
      savedRecovery: /** @type {any} */ (state).recovery,
      saveThreadState: async next => {
        state = next;
      },
    },
  });
  const secondReader = await second.client.send('second', {
    acknowledgedCheckpoint: terminal.checkpoint,
  });
  t.falsy(second.sent.find(message => message.method === 'thread/revert'));
  second.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  await drain(secondReader);
  await second.client.terminate();
});

test('replaying an already durable checkpoint is idempotent', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const first = await fixture.client.send('first');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  const checkpoint = (await drain(first)).at(-1).checkpoint;
  await fixture.client.acknowledge(checkpoint);

  const second = await fixture.client.send('second', {
    acknowledgedCheckpoint: checkpoint,
  });
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  t.is((await drain(second)).at(-1).checkpoint, 'turn-2');
  await fixture.client.acknowledge('turn-2');
  await fixture.client.terminate();
});

test('a failed thread-binding audit is retried before dispatch', async t => {
  let bindingAttempts = 0;
  const fixture = makeFixture({
    threadId: 'thread-saved',
    clientOptions: {
      auditEvent: async kind => {
        if (kind === 'thread-bound') {
          bindingAttempts += 1;
          if (bindingAttempts === 1) throw Error('audit unavailable');
        }
      },
    },
  });
  await t.throwsAsync(() => fixture.client.send('first'), {
    message: /audit unavailable/,
  });
  const reader = await fixture.client.send('retry');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  await drain(reader);
  t.is(bindingAttempts, 2);
  await fixture.client.acknowledge('turn-1');
  await fixture.client.terminate();
});

test('reconciliation is idempotent after revert wins a crash', async t => {
  const state = {
    threadId: 'thread-saved',
    recovery: { baseTurnId: null, turnId: 'lost-turn', status: 'failed' },
  };
  const fixture = makeFixture({
    threadId: 'thread-saved',
    existingTurnIds: [],
    clientOptions: {
      savedRecovery: state.recovery,
      saveThreadState: async () => undefined,
    },
  });
  const reader = await fixture.client.send('after crash');
  t.falsy(fixture.sent.find(message => message.method === 'thread/revert'));
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  await drain(reader);
  await fixture.client.terminate();
});

test('reconciliation marker survives a failed completion audit', async t => {
  let reconciliationAudits = 0;
  const persisted = [];
  const fixture = makeFixture({
    threadId: 'thread-saved',
    existingTurnIds: [],
    clientOptions: {
      savedRecovery: {
        baseTurnId: null,
        turnId: 'lost-turn',
        status: 'failed',
      },
      auditEvent: async kind => {
        if (kind === 'history-reconciled') {
          reconciliationAudits += 1;
          if (reconciliationAudits === 1) throw Error('audit unavailable');
        }
      },
      saveThreadState: async state => {
        persisted.push(state);
      },
    },
  });
  await t.throwsAsync(() => fixture.client.send('first'), {
    message: /audit unavailable/,
  });
  t.deepEqual(persisted, []);

  const reader = await fixture.client.send('retry');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  await drain(reader);
  t.is(reconciliationAudits, 2);
  t.true(persisted.some(state => state.recovery === undefined));
  await fixture.client.terminate();
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
  t.is(events.at(-1).type, 'end');
});

test('server requests fail closed', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('first');
  fixture.push({
    id: 91,
    method: 'account/chatgptAuthTokens/refresh',
    params: { reason: 'expired' },
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

test('operation approvals are automatically accepted inside the Endo sandbox', async t => {
  const audit = [];
  const fixture = makeFixture({
    threadId: 'thread-saved',
    clientOptions: {
      auditEvent: async (kind, payload) => audit.push({ kind, payload }),
    },
  });
  const reader = await fixture.client.send('first');
  fixture.push({
    id: 92,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'touch output.txt',
    },
  });
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.id === 92)) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  t.deepEqual(fixture.sent.find(message => message.id === 92)?.result, {
    decision: 'accept',
  });
  t.true(audit.some(entry => entry.kind === 'approval-auto-granted'));
  await fixture.client.interrupt();
  await drain(reader);
});

test('permission-profile expansion is not an exposed approval capability', async t => {
  const fixture = makeFixture({ threadId: 'thread-saved' });
  const reader = await fixture.client.send('first');
  fixture.push({
    id: 921,
    method: 'item/permissions/requestApproval',
    params: {
      threadId: 'thread-saved',
      turnId: 'turn-1',
      itemId: 'permission-1',
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ['/'], write: ['/'] },
      },
    },
  });
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.id === 921)) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  t.is(fixture.sent.find(message => message.id === 921)?.error.code, -32_601);
  await fixture.client.interrupt();
  await drain(reader);
});

test('only endowed dynamic Endo tools are callable and durably audited', async t => {
  const calls = [];
  const audit = [];
  const fixture = makeFixture({
    clientOptions: {
      toolSetId: 'tools-v1',
      dynamicTools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up an endowed capability.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
      ],
      callTool: async (name, args) => {
        calls.push({ name, args });
        return `found ${args.name}`;
      },
      auditEvent: async (kind, payload) => audit.push({ kind, payload }),
    },
  });
  const reader = await fixture.client.send('find it');
  fixture.push({
    id: 93,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: 'lookup',
      arguments: { name: 'workspace' },
    },
  });
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.id === 93)) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  t.deepEqual(calls, [{ name: 'lookup', args: { name: 'workspace' } }]);
  t.deepEqual(fixture.sent.find(message => message.id === 93)?.result, {
    success: true,
    contentItems: [{ type: 'inputText', text: 'found workspace' }],
  });
  t.deepEqual(
    audit
      .filter(entry => entry.kind.startsWith('tool-'))
      .map(entry => entry.kind),
    ['tool-intent', 'tool-result'],
  );
  await fixture.client.interrupt();
  await drain(reader);
});

test('a server request cannot bind a turn id before turn/start returns', async t => {
  const calls = [];
  const fixture = makeFixture({
    beforeTurnResponse: [
      {
        id: 931,
        method: 'item/tool/call',
        params: {
          threadId: 'thread-new',
          turnId: 'forged-turn',
          callId: 'forged-call',
          namespace: null,
          tool: 'lookup',
          arguments: {},
        },
      },
    ],
    clientOptions: {
      dynamicTools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'lookup',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () => {
        calls.push('called');
      },
    },
  });
  const events = await drain(await fixture.client.send('first'));
  t.deepEqual(calls, []);
  t.is(events.at(-1).type, 'abort');
  t.true(fixture.isClosed());
});

test('a dynamic tool call id cannot be replayed', async t => {
  const calls = [];
  const fixture = makeFixture({
    clientOptions: {
      dynamicTools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'lookup',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () => {
        calls.push('called');
        return 'ok';
      },
    },
  });
  const reader = await fixture.client.send('first');
  const params = {
    threadId: 'thread-new',
    turnId: 'turn-1',
    callId: 'same-call',
    namespace: null,
    tool: 'lookup',
    arguments: {},
  };
  fixture.push({ id: 941, method: 'item/tool/call', params });
  for (let tries = 0; tries < 20; tries += 1) {
    if (fixture.sent.some(message => message.id === 941)) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  fixture.push({ id: 942, method: 'item/tool/call', params });
  const events = await drain(reader);
  t.deepEqual(calls, ['called']);
  t.is(events.at(-1).type, 'abort');
  t.true(fixture.isClosed());
});

test('teardown reserves admission before awaiting its close audit', async t => {
  let calls = 0;
  const fixture = makeFixture({
    clientOptions: {
      dynamicTools: [
        {
          type: 'function',
          name: 'late',
          description: 'Must not start during teardown.',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () => {
        calls += 1;
        return 'bad';
      },
      auditEvent: async kind => {
        if (kind === 'session-close-requested') {
          /** @type {ReturnType<typeof makeFixture>} */ (fixture).push({
            id: 950,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-new',
              turnId: 'turn-1',
              callId: 'late-1',
              namespace: null,
              tool: 'late',
              arguments: {},
            },
          });
          await null;
        }
      },
    },
  });
  const reader = await fixture.client.send('first');
  await fixture.client.terminate();
  t.is(calls, 0);
  t.is((await drain(reader)).at(-1).type, 'abort');
});

test('teardown synchronously rejects a new turn before its close audit', async t => {
  /** @type {(value?: any) => void} */
  let auditStarted = () => {};
  /** @type {(value?: any) => void} */
  let releaseAudit = () => {};
  const started = new Promise(resolve => {
    auditStarted = resolve;
  });
  const gate = new Promise(resolve => {
    releaseAudit = resolve;
  });
  const fixture = makeFixture({
    clientOptions: {
      auditEvent: async kind => {
        if (kind === 'session-close-requested') {
          auditStarted();
          await gate;
        }
      },
    },
  });
  const closing = fixture.client.terminate();
  await started;
  await t.throwsAsync(() => fixture.client.send('too late'), {
    message: /session closing/,
  });
  releaseAudit();
  await closing;
});

test('a timed-out Endo tool poisons the session until late settlement', async t => {
  /** @type {(value?: any) => void} */
  let settle = () => {};
  const audit = [];
  const fixture = makeFixture({
    clientOptions: {
      toolCallTimeoutMs: 10,
      dynamicTools: [
        {
          type: 'function',
          name: 'wait',
          description: 'wait',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () =>
        new Promise(resolve => {
          settle = resolve;
        }),
      auditEvent: async (kind, payload) => audit.push({ kind, payload }),
    },
  });
  const reader = await fixture.client.send('first');
  fixture.push({
    id: 951,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'wait-1',
      namespace: null,
      tool: 'wait',
      arguments: {},
    },
  });
  t.is((await drain(reader)).at(-1).type, 'abort');
  t.true(fixture.isClosed());
  await t.throwsAsync(() => fixture.client.terminate(), {
    message: /unsettled Endo tool call/,
  });
  settle('late result');
  for (let tries = 0; tries < 20; tries += 1) {
    if (audit.some(entry => entry.kind === 'tool-late-settled')) break;
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  t.true(audit.some(entry => entry.kind === 'tool-outcome-unknown'));
  t.true(audit.some(entry => entry.kind === 'tool-late-settled'));
  await fixture.client.terminate();
});

test('late non-JSON tool fulfillments remain call-correlated unknowns', async t => {
  const cases = [
    ['bigint', 1n],
    ['remotable', Far('LateSuccessfulToolAuthority', {})],
  ];
  for (const [label, lateResult] of cases) {
    /** @type {(value?: any) => void} */
    let settle = () => {};
    const audit = [];
    const fixture = makeFixture({
      clientOptions: {
        toolCallTimeoutMs: 10,
        dynamicTools: [
          {
            type: 'function',
            name: 'wait',
            description: 'wait',
            inputSchema: { type: 'object' },
          },
        ],
        callTool: async () =>
          new Promise(resolve => {
            settle = resolve;
          }),
        auditEvent: async (kind, payload) => audit.push({ kind, payload }),
      },
    });
    // eslint-disable-next-line no-await-in-loop
    const reader = await fixture.client.send(`wait for ${label}`);
    fixture.push({
      id: label === 'bigint' ? 956 : 957,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        callId: `late-${label}`,
        namespace: null,
        tool: 'wait',
        arguments: {},
      },
    });
    // eslint-disable-next-line no-await-in-loop
    await drain(reader);
    settle(lateResult);
    for (let tries = 0; tries < 20; tries += 1) {
      if (audit.some(entry => entry.kind === 'tool-late-outcome-unknown'))
        break;
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    const late = audit.find(
      entry => entry.kind === 'tool-late-outcome-unknown',
    );
    t.is(late?.payload.callId, `late-${label}`);
    t.false(
      audit.some(
        entry => entry.kind === 'tool-late-settled' && entry.payload.success,
      ),
    );
    // eslint-disable-next-line no-await-in-loop
    await fixture.client.terminate();
  }
});

test('an unauditable successful Endo result quarantines instead of inviting replay', async t => {
  const fixture = makeFixture({
    clientOptions: {
      dynamicTools: [
        {
          type: 'function',
          name: 'mutate',
          description: 'Perform one endowed mutation.',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () => 'x'.repeat(4 * 1024 * 1024 + 1),
    },
  });
  const reader = await fixture.client.send('mutate once');
  fixture.push({
    id: 952,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'mutate-1',
      namespace: null,
      tool: 'mutate',
      arguments: {},
    },
  });
  const events = await drain(reader);
  t.is(events.at(-1).type, 'abort');
  t.regex(events.at(-1).reason, /Audit payload exceeded/);
  t.falsy(fixture.sent.find(message => message.id === 952));
  t.true(fixture.isClosed());
});

test('non-JSON successful Endo results are unknown and never retryable', async t => {
  const cases = [
    ['bigint', 1n],
    ['remotable', Far('SuccessfulToolAuthority', {})],
  ];
  for (const [label, result] of cases) {
    const audit = [];
    const fixture = makeFixture({
      clientOptions: {
        dynamicTools: [
          {
            type: 'function',
            name: 'mutate',
            description: 'Perform one endowed mutation.',
            inputSchema: { type: 'object' },
          },
        ],
        callTool: async () => result,
        auditEvent: async (kind, payload) => audit.push({ kind, payload }),
      },
    });
    // eslint-disable-next-line no-await-in-loop
    const reader = await fixture.client.send(`mutate with ${label}`);
    fixture.push({
      id: label === 'bigint' ? 954 : 955,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        callId: `mutate-${label}`,
        namespace: null,
        tool: 'mutate',
        arguments: {},
      },
    });
    // eslint-disable-next-line no-await-in-loop
    const events = await drain(reader);
    t.is(events.at(-1).type, 'abort');
    t.true(fixture.isClosed());
    t.falsy(
      fixture.sent.find(
        message => message.id === (label === 'bigint' ? 954 : 955),
      ),
    );
    t.deepEqual(
      audit
        .filter(entry => entry.kind.startsWith('tool-'))
        .map(entry => [entry.kind, entry.payload.success]),
      [
        ['tool-intent', undefined],
        ['tool-outcome-unknown', undefined],
      ],
    );
  }
});

test('a rejected post-success audit quarantines a side-effectful Endo tool', async t => {
  let mutations = 0;
  const fixture = makeFixture({
    clientOptions: {
      dynamicTools: [
        {
          type: 'function',
          name: 'mutate',
          description: 'Perform one endowed mutation.',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: async () => {
        mutations += 1;
        return 'committed';
      },
      auditEvent: async kind => {
        if (kind === 'tool-result') throw Error('audit store unavailable');
      },
    },
  });
  const reader = await fixture.client.send('mutate once');
  fixture.push({
    id: 953,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'mutate-2',
      namespace: null,
      tool: 'mutate',
      arguments: {},
    },
  });
  const events = await drain(reader);
  t.is(mutations, 1);
  t.is(events.at(-1).type, 'abort');
  t.is(events.at(-1).reason, 'audit store unavailable');
  t.falsy(fixture.sent.find(message => message.id === 953));
  t.true(fixture.isClosed());
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
    pendingToolCalls: 0,
    closing: false,
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
    pendingToolCalls: 0,
    closing: true,
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
          queue.push({
            id: message.id,
            result: { ...INITIALIZE_RESULT, codexHome: '/workspace' },
          });
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
        } else if (message.method === 'thread/turns/list') {
          queue.push({
            id: message.id,
            result: { data: [], nextCursor: null, backwardsCursor: null },
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
        } else if (message.method === 'thread/turns/list') {
          queue.push({
            id: message.id,
            result: { data: [], nextCursor: null, backwardsCursor: null },
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
  readerP.catch(() => undefined);
  await null;
  for (let tries = 0; tries < 200; tries += 1) {
    if (sent.some(message => message.method === 'turn/start')) break;
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.true(sent.some(message => message.method === 'turn/start'));
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
  await t.throwsAsync(() => client.interrupt(), {
    message: /interrupted during startup/,
  });
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
  t.is((await drain(reader)).at(-1).type, 'end');
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

test('a first turn on a fresh thread does not ask an unmaterialized thread for its history', async t => {
  const fixture = makeFixture();
  const reader = await fixture.client.send('hello');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  const events = await drain(reader);
  t.deepEqual(
    fixture.sent.filter(message => message.method === 'thread/turns/list'),
    [],
    'app-server 0.152.0 rejects thread/turns/list before the first user message',
  );
  t.deepEqual(events.at(-1), { type: 'end', checkpoint: 'turn-1' });

  // The thread is materialized now, so the next turn reads its write-ahead
  // checkpoint normally.
  await fixture.client.acknowledge('turn-1');
  const second = await fixture.client.send('again');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-new',
      turn: { id: 'turn-2', status: 'completed' },
    },
  });
  await drain(second);
  t.deepEqual(
    fixture.sent
      .filter(message => message.method === 'thread/turns/list')
      .map(message => message.params.threadId),
    ['thread-new'],
    'once a turn exists the checkpoint is read',
  );
});

test('a completion already in flight cannot resurrect a quarantined turn', async t => {
  /** @type {any[]} */
  const saved = [];
  /** @type {(() => void) | undefined} */
  let releaseAudit;
  const held = new Promise(resolve => {
    releaseAudit = () => resolve(undefined);
  });
  const { client, push } = makeFixture({
    interruptTerminal: false,
    clientOptions: {
      requestTimeoutMs: 200,
      saveThreadState: async state => {
        saved.push(JSON.parse(JSON.stringify(state)));
      },
      auditEvent: async event => {
        // A durable journal append is real I/O; the failure path awaits it
        // before delivering the abort, which is the window in which the
        // app-server's already-queued completion used to win.
        if (event?.type === 'session-failed') await held;
      },
    },
  });
  const reader = await client.send('hello');
  /** @type {any[]} */
  const events = [];
  const draining = (async () => {
    for await (const event of iterateReader(reader)) events.push(event);
  })();

  // The interrupt is acked but never confirmed, so the deadline quarantines the
  // session; the completion the app-server had already emitted arrives during
  // the session-failed audit.
  const interrupted = client.interrupt().then(
    () => undefined,
    error => error,
  );
  await new Promise(resolve => setTimeout(resolve, 350));
  push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  /** @type {any} */ (releaseAudit)();
  t.truthy(await interrupted);
  await draining;

  t.is(events.at(-1)?.type, 'abort', 'the consumer sees the abort, not an end');
  t.false(
    events.some(event => event.type === 'end'),
    'a quarantined turn never reports a commit checkpoint',
  );
  t.false(
    saved.some(state => state.recovery?.status === 'completed'),
    'and never persists one either',
  );
  const status = await client.status();
  t.true(status.needsReconciliation);
});

test('a turn can be interrupted while an Endo tool call is still running', async t => {
  /** @type {(value: string) => void} */
  let releaseTool = () => {};
  const toolRunning = new Promise(resolve => {
    releaseTool = resolve;
  });
  /** @type {(value?: any) => void} */
  let toolStarted = () => {};
  const started = new Promise(resolve => {
    toolStarted = resolve;
  });
  const fixture = makeFixture({
    clientOptions: {
      // The default ratio in production: a tool may run four times as long as
      // a request may take to answer.
      requestTimeoutMs: 300,
      toolCallTimeoutMs: 1200,
      toolSetId: 'tools-v1',
      dynamicTools: [
        {
          type: 'function',
          name: 'slow',
          description: 'A tool that takes a while.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ],
      callTool: async () => {
        toolStarted();
        return toolRunning;
      },
    },
  });
  const reader = await fixture.client.send('do the slow thing');
  fixture.push({
    id: 77,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: 'slow',
      arguments: {},
    },
  });
  await started;

  // The user presses stop. Before the pump stopped blocking on the tool call,
  // `turn/interrupt` was answered by the app-server but never dequeued, so it
  // hit its own 300 ms timeout and quarantined the session.
  await fixture.client.interrupt();
  releaseTool('done');
  const events = await drain(reader);
  t.is(events.at(-1)?.type, 'abort');
  const status = await fixture.client.status();
  t.false(status.terminated, 'the session survives a cancelled tool call');
  t.true(
    fixture.sent.some(message => message.method === 'turn/interrupt'),
    'the interrupt actually reached the app-server',
  );
});

test('a thread resumed from a write-ahead marker with no turn is still unmaterialized', async t => {
  // The process died between the write-ahead and `turn/start`, so the marker
  // names no turn at all and the thread never received a user message.
  const fixture = makeFixture({
    threadId: 'thread-saved',
    clientOptions: {
      savedRecovery: { baseTurnId: null },
      saveThreadState: async () => {},
    },
  });
  const reader = await fixture.client.send('try again');
  fixture.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-saved',
      turn: { id: 'turn-1', status: 'completed' },
    },
  });
  const events = await drain(reader);
  t.deepEqual(
    fixture.sent.filter(message => message.method === 'thread/turns/list'),
    [],
  );
  t.deepEqual(events.at(-1), { type: 'end', checkpoint: 'turn-1' });
});
