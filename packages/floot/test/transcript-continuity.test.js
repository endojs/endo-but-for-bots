// @ts-check
// A hosted backend whose continuity is its own transcript (a CLI resuming the
// conversation it persisted) retains every delivered prompt and whatever
// streamed before a stop or a failure. The tree is display-only on that path,
// so it must mirror what the transcript retains, or the history the UI shows
// and the context the model resumes with drift apart.
import test from '@endo/ses-ava/prepare-endo.js';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { Far } from '@endo/far';

import {
  makeStreamingAgent,
  resolveSharedWorkspaceHostPath,
} from '../agent.js';
import { UNSETTLED_TOOL_RESULT } from '../src/hosted-turn.js';
import { makeReplyChannel } from '../src/stream.js';
import { makeFlootToolRegistry } from '../src/tool-registry.js';

const makeFakePowers = () => {
  const store = new Map();
  const nameOf = petName =>
    Array.isArray(petName) ? petName.join('.') : petName;
  return harden({
    async storeValue(value, petName) {
      const name = nameOf(petName);
      if (store.has(name)) throw Error(`already stored: ${name}`);
      store.set(name, value);
    },
    async lookup(petName) {
      const name = nameOf(petName);
      if (!store.has(name)) throw Error(`not found: ${name}`);
      return store.get(name);
    },
    async has(petName) {
      return store.has(nameOf(petName));
    },
    async remove(petName) {
      store.delete(nameOf(petName));
    },
    async list() {
      return harden([...store.keys()]);
    },
    async followMessages() {
      return harden({ [Symbol.asyncIterator]: () => harden({}) });
    },
  });
};

// A hosted client whose send() hands back a buffered reader the test drives.
const makeFakeHostedClient = () => {
  /** @type {Array<ReturnType<typeof makeBufferedReader>>} */
  const turns = [];
  const client = harden({
    async send() {
      const channel = makeBufferedReader();
      turns.push(channel);
      return channel.reader;
    },
    async interrupt() {
      await null;
    },
  });
  return { client, turns };
};

/**
 * @param {Array<unknown>} turns
 * @param {number} count
 */
const waitForTurn = async (turns, count) => {
  await null;
  for (let tries = 0; turns.length < count && tries < 100; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
};

test('a stopped turn on a transcript backend keeps the prompt and partial reply', async t => {
  const powers = makeFakePowers();
  const { client, turns } = makeFakeHostedClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: client },
    'test prompt',
    { hostedContinuity: 'transcript' },
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
  await waitForTurn(turns, 1);
  turns[0].push({ type: 'tool-call', id: 'tool-1', name: 'Write', args: '{}' });
  turns[0].push({
    type: 'tool-result',
    id: 'tool-1',
    name: 'Write',
    result: 'wrote index.html',
  });
  turns[0].push({ type: 'text-delta', text: 'working' });
  // Let the turn process everything that streamed: the persisted partial turn
  // mirrors what the model was shown, so the stop must land after it.
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await replies.next();
    if (done || /** @type {any} */ (value).type === 'delta') break;
  }
  // The UI stops pulling: the reply channel's onClose aborts the signal.
  await replies.return();
  await turnP;

  t.deepEqual(await agent.getHistory(), [
    { role: 'user', content: 'long task' },
    { role: 'tool', name: 'Write', args: '{}', result: 'wrote index.html' },
    { role: 'assistant', content: 'working' },
  ]);
  // Nothing completed: usage is not counted.
  t.deepEqual(await agent.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});

test('a failed turn on a transcript backend keeps the delivered prompt', async t => {
  const powers = makeFakePowers();
  const { client, turns } = makeFakeHostedClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: client },
    'test prompt',
    { hostedContinuity: 'transcript' },
  );
  const { writer, reader } = makeReplyChannel();
  const replyP = (async () => {
    /** @type {Array<any>} */
    const events = [];
    for await (const event of iterateReader(reader)) events.push(event);
    return events;
  })();
  const turnP = agent.converse('do it', writer);
  await waitForTurn(turns, 1);
  // The backend took the prompt (it started the turn), then failed it.
  turns[0].push({ type: 'phase', phase: 'claude session starting' });
  turns[0].push({
    type: 'abort',
    reason: 'claude turn failed: error_max_turns',
  });
  await t.throwsAsync(() => turnP, { message: /error_max_turns/ });
  const events = await replyP;
  t.is(events.at(-1)?.type, 'abort');

  t.deepEqual(await agent.getHistory(), [{ role: 'user', content: 'do it' }]);

  // The next turn builds on that prompt rather than orphaning it.
  const second = makeReplyChannel();
  const secondP = agent.converse('retry', second.writer);
  await waitForTurn(turns, 2);
  turns[1].push({ type: 'text-delta', text: 'done' });
  turns[1].push({ type: 'end' });
  await secondP;
  t.deepEqual(
    (await agent.getHistory()).map(message => message.content),
    ['do it', 'retry', 'done'],
  );
});

