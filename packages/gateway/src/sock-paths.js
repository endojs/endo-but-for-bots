// @ts-check

/**
 * @file Sock (UNIX-domain socket) path resolution for the gateway's
 *   bootstrap channel.
 *
 * The "sock" name follows the Endo Daemon's convention: a local
 * stream socket whose listener shape is platform-bound. The gateway
 * targets Linux primarily and macOS secondarily; both implement the
 * sock as a UNIX-domain socket. Other server platforms are out of
 * scope for the gateway.
 *
 * The gateway's bootstrap sock is the system administrator's access
 * channel (per `designs/gateway-package.md` § Feature 4 and
 * § Feature 7). Its location depends on the deployment shape:
 *
 *   - **System service** on Linux: `/run/endo-gateway/bootstrap.sock`,
 *     owned by the `endo:endo` service user, mode `0700` (or `0770`
 *     with a group whitelist for multi-user hosts).
 *   - **User mode** on Linux (or any platform with `XDG_RUNTIME_DIR`):
 *     `${XDG_RUNTIME_DIR}/endo-gateway/bootstrap.sock`, owner-only.
 *   - **macOS user mode**: a
 *     `${HOME}/Library/Application Support/Endo/endo-gateway/bootstrap.sock`
 *     path, parallel to `packages/where`'s existing `whereEndoSock`
 *     shape.
 *   - **Fallback** when neither `XDG_RUNTIME_DIR` nor the darwin
 *     path applies: a
 *     `${TMPDIR}/endo-${user}/endo-gateway/bootstrap.sock` path,
 *     parallel to `packages/where`'s `whereEndoSock` shape on
 *     Linux without `XDG_RUNTIME_DIR`.
 *
 * Operators may override unconditionally via
 * `ENDO_GATEWAY_BOOTSTRAP_SOCK`. The override is taken verbatim:
 * the caller is responsible for any platform-shape correctness.
 *
 * The resolver is pure; it never touches the filesystem. The
 * caller (a Node-backed listener in a follow-on PR) is responsible
 * for `mkdir -p` of the parent, for `chmod 0700`, and for `unlink`
 * of a stale sock.
 *
 * Naming: the design names the sock
 * `bootstrap.sock` (not `registrar.sock` or `admin.sock`) because
 * the channel hosts both the registrar exo (Feature 4) and the admin
 * exo (Feature 7); "bootstrap" captures the role of "entry capability
 * for any local-trusted caller" the gateway adopts here.
 */

import { makeError, q, X } from '@endo/errors';

/**
 * The unbracketed basename for the sock path. Kept as an
 * export so callers (a follow-on listener, downstream tooling) can
 * compose the same name with their own directory.
 */
export const BOOTSTRAP_SOCKET_BASENAME = 'bootstrap.sock';
harden(BOOTSTRAP_SOCKET_BASENAME);

/**
 * The directory the system-service-mode bootstrap sock lives in
 * on Linux. Matches the design's Feature 4 sketch and the systemd
 * unit's `RuntimeDirectory=endo-gateway` per Feature 10.
 */
export const SYSTEM_RUNTIME_DIR_LINUX = '/run/endo-gateway';
harden(SYSTEM_RUNTIME_DIR_LINUX);

/**
 * The directory holding the user-mode bootstrap sock, relative
 * to `$XDG_RUNTIME_DIR`. Mirrors `packages/where`'s `endo` slug
 * convention but uses `endo-gateway` to distinguish the gateway
 * sock from the per-user daemon's CapTP sock (`captp0.sock`).
 */
export const USER_RUNTIME_SUBDIR = 'endo-gateway';
harden(USER_RUNTIME_SUBDIR);

/**
 * @typedef {object} BootstrapPathInfo
 * @property {string} home Home directory for fallback resolution.
 * @property {string} user User name for fallback resolution.
 * @property {string} temp Temp directory for fallback resolution.
 */

/**
 * @typedef {object} BootstrapPathResolution
 * @property {string} path The resolved sock path.
 * @property {'override' | 'system' | 'user-xdg' | 'user-darwin' | 'user-tmpdir'} source
 *   Where the path came from. Useful for diagnostics: when an
 *   operator misconfigures the override, the source name in the
 *   warning tells them which rule they hit.
 * @property {'unix-socket'} kind The listener shape. Always a UNIX
 *   domain socket; the gateway targets Linux primarily and macOS
 *   secondarily, both of which use a UNIX domain socket for the
 *   sock.
 */

