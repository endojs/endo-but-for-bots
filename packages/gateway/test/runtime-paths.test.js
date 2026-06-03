// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  detectServiceMode,
  resolveGatewayPaths,
  SYSTEM_STATE_DIR_LINUX,
  SYSTEM_RUNTIME_DIR_LINUX,
  SYSTEM_LOG_DIR_LINUX,
  SYSTEM_CACHE_DIR_LINUX,
  SYSTEM_CONFIG_FILE_LINUX,
  SYSTEM_STATE_DIR_DARWIN,
  SYSTEM_RUNTIME_DIR_DARWIN,
  SYSTEM_LOG_DIR_DARWIN,
  SYSTEM_CACHE_DIR_DARWIN,
  SYSTEM_CONFIG_FILE_DARWIN,
  USER_DIR_SUBDIR,
} from '../index.js';

const linuxInfo = harden({
  home: '/home/alice',
  user: 'alice',
});

const darwinInfo = harden({
  home: '/Users/alice',
  user: 'alice',
});

// -----------------------------------------------------------------------
// detectServiceMode
// -----------------------------------------------------------------------

test('detectServiceMode: no signals returns user', t => {
  t.is(detectServiceMode({ uid: 1000, env: {} }), 'user');
});

test('detectServiceMode: euid 0 returns system', t => {
  t.is(detectServiceMode({ uid: 0, env: {} }), 'system');
});

test('detectServiceMode: INVOCATION_ID returns system (systemd)', t => {
  // systemd sets INVOCATION_ID for every unit it starts. The signal
  // is independent of euid because a hardened systemd unit runs the
  // service as a non-root user (User=endo per Feature 10).
  t.is(
    detectServiceMode({ uid: 999, env: { INVOCATION_ID: 'abc123' } }),
    'system',
  );
});

test('detectServiceMode: empty INVOCATION_ID is not a signal', t => {
  // An explicit empty value is ignored. Hardens against environment
  // contamination from a parent process that exported the var.
  t.is(detectServiceMode({ uid: 1000, env: { INVOCATION_ID: '' } }), 'user');
});

test('detectServiceMode: explicit flag returns system', t => {
  t.is(detectServiceMode({ uid: 1000, env: {}, explicit: true }), 'system');
});

test('detectServiceMode: explicit overrides absent signals', t => {
  // The flag is the operator's last word; an admin running `sudo` on
  // a developer machine should be able to invoke
  // `endo gateway start --system` without setting INVOCATION_ID.
  t.is(detectServiceMode({ explicit: true }), 'system');
});

test('detectServiceMode: undefined uid on Windows', t => {
  // process.geteuid() is undefined on Windows. The detector must not
  // crash; without the other two signals it returns user.
  t.is(detectServiceMode({ uid: undefined, env: {} }), 'user');
});

// -----------------------------------------------------------------------
// resolveGatewayPaths: system mode
// -----------------------------------------------------------------------

