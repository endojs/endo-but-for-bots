// @ts-check
import '@endo/init';
import test from 'ava';

import {
  makeSandboxSessionId,
  readClaudeSessionPlan,
} from '../src/claude-session-plan.js';

const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});

const plan = harden({
  sessionId: 'session-a',
  sandboxSessionId: 'session-a-0123456789ab',
  rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
  network: 'private',
  workspaceDir: '/workspaces/session-a-0123456789ab',
  workspaceMountPoint: '/private/session-a-0123456789ab/workspace',
  mcpDir: '/private/session-a-0123456789ab/mcp',
  mounterSocketDir: '/private/session-a-0123456789ab/9p',
  nativeProfile: profile,
  model: 'claude-sonnet-4',
  systemPrompt: 'You are Floot.',
});

test('a recorded plan parses with its profile widened and nothing defaulted', t => {
  const parsed = readClaudeSessionPlan(JSON.stringify(plan));
  const { nativeProfile, ...rest } = parsed;
  t.is(nativeProfile.memoryBytes, 536_870_912n);
  t.is(nativeProfile.cpuQuotaMicros, 200_000n);
  t.is(nativeProfile.pids, 128);
  const { nativeProfile: _, ...recorded } = plan;
  t.deepEqual(rest, recorded);
  t.false(Object.hasOwn(parsed, 'mounterEnv'));
  const settings = { NINEP_SUDO: '1' };
  t.deepEqual(
    readClaudeSessionPlan(JSON.stringify({ ...plan, mounterEnv: settings }))
      .mounterEnv,
    settings,
  );
});

test('the plan refuses every deviation from its recorded shape', t => {
  /** @type {[string, Record<string, unknown>, RegExp][]} */
  const refused = [
    ['a missing session id', { ...plan, sessionId: '' }, /"sessionId"/],
    [
      'an unknown network',
      { ...plan, network: 'host-net' },
      /Unknown session plan network/,
    ],
    [
      'a public network',
      { ...plan, network: 'public-internet' },
      /Unknown session plan network/,
    ],
    [
      'a relative path',
      { ...plan, mcpDir: 'relative/mcp' },
      /recorded absolute path for "mcpDir"/,
    ],
    [
      'a mount point inside the workspace',
      { ...plan, workspaceMountPoint: `${plan.workspaceDir}/mount` },
      /must be disjoint/,
    ],
    [
      'both workspace forms',
      { ...plan, workspaceHostPath: '/srv/worktree' },
      /cannot record both/,
    ],
    [
      'no workspace',
      { ...plan, workspaceDir: undefined },
      /must record an owned or an operator-supplied workspace/,
    ],
    ['a non-text model', { ...plan, model: 7 }, /"model" must be text/],
    [
      'a missing profile',
      { ...plan, nativeProfile: undefined },
      /Missing native profile/,
    ],
    [
      'a bad mounter setting',
      { ...plan, mounterEnv: { NINEP_SUDO: '0' } },
      /"NINEP_SUDO" must be "1"/,
    ],
  ];
  for (const [name, mutated, message] of refused) {
    t.throws(
      () => readClaudeSessionPlan(JSON.stringify(mutated)),
      { message },
      name,
    );
  }
  t.throws(() => readClaudeSessionPlan('[]'), { message: /must be a record/ });
});

test('an operator-supplied workspace records no owned directory, and the id derivation is stable', t => {
  const { workspaceDir: _, ...foreign } = plan;
  const parsed = readClaudeSessionPlan(
    JSON.stringify({ ...foreign, workspaceHostPath: '/srv/worktree' }),
  );
  t.is(parsed.workspaceDir, undefined);
  t.is(parsed.workspaceHostPath, '/srv/worktree');
  t.regex(makeSandboxSessionId('Session A'), /^session-a-[0-9a-f]{12}$/);
  t.regex(makeSandboxSessionId('***'), /^claude-[0-9a-f]{12}$/);
  t.is(makeSandboxSessionId('x'), makeSandboxSessionId('x'));
});
