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
  const withMcp = buildSessionPowersSource('/mnt', 'ws', false, true);
  t.true(withMcp.includes('mcpMount: () => mcpMount'));
  const withoutMcp = buildSessionPowersSource('/mnt', 'ws', false, false);
  t.true(withoutMcp.includes('mcpMount: () => null'));
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
