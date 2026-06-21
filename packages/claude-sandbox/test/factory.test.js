// @ts-nocheck
/* global setTimeout */
/* eslint-disable import/order, no-empty-function, no-plusplus */

import '@endo/init';
import test from 'ava';

import { make } from '../src/claude-sandbox-factory.js';
import { DEFAULT_CLAUDE_IMAGE } from '../src/parse-rootfs.js';

// `E(target)` deep-hardens its target. Recording arrays therefore stay
// in closures (returned via a separate wrapper) rather than as
// properties on the objects the factory drives through `E()`. `Map`
// instances survive `harden` (their data lives in internal slots, not
// frozen own-properties), so `storedValues` can be a property.

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

const makeMockHostAgent = ({ filesystems = {}, credentials = {} } = {}) => {
  const stored = new Map();
  const provideMountCalls = [];
  const hostAgent = {
    async lookup(name) {
      if (name in filesystems) return filesystems[name];
      if (name in credentials) return credentials[name];
      return undefined;
    },
    async storeValue(value, name) {
      stored.set(name, value);
    },
    async provideMount(path, petName) {
      const cap = { kind: 'workspace-mount', path, petName };
      provideMountCalls.push({ path, petName, cap });
      return cap;
    },
  };
  return { hostAgent, storedValues: stored, provideMountCalls };
};

const makeMockSandboxFactory = () => {
  const makeCalls = [];
  return {
    factory: {
      async make(opts) {
        makeCalls.push(opts);
        return { kind: 'fake-slice', async dispose() {} };
      },
    },
    makeCalls,
  };
};

const makeMockFsMounter = () => {
  const mountCalls = [];
  return {
    mounter: {
      async mount(fs, mountPoint, opts) {
        mountCalls.push({ fs, mountPoint, opts });
        return { kind: 'mount-handle', async unmount() {} };
      },
    },
    mountCalls,
  };
};

const waitFor = async (pred, deadlineMs = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > deadlineMs) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 10));
  }
};

const wireDeps = (mock, host, sandbox, fsm, clientFactory) => {
  mock.setHostAgent(host.hostAgent);
  return {
    sandboxFactory: sandbox.factory,
    fsMounter: fsm.mounter,
    iterateMessages: mock.iterateMessages,
    clientFactory,
  };
};

test('factory presents the Create Claude Sandbox form to @host', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent();
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  const exo = make(
    mock.powers,
    undefined,
    wireDeps(mock, host, sandbox, fsm, ({ sessionId }) => ({
      sessionId,
      kind: 'mock-client',
    })),
  );

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

test('submission mounts 9P, provisions a slice, and stores a ClaudeClient', async t => {
  const fsCap = { kind: 'fake-fs' };
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: { 'my-fs': fsCap } });
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  make(
    mock.powers,
    undefined,
    wireDeps(
      mock,
      host,
      sandbox,
      fsm,
      ({ sessionId, slice, mountHandle, workspaceMountPoint }) => ({
        sessionId,
        slice,
        mountHandle,
        workspaceMountPoint,
        kind: 'mock-client',
      }),
    ),
  );

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'my-claude',
    filesystem: 'my-fs',
    network: 'private',
  });

  await waitFor(() => host.storedValues.size > 0);

  // 9P mount of the resolved FS cap onto a per-session host path.
  t.is(fsm.mountCalls.length, 1);
  t.is(fsm.mountCalls[0].fs, fsCap);
  t.regex(fsm.mountCalls[0].mountPoint, /claude-sandbox-my-claude-/);

  // The mountpoint was registered as a daemon Mount cap.
  t.is(host.provideMountCalls.length, 1);
  t.is(host.provideMountCalls[0].path, fsm.mountCalls[0].mountPoint);

  // The slice was minted with the workspace bound at /workspace and a
  // default OCI rootfs.
  t.is(sandbox.makeCalls.length, 1);
  const makeOpts = sandbox.makeCalls[0];
  t.deepEqual(makeOpts.rootfs, { kind: 'oci', ref: DEFAULT_CLAUDE_IMAGE });
  t.is(makeOpts.backend, 'podman');
  t.is(makeOpts.network, 'private');
  t.is(makeOpts.cwd, '/workspace');
  t.is(makeOpts.mounts.length, 1);
  t.is(makeOpts.mounts[0].innerPath, '/workspace');
  t.is(makeOpts.mounts[0].mode, 'rw');
  t.is(makeOpts.mounts[0].cap, host.provideMountCalls[0].cap);

  // The client was stored under the chosen pet name, holding the live
  // slice and the 9P mount handle.
  t.true(host.storedValues.has('my-claude'));
  const stored = host.storedValues.get('my-claude');
  t.is(stored.slice.kind, 'fake-slice');
  t.is(stored.mountHandle.kind, 'mount-handle');
  t.is(stored.workspaceMountPoint, fsm.mountCalls[0].mountPoint);

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /ClaudeClient "my-claude" created/);
});

