// @ts-check
import '@endo/init';
import test from 'ava';
import { makeSandboxSessionId } from '@endo/hosted-agent/session-plan.js';

import { readCodexSessionPlan } from '../src/codex-session-plan.js';

const plan = harden({
  sessionId: 'session-a',
  sandboxSessionId: makeSandboxSessionId('session-a', 'codex'),
  rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
  accountRef: 'subscription-a',
  stateRoot: '/native-state',
  networkPolicy: 'off',
  workspaceDir: '/workspaces/a',
  workspaceMountPoint: '/private/a/workspace',
  mounterSocketDir: '/private/a/9p',
  containerMounts: [],
});

test('native state root is required and must be a normalized absolute non-root path', t => {
  for (const stateRoot of [
    undefined,
    '/',
    'relative',
    '/state/../other',
    '/state/',
    `/state${String.fromCharCode(0)}bad`,
  ]) {
    t.throws(
      () => readCodexSessionPlan(JSON.stringify({ ...plan, stateRoot })),
      {
        message: /recorded absolute path for "stateRoot"/,
      },
    );
  }
  t.is(readCodexSessionPlan(JSON.stringify(plan)).stateRoot, plan.stateRoot);
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

test('unknown fields are refused, so none can add storage cleanup authority', t => {
  t.throws(
    () =>
      readCodexSessionPlan(JSON.stringify({ ...plan, mcpDir: '/private/a' })),
    { message: /Unknown session plan field "mcpDir"; recreate/ },
  );
  t.throws(
    () =>
      readCodexSessionPlan(
        JSON.stringify({ ...plan, stateDirectory: '/host/records' }),
      ),
    { message: /Unknown session plan field "stateDirectory"/ },
  );
  // The retired spelling of the image is unknown too.
  const { rootfs: _, ...unpinned } = plan;
  t.throws(
    () =>
      readCodexSessionPlan(
        JSON.stringify({
          ...unpinned,
          imageRef: `example@sha256:${'a'.repeat(64)}`,
        }),
      ),
    { message: /Unknown session plan field "imageRef"/ },
  );
});

/** @type {readonly [Record<string, unknown>, RegExp][]} */
const refused = harden([
  [{ sandboxSessionId: 'another-session' }, /must derive/],
  [{ accountRef: '' }, /account authority must be an id/],
  [{ rootfs: 'oci:example:latest' }, /pinned to a digest/],
  [{ rootfs: `example@sha256:${'a'.repeat(64)}` }, /oci:/],
  [
    { rootfs: `oci:example:tag@sha256:${'a'.repeat(64)}` },
    /native runtime will accept/,
  ],
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
      { message: /subscription must be a subscription id/ },
    );
  }
});

test('retired per-session native profiles are refused rather than ignored', t => {
  t.throws(
    () => readCodexSessionPlan(JSON.stringify({ ...plan, nativeProfile: {} })),
    {
      message: /Unknown session plan field "nativeProfile"/,
    },
  );
});
