// @ts-check
import '@endo/init';
import test from 'ava';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { HostedToolSetInterface } from '@endo/hosted-agent';

import {
  make,
  resolveBackendConfig,
  resolvePinnedImageRef,
} from '../src/opencode-backend-module.js';

const keyFor = names => (Array.isArray(names) ? names.join('/') : names);

const makeToolSet = (execute = async () => 'ok') =>
  makeExo('HostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({
        dynamicTools: [
          {
            name: 'lookup',
            description: 'look up a pet name',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        toolSetId: 'tools-v1',
      });
    },
    execute,
    help: () => 'test tool set',
  });

/**
 * A fake OpencodeClient that records turns and lifecycle calls.
 */
const makeFakeClient = () => {
  /** @type {Array<{ prompt: string, opts: Record<string, unknown>, push: (event: object) => void }>} */
  const turns = [];
  let terminated = false;
  let destroyed = false;
  const client = Far('FakeOpencodeClient', {
    async send(prompt, opts = {}) {
      const { push, reader } = makeBufferedReader();
      turns.push({ prompt, opts: { ...opts }, push });
      return reader;
    },
    async interrupt() {
      await null;
    },
    async terminate() {
      terminated = true;
    },
    async destroy() {
      destroyed = true;
    },
    async status() {
      return harden({ sessionId: 'session-a', turnActive: false });
    },
  });
  return {
    client,
    turns,
    terminated: () => terminated,
    destroyed: () => destroyed,
  };
};

/**
 * A recording `@agent` host: pet names live in a map keyed by their joined
 * path, `makeUnconfined` stores the fake client under its result name, and
 * every lifecycle call the module makes is logged.
 */
const makeRecordingHost = () => {
  /** @type {Map<string, any>} */
  const names = new Map();
  const evaluateCalls = [];
  const makeUnconfinedCalls = [];
  const provideMountCalls = [];
  const cancelled = [];
  const directories = [];
  const { client, turns, terminated, destroyed } = makeFakeClient();
  const host = harden({
    async has(...namesPath) {
      return names.has(keyFor(namesPath));
    },
    async lookup(nameOrPath) {
      return names.get(keyFor(nameOrPath));
    },
    async remove(...namesPath) {
      names.delete(keyFor(namesPath));
    },
    async makeDirectory(namesPath) {
      directories.push([...namesPath]);
      names.set(keyFor(namesPath), harden({ kind: 'directory' }));
    },
    async cancel(namesPath, reason) {
      cancelled.push({ path: [...namesPath], reason: reason.message });
    },
    async evaluate(_main, source, codeNames, petNames, resultName) {
      evaluateCalls.push({ source, codeNames, petNames, resultName });
      names.set(keyFor(resultName), harden({ kind: 'powers' }));
    },
    async provideMount(mountPath, name, options) {
      provideMountCalls.push({ path: mountPath, name, options });
      const cap = harden({ kind: 'mount', path: mountPath, name });
      names.set(keyFor(name), cap);
      return cap;
    },
    async makeUnconfined(_main, specifier, options = {}) {
      makeUnconfinedCalls.push({ specifier, options });
      if (options.resultName === undefined) {
        return harden({ kind: 'client' });
      }
      const cap =
        options.powersName === '@none'
          ? harden({ kind: 'fs', root: options.env.ENDO_FS_ROOT })
          : client;
      names.set(keyFor(options.resultName), cap);
      return cap;
    },
  });
  return {
    host,
    names,
    evaluateCalls,
    makeUnconfinedCalls,
    provideMountCalls,
    cancelled,
    directories,
    turns,
    terminated,
    destroyed,
  };
};

