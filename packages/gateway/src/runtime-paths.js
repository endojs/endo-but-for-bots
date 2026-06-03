// @ts-check

/**
 * @file Host-scope runtime path resolution for the gateway service.
 *
 * The gateway runs in two postures with distinct path conventions:
 *
 *   - **System service** (effective UID 0, `INVOCATION_ID` set by
 *     systemd, or an explicit `--system` flag): the gateway is a
 *     per-host service owned by the `endo` service account. Paths
 *     follow the Linux Filesystem Hierarchy Standard so they line up
 *     with what systemd's `StateDirectory`, `RuntimeDirectory`,
 *     `CacheDirectory`, and `LogsDirectory` already provide. On macOS
 *     the equivalent shapes live under `/usr/local/var/...` per the
 *     Homebrew convention. The design document names these paths
 *     directly (`designs/gateway-package.md` § Feature 10).
 *
 *   - **User mode** (anything else): the gateway is one of the
 *     per-user developer's processes. Paths follow the XDG Base
 *     Directory Specification on Linux and Apple's Application
 *     Support / Library / Caches conventions on macOS, parallel to
 *     `packages/where`'s existing per-user-daemon shape.
 *
 * The two postures share the resolver but never share a path: a
 * machine running both a system gateway (uid 0) and a per-user
 * gateway (uid > 0) places their state directories in disjoint trees
 * so neither overwrites the other.
 *
 * Like the sister `sock-paths.js`, this resolver is **pure**: it
 * never touches the filesystem. The caller (the daemon entry script,
 * the CLI's `endo gateway start` action) is responsible for
 * `mkdir -p` of each resolved directory, for the access modes the
 * design's Feature 10 names, and for refusing to start when a
 * required directory cannot be created (the gateway never silently
 * substitutes a different path).
 *
 * Overrides land on a per-directory basis through environment
 * variables: `ENDO_GATEWAY_STATE_DIR`, `ENDO_GATEWAY_RUNTIME_DIR`,
 * `ENDO_GATEWAY_LOG_DIR`, `ENDO_GATEWAY_CACHE_DIR`,
 * `ENDO_GATEWAY_CONFIG_FILE`. The override is taken verbatim. An
 * override on one directory does not affect the resolution of the
 * others.
 *
 * The service-posture detector (`detectServiceMode`) consults the
 * three signals named in the maintainer directive on PR #343:
 * effective UID 0, presence of `INVOCATION_ID` (set by systemd for
 * any unit it starts), or an explicit `--system` flag (passed
 * through as the caller's `explicit` argument). Any one of the three
 * resolves to `'system'`; otherwise the resolver returns `'user'`.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { GatewayPathInfo, GatewayPathResolution } from './types.d.ts' */

/** Default Linux system-service paths per `designs/gateway-package.md` § Feature 10. */
export const SYSTEM_STATE_DIR_LINUX = '/var/lib/endo-gateway';
harden(SYSTEM_STATE_DIR_LINUX);
export const SYSTEM_RUNTIME_DIR_LINUX = '/run/endo-gateway';
harden(SYSTEM_RUNTIME_DIR_LINUX);
export const SYSTEM_LOG_DIR_LINUX = '/var/log/endo-gateway';
harden(SYSTEM_LOG_DIR_LINUX);
export const SYSTEM_CACHE_DIR_LINUX = '/var/cache/endo-gateway';
harden(SYSTEM_CACHE_DIR_LINUX);
export const SYSTEM_CONFIG_FILE_LINUX = '/etc/endo-gateway/config.toml';
harden(SYSTEM_CONFIG_FILE_LINUX);

/**
 * Default macOS system-service paths. Homebrew's convention places
 * variable-state, run, log, and cache directories under
 * `/usr/local/var/...`; the design names these as the macOS
 * equivalents to the Linux system paths. A macOS deployment that
 * adopts a different prefix (Homebrew on Apple silicon ships under
 * `/opt/homebrew/var/...`) sets the override variables.
 */
