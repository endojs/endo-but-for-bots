// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { connectDaemon, resolveSockPath } from '../src/backend/daemon.js';

test('resolveSockPath honors an explicit sockPath override', t => {
  t.is(
    resolveSockPath({ sockPath: '/tmp/explicit.sock', env: {} }),
    '/tmp/explicit.sock',
  );
});

test('resolveSockPath honors ENDO_SOCK from the environment', t => {
  t.is(
    resolveSockPath({ env: { ENDO_SOCK: '/run/endo/captp0.sock' } }),
    '/run/endo/captp0.sock',
  );
});

test('connectDaemon returns null when no daemon is reachable (OFFLINE fallback)', async t => {
  // Point at a socket path that cannot accept a connection. The cockpit, unlike
  // the CLI, never starts a daemon, so an unreachable socket is a clean null
  // (OFFLINE), not a throw.
  const result = await connectDaemon({
    sockPath: '/nonexistent/cockpit-test-no-daemon.sock',
    env: {},
  });
  t.is(result, null);
});
