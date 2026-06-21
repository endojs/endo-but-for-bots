// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order, no-empty-function, no-plusplus */

import '@endo/init';
import test from 'ava';

import { make } from '../src/claude-sandbox-factory.js';

// `E(target)` deep-hardens its target. Recording arrays therefore stay
// in closures (returned via a separate wrapper) rather than as
// properties on the objects the factory drives through `E()`. `Map`
// instances survive `harden` (their data lives in internal slots, not
// frozen own-properties), so recorders can be Maps/arrays in closures.
//
// Post-refactor the factory no longer mounts / mints slices itself: it
// validates the submission and formulates a first-class `claude-client`
// caplet via `hostAgent.makeUnconfined`. These tests assert that
// formulation (the specifier + env); the mount/slice/credential
// behaviour is covered by `claude-client-module.test.js`.

/**
 * Mock guest powers. The factory consumes the message stream via the
 * injected `iterateMessages` (see `make(..., { iterateMessages })`),
 * which returns this mock's simple `.next()` iterator directly.
 */
const makeMockPowers = () => {
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
    async form(_target, _description, fields) {
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
      if (name === 'host-agent') return powers.hostAgent;
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
      return harden({ kind: 'fake-reader' });
    },
    async lookupById(id) {
      return valueStore.get(id);
    },
    async reply(number, body) {
      replies.push({ number, body });
    },
  };

  return {
    powers,
    formCalls,
    replies,
    iterateMessages: () => messageIterator,
    setHostAgent(hostAgent) {
      powers.hostAgent = hostAgent;
    },
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

const makeMockHostAgent = ({ filesystems = {} } = {}) => {
  const unconfinedCalls = [];
  const hostAgent = {
    async lookup(name) {
      if (name in filesystems) return filesystems[name];
      return undefined;
    },
    async makeUnconfined(powersName, specifier, opts) {
      unconfinedCalls.push({ powersName, specifier, opts });
      return harden({ kind: 'fake-client', name: opts.resultName });
    },
  };
  return { hostAgent, unconfinedCalls };
};

const waitFor = async (pred, deadlineMs = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > deadlineMs) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 10));
  }
};

const wireDeps = (mock, host) => {
  mock.setHostAgent(host.hostAgent);
  return { iterateMessages: mock.iterateMessages };
};

test('factory presents the Create Claude Sandbox form to @host', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent();

  const exo = make(mock.powers, undefined, wireDeps(mock, host));

  t.regex(exo.help(), /ClaudeSandboxFactory/);
  await waitFor(() => mock.formCalls.length > 0);
  const names = mock.formCalls[0].fields.map(f => f.name);
  t.deepEqual(names, [
    'name',
    'filesystem',
    'rootfs',
    'network',
    'model',
    'credentials',
    'initialPrompt',
  ]);
});

test('submission formulates a claude-client caplet with the right env', async t => {
  const fsCap = { kind: 'fake-fs' };
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: { 'my-fs': fsCap } });

  make(mock.powers, undefined, wireDeps(mock, host));

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'my-claude',
    filesystem: 'my-fs',
    network: 'private',
    credentials: 'my-creds',
    model: 'claude-sonnet-4-6',
  });

  await waitFor(() => host.unconfinedCalls.length > 0);
  const call = host.unconfinedCalls[0];

  // First-class formulation, stored under the chosen pet name.
  t.is(call.powersName, '@main');
  t.regex(call.specifier, /claude-client-module\.js$/);
  t.is(call.opts.resultName, 'my-claude');
  t.is(call.opts.powersName, '@agent');

  const { env } = call.opts;
  t.is(env.FILESYSTEM_NAME, 'my-fs');
  t.is(env.NETWORK, 'private');
  t.is(env.CREDENTIALS_NAME, 'my-creds');
  t.is(env.MODEL, 'claude-sonnet-4-6');
  t.is(env.BACKEND, 'podman');
  t.is(env.WORKSPACE_PATH, '/workspace');
  t.regex(env.SESSION_ID, /^my-claude-/);
  t.regex(env.WORKSPACE_MOUNT_POINT, /claude-sandbox-my-claude-/);
  // No secret is threaded through the formula env — only the pet name.
  t.is(env.ANTHROPIC_API_KEY, undefined);
  t.is(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /ClaudeClient "my-claude" created/);
});

test('createSession() formulates an un-named client and returns the cap', async t => {
  const fsCap = { kind: 'fake-fs' };
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: { 'my-fs': fsCap } });

  const factory = make(mock.powers, undefined, wireDeps(mock, host));

  const client = await factory.createSession(
    harden({
      name: 'peer-claude',
      filesystem: 'my-fs',
      network: 'private',
      credentials: 'peer-creds',
    }),
  );

  t.is(host.unconfinedCalls.length, 1);
  const call = host.unconfinedCalls[0];
  t.regex(call.specifier, /claude-client-module\.js$/);
  // Peer-rooted: NOT stored under a host pet name.
  t.is(call.opts.resultName, undefined);
  t.is(call.opts.powersName, '@agent');
  t.is(call.opts.env.FILESYSTEM_NAME, 'my-fs');
  t.is(call.opts.env.CREDENTIALS_NAME, 'peer-creds');
  // The cap is returned to the caller, not stored.
  t.is(client.kind, 'fake-client');
});

test('createSession() rejects an unknown filesystem', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: {} });
  const factory = make(mock.powers, undefined, wireDeps(mock, host));

  await t.throwsAsync(
    () => factory.createSession(harden({ name: 'x', filesystem: 'missing' })),
    { message: /Unknown filesystem/ },
  );
  t.is(host.unconfinedCalls.length, 0);
});

test('submission with an unknown filesystem replies with an error', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: {} });

  make(mock.powers, undefined, wireDeps(mock, host));

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'x', filesystem: 'missing-fs' });

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /Error creating sandbox/);
  t.is(host.unconfinedCalls.length, 0);
});

test('submission with an unknown network profile is rejected', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({
    filesystems: { 'my-fs': { kind: 'fake-fs' } },
  });

  make(mock.powers, undefined, wireDeps(mock, host));

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'x',
    filesystem: 'my-fs',
    network: 'wide-open',
  });

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /Unknown network profile/);
  t.is(host.unconfinedCalls.length, 0);
});

test('duplicate form replies are ignored (replay guard)', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({
    filesystems: { 'my-fs': { kind: 'fake-fs' } },
  });

  make(mock.powers, undefined, wireDeps(mock, host));

  await waitFor(() => mock.formCalls.length > 0);
  const payload = { name: 'replay', filesystem: 'my-fs', network: 'private' };
  mock.simulateSubmission(payload, { number: 99, replyTo: 'form-1' });
  await waitFor(() => host.unconfinedCalls.length >= 1);
  mock.simulateSubmission(payload, { number: 99, replyTo: 'form-1' });
  await new Promise(r => setTimeout(r, 100));
  t.is(host.unconfinedCalls.length, 1);
});