test.serial('resolveBackendConfig falls back to the opencode-* defaults', t => {
  const saved = new Map();
  for (const name of Object.keys(process.env)) {
    if (
      name.startsWith('ENDO_OPENCODE_') ||
      name === 'OPENCODE_SANDBOX_IMAGE'
    ) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  try {
    const config = resolveBackendConfig(harden({}));
    t.is(config.clientBase, 'opencode-client');
    t.is(config.credentialsName, 'openrouter-auth');
    t.is(
      config.workspaceBaseDir,
      path.join(os.homedir(), 'opencode-workspaces'),
    );
    t.is(config.configBaseDir, path.join(os.homedir(), 'opencode-configs'));
    t.is(config.rootfs, 'oci:localhost/opencode-sandbox:latest');
    t.is(config.mcpBaseDir, path.join(os.homedir(), 'opencode-mcp'));
  } finally {
    for (const name of Object.keys(process.env)) {
      if (
        name.startsWith('ENDO_OPENCODE_') ||
        name === 'OPENCODE_SANDBOX_IMAGE'
      ) {
        delete process.env[name];
      }
    }
    for (const [name, value] of saved) {
      process.env[name] = value;
    }
  }
});

test('resolveBackendConfig prefers the formula env over process env', t => {
  const config = resolveBackendConfig(
    harden({
      OPENCODE_CLIENT_NAME: 'client-x',
      OPENCODE_CREDS_NAME: 'creds-x',
      OPENCODE_WORKSPACE_BASE_DIR: '/ws',
      OPENCODE_CONFIG_BASE_DIR: '/cfg',
      OPENCODE_SANDBOX_IMAGE: 'oci:test',
      OPENCODE_MCP_DIR: '/mcp',
    }),
  );
  t.deepEqual(config, {
    clientBase: 'client-x',
    credentialsName: 'creds-x',
    workspaceBaseDir: '/ws',
    configBaseDir: '/cfg',
    rootfs: 'oci:test',
    mcpBaseDir: '/mcp',
    broker: {
      listenerImageRef: '',
      directory: path.join(os.homedir(), 'opencode-broker'),
      ownerId: '',
    },
  });
});

test('make() wires the provisioner and tool bridge into a working factory', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'opencode-backend-'));
  t.teardown(() => rm(tmp, { recursive: true, force: true }));
  const rec = makeRecordingHost();
  const factory = make(rec.host, undefined, {
    env: {
      OPENCODE_CLIENT_NAME: 'opencode-client',
      OPENCODE_CREDS_NAME: 'opencode-creds',
      OPENCODE_WORKSPACE_BASE_DIR: path.join(tmp, 'workspaces'),
      OPENCODE_CONFIG_BASE_DIR: path.join(tmp, 'configs'),
      OPENCODE_SANDBOX_IMAGE: 'oci:test',
      OPENCODE_MCP_DIR: path.join(tmp, 'mcp'),
    },
  });

  t.deepEqual(await E(factory).describe(), {
    id: 'opencode',
    title: 'OpenCode',
    kind: 'hosted',
    continuity: 'transcript',
    toolOwnership: 'endo',
    supportedNetworkPolicies: ['off', 'public-internet'],
  });
  const models = await E(factory).listModels();
  t.is(models.length, 1);
  t.is(models[0].id, 'openrouter/deepseek/deepseek-v4.1-flash');
  t.true(models[0].default);

  const { run, admin } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'You are Floot.',
      workspaceHostPath: path.join(tmp, 'worktree-a'),
      networkPolicy: 'public-internet',
    }),
    makeToolSet(),
  );
  // Even when an assertion below fails, stop the live bridge so the test
  // process can exit.
  t.teardown(async () => {
    await E(admin)
      .terminate()
      .catch(() => {});
  });

  // The workspace filesystem is rooted at the Floot-provided worktree: the
  // factory's `workspaceHostPath` reached the provisioner as `workspaceDir`.
  const fsCalls = rec.makeUnconfinedCalls.filter(
    call => call.options.powersName === '@none',
  );
  t.is(fsCalls.length, 2);
  t.is(fsCalls[0].options.env.ENDO_FS_ROOT, path.join(tmp, 'worktree-a'));
  t.is(
    fsCalls[1].options.env.ENDO_FS_ROOT,
    path.join(tmp, 'configs', 'session-a'),
  );

  // The client formula env carries the pinned model, persona, session id, and
  // the MCP mount paths.
  const clientCall = rec.makeUnconfinedCalls.find(
    call => call.options.powersName !== '@none',
  );
  t.is(clientCall.options.env.MODEL, 'openrouter/deepseek/deepseek-v4.1-flash');
  t.is(clientCall.options.env.SYSTEM_PROMPT, 'You are Floot.');
  // The provisioner forwards its deterministic sandbox session id, not the
  // Floot id, as the slice identity.
  t.regex(clientCall.options.env.SESSION_ID, /^session-a-[0-9a-f]{12}$/);
  t.is(clientCall.options.env.MCP_CONFIG_PATH, '/endo-mcp/mcp.json');
  t.is(clientCall.options.env.MCP_INNER_DIR, '/endo-mcp');
  t.true(rec.evaluateCalls[0].codeNames.includes('mcpMount'));
  t.true(rec.evaluateCalls[0].codeNames.includes('stateProvider'));

  // The tool-bridge socket dir is mounted read-only into the slice.
  t.is(rec.provideMountCalls.length, 1);
  t.is(rec.provideMountCalls[0].path, path.join(tmp, 'mcp', 'session-a'));
  t.deepEqual(rec.provideMountCalls[0].options, { readOnly: true });

  // The factory's run facet reaches the provisioned client.
  const readerP = E(run).send('hello');
  for (let tries = 0; rec.turns.length === 0 && tries < 50; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  t.is(rec.turns.length, 1);
  rec.turns[0].push({ type: 'end' });
  const events = [];
  for await (const event of iterateReader(await readerP)) {
    events.push(event);
  }
  t.deepEqual(events, [{ type: 'end' }]);
  const status = await E(run).status();
  t.is(status.pendingToolCalls, 0);
  t.deepEqual(status.toolBridge, {
    innerDir: '/endo-mcp',
    configPath: '/endo-mcp/mcp.json',
  });

  // terminate stops the client and cancels the formula (a stop, not a
  // deletion), and closes the socket listener.
  await E(admin).terminate();
  t.true(rec.terminated());
  t.deepEqual(rec.cancelled, [
    {
      path: ['opencode-sandbox', 'sessions', 'opencode-client-session-a'],
      reason: 'OpenCode session session-a stopped',
    },
  ]);
  t.false(existsSync(path.join(tmp, 'mcp', 'session-a', 'mcp.sock')));

  // destroy removes the session (client destroy + formula removal) and its
  // tool-bridge directory.
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.true(rec.destroyed());
  t.false(rec.names.has('opencode-sandbox/sessions/opencode-client-session-a'));
  t.false(existsSync(path.join(tmp, 'mcp', 'session-a')));
});

