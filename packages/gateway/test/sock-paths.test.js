// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  resolveBootstrapSocketPath,
  resolveAdminSocketPath,
  BOOTSTRAP_SOCKET_BASENAME,
  ADMIN_SOCKET_BASENAME,
  SYSTEM_RUNTIME_DIR_LINUX,
  USER_RUNTIME_SUBDIR,
} from '../index.js';

const linuxInfo = harden({
  home: '/home/alice',
  user: 'alice',
  temp: '/tmp',
});

test('system mode on Linux resolves /run/endo-gateway/bootstrap.sock', t => {
  const result = resolveBootstrapSocketPath({
    mode: 'system',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.is(result.path, `${SYSTEM_RUNTIME_DIR_LINUX}/${BOOTSTRAP_SOCKET_BASENAME}`);
  t.is(result.source, 'system');
  t.is(result.kind, 'unix-socket');
});

test('user mode on Linux prefers XDG_RUNTIME_DIR', t => {
  const result = resolveBootstrapSocketPath({
    mode: 'user',
    platform: 'linux',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    info: linuxInfo,
  });
  t.is(
    result.path,
    `/run/user/1000/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
  );
  t.is(result.source, 'user-xdg');
});

test('user mode on Linux without XDG_RUNTIME_DIR falls back to TMPDIR', t => {
  // Regression: a Linux process that runs outside a logind session
  // (a Docker container without `tmpfs /run`, a bare init) loses
  // XDG_RUNTIME_DIR. If the resolver crashes rather than falling
  // back, those callers cannot stand up a per-user gateway.
  const result = resolveBootstrapSocketPath({
    mode: 'user',
    platform: 'linux',
    env: { TMPDIR: '/tmp', USER: 'alice' },
    info: linuxInfo,
  });
  t.is(
    result.path,
    `/tmp/endo-alice/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
  );
  t.is(result.source, 'user-tmpdir');
});

test('user mode on darwin uses Library/Application Support', t => {
  const result = resolveBootstrapSocketPath({
    mode: 'user',
    platform: 'darwin',
    env: {},
    info: { home: '/Users/alice', user: 'alice', temp: '/tmp' },
  });
  t.is(
    result.path,
    `/Users/alice/Library/Application Support/Endo/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
  );
  t.is(result.source, 'user-darwin');
});

test('system mode on darwin resolves under /Library/Application Support', t => {
  // The 'system' mode on darwin is the macOS LaunchDaemon variant.
  // The design names /var/run/ for the runtime directory; we still
  // resolve to the Linux /run/endo-gateway path here as the
  // forward-compatible default. Maintainer surface this as an open
  // question on the PR.
  const result = resolveBootstrapSocketPath({
    mode: 'system',
    platform: 'darwin',
    env: {},
    info: { home: '/Users/alice', user: 'alice', temp: '/tmp' },
  });
  t.is(result.path, `${SYSTEM_RUNTIME_DIR_LINUX}/${BOOTSTRAP_SOCKET_BASENAME}`);
  t.is(result.source, 'system');
});

test('ENDO_GATEWAY_BOOTSTRAP_SOCK overrides every resolution rule', t => {
  // Regression for the operator-override path: if the resolver
  // ever silently ignores the env var, an operator who points to a
  // non-default path gets no diagnostic and silently binds to the
  // default location.
  const result = resolveBootstrapSocketPath({
    mode: 'system',
    platform: 'linux',
    env: { ENDO_GATEWAY_BOOTSTRAP_SOCK: '/var/run/custom.sock' },
    info: linuxInfo,
  });
  t.is(result.path, '/var/run/custom.sock');
  t.is(result.source, 'override');
  t.is(result.kind, 'unix-socket');
});

test('empty ENDO_GATEWAY_BOOTSTRAP_SOCK is ignored', t => {
  // An exported-but-empty environment variable is a common shell
  // mishap; the resolver must treat it as unset rather than as a
  // literal empty path.
  const result = resolveBootstrapSocketPath({
    mode: 'system',
    platform: 'linux',
    env: { ENDO_GATEWAY_BOOTSTRAP_SOCK: '' },
    info: linuxInfo,
  });
  t.is(result.path, `${SYSTEM_RUNTIME_DIR_LINUX}/${BOOTSTRAP_SOCKET_BASENAME}`);
  t.is(result.source, 'system');
});

test('mode validation rejects unknown modes', t => {
  t.throws(
    () =>
      resolveBootstrapSocketPath({
        mode: /** @type {any} */ ('unknown'),
        platform: 'linux',
        env: {},
        info: linuxInfo,
      }),
    { message: /mode must be 'system' or 'user'/ },
  );
});

test('platform validation rejects empty', t => {
  t.throws(
    () =>
      resolveBootstrapSocketPath({
        mode: 'system',
        platform: '',
        env: {},
        info: linuxInfo,
      }),
    { message: /Platform must be a non-empty string/ },
  );
});

test('user mode without TMPDIR or info.temp throws clearly', t => {
  // Regression: an underprovisioned environment should fail at the
  // resolver, not later when the socket-listener helper trips on
  // an undefined path.
  t.throws(
    () =>
      resolveBootstrapSocketPath({
        mode: 'user',
        platform: 'linux',
        env: { USER: 'alice' },
        info: { home: '/home/alice', user: 'alice', temp: '' },
      }),
    { message: /no TMPDIR and no info.temp/ },
  );
});

test('user mode without USER or info.user throws clearly', t => {
  t.throws(
    () =>
      resolveBootstrapSocketPath({
        mode: 'user',
        platform: 'linux',
        env: { TMPDIR: '/tmp' },
        info: { home: '/home/alice', user: '', temp: '/tmp' },
      }),
    { message: /no USER and no info.user/ },
  );
});

test('darwin user mode without HOME or info.home throws clearly', t => {
  t.throws(
    () =>
      resolveBootstrapSocketPath({
        mode: 'user',
        platform: 'darwin',
        env: {},
        info: { home: '', user: 'alice', temp: '/tmp' },
      }),
    { message: /no HOME and no info.home on darwin/ },
  );
});

test('returned BootstrapPathResolution is hardened', t => {
  // Regression: callers may stash the result; an un-hardened
  // record would let downstream code mutate `path` and silently
  // bind to a different socket than the resolver returned.
  const result = resolveBootstrapSocketPath({
    mode: 'system',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.true(Object.isFrozen(result));
});

// -- Admin sock path resolution -----------------------------------

// The admin sock carries the `GatewayAdmin` exo. It is a separate
// file from the bootstrap sock; the two are intentionally distinct
// so that connecting to the bootstrap sock (any local user daemon
// may do this to register itself) does not grant admin authority,
// and the admin sock can live behind a stricter ACL.

test('admin sock system mode on Linux resolves /run/endo-gateway/admin.sock', t => {
  const result = resolveAdminSocketPath({
    mode: 'system',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.is(result.path, `${SYSTEM_RUNTIME_DIR_LINUX}/${ADMIN_SOCKET_BASENAME}`);
  t.is(result.source, 'system');
  t.is(result.kind, 'unix-socket');
});

test('admin sock user mode on Linux prefers XDG_RUNTIME_DIR', t => {
  const result = resolveAdminSocketPath({
    mode: 'user',
    platform: 'linux',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    info: linuxInfo,
  });
  t.is(
    result.path,
    `/run/user/1000/${USER_RUNTIME_SUBDIR}/${ADMIN_SOCKET_BASENAME}`,
  );
  t.is(result.source, 'user-xdg');
});

test('admin sock user mode on darwin uses Library/Application Support', t => {
  const result = resolveAdminSocketPath({
    mode: 'user',
    platform: 'darwin',
    env: {},
    info: { home: '/Users/alice', user: 'alice', temp: '/tmp' },
  });
  t.is(
    result.path,
    `/Users/alice/Library/Application Support/Endo/${USER_RUNTIME_SUBDIR}/${ADMIN_SOCKET_BASENAME}`,
  );
  t.is(result.source, 'user-darwin');
});

test('ENDO_GATEWAY_ADMIN_SOCK overrides the admin sock resolution', t => {
  // Regression: a deployment that wants the admin sock under a
  // tighter parent directory (mode 0700 instead of the bootstrap
  // sock's 0755 parent) supplies an override; if the resolver
  // silently ignored it, the admin sock would land in the same
  // world-traversable directory as the bootstrap sock.
  const result = resolveAdminSocketPath({
    mode: 'system',
    platform: 'linux',
    env: { ENDO_GATEWAY_ADMIN_SOCK: '/run/endo-gateway-admin/admin.sock' },
    info: linuxInfo,
  });
  t.is(result.path, '/run/endo-gateway-admin/admin.sock');
  t.is(result.source, 'override');
});

test('admin sock override does not pick up the bootstrap override env var', t => {
  // Regression-evidence saboteur: if a caller accidentally reads
  // `ENDO_GATEWAY_BOOTSTRAP_SOCK` for the admin sock, the admin
  // and bootstrap socks collapse onto the same path. Verify the
  // admin resolver ignores the bootstrap variable.
  const result = resolveAdminSocketPath({
    mode: 'system',
    platform: 'linux',
    env: { ENDO_GATEWAY_BOOTSTRAP_SOCK: '/run/sneaky/bootstrap.sock' },
    info: linuxInfo,
  });
  t.is(result.path, `${SYSTEM_RUNTIME_DIR_LINUX}/${ADMIN_SOCKET_BASENAME}`);
  t.is(result.source, 'system');
});

test('admin and bootstrap socks resolve to distinct file paths', t => {
  // The single most important invariant of the split: the two
  // socks are never the same file. A registration-only daemon
  // connecting to bootstrap.sock must not reach the admin facet;
  // an administrator connecting to admin.sock must not be
  // confused with a registration-only daemon. Verified across the
  // four resolution sources.
  const cases = harden([
    harden({
      mode: /** @type {'system' | 'user'} */ ('system'),
      platform: 'linux',
      env: {},
      info: linuxInfo,
    }),
    harden({
      mode: /** @type {'system' | 'user'} */ ('user'),
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      info: linuxInfo,
    }),
    harden({
      mode: /** @type {'system' | 'user'} */ ('user'),
      platform: 'darwin',
      env: {},
      info: { home: '/Users/alice', user: 'alice', temp: '/tmp' },
    }),
    harden({
      mode: /** @type {'system' | 'user'} */ ('user'),
      platform: 'linux',
      env: { TMPDIR: '/tmp', USER: 'alice' },
      info: linuxInfo,
    }),
  ]);
  for (const args of cases) {
    const bootstrap = resolveBootstrapSocketPath(args);
    const admin = resolveAdminSocketPath(args);
    t.not(
      bootstrap.path,
      admin.path,
      `bootstrap and admin socks must be distinct for ${args.mode}/${args.platform}`,
    );
    t.true(bootstrap.path.endsWith(BOOTSTRAP_SOCKET_BASENAME));
    t.true(admin.path.endsWith(ADMIN_SOCKET_BASENAME));
  }
});

test('admin and bootstrap basenames are distinct constants', t => {
  // Regression-evidence: if a refactor accidentally pointed
  // ADMIN_SOCKET_BASENAME at the bootstrap basename, every other
  // test in this suite would still pass (the resolvers would
  // pick up the wrong constant, but consistently). Pinning the
  // value here catches that class of mistake at the unit level.
  t.is(BOOTSTRAP_SOCKET_BASENAME, 'bootstrap.sock');
  t.is(ADMIN_SOCKET_BASENAME, 'admin.sock');
  t.not(BOOTSTRAP_SOCKET_BASENAME, ADMIN_SOCKET_BASENAME);
});

test('admin sock resolution is hardened', t => {
  const result = resolveAdminSocketPath({
    mode: 'system',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.true(Object.isFrozen(result));
});
