// @ts-check
/**
 * Cross-restart conversation-continuity tests for lal's per-turn transcript
 * persistence (candidate H of the #290 memory-regression analysis).
 *
 * #290 migrated lal to a pi-agent-core PiAgent whose `state.messages` lived
 * only for the worker process's lifetime, so every daemon restart reset each
 * worker to a fresh `messages: []` and dropped the prior conversation. The
 * fix persists a per-turn delta (`pi-turn-<inboxNumber>`) at each
 * complete-assistant-message boundary and rehydrates `initialState.messages`
 * on spawn by sorted-concat of those deltas.
 *
 * These tests exercise the persistence layer (`persistTurnDelta` /
 * `loadPersistedTranscript`) directly against the in-memory mock powers, and
 * drive a scripted PiAgent (no provider call) the same way `spawnWorkerLoop`
 * does so the round-trip mirrors production message shapes.
 *
 * Strategy mirrors `pi-agent-tools.test.js`: a scripted `streamFn` supplies
 * each assistant turn from a queue so no LLM provider is contacted.
 */

import test from '@endo/ses-ava/prepare-endo.js';

import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

import {
  persistTurnDelta,
  loadPersistedTranscript,
} from '../agent.js';
import { makeMockPowers } from '../tools/mock-powers.js';

/** @type {any} */
const stubModel = harden({
  id: 'stub-model',
  name: 'stub/stub-model',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'http://invalid.example',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
});

/**
 * Build a scripted streamFn that yields a fresh stop-only assistant message
 * for each LLM call, recording the conversation context pi-agent-core passes
 * in so a test can assert how many prior messages the next round carries.
 *
 * @param {Array<any[]>} contexts - sink: each call appends the `context`
 *   argument pi-agent-core forwarded (the converted message array).
 * @param {Array<{content: any[], stopReason: string}>} [script]
 */
