// @ts-check
// The claude-cli branch of makeStreamingAgent: a session whose turns run
// against a ClaudeClient capability instead of a streaming API provider.
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeStreamingAgent } from '../agent.js';
import { makeReplyChannel } from '../src/stream.js';

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
  /** @type {Array<{ push: (event: object) => void, killed: () => boolean, prompt: string, opts: Record<string, unknown> }>} */
  const turns = [];
  const client = harden({
    async send(prompt, opts = {}) {
      let killed = false;
      const { push, reader, setOnClose } = makeBufferedReader();
      setOnClose(() => {
        killed = true;
      });
      turns.push({ push, killed: () => killed, prompt, opts: { ...opts } });
      return reader;
    },
  });
  return { client, turns };
};

// Drain a reply reader into a list of events (the shape the UI consumes).
const collectReply = async reader => {
  const events = [];
  for await (const value of iterateReader(reader)) {
    events.push(value);
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
    message: {
      content: [
        { type: 'text', text: 'building' },
        {
          type: 'tool_use',
          id: 'toolu_write',
          name: 'Write',
          input: { file_path: '/workspace/index.html' },
        },
      ],
    },
  });
  turns[0].push({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_write',
          content: 'wrote index.html',
        },
      ],
    },
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
    ['phase', 'delta', 'tool_call', 'tool_result', 'usage', 'final', 'end'],
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
  t.deepEqual(history, [
    { role: 'user', content: 'build the thing' },
    {
      role: 'tool',
      name: 'Write',
      args: '{"file_path":"/workspace/index.html"}',
      result: 'wrote index.html',
    },
    { role: 'assistant', content: 'Built the thing.' },
  ]);
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 20,
    outputTokens: 5,
    turns: 1,
  });
});

test('a codex-cli turn surfaces and persists tool activity', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { codexClient: client },
    'test prompt',
  );

  const { writer, reader } = makeReplyChannel();
  const replyP = collectReply(reader);
  const turnP = agent.converse('check health', writer);
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns.length, 1);
  turns[0].push({ type: 'thread.started', thread_id: 'thread-1' });
  turns[0].push({ type: 'turn.started' });
  turns[0].push({
    type: 'item.started',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'uptime',
      status: 'in_progress',
    },
  });
  turns[0].push({
    type: 'item.completed',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'uptime',
      aggregated_output: 'up 13 days',
      exit_code: 0,
      status: 'completed',
    },
  });
  turns[0].push({
    type: 'item.completed',
    item: { id: 'msg-1', type: 'agent_message', text: 'Healthy.' },
  });
  turns[0].push({
    type: 'turn.completed',
    usage: { input_tokens: 30, output_tokens: 6 },
  });
  turns[0].push({ type: 'end' });

  await turnP;
  const events = await replyP;
  t.deepEqual(
    events.map(event => event.type),
    [
      'phase',
      'phase',
      'phase',
      'tool_call',
      'phase',
      'phase',
      'tool_result',
      'phase',
      'delta',
      'usage',
      'final',
      'end',
    ],
  );
  t.deepEqual(await agent.getHistory(), [
    { role: 'user', content: 'check health' },
    {
      role: 'tool',
      name: 'shell',
      args: '{"command":"uptime"}',
      result: 'up 13 days',
    },
    { role: 'assistant', content: 'Healthy.' },
  ]);
});

test('a codex-cli turn persists a programmatic tool failure', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { codexClient: client },
    'test prompt',
  );

  const { writer, reader } = makeReplyChannel();
  const replyP = collectReply(reader);
  const turnP = agent.converse('check health', writer);
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  turns[0].push({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: 'call-health',
      name: 'exec',
      input: 'const r = await tools.mcp__endo__exec({ code: "health" });',
    },
  });
  turns[0].push({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call-health',
      output: [
        {
          type: 'input_text',
          text: 'MCP tool call requires approval, but approval policy is never',
        },
      ],
    },
  });
  turns[0].push({
    type: 'item.completed',
    item: { id: 'msg-1', type: 'agent_message', text: 'Blocked.' },
  });
  turns[0].push({ type: 'turn.completed', usage: {} });
  turns[0].push({ type: 'end' });

  await turnP;
  await replyP;
  t.deepEqual(await agent.getHistory(), [
    { role: 'user', content: 'check health' },
    {
      role: 'tool',
      name: 'exec',
      args: JSON.stringify({
        input: 'const r = await tools.mcp__endo__exec({ code: "health" });',
      }),
      result: 'MCP tool call requires approval, but approval policy is never',
    },
    { role: 'assistant', content: 'Blocked.' },
  ]);
});

test('a failed claude-cli turn aborts the reply but keeps the delivered prompt', async t => {
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

  // No assistant reply is persisted, but the user node stays on the active
  // branch: on the CLI path the model's memory is the sandbox transcript,
  // which already holds the delivered prompt — dropping it from the tree
  // would show a history the model does not match. Usage stays untouched.
  t.deepEqual(await agent.getHistory(), [{ role: 'user', content: 'do it' }]);
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});

test('stopping the reply kills the in-flight CLI turn', async t => {
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

  // The killed turn's partial output is persisted: the CLI's own transcript
  // retains the prompt and whatever streamed before the kill, so the tree
  // mirrors it — otherwise the next turn's displayed history and the
  // conversation the CLI resumes with --continue diverge. Usage is not
  // counted (no result event ever arrived).
  t.deepEqual(await agent.getHistory(), [
    { role: 'user', content: 'long task' },
    { role: 'assistant', content: 'working' },
  ]);
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});

test('the session model rides each CLI turn as a per-send override', async t => {
  t.timeout(20_000);
  const powers = makeFakePowers();
  const { client, turns } = makeFakeClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { claudeClient: client, claudeModel: 'claude-opus-5' },
    'test prompt',
  );

  const { writer, reader } = makeReplyChannel();
  const replyP = collectReply(reader);
  const turnP = agent.converse('hello', writer);
  for (let i = 0; i < 50 && turns.length === 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(turns.length, 1);
  // The client's own env default was frozen at provision time; the per-turn
  // override is what makes a later model change actually take effect.
  t.is(turns[0].opts.model, 'claude-opus-5');
  t.is(turns[0].opts.systemPrompt, 'test prompt');
  turns[0].push({ type: 'result', subtype: 'success', result: 'hi' });
  turns[0].push({ type: 'end' });
  await turnP;
  await replyP;
});