test('resolveGatewayPaths: system mode on Linux uses /var, /run, /etc', t => {
  const paths = resolveGatewayPaths({
    mode: 'system',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, SYSTEM_STATE_DIR_LINUX);
  t.is(paths.stateDir.source, 'system-linux');
  t.is(paths.runtimeDir.path, SYSTEM_RUNTIME_DIR_LINUX);
  t.is(paths.runtimeDir.source, 'system-linux');
  t.is(paths.logDir.path, SYSTEM_LOG_DIR_LINUX);
  t.is(paths.logDir.source, 'system-linux');
  t.is(paths.cacheDir.path, SYSTEM_CACHE_DIR_LINUX);
  t.is(paths.cacheDir.source, 'system-linux');
  t.is(paths.configFile.path, SYSTEM_CONFIG_FILE_LINUX);
  t.is(paths.configFile.source, 'system-linux');
});

test('resolveGatewayPaths: system mode on macOS uses /usr/local/var', t => {
  const paths = resolveGatewayPaths({
    mode: 'system',
    platform: 'darwin',
    env: {},
    info: darwinInfo,
  });
  t.is(paths.stateDir.path, SYSTEM_STATE_DIR_DARWIN);
  t.is(paths.stateDir.source, 'system-darwin');
  t.is(paths.runtimeDir.path, SYSTEM_RUNTIME_DIR_DARWIN);
  t.is(paths.logDir.path, SYSTEM_LOG_DIR_DARWIN);
  t.is(paths.cacheDir.path, SYSTEM_CACHE_DIR_DARWIN);
  t.is(paths.configFile.path, SYSTEM_CONFIG_FILE_DARWIN);
});

// -----------------------------------------------------------------------
// resolveGatewayPaths: user mode
// -----------------------------------------------------------------------

test('resolveGatewayPaths: user mode on Linux honors XDG vars', t => {
  const paths = resolveGatewayPaths({
    mode: 'user',
    platform: 'linux',
    env: {
      XDG_STATE_HOME: '/home/alice/.local/state',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CACHE_HOME: '/home/alice/.cache',
      XDG_CONFIG_HOME: '/home/alice/.config',
    },
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, `/home/alice/.local/state/${USER_DIR_SUBDIR}`);
  t.is(paths.stateDir.source, 'user-xdg');
  t.is(paths.runtimeDir.path, `/run/user/1000/${USER_DIR_SUBDIR}`);
  t.is(paths.runtimeDir.source, 'user-xdg');
  // The log dir reuses XDG_STATE_HOME; symmetry with whereEndoState.
  t.is(paths.logDir.path, `/home/alice/.local/state/${USER_DIR_SUBDIR}`);
  t.is(paths.cacheDir.path, `/home/alice/.cache/${USER_DIR_SUBDIR}`);
  t.is(paths.configFile.path, `/home/alice/.config/${USER_DIR_SUBDIR}`);
});

test('resolveGatewayPaths: user mode on Linux falls back when XDG vars unset', t => {
  // Regression: a Linux user without a logind session loses
  // XDG_RUNTIME_DIR; the resolver must still produce a path.
  const paths = resolveGatewayPaths({
    mode: 'user',
    platform: 'linux',
    env: {},
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, '/home/alice/.local/state/endo-gateway');
  t.is(paths.stateDir.source, 'user-xdg-fallback');
  t.is(paths.runtimeDir.path, '/home/alice/.local/run/endo-gateway');
  t.is(paths.logDir.path, '/home/alice/.local/state/endo-gateway/log');
  t.is(paths.cacheDir.path, '/home/alice/.cache/endo-gateway');
  t.is(paths.configFile.path, '/home/alice/.config/endo-gateway/config.toml');
});

test('resolveGatewayPaths: user mode on macOS uses Library/Application Support', t => {
  const paths = resolveGatewayPaths({
    mode: 'user',
    platform: 'darwin',
    env: {},
    info: darwinInfo,
  });
  t.is(
    paths.stateDir.path,
    '/Users/alice/Library/Application Support/Endo/endo-gateway',
  );
  t.is(paths.stateDir.source, 'user-darwin');
  t.is(
    paths.runtimeDir.path,
    '/Users/alice/Library/Application Support/Endo/endo-gateway/run',
  );
  t.is(paths.logDir.path, '/Users/alice/Library/Logs/Endo/endo-gateway');
  t.is(paths.cacheDir.path, '/Users/alice/Library/Caches/Endo/endo-gateway');
});

test('resolveGatewayPaths: HOME env overrides info.home', t => {
  const paths = resolveGatewayPaths({
    mode: 'user',
    platform: 'linux',
    env: { HOME: '/home/bob' },
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, '/home/bob/.local/state/endo-gateway');
});

// -----------------------------------------------------------------------
// resolveGatewayPaths: per-directory overrides
// -----------------------------------------------------------------------

test('resolveGatewayPaths: override env var beats every other rule', t => {
  const paths = resolveGatewayPaths({
    mode: 'system',
    platform: 'linux',
    env: {
      ENDO_GATEWAY_STATE_DIR: '/srv/endo/state',
      ENDO_GATEWAY_RUNTIME_DIR: '/srv/endo/run',
      ENDO_GATEWAY_LOG_DIR: '/srv/endo/log',
      ENDO_GATEWAY_CACHE_DIR: '/srv/endo/cache',
      ENDO_GATEWAY_CONFIG_FILE: '/srv/endo/etc/config.toml',
    },
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, '/srv/endo/state');
  t.is(paths.stateDir.source, 'override');
  t.is(paths.runtimeDir.path, '/srv/endo/run');
  t.is(paths.runtimeDir.source, 'override');
  t.is(paths.logDir.path, '/srv/endo/log');
  t.is(paths.cacheDir.path, '/srv/endo/cache');
  t.is(paths.configFile.path, '/srv/endo/etc/config.toml');
});

test('resolveGatewayPaths: override on one directory does not affect siblings', t => {
  const paths = resolveGatewayPaths({
    mode: 'system',
    platform: 'linux',
    env: {
      ENDO_GATEWAY_STATE_DIR: '/srv/endo/state',
    },
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, '/srv/endo/state');
  t.is(paths.stateDir.source, 'override');
  t.is(paths.runtimeDir.path, SYSTEM_RUNTIME_DIR_LINUX);
  t.is(paths.runtimeDir.source, 'system-linux');
});

test('resolveGatewayPaths: empty override env value is ignored', t => {
  // A `setx VAR=` (or an `export VAR=` with no value) is normalized
  // to "not provided"; otherwise an operator who tries to clear an
  // override accidentally invents a path of `""` (the empty string)
  // and crashes the mkdir.
  const paths = resolveGatewayPaths({
    mode: 'system',
    platform: 'linux',
    env: { ENDO_GATEWAY_STATE_DIR: '' },
    info: linuxInfo,
  });
  t.is(paths.stateDir.path, SYSTEM_STATE_DIR_LINUX);
  t.is(paths.stateDir.source, 'system-linux');
});

// -----------------------------------------------------------------------
// validation
// -----------------------------------------------------------------------

test('resolveGatewayPaths: rejects invalid mode', t => {
  t.throws(
    () =>
      resolveGatewayPaths({
        // @ts-expect-error testing runtime validation
        mode: 'admin',
        platform: 'linux',
        env: {},
        info: linuxInfo,
      }),
    { message: /mode must be 'system' or 'user'/u },
  );
});

test('resolveGatewayPaths: rejects empty platform', t => {
  t.throws(
    () =>
      resolveGatewayPaths({
        mode: 'user',
        platform: '',
        env: {},
        info: linuxInfo,
      }),
    { message: /Platform must be a non-empty string/u },
  );
});

test('resolveGatewayPaths: rejects user mode without HOME or info.home', t => {
  t.throws(
    () =>
      resolveGatewayPaths({
        mode: 'user',
        platform: 'linux',
        env: {},
        // @ts-expect-error testing runtime validation
        info: harden({ user: 'alice' }),
      }),
    { message: /no HOME and no info.home/u },
  );
});
