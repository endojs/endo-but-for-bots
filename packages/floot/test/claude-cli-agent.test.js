// @ts-check
// The claude-cli branch of makeStreamingAgent: a session whose turns run
// against a ClaudeClient capability instead of a streaming API provider.
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

/** @import { ReplyEvent } from '../src/stream.js' */

// A minimal in-memory stand-in for a session guest's petstore powers: the
// surface makeEndoPetstoreBackend and the usage counter actually use.
const makeFakePowers = () => {
  /** @type {Map<string, unknown>} */
  const store = new Map();
  return harden({
    async storeValue(value, petName) {
      const name = Array.isArray(petName) ? petName.join('.') : petName;
      if (store.has(name)) throw Error(`already stored: ${name}`);
      store.set(name, value);
    },
    async lookup(petName) {
      const name = Array.isArray(petName) ? petName.join('.') : petName;
      if (!store.has(name)) throw Error(`not found: ${name}`);
      return store.get(name);
    },
    async has(petName) {
      const name = Array.isArray(petName) ? petName.join('.') : petName;
      return store.has(name);
    },
    async remove(petName) {
      const name = Array.isArray(petName) ? petName.join('.') : petName;
      store.delete(name);
    },
    async list() {
      return harden([...store.keys()]);
    },
    async followMessages() {
      // The inbox loop is not started in these tests.
      return harden({ [Symbol.asyncIterator]: () => harden({}) });
    },
  });
};

// A ClaudeClient stand-in: each send() hands back a fresh buffered reader that
// the test drives, mirroring the real per-turn reply wire.
const makeFakeClient = () => {
  let stop = () => {};
  /** @type {Array<{ push: (event: object) => void, killed: () => boolean }>} */
  const turns = [];
  const client = harden({
    async interrupt() {
      stop();
    },
    async send() {
      let killed = false;
      const { push, reader, close, setOnClose } = makeBufferedReader();
      stop = close;
      setOnClose(() => {
        killed = true;
      });
      turns.push({ push, killed: () => killed });
      return reader;
    },
  });
  return { client, turns };
};

// Drain a reply reader into a list of events (the shape the UI consumes).
const collectReply = async reader => {
  /** @type {ReplyEvent[]} */
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(/** @type {ReplyEvent} */ (value));
  }
  return events;
};

test('a claude-cli turn persists history and folds usage', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { claudeClient: client },
    'test prompt',
  );

  const { writer, reader } = makeReplyChannel();
  const replyP = collectReply(reader);
  const turnP = agent.converse('build the thing', writer);

  // Wait for the client to receive the turn, then drive its reply.
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns.length, 1);
  turns[0].push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'building' }] },
  });
  turns[0].push({
    type: 'result',
    subtype: 'success',
    result: 'Built the thing.',
    usage: { input_tokens: 20, output_tokens: 5 },
  });
  turns[0].push({ type: 'end' });

  await turnP;
  const events = await replyP;
  t.deepEqual(
    events.map(e => e.type),
    ['phase', 'delta', 'usage', 'final', 'end'],
    'the reply wire carries the same shape as an API-backed turn',
  );
  t.deepEqual(events.at(-2), { type: 'final', text: 'Built the thing.' });
  t.deepEqual(events.at(-3), {
    type: 'usage',
    inputTokens: 20,
    outputTokens: 5,
    turns: 1,
  });

  const history = await agent.getHistory();
  t.deepEqual(
    history.map(m => [m.role, m.content]),
    [
      ['user', 'build the thing'],
      ['assistant', 'Built the thing.'],
    ],
    'the CLI turn is persisted like any other',
  );
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 20,
    outputTokens: 5,
    turns: 1,
  });
});

test('a failed claude-cli turn aborts the reply and persists its failure', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { claudeClient: client },
    'test prompt',
  );

  const { writer, reader } = makeReplyChannel();
  const replyP = collectReply(reader);
  const turnP = agent.converse('do it', writer);
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  turns[0].push({ type: 'result', subtype: 'error_max_turns', is_error: true });
  turns[0].push({ type: 'end' });

  await t.throwsAsync(() => turnP, { message: /error_max_turns/ });
  const events = await replyP;
  t.is(events.at(-1)?.type, 'abort', 'the consumer learns the turn failed');

  const history = await agent.getHistory();
  t.is(history[0].content, 'do it');
  t.regex(history.at(-1)?.content || '', /Turn failed:.*error_max_turns/);
  t.is((await agent.getTurns())[0].state, 'failed');
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});

