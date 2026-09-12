// @ts-check
import '@endo/init';
import test from 'ava';

import {
  provisionOpencodeSession,
  resolveSandboxConfig,
} from '../src/provision-opencode-session.js';

const keyFor = names => (Array.isArray(names) ? names.join('/') : names);

/**
 * A mock `@agent` host that records the calls provisionOpencodeSession makes
 * and satisfies the pet-name existence checks against an in-memory set.
 */
const makeRecordingHost = () => {
  const names = new Set();
  const stored = [];
  const lookups = [];
  const powersCalls = [];
  const makeUnconfinedCalls = [];
  const provideMountCalls = [];
  const host = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
    async lookup(path) {
      lookups.push(path);
      return harden({ identity: keyFor(path) });
    },
    async storeValue(value, resultName) {
      stored.push({ value, resultName });
      names.add(keyFor(resultName));
    },
    async provideMount(path, name, options) {
      provideMountCalls.push({ path, name, options });
      names.add(keyFor(name));
      return harden({ kind: 'mount', path, name });
    },
    async makeUnconfined(_main, _specifier, options) {
      if (_specifier.endsWith('/session-powers.js')) powersCalls.push(options);
      else makeUnconfinedCalls.push(options);
      if (options.resultName) names.add(keyFor(options.resultName));
      return harden({ kind: 'client' });
    },
  });
  return {
    host,
    stored,
    lookups,
    powersCalls,
    makeUnconfinedCalls,
    provideMountCalls,
  };
};

test('provisionOpencodeSession wires the MCP bridge mount, powers ref, and env', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-a',
      filesystemName: 'opencode-workspace-session-a',
      rootfs: 'oci:test',
      mcp: {
        socketDir: '/tmp/floot-mcp/session-a',
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
        socketName: 'mcp.sock',
        stdioBridgeName: 'mcp-stdio-bridge.mjs',
        serverName: 'endo',
      },
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-a'],
    },
  );

  // The socket dir was registered as a read-only Mount cap.
  t.is(rec.provideMountCalls.length, 1);
  t.is(rec.provideMountCalls[0].path, '/tmp/floot-mcp/session-a');
  t.deepEqual(rec.provideMountCalls[0].options, { readOnly: true });
  const mcpMountName = rec.provideMountCalls[0].name;

  const bundle = rec.stored[0].value;
  t.deepEqual(bundle.stateProvider, { identity: 'state-provider' });
  t.deepEqual(bundle.mcpMount, { identity: mcpMountName });
  t.is(rec.powersCalls[0].powersName, rec.stored[0].resultName);
  t.is(rec.makeUnconfinedCalls[0].powersName, rec.powersCalls[0].resultName);

  // The client formula env carries the slice-internal bridge paths.
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.MCP_CONFIG_PATH, '/endo-mcp/mcp.json');
  t.is(clientEnv.MCP_INNER_DIR, '/endo-mcp');
  t.is(clientEnv.MCP_SOCKET_NAME, 'mcp.sock');
  t.is(clientEnv.MCP_BRIDGE_NAME, 'mcp-stdio-bridge.mjs');
  t.is(clientEnv.MCP_SERVER_NAME, 'endo');
  t.is(clientEnv.STATE_INNER_PATH, '/opencode-state');
});

test('provisionOpencodeSession wires a config filesystem, powers ref, and env', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-c',
      filesystemName: 'opencode-workspace-session-c',
      configFilesystemName: 'opencode-config-session-c',
      configHostDir: '/var/lib/endo/opencode-configs/session-c',
      rootfs: 'oci:test',
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-c'],
    },
  );

  t.deepEqual(rec.stored[0].value.configFilesystem, {
    identity: 'opencode-config-session-c',
  });

  // The client formula env carries the slice-internal + host config paths.
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.OPENCODE_CONFIG_INNER_DIR, '/opencode-config');
  t.is(
    clientEnv.OPENCODE_CONFIG_HOST_DIR,
    '/var/lib/endo/opencode-configs/session-c',
  );
  t.truthy(clientEnv.CONFIG_MOUNT_POINT);
  t.truthy(clientEnv.CONFIG_PET_NAME);
});

