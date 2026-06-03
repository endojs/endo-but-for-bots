// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  resolveBootstrapSocketPath,
  BOOTSTRAP_SOCKET_BASENAME,
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