test('stopping the reply requests termination and retains an unknown outcome', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { claudeClient: client },
    'test prompt',
  );

  const controller = new AbortController();
  const { writer, reader } = makeReplyChannel(() => controller.abort());
  const replies = iterateReader(reader);
  const turnP = agent.converse(
    'long task',
    writer,
    undefined,
    controller.signal,
  );
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  turns[0].push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'working' }] },
  });
  t.deepEqual(await replies.next(), {
    value: { type: 'phase', phase: 'thinking' },
    done: false,
  });

  // The UI stops pulling: the reply channel's onClose aborts the signal, which
  // closes the CLI reader and kills the sandboxed turn.
  await replies.return();
  await turnP;
  t.true(turns[0].killed(), 'the in-flight claude -p was killed');

  const history = await agent.getHistory();
  t.is(history[0].content, 'long task');
  t.regex(history.at(-1)?.content || '', /unknown/i);
  t.is((await agent.getTurns())[0].state, 'outcome-unknown');
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});

for (const outcome of ['success', 'failed', 'unsettled']) {
  test(`legacy Claude ${outcome} keeps native tool evidence and usage after revival`, async t => {
    t.timeout(20_000);
    const powers = makeFakePowers();
    const { client, turns } = makeFakeClient();
    const agent = await makeStreamingAgent(
      powers,
      undefined,
      { claudeClient: client },
      'test prompt',
    );
    const { writer, reader } = makeReplyChannel();
    const replyP = collectReply(reader);
    const turnP = agent.converse('inspect source', writer);
    for (let i = 0; i < 100 && turns.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    t.is(turns.length, 1);
    turns[0].push({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Inspecting.' },
          {
            type: 'tool_use',
            id: 'native-read',
            name: 'Read',
            input: { path: 'source' },
          },
        ],
      },
    });
    if (outcome !== 'unsettled') {
      turns[0].push({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'native-read',
              content: 'source contents',
            },
          ],
        },
      });
    }
    turns[0].push({
      type: 'result',
      result: 'Read complete.',
      ...(outcome === 'failed'
        ? { is_error: true, subtype: 'error_max_turns' }
        : {}),
      usage: { input_tokens: 8, output_tokens: 3 },
    });
    turns[0].push({ type: 'end' });
    if (outcome === 'success') await turnP;
    else
      await t.throwsAsync(turnP, {
        message: outcome === 'unsettled' ? /effects unknown/ : /Read complete/,
      });
    await replyP;
    const revived = await makeStreamingAgent(
      powers,
      undefined,
      { claudeClient: client },
      'test prompt',
    );
    const [record] = await revived.getTurns();
    t.is(
      record.state,
      outcome === 'success'
        ? 'completed'
        : outcome === 'unsettled'
          ? 'outcome-unknown'
          : 'failed',
    );
    t.deepEqual(record.usage, { inputTokens: 8, outputTokens: 3 });
    t.like(record.activity[0], {
      callId: 'native-read',
      name: 'Read',
      args: '{"path":"source"}',
    });
    t.is(Boolean(record.activity[0].settled), outcome !== 'unsettled');
    if (outcome !== 'unsettled')
      t.is(record.activity[0].result, 'source contents');
    const history = await revived.getHistory();
    t.true(history.some(message => message.role === 'tool'));
    t.true(history.some(message => message.content === 'inspect source'));
    if (outcome === 'success')
      t.true(history.some(message => message.content === 'Read complete.'));
    else t.true(history.some(message => message.meta?.turnStatus));
    // The legacy cumulative counter counts completed turns; partial provider
    // usage remains available on the durable turn record checked above.
    t.deepEqual(
      await revived.getUsage(),
      outcome === 'success'
        ? {
            inputTokens: 8,
            outputTokens: 3,
            turns: 1,
          }
        : { inputTokens: 0, outputTokens: 0, turns: 0 },
    );
  });
}
