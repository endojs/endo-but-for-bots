// @ts-check
import '@endo/init';
import test from 'ava';

import { assertBridgeEvent, parseJsonLines } from '../src/opencode-protocol.js';

const streamOf = async function* streamOf(chunks) {
  for (const chunk of chunks) {
    yield new TextEncoder().encode(chunk);
  }
};

const collect = async chunks => {
  const values = [];
  for await (const value of parseJsonLines(streamOf(chunks))) {
    values.push(value);
  }
  return values;
};

test('parses newline-delimited JSON across arbitrary chunk boundaries', async t => {
  const values = await collect([
    '{"type":"phase","phase":"busy"}\n{"type":"text-',
    'delta","text":"he',
    'llo"}\n\n{"type":"end"}\n',
  ]);
  t.deepEqual(values, [
    { type: 'phase', phase: 'busy' },
    { type: 'text-delta', text: 'hello' },
    { type: 'end' },
  ]);
});

test('rejects malformed and oversized lines', async t => {
  await t.throwsAsync(collect(['{"type":"phase"\n']), {
    message: /malformed JSONL/,
  });
  await t.throwsAsync(collect(['[1,2,3]\n']), {
    message: /must be an object/,
  });
  await t.throwsAsync(
    parseJsonLines(streamOf([`{"type":"end","pad":"${'x'.repeat(64)}"}\n`]), {
      maxLineBytes: 32,
    }).next(),
    { message: /exceeded .* bytes/ },
  );
  await t.throwsAsync(
    parseJsonLines(streamOf(['{"type":"end"}\n']), { maxLineBytes: 0 }).next(),
    { message: /maxLineBytes/ },
  );
});

test('validates and projects bridge events by type', t => {
  t.deepEqual(
    assertBridgeEvent({ type: 'ready', sessionId: 'ses_1', port: 4096 }),
    {
      type: 'ready',
      sessionId: 'ses_1',
      port: 4096,
    },
  );
  t.deepEqual(assertBridgeEvent({ type: 'phase', phase: 'busy' }), {
    type: 'phase',
    phase: 'busy',
  });
  t.deepEqual(assertBridgeEvent({ type: 'text-delta', text: 'hi' }), {
    type: 'text-delta',
    text: 'hi',
  });
  t.deepEqual(assertBridgeEvent({ type: 'commentary-delta', text: 'hm' }), {
    type: 'commentary-delta',
    text: 'hm',
  });
  t.deepEqual(
    assertBridgeEvent({ type: 'tool-call', id: 'c1', name: 'bash' }),
    {
      type: 'tool-call',
      id: 'c1',
      name: 'bash',
    },
  );
  t.deepEqual(
    assertBridgeEvent({
      type: 'tool-call',
      id: 'c1',
      name: 'bash',
      args: { x: 1 },
    }),
    {
      type: 'tool-call',
      id: 'c1',
      name: 'bash',
      args: { x: 1 },
    },
  );
  t.deepEqual(
    assertBridgeEvent({ type: 'tool-result', id: 'c1', ok: false, error: 'x' }),
    {
      type: 'tool-result',
      id: 'c1',
      ok: false,
      error: 'x',
    },
  );
  t.deepEqual(
    assertBridgeEvent({
      type: 'tool-result',
      id: 'c1',
      ok: true,
      result: 'out',
    }),
    {
      type: 'tool-result',
      id: 'c1',
      ok: true,
      result: 'out',
    },
  );
  t.deepEqual(
    assertBridgeEvent({ type: 'usage', inputTokens: 1, outputTokens: 2 }),
    {
      type: 'usage',
      inputTokens: 1,
      outputTokens: 2,
    },
  );
  t.deepEqual(assertBridgeEvent({ type: 'end', checkpoint: 't1' }), {
    type: 'end',
    checkpoint: 't1',
  });
  t.deepEqual(assertBridgeEvent({ type: 'abort' }), {
    type: 'abort',
    reason: 'aborted',
  });
  // Unknown extra fields are dropped.
  t.deepEqual(assertBridgeEvent({ type: 'text-delta', text: 'a', extra: 1 }), {
    type: 'text-delta',
    text: 'a',
  });
});

test('rejects invalid bridge events', t => {
  t.throws(() => assertBridgeEvent(null), { message: /must be a record/ });
  t.throws(() => assertBridgeEvent([]), { message: /must be a record/ });
  t.throws(() => assertBridgeEvent({ type: 'nope' }), {
    message: /unknown opencode bridge event type/,
  });
  t.throws(() => assertBridgeEvent({ type: 'ready', port: 1 }), {
    message: /sessionId/,
  });
  t.throws(() => assertBridgeEvent({ type: 'ready', sessionId: 's' }), {
    message: /port/,
  });
  t.throws(() => assertBridgeEvent({ type: 'phase', phase: 'nope' }), {
    message: /invalid phase/,
  });
  t.throws(() => assertBridgeEvent({ type: 'text-delta' }), {
    message: /needs text/,
  });
  t.throws(() => assertBridgeEvent({ type: 'tool-call', id: 'c' }), {
    message: /needs a name/,
  });
  t.throws(() => assertBridgeEvent({ type: 'tool-result', id: 'c' }), {
    message: /needs ok/,
  });
  t.throws(
    () =>
      assertBridgeEvent({ type: 'usage', inputTokens: -1, outputTokens: 1 }),
    {
      message: /inputTokens/,
    },
  );
});