export const SYSTEM_STATE_DIR_DARWIN = '/usr/local/var/lib/endo-gateway';
harden(SYSTEM_STATE_DIR_DARWIN);
export const SYSTEM_RUNTIME_DIR_DARWIN = '/usr/local/var/run/endo-gateway';
harden(SYSTEM_RUNTIME_DIR_DARWIN);
export const SYSTEM_LOG_DIR_DARWIN = '/usr/local/var/log/endo-gateway';
harden(SYSTEM_LOG_DIR_DARWIN);
export const SYSTEM_CACHE_DIR_DARWIN = '/usr/local/var/cache/endo-gateway';
harden(SYSTEM_CACHE_DIR_DARWIN);
export const SYSTEM_CONFIG_FILE_DARWIN =
  '/usr/local/etc/endo-gateway/config.toml';
harden(SYSTEM_CONFIG_FILE_DARWIN);

/** Subdirectory name used for user-mode paths. */
export const USER_DIR_SUBDIR = 'endo-gateway';
harden(USER_DIR_SUBDIR);

/** Environment-variable names for per-directory overrides. */
const STATE_OVERRIDE_ENV = 'ENDO_GATEWAY_STATE_DIR';
const RUNTIME_OVERRIDE_ENV = 'ENDO_GATEWAY_RUNTIME_DIR';
const LOG_OVERRIDE_ENV = 'ENDO_GATEWAY_LOG_DIR';
const CACHE_OVERRIDE_ENV = 'ENDO_GATEWAY_CACHE_DIR';
const CONFIG_OVERRIDE_ENV = 'ENDO_GATEWAY_CONFIG_FILE';

/**
 * Detect whether the gateway should run as a system service. The
 * three signals are listed in the maintainer directive (PR #343
 * review): effective UID 0, `INVOCATION_ID` set (systemd does this
 * for every unit), or an explicit `--system` flag. The CLI's
 * `endo gateway start --system` translates to `explicit: true`.
 *
 * @param {object} args
 * @param {number} [args.uid] The effective UID. `process.geteuid()` on
 *   POSIX, `undefined` on Windows where the concept does not apply.
 * @param {{[name: string]: string | undefined}} [args.env] Process
 *   environment, consulted for `INVOCATION_ID`.
 * @param {boolean} [args.explicit] Caller-supplied `--system` flag.
 * @returns {'system' | 'user'}
 */
export const detectServiceMode = ({ uid, env = {}, explicit = false } = {}) => {
  if (explicit) {
    return 'system';
  }
  if (uid === 0) {
    return 'system';
  }
  if (env.INVOCATION_ID !== undefined && env.INVOCATION_ID !== '') {
    return 'system';
  }
  return 'user';
};
harden(detectServiceMode);

/**
 * @param {object} args
 * @param {'system' | 'user'} args.mode
 * @param {string} args.platform
 * @param {{[name: string]: string | undefined}} args.env
 * @param {GatewayPathInfo} args.info
 * @param {string} args.systemLinux
 * @param {string} args.systemDarwin
 * @param {string | undefined} args.override
 * @param {string} args.xdgVar  Name of the XDG env var consulted in
 *   user mode (`XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`,
 *   etc.). When the env var is unset the resolver falls back to the
 *   platform default.
 * @param {string} args.xdgFallbackLinux  Path template for the Linux
 *   user-mode fallback when the XDG var is unset, with `@HOME@` as
 *   the only substitution.
 * @param {string} args.darwinFallback  Path template for the macOS
 *   user-mode fallback, with `@HOME@` as the only substitution.
 * @returns {GatewayPathResolution}
 */
const resolveOne = ({
  mode,
  platform,
  env,
  info,
  systemLinux,
  systemDarwin,
  override,
  xdgVar,
  xdgFallbackLinux,
  darwinFallback,
}) => {
  if (override !== undefined && override !== '') {
    return harden({ path: override, source: 'override' });
  }

  if (mode === 'system') {
    if (platform === 'darwin') {
      return harden({ path: systemDarwin, source: 'system-darwin' });
    }
    // Default to the Linux FHS layout for every non-darwin platform.
    return harden({ path: systemLinux, source: 'system-linux' });
  }

  // mode === 'user'
  const xdgValue = env[xdgVar];
  if (xdgValue !== undefined && xdgValue !== '') {
    return harden({
      path: `${xdgValue}/${USER_DIR_SUBDIR}`,
      source: 'user-xdg',
    });
  }

  const home = env.HOME ?? info.home;
  if (typeof home !== 'string' || home.length === 0) {
    throw makeError(
      X`Cannot resolve user-mode gateway path: no HOME and no info.home`,
    );
  }
  if (platform === 'darwin') {
    return harden({
      path: darwinFallback.replace('@HOME@', home),
      source: 'user-darwin',
    });
  }
  return harden({
    path: xdgFallbackLinux.replace('@HOME@', home),
    source: 'user-xdg-fallback',
  });
};