test('resolvePinnedImageRef pins tags and accepts already-pinned digests', async t => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const exec = async (file, args) => {
    t.is(file, 'podman');
    t.deepEqual(args.slice(0, 3), ['image', 'inspect', '--format']);
    return { stdout: `${digest}\n` };
  };
  t.deepEqual(
    await resolvePinnedImageRef('oci:localhost/opencode-sandbox:tag', exec),
    {
      imageRef: `localhost/opencode-sandbox:tag@${digest}`,
      imageDigest: digest,
    },
  );
  t.deepEqual(
    await resolvePinnedImageRef(
      `oci:localhost/opencode-sandbox@${digest}`,
      exec,
    ),
    {
      imageRef: `localhost/opencode-sandbox@${digest}`,
      imageDigest: digest,
    },
  );
  await t.throwsAsync(
    () => resolvePinnedImageRef('oci:x', async () => ({ stdout: 'nope' })),
    { message: /Cannot resolve a digest/ },
  );
  await t.throwsAsync(() => resolvePinnedImageRef('oci:--privileged', exec), {
    message: /Invalid OpenCode sandbox image/,
  });
});

test('resolveBackendConfig exposes broker settings', t => {
  const listenerImageRef = `localhost/endo-provider@sha256:${'b'.repeat(64)}`;
  const config = resolveBackendConfig({
    OPENCODE_BROKER_LISTENER_IMAGE: listenerImageRef,
    OPENCODE_BROKER_DIR: '/var/lib/endo/opencode-broker',
    OPENCODE_BROKER_OWNER_ID: 'owner-1',
  });
  t.deepEqual(config.broker, {
    listenerImageRef,
    directory: '/var/lib/endo/opencode-broker',
    ownerId: 'owner-1',
  });
  t.is(resolveBackendConfig({}).broker.listenerImageRef, '');
});
