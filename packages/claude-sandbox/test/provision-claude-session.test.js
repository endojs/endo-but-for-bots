// @ts-check
import '@endo/init';
import test from 'ava';

import {
  provisionClaudeSession,
  buildSessionPowersSource,
} from '../src/provision-claude-session.js';

const keyFor = names => (Array.isArray(names) ? names.join('/') : names);

/**
 * A mock `@agent` host that records the calls provisionClaudeSession makes and
 * satisfies the pet-name existence checks against an in-memory set.
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

test('provisionClaudeSession wires the MCP bridge mount, powers ref, and env', async t => {
  const rec = makeRecordingHost();
  await provisionClaudeSession(
    rec.host,
    {
      name: 'claude-client-session-a',
      filesystemName: 'claude-workspace-session-a',
      rootfs: 'oci:test',
      mcp: {
        socketDir: '/tmp/floot-mcp/session-a',
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
      },
    },
    { resultName: ['floot', 'controller-profile', 'claude-client-session-a'] },
  );

  // The socket dir was registered as a read-only Mount cap.
  t.is(rec.provideMountCalls.length, 1);
  t.is(rec.provideMountCalls[0].path, '/tmp/floot-mcp/session-a');
  t.deepEqual(rec.provideMountCalls[0].options, { readOnly: true });
  const mcpMountName = rec.provideMountCalls[0].name;

  // The powers eval references the mount cap under `mcpMount` and the generated
  // source hands it back.
  const evalCall = rec.evaluateCalls[0];
  t.true(evalCall.codeNames.includes('mcpMount'));
  t.true(evalCall.petNames.includes(mcpMountName));
  t.true(evalCall.source.includes('mcpMount: () => mcpMount'));

  // The client formula env carries the slice-internal config + mount paths.
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.MCP_CONFIG_PATH, '/endo-mcp/mcp.json');
  t.is(clientEnv.MCP_INNER_DIR, '/endo-mcp');
});

test('provisionClaudeSession wires a persistent config filesystem, powers ref, and env', async t => {
  const rec = makeRecordingHost();
  await provisionClaudeSession(
    rec.host,
    {
      name: 'claude-client-session-c',
      filesystemName: 'claude-workspace-session-c',
      configFilesystemName: 'claude-config-session-c',
      configHostDir: '/var/lib/endo/claude-configs/session-c',
      rootfs: 'oci:test',
    },
    { resultName: ['floot', 'controller-profile', 'claude-client-session-c'] },
  );

  // The powers eval references the config filesystem cap and hands it back.
  const evalCall = rec.evaluateCalls[0];
  t.true(evalCall.codeNames.includes('configFilesystem'));
  t.true(evalCall.petNames.includes('claude-config-session-c'));
  t.true(evalCall.source.includes('configFilesystem: () => configFilesystem'));

  // The client formula env carries the slice-internal + host config paths that
  // let it mount the config dir and detect a pre-restart transcript.
  const clientEnv = rec.makeUnconfinedCalls[0].env;
  t.is(clientEnv.CLAUDE_CONFIG_INNER_DIR, '/claude-config');
  t.is(
    clientEnv.CLAUDE_CONFIG_HOST_DIR,
    '/var/lib/endo/claude-configs/session-c',
  );
  t.truthy(clientEnv.CONFIG_MOUNT_POINT);
  t.truthy(clientEnv.CONFIG_PET_NAME);
});

test('provisionClaudeSession omits config wiring when no config filesystem is given', async t => {
  const rec = makeRecordingHost();
  await provisionClaudeSession(
    rec.host,
    {
      name: 'claude-client-session-d',
      filesystemName: 'claude-workspace-session-d',
      rootfs: 'oci:test',
    },
    { resultName: ['floot', 'controller-profile', 'claude-client-session-d'] },
  );
  t.false(rec.evaluateCalls[0].codeNames.includes('configFilesystem'));
  t.true(rec.evaluateCalls[0].source.includes('configFilesystem: () => null'));
  t.is(rec.makeUnconfinedCalls[0].env.CONFIG_MOUNT_POINT, undefined);
  t.is(rec.makeUnconfinedCalls[0].env.CLAUDE_CONFIG_HOST_DIR, undefined);
});

test('provisionClaudeSession omits MCP wiring when no bridge is given', async t => {
  const rec = makeRecordingHost();
  await provisionClaudeSession(
    rec.host,
    {
      name: 'claude-client-session-b',
      filesystemName: 'claude-workspace-session-b',
      rootfs: 'oci:test',
    },
    { resultName: ['floot', 'controller-profile', 'claude-client-session-b'] },
  );
  t.is(rec.provideMountCalls.length, 0);
  t.false(rec.evaluateCalls[0].codeNames.includes('mcpMount'));
  t.is(rec.makeUnconfinedCalls[0].env.MCP_CONFIG_PATH, undefined);
  t.true(rec.evaluateCalls[0].source.includes('mcpMount: () => null'));
});
