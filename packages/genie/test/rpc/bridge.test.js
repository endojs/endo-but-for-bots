// @ts-check

/**
 * Tests for the stdio RPC bridge dispatcher.
 *
 * The bridge is driven against a scripted fake {@link Session}, so these
 * exercise the command parsing, event translation, `id` correlation, and
 * single-flight busy tracking without a live model round-trip. Each
 * assertion fails if the corresponding mapping or guard regresses.
 */

import '@endo/harden';

import test from 'ava';
import { setTimeout as nodeSetTimeout } from 'node:timers';

import { makeRpcBridge } from '../../src/rpc/bridge.js';

/** Yield to the microtask/timer queue so fire-and-forget prompts settle. */
const flush = () => new Promise(resolve => nodeSetTimeout(resolve, 0));

/**
 * Build a scripted fake session plus a record of the calls made to it and
 * a hook to emit raw agent events to the bridge's subscriber.
 */
const makeFakeSession = () => {
  /** @type {((event: unknown) => void) | undefined} */
  let listener;
  const calls = {
    /** @type {string[]} */ prompt: [],
    /** @type {string[]} */ steer: [],
    abort: 0,
    /** @type {Array<{ provider: string, model: string }>} */ setModel: [],
  };
  const session = {
    subscribe: l => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    prompt: async message => {
      calls.prompt.push(message);
    },
    abort: () => {
      calls.abort += 1;
    },
    steer: message => {
      calls.steer.push(message);
    },
    describeModel: () => 'test/model',
    listModels: () => ({
      providers: ['anthropic'],
      models: [{ provider: 'anthropic', id: 'x', name: 'anthropic/x' }],
    }),
    setModel: async selection => {
      calls.setModel.push(selection);
    },
  };
  return {
    session,
    calls,
    /** @param {unknown} event */
    emit: event => listener && listener(event),
  };
};

/** Build a bridge whose emitted events land in a collected array. */
const makeHarness = () => {
  const fake = makeFakeSession();
  /** @type {object[]} */
  const written = [];
  const bridge = makeRpcBridge({
    session: fake.session,
    write: event => written.push(event),
  });
  return { ...fake, written, bridge };
};

test('prompt — streams translated events tagged with the command id', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"1","type":"prompt","message":"hi"}');
  await flush();
  t.deepEqual(h.calls.prompt, ['hi']);

  h.emit({
    type: 'message_start',
    message: { role: 'assistant', content: [] },
  });
  h.emit({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'text_delta', delta: 'He' },
  });
  h.emit({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
  });
  h.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: { cmd: 'ls' },
  });
  h.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: { ok: true },
    isError: false,
  });
  h.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
  });
  h.emit({ type: 'agent_end', messages: [] });

  t.deepEqual(h.written, [
    {
      type: 'message_start',
      message: { role: 'assistant', content: [] },
      id: '1',
    },
    { type: 'message_update', delta: 'He', id: '1' },
    { type: 'endo:thinking', delta: 'hmm', id: '1' },
    {
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { cmd: 'ls' },
      id: '1',
    },
    {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { ok: true },
      isError: false,
      id: '1',
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
      id: '1',
    },
    { type: 'agent_end', id: '1' },
  ]);
});

test('prompt — internal book-keeping events are not relayed', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"type":"prompt","message":"hi"}');
  await flush();

  h.emit({ type: 'agent_start' });
  h.emit({ type: 'turn_start' });
  h.emit({ type: 'turn_end', message: {}, toolResults: [] });
  h.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
    partialResult: {},
  });
  h.emit({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'other' },
  });
  // A message_update with no inner assistant event is also dropped.
  h.emit({ type: 'message_update', message: {} });

  t.deepEqual(h.written, []);
});

test('prompt — a second prompt while busy is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"1","type":"prompt","message":"first"}');
  await flush();
  await h.bridge.handleLine('{"id":"2","type":"prompt","message":"second"}');

  t.deepEqual(h.calls.prompt, ['first']);
  t.is(h.written.length, 1);
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, '2');
  t.regex(h.written[0].message, /busy/);
});

test('prompt — a new prompt is accepted after agent_end clears busy', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"1","type":"prompt","message":"first"}');
  await flush();
  h.emit({ type: 'agent_end', messages: [] });
  await h.bridge.handleLine('{"id":"2","type":"prompt","message":"second"}');
  await flush();

  t.deepEqual(h.calls.prompt, ['first', 'second']);
  // The only relayed event is the first round's agent_end; no busy error.
  t.deepEqual(h.written, [{ type: 'agent_end', id: '1' }]);
});

test('list_models — reports providers and models with the command id', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"m","type":"list_models"}');
  t.deepEqual(h.written, [
    {
      type: 'models',
      providers: ['anthropic'],
      models: [{ provider: 'anthropic', id: 'x', name: 'anthropic/x' }],
      id: 'm',
    },
  ]);
});

test('get_status — reports the model and busy flag', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"s","type":"get_status"}');
  t.deepEqual(h.written, [
    { type: 'status', model: 'test/model', busy: false, id: 's' },
  ]);
});

test('abort — invokes the session and acks', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"a","type":"abort"}');
  t.is(h.calls.abort, 1);
  t.deepEqual(h.written, [{ type: 'endo:ack', command: 'abort', id: 'a' }]);
});

test('steer — forwards the message and acks', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"st","type":"steer","message":"stop"}');
  t.deepEqual(h.calls.steer, ['stop']);
  t.deepEqual(h.written, [{ type: 'endo:ack', command: 'steer', id: 'st' }]);
});

