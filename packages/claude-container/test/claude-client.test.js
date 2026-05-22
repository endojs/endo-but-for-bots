// @ts-nocheck
/* global Buffer */
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';

import { makeClaudeClient } from '../src/claude-client.js';

/**
 * Minimal orchestrator stub. Only `sendPrompt` and `terminateSession`
 * are touched by the assertions below; `createSession` / `markReady`
 * aren't called from `makeClaudeClient`.
 */
const makeStubOrchestrator = ({ onSendPrompt } = {}) => ({
  async createSession() {
    throw new Error('createSession unused in client unit tests');
  },
  async markReady() {},
  async terminateSession() {},
  async sendPrompt(session, prompt, opts) {
    if (onSendPrompt) onSendPrompt(session, prompt, opts);
    // Return an empty async iterable so `send()` resolves to a Far
    // iterator over zero events.
    return (async function* () {})();
  },
});

const baseSession = () => ({
  id: 'session-test-0001',
  fsSocketPath: '/tmp/test-fs.sock',
  attachSocketPath: '/tmp/test-attach.sock',
  createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
});

test('interrupt() throws the documented v1 shape', async t => {
  // ClaudeClient.help() advertises `interrupt() — not implemented in
  // v1 (throws)` and the impl in claude-client.js threads that promise
  // through `makeError(X\`ClaudeClient.interrupt is not implemented in
  // v1.\`)`. Pin the throw so the help text and the impl can't drift
  // apart silently again.
  const orchestrator = makeStubOrchestrator();
  const client = makeClaudeClient({
    session: baseSession(),
    orchestrator,
    bridge: {},
  });

  await t.throwsAsync(() => client.interrupt(), {
    message: /ClaudeClient\.interrupt is not implemented in v1\./,
  });
});

test('status() reports the session id and live state', async t => {
  const orchestrator = makeStubOrchestrator();
  const session = baseSession();
  const client = makeClaudeClient({
    session,
    orchestrator,
    bridge: {},
  });

  const status = await client.status();
  t.is(status.sessionId, session.id);
  t.is(status.createdAt, session.createdAt);
  t.false(status.terminated);
});

test('terminate() flips status.terminated and rejects subsequent send', async t => {
  const orchestrator = makeStubOrchestrator();
  const client = makeClaudeClient({
    session: baseSession(),
    orchestrator,
    bridge: {},
  });

  await client.terminate();

  const status = await client.status();
  t.true(status.terminated);
  await t.throwsAsync(() => client.send('anything'), {
    message: /is terminated/,
  });
});