const makeScriptedStreamFn = (contexts, script = []) => {
  let turn = 0;
  return (_model, context, _options) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    /** @type {any} */
    const partial = harden({
      role: 'assistant',
      content: [],
      api: stubModel.api,
      provider: stubModel.provider,
      model: stubModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const next = script[turn] || {
      content: [{ type: 'text', text: `reply-${turn}` }],
      stopReason: 'stop',
    };
    turn += 1;
    /** @type {any} */
    const finalMessage = harden({
      ...partial,
      content: next.content,
      stopReason: next.stopReason,
    });
    stream.push({ type: 'start', partial });
    stream.push({
      type: 'done',
      reason: /** @type {'toolUse' | 'stop'} */ (
        next.stopReason === 'toolUse' ? 'toolUse' : 'stop'
      ),
      message: finalMessage,
    });
    stream.end(finalMessage);
    return stream;
  };
};

/**
 * Construct a PiAgent with a scripted streamFn, seeded with `messages`,
 * recording the per-round LLM context into `contexts`.
 *
 * @param {Array<any>} messages
 * @param {Array<any[]>} contexts
 */
const makeScriptedAgent = (messages, contexts) =>
  new PiAgent({
    initialState: {
      systemPrompt: 'You are a test stub.',
      model: stubModel,
      tools: [],
      messages,
      thinkingLevel: 'off',
    },
    convertToLlm: msgs =>
      msgs.filter(
        m =>
          m.role === 'user' ||
          m.role === 'assistant' ||
          m.role === 'toolResult',
      ),
    toolExecution: 'sequential',
    streamFn: makeScriptedStreamFn(contexts),
  });

test('persist+rehydrate: restored transcript deep-equals pre-restart messages', async t => {
  const { powers } = makeMockPowers();

  // --- Pre-restart worker: drive N turns, persisting each turn's delta the
  // way spawnWorkerLoop does (high-water mark before, slice after). ---
  const contextsBefore = [];
  const agent = makeScriptedAgent([], contextsBefore);

  const N = 3;
  for (let i = 1; i <= N; i += 1) {
    const priorLength = agent.state.messages.length;
    // eslint-disable-next-line no-await-in-loop
    await agent.prompt(`message ${i}`);
    // eslint-disable-next-line no-await-in-loop
    await agent.waitForIdle();
    const delta = agent.state.messages.slice(priorLength);
    // eslint-disable-next-line no-await-in-loop
    await persistTurnDelta(powers, BigInt(i), delta);
  }

  const preRestart = agent.state.messages;
  t.true(preRestart.length >= N, 'agent accumulated at least one msg per turn');

  // --- Simulate a daemon restart: a brand-new PiAgent seeded only from the
  // persistence layer. ---
  const restored = await loadPersistedTranscript(powers);
  t.deepEqual(
    restored,
    preRestart,
    'rehydrated messages deep-equal the pre-restart transcript',
  );

  // The fresh agent carries the prior context: its post-restart transcript
  // begins with every restored message and only grows from there.
  const contextsAfter = [];
  const freshAgent = makeScriptedAgent(restored, contextsAfter);
  t.deepEqual(
    freshAgent.state.messages.slice(0, preRestart.length),
    preRestart,
    'fresh agent spawns seeded with the full prior transcript',
  );
  await freshAgent.prompt('message after restart');
  await freshAgent.waitForIdle();
  t.true(contextsAfter.length >= 1, 'post-restart round made an LLM call');
  t.true(
    freshAgent.state.messages.length > preRestart.length,
    'post-restart round appends to the restored transcript, not a fresh one',
  );
});

test('persist: per-turn entries are deltas, not the growing full transcript', async t => {
  const { powers } = makeMockPowers();
  const contexts = [];
  const agent = makeScriptedAgent([], contexts);

  // Turn 1.
  let prior = agent.state.messages.length;
  await agent.prompt('first');
  await agent.waitForIdle();
  await persistTurnDelta(powers, 1n, agent.state.messages.slice(prior));

  // Turn 2.
  prior = agent.state.messages.length;
  await agent.prompt('second');
  await agent.waitForIdle();
  await persistTurnDelta(powers, 2n, agent.state.messages.slice(prior));

  const entry1 = await powers.lookup('pi-turn-1');
  const entry2 = await powers.lookup('pi-turn-2');
  t.is(entry1.schemaVersion, 1, 'entry carries current schemaVersion');
  t.is(entry1.inboxNumber, 1n, 'entry carries its inbox number for sorting');
  // Each entry holds only that turn's delta; entry2 does NOT re-include
  // entry1's messages (the candidate-H growth-profile invariant).
  t.deepEqual(
    [...entry1.messages, ...entry2.messages],
    agent.state.messages,
    'concatenated deltas reconstruct the full transcript without overlap',
  );
});

test('rehydrate: missing prefix yields empty transcript (fresh worker)', async t => {
  const { powers } = makeMockPowers();
  // A fresh worker has no pi-turn-* entries (only @self/@host seeded).
  const restored = await loadPersistedTranscript(powers);
  t.deepEqual(restored, [], 'fresh worker rehydrates to empty context');
});

test('rehydrate: corrupt/unreadable entry is dropped, never throws', async t => {
  const { powers } = makeMockPowers();
  // A pi-turn-* name whose value is malformed (messages not an array).
  await powers.storeValue(
    harden({ schemaVersion: 1, inboxNumber: 1n, messages: 'not-an-array' }),
    'pi-turn-1',
  );
  // A well-formed sibling so we can confirm the rehydrator keeps going.
  await powers.storeValue(
    harden({
      schemaVersion: 1,
      inboxNumber: 2n,
      messages: [{ role: 'user', content: 'kept' }],
    }),
    'pi-turn-2',
  );
  const restored = await loadPersistedTranscript(powers);
  t.deepEqual(
    restored,
    [{ role: 'user', content: 'kept' }],
    'malformed entry dropped; well-formed sibling survives',
  );
});

test('rehydrate: schemaVersion mismatch is dropped + skipped', async t => {
  const { powers } = makeMockPowers();
  await powers.storeValue(
    harden({
      schemaVersion: 999,
      inboxNumber: 1n,
      messages: [{ role: 'user', content: 'from-the-future' }],
    }),
    'pi-turn-1',
  );
  await powers.storeValue(
    harden({
      schemaVersion: 1,
      inboxNumber: 2n,
      messages: [{ role: 'user', content: 'current' }],
    }),
    'pi-turn-2',
  );
  const restored = await loadPersistedTranscript(powers);
  t.deepEqual(
    restored,
    [{ role: 'user', content: 'current' }],
    'unknown-schemaVersion entry dropped; current entry kept',
  );
});

test('integration (spawn-seam restart): post-restart round carries M+1 turns', async t => {
  // A true daemon restart (pkill the daemon worker + respawn) is infeasible
  // in this unit harness, so this emulates the restart at the worker-spawn
  // seam: drive M turns through one scripted PiAgent persisting each delta
  // exactly as `spawnWorkerLoop` does, then construct a *fresh* PiAgent
  // seeded only from `loadPersistedTranscript` (the same call the spawn path
  // makes before `new PiAgent`). The fresh agent is the post-restart worker;
  // we send one more message and assert its transcript reflects M+1 turns of
  // context rather than a single fresh turn.
  const { powers } = makeMockPowers();

  const M = 4;
  const beforeContexts = [];
  const beforeAgent = makeScriptedAgent([], beforeContexts);
  for (let i = 1; i <= M; i += 1) {
    const prior = beforeAgent.state.messages.length;
    // eslint-disable-next-line no-await-in-loop
    await beforeAgent.prompt(`pre-restart message ${i}`);
    // eslint-disable-next-line no-await-in-loop
    await beforeAgent.waitForIdle();
    // eslint-disable-next-line no-await-in-loop
    await persistTurnDelta(powers, BigInt(i), beforeAgent.state.messages.slice(prior));
  }
  const userTurnsBefore = beforeAgent.state.messages.filter(
    m => m.role === 'user',
  ).length;
  t.is(userTurnsBefore, M, 'pre-restart agent saw M user turns');

  // --- Restart at the spawn seam. ---
  const restored = await loadPersistedTranscript(powers);
  const afterContexts = [];
  const afterAgent = makeScriptedAgent(restored, afterContexts);

  await afterAgent.prompt('post-restart message');
  await afterAgent.waitForIdle();

  const userTurnsAfter = afterAgent.state.messages.filter(
    m => m.role === 'user',
  ).length;
  t.is(
    userTurnsAfter,
    M + 1,
    'post-restart round sees M+1 user turns of context (continuity restored)',
  );
});

test('rehydrate: entries are concatenated in inbox-number order, not list order', async t => {
  const { powers } = makeMockPowers();
  // Store out of order; rehydration must sort by inboxNumber. Use numbers
  // whose lexical order differs from numeric order (2 vs 10) to prove the
  // sort is numeric, not string.
  await powers.storeValue(
    harden({
      schemaVersion: 1,
      inboxNumber: 10n,
      messages: [{ role: 'user', content: 'tenth' }],
    }),
    'pi-turn-10',
  );
  await powers.storeValue(
    harden({
      schemaVersion: 1,
      inboxNumber: 2n,
      messages: [{ role: 'user', content: 'second' }],
    }),
    'pi-turn-2',
  );
  const restored = await loadPersistedTranscript(powers);
  t.deepEqual(
    restored,
    [
      { role: 'user', content: 'second' },
      { role: 'user', content: 'tenth' },
    ],
    'restored in numeric inbox order (2 before 10), not lexical',
  );
});