test('set_model — forwards the selection and acks', async t => {
  const h = makeHarness();
  await h.bridge.handleLine(
    '{"id":"sm","type":"set_model","provider":"anthropic","model":"claude"}',
  );
  t.deepEqual(h.calls.setModel, [{ provider: 'anthropic', model: 'claude' }]);
  t.deepEqual(h.written, [
    { type: 'endo:ack', command: 'set_model', id: 'sm' },
  ]);
});

test('set_model — rejects a missing provider or model', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"sm","type":"set_model","provider":"x"}');
  t.deepEqual(h.calls.setModel, []);
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, 'sm');
});

test('set_model — is rejected while a round is in flight', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"1","type":"prompt","message":"hi"}');
  await flush();
  await h.bridge.handleLine(
    '{"id":"2","type":"set_model","provider":"anthropic","model":"claude"}',
  );
  // The mid-round switch is refused; the agent's model is left untouched.
  t.deepEqual(h.calls.setModel, []);
  t.is(h.written.length, 1);
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, '2');
  t.regex(h.written[0].message, /busy/);
});

test('handleLine — invalid JSON yields an error event', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('not json');
  t.is(h.written[0].type, 'error');
  t.regex(h.written[0].message, /invalid JSON/);
});

test('handleLine — a non-object record is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('[1,2,3]');
  t.is(h.written[0].type, 'error');
  t.regex(h.written[0].message, /must be a JSON object/);
});

test('handleLine — a record without a string type is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"9"}');
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, '9');
  t.regex(h.written[0].message, /must have a string "type"/);
});

test('handleLine — a non-string id is rejected before dispatch', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":42,"type":"prompt","message":"hi"}');
  t.deepEqual(h.calls.prompt, []);
  t.is(h.written[0].type, 'error');
  t.regex(h.written[0].message, /"id" must be a string/);
});

test('handleLine — an unknown command type is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"9","type":"boop"}');
  t.is(h.written[0].type, 'error');
  t.regex(h.written[0].message, /unknown command type: boop/);
});

test('handleLine — a blank line is ignored', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('   ');
  t.deepEqual(h.written, []);
});

test('prompt — a rejected round clears busy and reports the error', async t => {
  const fake = makeFakeSession();
  fake.session.prompt = async () => {
    throw new Error('model unreachable');
  };
  /** @type {object[]} */
  const written = [];
  const bridge = makeRpcBridge({
    session: fake.session,
    write: event => written.push(event),
  });

  await bridge.handleLine('{"id":"1","type":"prompt","message":"hi"}');
  await flush();

  t.is(written.length, 1);
  t.is(written[0].type, 'error');
  t.is(written[0].id, '1');
  t.regex(written[0].message, /model unreachable/);

  // Busy was cleared, so a follow-up prompt is accepted.
  await bridge.handleLine('{"id":"2","type":"get_status"}');
  t.is(written[1].busy, false);
});

test("prompt — a superseded round's late failure does not clobber the active round", async t => {
  const h = makeHarness();
  let call = 0;
  /** @type {(err: Error) => void} */
  let failFirst = () => {};
  h.session.prompt = message => {
    call += 1;
    if (call === 1) {
      // The first round stays in flight until we reject it below.
      return new Promise((_resolve, reject) => {
        failFirst = reject;
      });
    }
    return Promise.resolve();
  };

  // Round A starts and is left pending.
  await h.bridge.handleLine('{"id":"A","type":"prompt","message":"a"}');
  await flush();
  // A ends (as an abort would drive it): agent_end clears busy so a new
  // round is admissible.
  h.emit({ type: 'agent_end', messages: [] });
  // Round B starts and becomes the active round.
  await h.bridge.handleLine('{"id":"B","type":"prompt","message":"b"}');
  await flush();
  // A's prompt now rejects, late. Its catch must be inert.
  failFirst(new Error('aborted'));
  await flush();

  // No spurious error is emitted for the superseded round A.
  t.false(h.written.some(e => e.type === 'error'));
  // B is still the active round: its streamed events carry B's id, not the
  // `undefined` a clobbered `currentId` would produce.
  h.emit({
    type: 'message_update',
    message: {},
    assistantMessageEvent: { type: 'text_delta', delta: 'x' },
  });
  const update = h.written.find(e => e.type === 'message_update');
  t.is(update && update.id, 'B');
});

test('prompt — a non-string message is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"p","type":"prompt","message":5}');
  t.deepEqual(h.calls.prompt, []);
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, 'p');
  t.regex(h.written[0].message, /prompt requires a string "message"/);
});

test('steer — a non-string message is rejected', async t => {
  const h = makeHarness();
  await h.bridge.handleLine('{"id":"st","type":"steer","message":5}');
  t.deepEqual(h.calls.steer, []);
  t.is(h.written[0].type, 'error');
  t.is(h.written[0].id, 'st');
  t.regex(h.written[0].message, /steer requires a string "message"/);
});

test('handleLine — an unknown command type is logged to the diagnostic sink', async t => {
  const fake = makeFakeSession();
  /** @type {string[]} */
  const logs = [];
  /** @type {object[]} */
  const written = [];
  const bridge = makeRpcBridge({
    session: fake.session,
    write: event => written.push(event),
    log: message => logs.push(message),
  });
  await bridge.handleLine('{"type":"boop"}');
  t.true(
    logs.some(message => /ignoring unknown command type: boop/.test(message)),
  );
  t.is(written[0].type, 'error');
});