test('submission injects ANTHROPIC_API_KEY from a credentials cap', async t => {
  const fsCap = { kind: 'fake-fs' };
  let issuedTag;
  const credCap = {
    async issue(tag) {
      issuedTag = tag;
      return {
        async materialise() {
          return 'sk-ant-secret';
        },
      };
    },
  };
  const mock = makeMockPowers();
  const host = makeMockHostAgent({
    filesystems: { 'my-fs': fsCap },
    credentials: { 'my-creds': credCap },
  });
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  make(
    mock.powers,
    undefined,
    wireDeps(mock, host, sandbox, fsm, ({ sessionId }) => ({ sessionId })),
  );

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'creds-claude',
    filesystem: 'my-fs',
    credentials: 'my-creds',
  });

  await waitFor(() => sandbox.makeCalls.length > 0);
  t.is(issuedTag, 'creds-claude');
  t.is(sandbox.makeCalls[0].env.ANTHROPIC_API_KEY, 'sk-ant-secret');
});

test('submission with an unknown filesystem replies with an error', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({ filesystems: {} });
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  make(
    mock.powers,
    undefined,
    wireDeps(mock, host, sandbox, fsm, () => ({})),
  );

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({ name: 'x', filesystem: 'missing-fs' });

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /Error creating sandbox/);
  t.is(host.storedValues.size, 0);
  t.is(sandbox.makeCalls.length, 0);
});

test('submission with an unknown network profile is rejected', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({
    filesystems: { 'my-fs': { kind: 'fake-fs' } },
  });
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  make(
    mock.powers,
    undefined,
    wireDeps(mock, host, sandbox, fsm, () => ({})),
  );

  await waitFor(() => mock.formCalls.length > 0);
  mock.simulateSubmission({
    name: 'x',
    filesystem: 'my-fs',
    network: 'wide-open',
  });

  await waitFor(() => mock.replies.length > 0);
  t.regex(mock.replies[0].body.join('\n'), /Unknown network profile/);
  t.is(sandbox.makeCalls.length, 0);
});

test('duplicate form replies are ignored (replay guard)', async t => {
  const mock = makeMockPowers();
  const host = makeMockHostAgent({
    filesystems: { 'my-fs': { kind: 'fake-fs' } },
  });
  const sandbox = makeMockSandboxFactory();
  const fsm = makeMockFsMounter();

  make(
    mock.powers,
    undefined,
    wireDeps(mock, host, sandbox, fsm, ({ sessionId }) => ({ sessionId })),
  );

  await waitFor(() => mock.formCalls.length > 0);
  const payload = { name: 'replay', filesystem: 'my-fs', network: 'private' };
  mock.simulateSubmission(payload, { number: 99, replyTo: 'form-1' });
  await waitFor(() => sandbox.makeCalls.length >= 1);
  mock.simulateSubmission(payload, { number: 99, replyTo: 'form-1' });
  await new Promise(r => setTimeout(r, 100));
  t.is(sandbox.makeCalls.length, 1);
});