/**
 * Resolve the gateway's bootstrap sock path for a given platform
 * and environment. Pure: never touches the filesystem.
 *
 * The `mode` argument selects the system-service vs user-mode
 * default; the `ENDO_GATEWAY_BOOTSTRAP_SOCK` environment variable
 * overrides both unconditionally.
 *
 * @param {object} args
 * @param {'system' | 'user'} args.mode The deployment posture.
 *   `system` resolves to `/run/endo-gateway/bootstrap.sock` on
 *   Linux (system-service variant); `user` resolves to the
 *   `XDG_RUNTIME_DIR`-rooted path (per-user variant).
 * @param {string} args.platform `process.platform` value:
 *   `linux`, `darwin`, ...
 * @param {{[name: string]: string | undefined}} args.env Process
 *   environment, for `XDG_RUNTIME_DIR`, `TMPDIR`, etc.
 * @param {BootstrapPathInfo} args.info Platform info (home, user,
 *   temp). Parallel to `packages/where/types.d.ts`.
 * @returns {BootstrapPathResolution}
 */
export const resolveBootstrapSocketPath = ({
  mode,
  platform,
  env = {},
  info,
}) => {
  if (mode !== 'system' && mode !== 'user') {
    throw makeError(
      X`Bootstrap sock mode must be 'system' or 'user', got ${q(mode)}`,
    );
  }
  if (typeof platform !== 'string' || platform.length === 0) {
    throw makeError(X`Platform must be a non-empty string, got ${q(platform)}`);
  }
  if (info === undefined || typeof info !== 'object') {
    throw makeError(X`Bootstrap path info must be an object, got ${q(info)}`);
  }

  const override = env.ENDO_GATEWAY_BOOTSTRAP_SOCK;
  if (override !== undefined && override !== '') {
    return harden({
      path: override,
      source: 'override',
      kind: 'unix-socket',
    });
  }

  if (mode === 'system') {
    // System-service variant. The design names this path explicitly
    // for Linux; downstream packaging (Feature 10) creates the
    // directory at install time with the `endo:endo` service user.
    // macOS LaunchDaemon deployments adopt the same path as the
    // forward-compatible default.
    return harden({
      path: `${SYSTEM_RUNTIME_DIR_LINUX}/${BOOTSTRAP_SOCKET_BASENAME}`,
      source: 'system',
      kind: 'unix-socket',
    });
  }

  // User mode: prefer `XDG_RUNTIME_DIR` per the design and
  // `packages/where` convention.
  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== '') {
    return harden({
      path: `${env.XDG_RUNTIME_DIR}/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
      source: 'user-xdg',
      kind: 'unix-socket',
    });
  }

  if (platform === 'darwin') {
    // macOS has no XDG_RUNTIME_DIR by default; mirror
    // `whereEndoSock`'s `Library/Application Support/Endo` choice
    // but stay under a gateway-specific subdirectory so the gateway
    // sock does not collide with the per-user daemon's CapTP
    // sock.
    const home = env.HOME ?? info.home;
    if (typeof home !== 'string' || home.length === 0) {
      throw makeError(
        X`Cannot resolve bootstrap sock: no HOME and no info.home on darwin`,
      );
    }
    return harden({
      path: `${home}/Library/Application Support/Endo/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
      source: 'user-darwin',
      kind: 'unix-socket',
    });
  }

  // Last resort: `${TMPDIR}/endo-${user}/...`, parallel to
  // `whereEndoSock` on Linux without `XDG_RUNTIME_DIR`. Used in
  // test harnesses and on stripped-down platforms.
  const temp = env.TMPDIR ?? info.temp;
  const user = env.USER ?? info.user;
  if (typeof temp !== 'string' || temp.length === 0) {
    throw makeError(
      X`Cannot resolve bootstrap sock: no TMPDIR and no info.temp`,
    );
  }
  if (typeof user !== 'string' || user.length === 0) {
    throw makeError(X`Cannot resolve bootstrap sock: no USER and no info.user`);
  }
  return harden({
    path: `${temp}/endo-${user}/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
    source: 'user-tmpdir',
    kind: 'unix-socket',
  });
};
harden(resolveBootstrapSocketPath);
