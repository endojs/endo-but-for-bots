// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order, no-empty-function, no-plusplus, no-await-in-loop */

/**
 * ClaudeCredentials factory tests (R3).
 */

import '@endo/init';
import test from 'ava';

import { make } from '../src/claude-credentials-factory.js';

const makeMockPowers = ({ hostAgent }) => {
  const formCalls = [];
  const replies = [];
  const pendingMessages = [];
  let nextWaiter = null;
  let formMessageNumber = 0;
  let currentFormId = null;

  const pushMessage = msg => {
    if (nextWaiter) {
      const w = nextWaiter;
      nextWaiter = null;
      w({ value: msg, done: false });
    } else {
      pendingMessages.push(msg);
    }
  };

  const messageIterator = {
    async next() {
      if (pendingMessages.length > 0) {
        return { value: pendingMessages.shift(), done: false };
      }
      return new Promise(resolve => {
        nextWaiter = resolve;
      });
    },
  };

  const valueStore = new Map();

  const powers = {
    async form(_t, _d, fields) {
      formCalls.push({ fields });
      formMessageNumber += 1;
      currentFormId = `form-${formMessageNumber}`;
      pushMessage({
        from: 'self-id',
        type: 'form',
        messageId: currentFormId,
        number: formMessageNumber,
      });
    },
    async lookup(name) {
      if (name === 'host-agent') return hostAgent;
      throw new Error(`unknown lookup: ${name}`);
    },
    async locate(name) {
      if (name === '@self') return 'self-id';
      throw new Error(`unknown locate: ${name}`);
    },
    async listMessages() {
      return [];
    },
    followMessages() {
      return messageIterator;
    },
    async lookupById(id) {
      return valueStore.get(id);
    },
    async reply(number, body, _a, _t) {
      replies.push({ number, body });
    },
  };

  return {
    powers,
    formCalls,
    replies,
    simulateSubmission(values, { number, replyTo } = {}) {
      const id = `value-${Date.now()}-${Math.random()}`;
      valueStore.set(id, values);
      pushMessage({
        from: 'host-id',
        type: 'value',
        number: number ?? ++formMessageNumber,
        replyTo: replyTo ?? currentFormId,
        valueId: id,
      });
    },
  };
};

const makeMockHostAgent = () => {
  const stored = new Map();
  return {
    storedValues: stored,
    async storeValue(value, name) {
      stored.set(name, value);
    },
  };
};

const waitFor = async (pred, deadlineMs = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > deadlineMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('factory presents the Create Claude Credentials form', async t => {
  const hostAgent = makeMockHostAgent();
  const mock = makeMockPowers({ hostAgent });
  const exo = make(mock.powers, undefined, { inProcessFactory: true });
  t.regex(exo.help(), /ClaudeCredentialsFactory/);
  await waitFor(() => mock.formCalls.length > 0);
  const names = mock.formCalls[0].fields.map(f => f.name);
  t.deepEqual(names, ['name', 'apiKey']);
});

test('form submission stores a ClaudeCredentials under the chosen name', async t => {
  const hostAgent = makeMockHostAgent();
  const mock = makeMockPowers({ hostAgent });
  make(mock.powers, undefined, { inProcessFactory: true });
  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'my-creds', apiKey: 'sk-ant-xyz' });
  await waitFor(() => hostAgent.storedValues.size > 0);
  t.true(hostAgent.storedValues.has('my-creds'));

  const cred = hostAgent.storedValues.get('my-creds');
  const issued = await cred.issue('session-1');
  // `issue` now returns an IssuedCredential cap, not a `{apiKey}` bag.
  // The key bytes only flow at `materialise` time, single-shot.
  t.is(await issued.materialise(), 'sk-ant-xyz');
  await t.throwsAsync(() => issued.materialise(), {
    message: /single-shot/,
  });
});

test('rotate replaces the stored key and invalidates outstanding grants', async t => {
  const hostAgent = makeMockHostAgent();
  const mock = makeMockPowers({ hostAgent });
  make(mock.powers, undefined, { inProcessFactory: true });
  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'c', apiKey: 'sk-old' });
  await waitFor(() => hostAgent.storedValues.size > 0);
  const cred = hostAgent.storedValues.get('c');
  // Issue a grant *before* rotating; the rotation must invalidate it.
  const stale = await cred.issue('session-1');
  await cred.rotate('sk-new');
  await t.throwsAsync(() => stale.materialise(), {
    message: /revoked or rotated/,
  });
  // Fresh grants after rotation see the new key.
  const fresh = await cred.issue('session-2');
  t.is(await fresh.materialise(), 'sk-new');
});

test('rotate rejects empty string', async t => {
  const hostAgent = makeMockHostAgent();
  const mock = makeMockPowers({ hostAgent });
  make(mock.powers, undefined, { inProcessFactory: true });
  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'c', apiKey: 'sk-old' });
  await waitFor(() => hostAgent.storedValues.size > 0);
  const cred = hostAgent.storedValues.get('c');
  await t.throwsAsync(() => cred.rotate(''), { message: /EINVAL/ });
});

test('missing apiKey rejects with form error reply', async t => {
  const hostAgent = makeMockHostAgent();
  const mock = makeMockPowers({ hostAgent });
  make(mock.powers, undefined, { inProcessFactory: true });
  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'c' });
  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /Missing "apiKey"/);
  t.is(hostAgent.storedValues.size, 0);
});
