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
  const evaluateCalls = [];
  const removeCalls = [];
  const hostAgent = {
    async lookup(name) {
      if (name in filesystems) return filesystems[name];
      return undefined;
    },
    async evaluate(workerName, source, codeNames, petNames, resultName) {
      evaluateCalls.push({
        workerName,
        source,
        codeNames,
        petNames,
        resultName,
      });
      return harden({ kind: 'fake-powers', name: resultName });
    },
    async makeUnconfined(powersName, specifier, opts) {
      unconfinedCalls.push({ powersName, specifier, opts });
      return harden({ kind: 'fake-client', name: opts.resultName });
    },
    async remove(name) {
      removeCalls.push(name);
    },
  };
  return { hostAgent, unconfinedCalls, evaluateCalls, removeCalls };
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
  // Least authority: the client runs as a per-session powers cap, not @agent
  // and not a shared cap. The name is per-session (`claude-<sessionId>-powers`).
  t.regex(call.opts.powersName, /^claude-my-claude-.*-powers$/);

  // The per-session powers was built by `evaluate`, endowing exactly the
  // caps the client needs by pet name (incl. the credential, since the form
  // named one), and `@agent` for the bounded provideMount.
  t.is(host.evaluateCalls.length, 1);
  const evalCall = host.evaluateCalls[0];
  t.is(evalCall.resultName, call.opts.powersName);
  t.deepEqual(evalCall.petNames, [
    '@agent',
    'sandbox-factory',
    'fs-mounter',
    'my-fs',
    'my-creds',
  ]);
  t.deepEqual(evalCall.codeNames, [
    'agent',
    'sandboxFactory',
    'fsMounter',
    'filesystem',
    'credentials',
  ]);
  // …and the per-session powers name was removed after makeUnconfined, so it
  // leaves no host-petstore residue (collected with the client).
  t.deepEqual(host.removeCalls, [call.opts.powersName]);

  const { env } = call.opts;
  // Caps are passed by reference through powers — no cap-name env vars.
  t.is(env.FILESYSTEM_NAME, undefined);
  t.is(env.CREDENTIALS_NAME, undefined);
  t.is(env.SANDBOX_FACTORY_NAME, undefined);
  t.is(env.NETWORK, 'private');
  t.is(env.MODEL, 'claude-sonnet-4-6');
  t.is(env.BACKEND, 'podman');
  t.is(env.WORKSPACE_PATH, '/workspace');
  t.regex(env.SESSION_ID, /^my-claude-/);
  t.regex(env.WORKSPACE_MOUNT_POINT, /claude-sandbox-my-claude-/);
  // No secret is threaded through the formula env.
  t.is(env.ANTHROPIC_API_KEY, undefined);
  t.is(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /ClaudeClient "my-claude" created/);
});

test('SANDBOX_NAMESPACE endows the infra caps under the factory directory', async t => {
  const fsCap = { kind: 'fake-fs' };
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: { 'my-fs': fsCap } });

  // The provisioner sets SANDBOX_NAMESPACE so the per-session powers endows
  // `claude-sandbox/sandbox-factory` and `claude-sandbox/fs-mounter` by path,
  // rather than the bare top-level names.
  make(mock.powers, undefined, {
    ...wireDeps(mock, host),
    env: { SANDBOX_NAMESPACE: 'claude-sandbox' },
  });

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'ns-claude',
    filesystem: 'my-fs',
    network: 'private',
  });

  await waitFor(() => host.evaluateCalls.length > 0);
  t.deepEqual(host.evaluateCalls[0].petNames, [
    '@agent',
    ['claude-sandbox', 'sandbox-factory'],
    ['claude-sandbox', 'fs-mounter'],
    'my-fs',
  ]);
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
  t.regex(call.opts.powersName, /^claude-peer-claude-.*-powers$/);
  // Caps by reference: the credential pet name is endowed into the powers
  // (not threaded through env).
  t.deepEqual(host.evaluateCalls[0].petNames, [
    '@agent',
    'sandbox-factory',
    'fs-mounter',
    'my-fs',
    'peer-creds',
  ]);
  t.is(call.opts.env.FILESYSTEM_NAME, undefined);
  t.is(call.opts.env.CREDENTIALS_NAME, undefined);
  // Per-session powers name removed (no residue), even on the peer path.
  t.deepEqual(host.removeCalls, [call.opts.powersName]);
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
