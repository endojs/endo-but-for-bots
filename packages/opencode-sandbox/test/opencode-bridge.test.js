// @ts-check
import '@endo/init';
import test from 'ava';

import {
  deriveTerminal,
  isCompactionContinuation,
  iterateSseData,
  makeMessageRegistry,
  mapSseEvent,
  parseListeningLine,
} from '../src/opencode-bridge.mjs';

const SESSION = 'ses_1';

const messageUpdated = (info, sessionID = SESSION) => ({
  type: 'message.updated',
  properties: { sessionID, info },
});
const partUpdated = (part, sessionID = SESSION) => ({
  type: 'message.part.updated',
  properties: { part: { ...part, sessionID } },
});
const partDelta = (properties, sessionID = SESSION) => ({
  type: 'message.part.delta',
  properties: { sessionID, ...properties },
});
const sessionStatus = (type, sessionID = SESSION) => ({
  type: 'session.status',
  properties: { sessionID, status: { type } },
});

const registryWithParts = () => {
  const registry = makeMessageRegistry();
  registry.noteMessage({ id: 'msg_answer', role: 'assistant' });
  registry.noteMessage({ id: 'msg_summary', role: 'assistant', summary: true });
  registry.noteMessage({
    id: 'msg_user',
    role: 'user',
    summary: { diffs: [] },
  });
  registry.notePart({ id: 'prt_text', messageID: 'msg_answer', type: 'text' });
  registry.notePart({
    id: 'prt_r',
    messageID: 'msg_answer',
    type: 'reasoning',
  });
  registry.notePart({
    id: 'prt_summary',
    messageID: 'msg_summary',
    type: 'text',
  });
  registry.notePart({ id: 'prt_user', messageID: 'msg_user', type: 'text' });
  return registry;
};

test('parses only loopback http listening lines', t => {
  t.deepEqual(
    parseListeningLine('opencode server listening on http://127.0.0.1:4321'),
    { host: '127.0.0.1', port: 4321 },
  );
  t.is(
    parseListeningLine('opencode server listening on https://127.0.0.1:4321'),
    undefined,
  );
  t.is(
    parseListeningLine('opencode server listening on http://10.0.0.5:4321'),
    undefined,
  );
  t.is(parseListeningLine('starting up'), undefined);
  t.is(parseListeningLine('listening on http://127.0.0.1:notaport'), undefined);
});

test('drops events from other sessions on the shared event bus', t => {
  const registry = makeMessageRegistry();
  registry.noteMessage({ id: 'msg_answer', role: 'assistant' });
  registry.notePart({ id: 'prt_text', messageID: 'msg_answer', type: 'text' });

  t.is(
    mapSseEvent(
      messageUpdated({ id: 'm9', role: 'assistant' }, 'ses_other'),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.is(
    mapSseEvent(
      partUpdated(
        {
          id: 'p9',
          messageID: 'm9',
          type: 'text',
          time: { end: 1 },
          text: 'hi',
        },
        'ses_other',
      ),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.is(
    mapSseEvent(
      partDelta({ partID: 'prt_text', field: 'text', delta: 'x' }, 'ses_other'),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.is(
    mapSseEvent(sessionStatus('idle', 'ses_other'), registry, SESSION),
    undefined,
  );
  // Our own events still flow.
  t.deepEqual(
    mapSseEvent(
      partDelta({ partID: 'prt_text', field: 'text', delta: 'mine' }),
      registry,
      SESSION,
    ),
    { type: 'text-delta', text: 'mine' },
  );
});

test('suppresses the compaction summary and user-message content', t => {
  const registry = registryWithParts();
  t.is(
    mapSseEvent(
      partDelta({ partID: 'prt_summary', field: 'text', delta: 'secret' }),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.is(
    mapSseEvent(
      partDelta({ partID: 'prt_user', field: 'text', delta: 'prompt' }),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.is(
    mapSseEvent(
      partUpdated({
        id: 'prt_step_summary',
        messageID: 'msg_summary',
        type: 'step-finish',
        tokens: { input: 10, output: 2 },
      }),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.deepEqual(
    mapSseEvent(
      partDelta({ partID: 'prt_text', field: 'text', delta: 'hi' }),
      registry,
      SESSION,
    ),
    { type: 'text-delta', text: 'hi' },
  );
});

test('maps reasoning deltas to commentary', t => {
  const registry = registryWithParts();
  t.deepEqual(
    mapSseEvent(
      partDelta({ partID: 'prt_r', field: 'text', delta: 'think' }),
      registry,
      SESSION,
    ),
    { type: 'commentary-delta', text: 'think' },
  );
  t.is(
    mapSseEvent(
      partDelta({ partID: 'prt_r', field: 'other', delta: 'x' }),
      registry,
      SESSION,
    ),
    undefined,
  );
});

test('emits the completed part text only when no deltas arrived', t => {
  const registry = makeMessageRegistry();
  registry.noteMessage({ id: 'msg_1', role: 'assistant' });
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_t',
        messageID: 'msg_1',
        type: 'text',
        text: 'full text',
        time: { end: 1 },
      }),
      registry,
      SESSION,
    ),
    { type: 'text-delta', text: 'full text' },
  );

  const registry2 = makeMessageRegistry();
  registry2.noteMessage({ id: 'msg_1', role: 'assistant' });
  registry2.notePart({ id: 'prt_t', messageID: 'msg_1', type: 'text' });
  registry2.noteDelta('prt_t');
  t.is(
    mapSseEvent(
      partUpdated({
        id: 'prt_t',
        messageID: 'msg_1',
        type: 'text',
        text: 'full text',
        time: { end: 1 },
      }),
      registry2,
      SESSION,
    ),
    undefined,
  );
});

test('maps tool parts to call and result events', t => {
  const registry = registryWithParts();
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_tool',
        messageID: 'msg_answer',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'running', input: { command: 'ls' } },
      }),
      registry,
      SESSION,
    ),
    { type: 'tool-call', id: 'call_1', name: 'bash', args: { command: 'ls' } },
  );
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_tool',
        messageID: 'msg_answer',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'completed', output: 'ok' },
      }),
      registry,
      SESSION,
    ),
    { type: 'tool-result', id: 'call_1', ok: true, result: 'ok' },
  );
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_tool',
        messageID: 'msg_answer',
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: { status: 'error', error: 'boom' },
      }),
      registry,
      SESSION,
    ),
    { type: 'tool-result', id: 'call_1', ok: false, error: 'boom' },
  );
  // A tool part without an id is dropped rather than emitting undefined ids.
  t.is(
    mapSseEvent(
      partUpdated({
        id: 'prt_bad',
        messageID: 'msg_answer',
        type: 'tool',
        tool: 'bash',
        state: { status: 'running', input: {} },
      }),
      registry,
      SESSION,
    ),
    undefined,
  );
});

