// @ts-check
import '@endo/init';
import test from 'ava';
import { makeSandboxSessionId } from '@endo/hosted-agent/session-plan.js';

import { readCodexSessionPlan } from '../src/codex-session-plan.js';

const plan = harden({
  sessionId: 'session-a',
  sandboxSessionId: makeSandboxSessionId('session-a', 'codex'),
  imageRef: `example@sha256:${'a'.repeat(64)}`,
  accountRef: 'subscription-a',
  networkPolicy: 'off',
  workspaceDir: '/workspaces/a',
  workspaceMountPoint: '/private/a/workspace',
  mounterSocketDir: '/private/a/9p',
  containerMounts: [],
});

test('Codex records placement without a volume lease or an MCP directory', t => {
  const parsed = readCodexSessionPlan(JSON.stringify(plan));
  t.is(parsed.sandboxSessionId, plan.sandboxSessionId);
  t.false(Object.hasOwn(parsed, 'nativeProfile'));
  t.false('mcpDir' in parsed);
  const foreign = { ...plan, workspaceDir: undefined };
  t.is(
    readCodexSessionPlan(
      JSON.stringify({ ...foreign, workspaceHostPath: '/operator/repo' }),
    ).workspaceHostPath,
    '/operator/repo',
  );
});

test('unknown fields cannot add storage cleanup authority', t => {
  const parsed = readCodexSessionPlan(
    JSON.stringify({
      ...plan,
      mcpDir: '/private/a',
      stateDirectory: '/host/records',
    }),
  );
  t.false('mcpDir' in parsed);
  t.false('stateDirectory' in parsed);
  t.deepEqual(parsed, readCodexSessionPlan(JSON.stringify(plan)));
});

/** @type {readonly [Record<string, unknown>, RegExp][]} */
const refused = harden([
  [{ sandboxSessionId: 'another-session' }, /must derive/],
  [{ accountRef: '' }, /pin its subscription/],
  [{ imageRef: 'example:latest' }, /pinned/],
  [{ networkPolicy: 'host' }, /network policy/],
  [{ workspaceHostPath: '/operator/repo' }, /exactly one/],
  [{ workspaceDir: undefined }, /exactly one/],
  [{ mounterSocketDir: '/private/a/workspace/socket' }, /overlaps/],
  [{ workspaceDir: '/workspaces/../other' }, /absolute path/],
  [{ reasoningEffort: 7 }, /must be text/],
  [{ mounterEnv: { PATH: '/untrusted' } }, /Unknown mounter setting/],
]);

for (const [change, message] of refused) {
  test(`Codex refuses invalid recorded plan ${JSON.stringify(change)}`, t => {
    t.throws(
      () => readCodexSessionPlan(JSON.stringify({ ...plan, ...change })),
      { message },
    );
  });
}

test('a plan may pin its session to one of the provider’s subscriptions', t => {
  // A plan from before subscriptions has none, and reads as before.
  t.false('subscription' in readCodexSessionPlan(JSON.stringify(plan)));
  t.is(
    readCodexSessionPlan(JSON.stringify({ ...plan, subscription: 'work' }))
      .subscription,
    'work',
  );
  for (const subscription of ['not an id', '', 7, { id: 'work' }]) {
    t.throws(
      () => readCodexSessionPlan(JSON.stringify({ ...plan, subscription })),
      { message: /subscription must be auto or a subscription id/ },
    );
  }
});

test('retired per-session native profiles are refused rather than ignored', t => {
  t.throws(
    () => readCodexSessionPlan(JSON.stringify({ ...plan, nativeProfile: {} })),
    {
      message: /Retired nativeProfile field/,
    },
  );
});