test('a failed turn keeps the tool activity and text that streamed before it', async t => {
  // error_max_turns and error_during_execution end a turn whose transcript
  // already holds every tool round and the text before the error.
  const powers = makeFakePowers();
  const { client, turns } = makeFakeHostedClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: client },
    'test prompt',
    { hostedContinuity: 'transcript' },
  );
  const { writer } = makeReplyChannel();
  const turnP = agent.converse('build it', writer);
  await waitForTurn(turns, 1);
  turns[0].push({ type: 'tool-call', id: 'tool-1', name: 'Write', args: '{}' });
  turns[0].push({
    type: 'tool-result',
    id: 'tool-1',
    name: 'Write',
    result: 'wrote index.html',
  });
  turns[0].push({ type: 'tool-call', id: 'tool-2', name: 'Read', args: '{}' });
  turns[0].push({ type: 'text-delta', text: 'almost' });
  turns[0].push({
    type: 'abort',
    reason: 'claude turn failed: error_max_turns',
  });
  await t.throwsAsync(() => turnP, { message: /error_max_turns/ });
  t.deepEqual(await agent.getHistory(), [
    { role: 'user', content: 'build it' },
    { role: 'tool', name: 'Write', args: '{}', result: 'wrote index.html' },
    { role: 'tool', name: 'Read', args: '{}', result: UNSETTLED_TOOL_RESULT },
    { role: 'assistant', content: 'almost' },
  ]);
});

test('a prompt the backend never took is not mirrored', async t => {
  // A spawn refusal, or a stop before dispatch, arrives as a leading abort:
  // the transcript has no such prompt, so the tree must not show one.
  const powers = makeFakePowers();
  const { client, turns } = makeFakeHostedClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: client },
    'test prompt',
    { hostedContinuity: 'transcript' },
  );
  const { writer } = makeReplyChannel();
  const turnP = agent.converse('do it', writer);
  await waitForTurn(turns, 1);
  turns[0].push({ type: 'abort', reason: 'claude exited with code 1' });
  await t.throwsAsync(() => turnP, { message: /code 1/ });
  t.deepEqual(await agent.getHistory(), []);
});

test('a checkpoint-reconciled backend still drops a stopped or failed turn', async t => {
  const powers = makeFakePowers();
  const { client, turns } = makeFakeHostedClient();
  const agent = await makeStreamingAgent(
    powers,
    undefined,
    { hostedClient: client },
    'test prompt',
    { hostedContinuity: 'opaque-reconciled' },
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
  await waitForTurn(turns, 1);
  turns[0].push({ type: 'text-delta', text: 'working' });
  await replies.next();
  await replies.return();
  await turnP;
  t.deepEqual(await agent.getHistory(), []);
});

test('extra tools join the session catalog beside the built-ins', async t => {
  const powers = Far('SessionPowers', {
    list: async () => harden([]),
    lookup: async () => {
      throw Error('no stored tools');
    },
  });
  const publish = harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'publishWorkspace',
          description: 'publish',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => 'http://host/token/',
    help: () => 'publish',
  });
  const registry = makeFlootToolRegistry(powers, {
    extraTools: new Map([['publishWorkspace', publish]]),
  });
  const snapshot = await registry.snapshot();
  t.true(snapshot.names.includes('publishWorkspace'));
  t.true(snapshot.names.includes('exec'));
  t.is(await snapshot.execute('publishWorkspace', {}), 'http://host/token/');
  const without = await makeFlootToolRegistry(powers).snapshot();
  t.not(
    snapshot.toolSetId,
    without.toolSetId,
    'a pinned hosted thread cannot silently resume with different powers',
  );
});

test('resolveSharedWorkspaceHostPath resolves a git workspace worktree', async t => {
  const worktree = Far('Worktree', {});
  const workspace = Far('EndoGit', {
    worktree: async () => worktree,
    status: async () => harden({ entries: [], truncated: false }),
  });
  const guest = Far('Guest', {
    has: async name => name === 'workspace',
    lookup: async name => {
      if (name !== 'workspace') throw Error('missing');
      return workspace;
    },
  });
  const host = Far('Host', {
    provideHostPath: async mount => {
      t.is(mount, worktree);
      return '/var/lib/endo/scratch/session-a';
    },
  });
  const resolved = await resolveSharedWorkspaceHostPath(host, guest);
  t.is(resolved, '/var/lib/endo/scratch/session-a');

  // The preset names the workspace: a git workspace bound under another pet
  // name resolves by that name.
  const named = Far('Guest', {
    has: async name => name === 'project',
    lookup: async name => {
      if (name !== 'project') throw Error('missing');
      return workspace;
    },
  });
  t.is(
    await resolveSharedWorkspaceHostPath(host, named, 'project'),
    '/var/lib/endo/scratch/session-a',
  );

  // No workspace, or a workspace that is not a git repository: nothing to
  // share, and never an error.
  const bare = Far('Guest', { has: async () => false, lookup: async () => {} });
  t.is(await resolveSharedWorkspaceHostPath(host, bare), undefined);
  const plainMount = Far('Guest', {
    has: async () => true,
    lookup: async () => Far('Mount', { list: async () => harden([]) }),
  });
  t.is(await resolveSharedWorkspaceHostPath(host, plainMount), undefined);
});
