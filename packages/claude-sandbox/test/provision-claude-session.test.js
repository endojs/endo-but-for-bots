// @ts-check
import '@endo/init';
import test from 'ava';

import { provisionClaudeSession } from '../src/provision-claude-session.js';

const keyFor = names => (Array.isArray(names) ? names.join('/') : names);

/**
 * A mock `@agent` host that records the calls provisionClaudeSession makes and
 * satisfies the pet-name existence checks against an in-memory set.
 * @param {{ failAt?: string }} [options]
 */
const makeRecordingHost = ({ failAt = '' } = {}) => {
  const names = new Set();
  const removals = [];
  const storeCalls = [];
  const lookupCalls = [];
  const powersCalls = [];
  const resolved = new Map();
  const makeUnconfinedCalls = [];
  const provideMountCalls = [];
  const host = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async remove(...path) {
      removals.push(...path);
      names.delete(keyFor(path));
    },
    async lookup(name) {
      lookupCalls.push(name);
      const key = keyFor(name);
      if (!resolved.has(key)) resolved.set(key, harden({ kind: key }));
      return resolved.get(key);
    },
    async storeValue(bundle, name) {
      storeCalls.push({ bundle, name });
      names.add(keyFor(name));
      if (failAt === 'store') throw Error('bundle persistence failed');
    },
    async provideMount(path, name, options) {
      provideMountCalls.push({ path, name, options });
      names.add(keyFor(name));
      return harden({ kind: 'mount', path, name });
    },
    async makeUnconfined(_main, _specifier, options) {
      if (_specifier.endsWith('/session-powers.js')) {
        powersCalls.push({ specifier: _specifier, options });
        if (failAt === 'powers') throw Error('powers construction failed');
      } else {
        makeUnconfinedCalls.push(options);
        if (failAt === 'client') throw Error('client construction failed');
        if (!names.has(keyFor(options.powersName)))
          throw Error('powers removed too early');
        if (!names.has(storeCalls[0].name))
          throw Error('bundle removed too early');
      }
      if (options.resultName) names.add(keyFor(options.resultName));
      return harden({ kind: 'client' });
    },
  });
  return {
    host,
    storeCalls,
    lookupCalls,
    powersCalls,
    resolved,
    names,
    removals,
    makeUnconfinedCalls,
    provideMountCalls,
  };
};

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

  const { bundle, name: inputName } = rec.storeCalls[0];
  t.is(bundle.mcpMount, rec.resolved.get(mcpMountName));
  t.deepEqual(rec.powersCalls[0].options, {
    powersName: inputName,
    resultName: rec.makeUnconfinedCalls[0].powersName,
  });
  t.regex(
    rec.powersCalls[0].specifier,
    /hosted-agent\/src\/session-powers\.js$/,
  );

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

  const { bundle } = rec.storeCalls[0];
  t.is(bundle.configFilesystem, rec.resolved.get('claude-config-session-c'));
  t.is(bundle.mounts.length, 2);
  t.deepEqual(bundle.mounts[1], {
    mountPoint: rec.makeUnconfinedCalls[0].env.CONFIG_MOUNT_POINT,
    mountName: rec.makeUnconfinedCalls[0].env.CONFIG_PET_NAME,
  });

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
  t.is(rec.storeCalls[0].bundle.configFilesystem, undefined);
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
  t.is(rec.storeCalls[0].bundle.mcpMount, undefined);
  t.is(rec.makeUnconfinedCalls[0].env.MCP_CONFIG_PATH, undefined);
  t.is(rec.storeCalls[0].bundle.mounts.length, 1);
});

for (const failAt of ['store', 'powers', 'client']) {
  test(`temporary bundle and powers names are cleaned after ${failAt} failure`, async t => {
    const rec = makeRecordingHost({ failAt });
    await t.throwsAsync(
      () =>
        provisionClaudeSession(rec.host, {
          name: 'failed-session',
          filesystemName: 'workspace',
          rootfs: 'oci:test',
        }),
      { message: /persistence failed|construction failed/ },
    );
    t.is(rec.storeCalls.length, 1);
    const inputName = rec.storeCalls[0].name;
    t.true(rec.removals.includes(inputName));
    t.true(rec.removals.includes(inputName.slice(0, -'-input'.length)));
    t.is(rec.names.size, 0);
    t.false(rec.removals.includes('workspace'));
  });
}

test('persisted powers retain dependencies when their names are rebound', async t => {
  const rec = makeRecordingHost();
  await provisionClaudeSession(rec.host, {
    name: 'retained-session',
    filesystemName: 'workspace',
    credentialsName: 'credentials',
    rootfs: 'oci:test',
  });
  const { bundle } = rec.storeCalls[0];
  const originalFilesystem = rec.resolved.get('workspace');
  const originalCredentials = rec.resolved.get('credentials');
  rec.resolved.set('workspace', harden({ kind: 'replacement filesystem' }));
  rec.resolved.set('credentials', harden({ kind: 'replacement credentials' }));
  t.is(bundle.filesystem, originalFilesystem);
  t.is(bundle.credentials, originalCredentials);
  t.is(rec.lookupCalls.filter(name => name === 'workspace').length, 1);
  t.is(rec.lookupCalls.filter(name => name === 'credentials').length, 1);
  t.false(Object.hasOwn(bundle, 'client'));
});
