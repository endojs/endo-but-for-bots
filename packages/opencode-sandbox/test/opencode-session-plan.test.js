// @ts-check
import '@endo/init';
import test from 'ava';

import {
  readNativeProfile,
  readSessionPlan,
} from '../src/opencode-session-plan.js';

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
  networkPolicy: 'off',
  workspaceDir: '/workspaces/session-a-0123456789ab',
  workspaceMountPoint: '/mounts/session-a-0123456789ab',
  mcpDir: '/private/session-a-0123456789ab/mcp',
  mounterSocketDir: '/private/session-a-0123456789ab/9p',
  nativeProfile: profile,
  model: 'openrouter/anthropic/claude-sonnet-4',
});

test('a recorded plan parses with its profile widened and nothing defaulted', t => {
  const parsed = readSessionPlan(JSON.stringify(plan));
  t.deepEqual(parsed.nativeProfile, {
    ...profile,
    memoryBytes: 536_870_912n,
    cpuQuotaMicros: 200_000n,
  });
  t.is(parsed.workspaceDir, plan.workspaceDir);
  t.is(parsed.model, plan.model);
  t.false('systemPrompt' in parsed);
  const { systemPrompt: _, ...rest } = readSessionPlan(
    JSON.stringify({ ...plan, systemPrompt: 'persona' }),
  );
  t.deepEqual(rest, parsed);
});

/** @type {readonly [string, unknown, RegExp][]} */
const refused = harden([
  ['a non-record', 'null', /plan must be a record/],
  ['an array', '[]', /plan must be a record/],
  [
    'a missing id',
    JSON.stringify({ ...plan, sessionId: '' }),
    /Missing session plan field "sessionId"/,
  ],
  [
    'an unknown policy',
    JSON.stringify({ ...plan, networkPolicy: 'lan' }),
    /network policy/,
  ],
  [
    'a non-text model',
    JSON.stringify({ ...plan, model: 7 }),
    /"model" must be text/,
  ],
  [
    'a relative path',
    JSON.stringify({ ...plan, mcpDir: 'private/mcp' }),
    /absolute path for "mcpDir"/,
  ],
  [
    'a trailing slash',
    JSON.stringify({ ...plan, workspaceDir: '/workspaces/a/' }),
    /absolute path for "workspaceDir"/,
  ],
  [
    'a dot segment',
    JSON.stringify({ ...plan, workspaceDir: '/workspaces/../a' }),
    /absolute path for "workspaceDir"/,
  ],
  [
    'the filesystem root',
    JSON.stringify({ ...plan, workspaceMountPoint: '/' }),
    /absolute path for "workspaceMountPoint"/,
  ],
  [
    'a socket directory inside the guest-visible relay directory',
    JSON.stringify({ ...plan, mounterSocketDir: `${plan.mcpDir}/9p` }),
    /"mcpDir" and "mounterSocketDir" must be disjoint/,
  ],
  [
    'a mount point inside its backing storage',
    JSON.stringify({
      ...plan,
      workspaceMountPoint: `${plan.workspaceDir}/mount`,
    }),
    /"workspaceDir" and "workspaceMountPoint" must be disjoint/,
  ],
  [
    'no profile',
    JSON.stringify({ ...plan, nativeProfile: undefined }),
    /Missing native profile/,
  ],
  [
    'a numeric quantity',
    JSON.stringify({ ...plan, nativeProfile: { ...profile, memoryBytes: 1 } }),
    /decimal digit strings/,
  ],
]);

for (const [name, text, message] of refused) {
  test(`a plan with ${name} is refused`, t => {
    t.throws(() => readSessionPlan(/** @type {string} */ (text)), { message });
  });
}

test('profile quantities widen exactly and reject every non-canonical spelling', t => {
  t.is(
    readNativeProfile({ ...profile, memoryBytes: '9223372036854775807' })
      .memoryBytes,
    9_223_372_036_854_775_807n,
  );
  for (const memoryBytes of [
    '0',
    '+1',
    ' 1',
    '1e3',
    '01',
    '9223372036854775808',
  ]) {
    t.throws(
      () => readNativeProfile({ ...profile, memoryBytes }),
      undefined,
      memoryBytes,
    );
  }
  t.throws(() => readNativeProfile({ ...profile, seccomp: 'unconfined' }), {
    message: /native Podman profile/,
  });
});
