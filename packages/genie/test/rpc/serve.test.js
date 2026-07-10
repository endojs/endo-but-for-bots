// @ts-check

/**
 * End-to-end test for `serveRpc`: a real async byte stream in, LF-delimited
 * JSON out. This exercises the whole pipeline — strict framing, JSON
 * parsing, dispatch, and output encoding — over chunk boundaries that fall
 * in the middle of records, proving the decoder reassembles them.
 */

import '@endo/harden';

import test from 'ava';

import { serveRpc } from '../../src/rpc/serve.js';

// An async iterable that yields the given string chunks in order.
const streamOf = chunks => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) {
      yield chunk;
    }
  },
});

/** A collecting stand-in for a writable stream. */
const makeSink = () => {
  /** @type {string[]} */
  const writes = [];
  return {
    writes,
    stream: { write: text => writes.push(text) },
    records: () =>
      writes
        .join('')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line)),
  };
};

/** A synchronous fake session that emits a scripted round on prompt. */
const makeFakeSession = () => {
  /** @type {((event: unknown) => void) | undefined} */
  let listener;
  return {
    subscribe: l => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      listener?.({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      });
      listener?.({
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', delta: 'Hi' },
      });
      listener?.({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      });
      listener?.({ type: 'agent_end', messages: [] });
    },
    abort: () => {},
    steer: () => {},
    describeModel: () => 'test/model',
    listModels: () => ({ providers: ['ollama'], models: [] }),
    setModel: async () => {},
  };
};

test('serveRpc — dispatches synchronous commands across split chunks', async t => {
  const sink = makeSink();
  // The `list_models` record is split across two chunks; a malformed line
  // and a blank line are interleaved to prove they are handled per record.
  await serveRpc({
    input: streamOf([
      '{"id":"a","type":"get_stat',
      'us"}\n{"id":"b","type":"list_mod',
      'els"}\n\nnot-json\n',
    ]),
    output: sink.stream,
    session: makeFakeSession(),
  });

  const records = sink.records();
  t.is(records.length, 3);
  t.deepEqual(records[0], {
    type: 'status',
    model: 'test/model',
    busy: false,
    id: 'a',
  });
  t.deepEqual(records[1], {
    type: 'models',
    providers: ['ollama'],
    models: [],
    id: 'b',
  });
  t.is(records[2].type, 'error');
  t.regex(records[2].message, /invalid JSON/);
});

test('serveRpc — streams a full prompt round to the output', async t => {
  const sink = makeSink();
  await serveRpc({
    input: streamOf(['{"id":"1","type":"prompt","message":"hello"}\n']),
    output: sink.stream,
    session: makeFakeSession(),
  });

  const records = sink.records();
  t.deepEqual(
    records.map(r => r.type),
    ['message_start', 'message_update', 'message_end', 'agent_end'],
  );
  t.true(records.every(r => r.id === '1'));
  t.is(records[1].delta, 'Hi');
});

test('serveRpc — surfaces a trailing unterminated line at end of input', async t => {
  const sink = makeSink();
  // No trailing newline on the final command; flush must still deliver it.
  await serveRpc({
    input: streamOf(['{"id":"z","type":"get_status"}']),
    output: sink.stream,
    session: makeFakeSession(),
  });
  const records = sink.records();
  t.is(records.length, 1);
  t.is(records[0].id, 'z');
  t.is(records[0].type, 'status');
});

test('serveRpc — an unencodable record yields a fallback error, not a throw', async t => {
  const sink = makeSink();
  /** @type {((event: unknown) => void) | undefined} */
  let listener;
  const session = {
    subscribe: l => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      // A BigInt in the relayed message cannot be JSON-encoded; the writer
      // must fall back to an error record rather than throwing and tearing
      // down the whole stream.
      listener?.({ type: 'message_end', message: { size: 1n } });
      listener?.({ type: 'agent_end', messages: [] });
    },
    abort: () => {},
    steer: () => {},
    describeModel: () => 'test/model',
    listModels: () => ({ providers: [], models: [] }),
    setModel: async () => {},
  };

  await serveRpc({
    input: streamOf(['{"id":"1","type":"prompt","message":"hi"}\n']),
    output: sink.stream,
    session,
  });

  const records = sink.records();
  const failure = records.find(r => r.type === 'error');
  t.truthy(failure);
  t.regex(failure.message, /failed to encode message_end event/);
  // The following agent_end still encodes and is delivered.
  t.true(records.some(r => r.type === 'agent_end'));
});

test('serveRpc — diagnostics go to errorOutput, not the protocol stream', async t => {
  const out = makeSink();
  const err = makeSink();

  await serveRpc({
    input: streamOf(['{"type":"boop"}\n']),
    output: out.stream,
    errorOutput: err.stream,
    session: makeFakeSession(),
  });

  // The unknown-command diagnostic lands on errorOutput...
  t.true(err.writes.join('').includes('ignoring unknown command type: boop'));
  // ...while the protocol stream on output carries only the error record.
  const records = out.records();
  t.is(records.length, 1);
  t.is(records[0].type, 'error');
  t.regex(records[0].message, /unknown command type: boop/);
});