test('maps step-finish tokens to usage and status to phase', t => {
  const registry = registryWithParts();
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_step',
        messageID: 'msg_answer',
        type: 'step-finish',
        tokens: { input: 12, output: 3 },
      }),
      registry,
      SESSION,
    ),
    { type: 'usage', inputTokens: 12, outputTokens: 3 },
  );
  t.deepEqual(
    mapSseEvent(
      partUpdated({
        id: 'prt_step',
        messageID: 'msg_answer',
        type: 'step-finish',
      }),
      registry,
      SESSION,
    ),
    undefined,
  );
  t.deepEqual(mapSseEvent(sessionStatus('busy'), registry, SESSION), {
    type: 'phase',
    phase: 'busy',
  });
  t.deepEqual(mapSseEvent(sessionStatus('idle'), registry, SESSION), {
    type: 'phase',
    phase: 'idle',
  });
  t.deepEqual(
    mapSseEvent(
      { type: 'session.idle', properties: { sessionID: SESSION } },
      registry,
      SESSION,
    ),
    { type: 'phase', phase: 'idle' },
  );
});

test('recognizes the synthetic compaction continuation', t => {
  t.true(
    isCompactionContinuation({
      type: 'text',
      synthetic: true,
      metadata: { compaction_continue: true },
    }),
  );
  t.false(isCompactionContinuation({ type: 'text', synthetic: true }));
  t.false(
    isCompactionContinuation({
      type: 'text',
      metadata: { compaction_continue: true },
    }),
  );
});

test('derives the terminal from turn state', t => {
  t.deepEqual(deriveTerminal({}), { type: 'end' });
  t.deepEqual(deriveTerminal({ pendingError: 'boom' }), {
    type: 'abort',
    reason: 'boom',
  });
  t.deepEqual(deriveTerminal({ timedOut: true }), {
    type: 'abort',
    reason: 'turn timeout',
  });
  t.deepEqual(deriveTerminal({ interrupted: true }), {
    type: 'abort',
    reason: 'interrupted',
  });
});

test('parses SSE frames across chunk boundaries', async t => {
  const payloads = [];
  const source = async function* chunks() {
    yield new TextEncoder().encode('data: {"n":1}\n');
    yield new TextEncoder().encode(
      '\n:heartbeat\n\ndata: {"n":2}\r\n\r\ndata: {"n":',
    );
    yield new TextEncoder().encode('3}\n\n');
    yield new TextEncoder().encode('data: not json\n\n');
  };
  for await (const payload of iterateSseData(source())) {
    payloads.push(payload);
  }
  t.deepEqual(payloads, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});
