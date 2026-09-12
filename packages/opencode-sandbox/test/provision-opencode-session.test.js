// @ts-check
import '@endo/init';
import test from 'ava';

import {
  provisionOpencodeSession,
  buildSessionPowersSource,
  resolveSandboxConfig,
} from '../src/provision-opencode-session.js';

const keyFor = names => (Array.isArray(names) ? names.join('/') : names);

/**
 * A mock `@agent` host that records the calls provisionOpencodeSession makes
 * and satisfies the pet-name existence checks against an in-memory set.
 */
const makeRecordingHost = () => {
  const names = new Set();
  const evaluateCalls = [];
  const makeUnconfinedCalls = [];
  const provideMountCalls = [];
  const host = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
    async evaluate(_main, source, codeNames, petNames, resultName) {
      evaluateCalls.push({ source, codeNames, petNames, resultName });
      names.add(keyFor(resultName));
    },
    async provideMount(path, name, options) {
      provideMountCalls.push({ path, name, options });
      names.add(keyFor(name));
      return harden({ kind: 'mount', path, name });
    },
    async makeUnconfined(_main, _specifier, options) {
      makeUnconfinedCalls.push(options);
      if (options.resultName) names.add(keyFor(options.resultName));
      return harden({ kind: 'client' });
    },
  });
  return {
    host,
    evaluateCalls,
    makeUnconfinedCalls,
    provideMountCalls,
  };
};

test('buildSessionPowersSource always endows the stateProvider power', t => {
  const source = buildSessionPowersSource(
    [{ mountPoint: '/mnt', mountName: 'ws' }],
    false,
  );
  t.true(source.includes('stateProvider: () => stateProvider'));
  t.true(source.includes('stateProvider: M.call().returns(M.any())'));
  // Optional powers are null unless requested.
  t.true(source.includes('mcpMount: () => null'));
  t.true(source.includes('configFilesystem: () => null'));
});

test('buildSessionPowersSource exposes an mcpMount accessor only when requested', t => {
  const mounts = [{ mountPoint: '/mnt', mountName: 'ws' }];
  const withMcp = buildSessionPowersSource(mounts, false, true);
  t.true(withMcp.includes('mcpMount: () => mcpMount'));
  const withoutMcp = buildSessionPowersSource(mounts, false, false);
  t.true(withoutMcp.includes('mcpMount: () => null'));
});

test('buildSessionPowersSource exposes a configFilesystem accessor + config mount only when requested', t => {
  const withConfig = buildSessionPowersSource(
    [
      { mountPoint: '/mnt', mountName: 'ws' },
      { mountPoint: '/cfg', mountName: 'cfg' },
    ],
    false,
    false,
    true,
  );
  t.true(withConfig.includes('configFilesystem: () => configFilesystem'));
  // provideMount now allows both the workspace and the config mountpoints.
  t.true(withConfig.includes('/cfg'));
  t.true(withConfig.includes('"cfg"'));

  const withoutConfig = buildSessionPowersSource(
    [{ mountPoint: '/mnt', mountName: 'ws' }],
    false,
    false,
    false,
  );
  t.true(withoutConfig.includes('configFilesystem: () => null'));
  t.false(withoutConfig.includes('/cfg'));
});

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

  // The powers eval references the state provider and the mount cap.
  const evalCall = rec.evaluateCalls[0];
  t.true(evalCall.codeNames.includes('stateProvider'));
  t.true(evalCall.codeNames.includes('mcpMount'));
  t.true(evalCall.petNames.includes('state-provider'));
  t.true(evalCall.petNames.includes(mcpMountName));
  t.true(evalCall.source.includes('mcpMount: () => mcpMount'));

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

  // The powers eval references the config filesystem cap and hands it back.
  const evalCall = rec.evaluateCalls[0];
  t.true(evalCall.codeNames.includes('configFilesystem'));
  t.true(evalCall.petNames.includes('opencode-config-session-c'));
  t.true(evalCall.source.includes('configFilesystem: () => configFilesystem'));

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
  t.false(rec.evaluateCalls[0].codeNames.includes('configFilesystem'));
  t.true(rec.evaluateCalls[0].source.includes('configFilesystem: () => null'));
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
  t.false(rec.evaluateCalls[0].codeNames.includes('mcpMount'));
  t.is(rec.makeUnconfinedCalls[0].env.MCP_CONFIG_PATH, undefined);
  t.true(rec.evaluateCalls[0].source.includes('mcpMount: () => null'));
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