/**
 * Resolve every gateway directory at once. Returns a record of
 * `{stateDir, runtimeDir, logDir, cacheDir, configFile}`, each as a
 * `GatewayPathResolution` carrying the resolved path plus a source
 * label.
 *
 * The function is pure. The caller `mkdir -p`s each directory and
 * touches the config file as appropriate.
 *
 * @param {object} args
 * @param {'system' | 'user'} args.mode
 * @param {string} args.platform `process.platform` value.
 * @param {{[name: string]: string | undefined}} [args.env]
 * @param {GatewayPathInfo} args.info
 * @returns {{
 *   stateDir: GatewayPathResolution,
 *   runtimeDir: GatewayPathResolution,
 *   logDir: GatewayPathResolution,
 *   cacheDir: GatewayPathResolution,
 *   configFile: GatewayPathResolution,
 * }}
 */
export const resolveGatewayPaths = ({ mode, platform, env = {}, info }) => {
  if (mode !== 'system' && mode !== 'user') {
    throw makeError(
      X`Gateway path mode must be 'system' or 'user', got ${q(mode)}`,
    );
  }
  if (typeof platform !== 'string' || platform.length === 0) {
    throw makeError(X`Platform must be a non-empty string, got ${q(platform)}`);
  }
  if (info === undefined || typeof info !== 'object') {
    throw makeError(X`Gateway path info must be an object, got ${q(info)}`);
  }

  const stateDir = resolveOne({
    mode,
    platform,
    env,
    info,
    systemLinux: SYSTEM_STATE_DIR_LINUX,
    systemDarwin: SYSTEM_STATE_DIR_DARWIN,
    override: env[STATE_OVERRIDE_ENV],
    xdgVar: 'XDG_STATE_HOME',
    xdgFallbackLinux: '@HOME@/.local/state/endo-gateway',
    darwinFallback: '@HOME@/Library/Application Support/Endo/endo-gateway',
  });

  const runtimeDir = resolveOne({
    mode,
    platform,
    env,
    info,
    systemLinux: SYSTEM_RUNTIME_DIR_LINUX,
    systemDarwin: SYSTEM_RUNTIME_DIR_DARWIN,
    override: env[RUNTIME_OVERRIDE_ENV],
    xdgVar: 'XDG_RUNTIME_DIR',
    xdgFallbackLinux: '@HOME@/.local/run/endo-gateway',
    darwinFallback: '@HOME@/Library/Application Support/Endo/endo-gateway/run',
  });

  const logDir = resolveOne({
    mode,
    platform,
    env,
    info,
    systemLinux: SYSTEM_LOG_DIR_LINUX,
    systemDarwin: SYSTEM_LOG_DIR_DARWIN,
    override: env[LOG_OVERRIDE_ENV],
    xdgVar: 'XDG_STATE_HOME',
    xdgFallbackLinux: '@HOME@/.local/state/endo-gateway/log',
    darwinFallback: '@HOME@/Library/Logs/Endo/endo-gateway',
  });

  const cacheDir = resolveOne({
    mode,
    platform,
    env,
    info,
    systemLinux: SYSTEM_CACHE_DIR_LINUX,
    systemDarwin: SYSTEM_CACHE_DIR_DARWIN,
    override: env[CACHE_OVERRIDE_ENV],
    xdgVar: 'XDG_CACHE_HOME',
    xdgFallbackLinux: '@HOME@/.cache/endo-gateway',
    darwinFallback: '@HOME@/Library/Caches/Endo/endo-gateway',
  });

  const configFile = resolveOne({
    mode,
    platform,
    env,
    info,
    systemLinux: SYSTEM_CONFIG_FILE_LINUX,
    systemDarwin: SYSTEM_CONFIG_FILE_DARWIN,
    override: env[CONFIG_OVERRIDE_ENV],
    xdgVar: 'XDG_CONFIG_HOME',
    xdgFallbackLinux: '@HOME@/.config/endo-gateway/config.toml',
    darwinFallback:
      '@HOME@/Library/Application Support/Endo/endo-gateway/config.toml',
  });

  return harden({
    stateDir,
    runtimeDir,
    logDir,
    cacheDir,
    configFile,
  });
};
harden(resolveGatewayPaths);