test('provisionOpencodeSession omits config wiring when no config filesystem is given', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-d',
      filesystemName: 'opencode-workspace-session-d',
      rootfs: 'oci:test',
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-d'],
    },
  );
  t.is(rec.stored[0].value.configFilesystem, undefined);
  t.is(rec.makeUnconfinedCalls[0].env.CONFIG_MOUNT_POINT, undefined);
  t.is(rec.makeUnconfinedCalls[0].env.OPENCODE_CONFIG_HOST_DIR, undefined);
});

test('provisionOpencodeSession omits MCP wiring when no bridge is given', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-b',
      filesystemName: 'opencode-workspace-session-b',
      rootfs: 'oci:test',
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-b'],
    },
  );
  t.is(rec.provideMountCalls.length, 0);
  t.is(rec.stored[0].value.mcpMount, undefined);
  t.is(rec.makeUnconfinedCalls[0].env.MCP_CONFIG_PATH, undefined);
});

test('provisionOpencodeSession forwards model, persona, resume id, and turn timeout', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-e',
      filesystemName: 'opencode-workspace-session-e',
      rootfs: 'oci:test',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'You are Floot.',
      opencodeSessionId: 'ses_recorded',
      turnTimeoutMs: 123_000,
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-e'],
    },
  );
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.MODEL, 'openrouter/deepseek/deepseek-v4.1-flash');
  t.is(clientEnv.SYSTEM_PROMPT, 'You are Floot.');
  t.is(clientEnv.OPENCODE_SESSION_ID, 'ses_recorded');
  t.is(clientEnv.OPENCODE_BRIDGE_TURN_TIMEOUT_MS, '123000');
});

test('provisionOpencodeSession accepts the join network and forwards brokerEnv', async t => {
  const rec = makeRecordingHost();
  await provisionOpencodeSession(
    rec.host,
    {
      name: 'opencode-client-session-a',
      filesystemName: 'opencode-workspace-session-a',
      rootfs: 'oci:test',
      network: 'join',
      brokerEnv: {
        OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:41337/api/v1',
        OPENCODE_BROKER_CONTAINER: 'endo-provider-abc',
      },
    },
    {
      resultName: ['floot', 'controller-profile', 'opencode-client-session-a'],
    },
  );
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.NETWORK, 'join');
  t.is(clientEnv.OPENCODE_BROKER_BASE_URL, 'http://127.0.0.1:41337/api/v1');
  t.is(clientEnv.OPENCODE_BROKER_CONTAINER, 'endo-provider-abc');
  await t.throwsAsync(
    () =>
      provisionOpencodeSession(rec.host, {
        name: 'opencode-client-session-b',
        filesystemName: 'opencode-workspace-session-b',
        rootfs: 'oci:test',
        brokerEnv: { OPENCODE_BROKER_BASE_URL: 'http://127.0.0.1:1/api/v1' },
      }),
    { message: /Invalid broker transport/ },
  );
});

test('sandbox mount base honors the daemon ENDO_ variable', async t => {
  const previous = process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR;
  process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR = '/var/lib/endo/opencode-mounts';
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR;
    } else {
      process.env.ENDO_OPENCODE_SANDBOX_MOUNT_DIR = previous;
    }
  });
  t.is(
    resolveSandboxConfig({}).mountBaseDir,
    '/var/lib/endo/opencode-mounts',
    'the daemon env reaches the provisioner so mounts stay in the cleanup dir',
  );
  t.is(
    resolveSandboxConfig({ OPENCODE_SANDBOX_MOUNT_DIR: '/formula/mounts' })
      .mountBaseDir,
    '/formula/mounts',
    'the formula env still wins',
  );
});
