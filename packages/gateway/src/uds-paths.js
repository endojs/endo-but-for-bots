// @ts-check

/**
 * @file UDS (UNIX-domain socket) and named-pipe path resolution for
 *   the gateway's bootstrap channel.
 *
 * The gateway's bootstrap socket is the system administrator's
 * access channel (per `designs/gateway-package.md` § Feature 4 and
 * § Feature 7). Its location depends on the deployment shape:
 *
 *   - **System service** on Linux: `/run/endo-gateway/bootstrap.sock`,
 *     owned by the `endo:endo` service user, mode `0700` (or `0770`
 *     with a group whitelist for multi-user hosts).
 *   - **User mode** on Linux (or any platform with `XDG_RUNTIME_DIR`):
 *     `${XDG_RUNTIME_DIR}/endo-gateway/bootstrap.sock`, owner-only.
 *   - **Windows**: the named-pipe analogue at
 *     `\\.\pipe\endo-gateway`. Windows has no octal mode; the pipe's
 *     ACL is the access-control surface and is set at create time by
 *     the platform-specific listener helper (a follow-on PR; this
 *     module only resolves the path).
 *   - **macOS / other**: a `${TMPDIR}/endo-${user}/endo-gateway-bootstrap.sock`
 *     fallback, parallel to `packages/where`'s existing
 *     `whereEndoSock` shape.
 *
 * Operators may override unconditionally via
 * `ENDO_GATEWAY_BOOTSTRAP_SOCK`. The override is taken verbatim:
 * the caller is responsible for any platform-shape correctness.
 *
 * The resolver is pure; it never touches the filesystem. The
 * caller (a Node-backed listener in a follow-on PR) is responsible
 * for `mkdir -p` of the parent, for `chmod 0700`, and for `unlink`
 * of a stale socket.
 *
 * Naming: the design names the socket
 * `bootstrap.sock` (not `registrar.sock` or `admin.sock`) because
 * the channel hosts both the registrar exo (Feature 4) and the admin
 * exo (Feature 7); "bootstrap" captures the role of "entry capability
 * for any local-trusted caller" the gateway adopts here.
 */

import { makeError, q, X } from '@endo/errors';

/**
 * The unbracketed basename for the UDS / pipe path. Kept as an
 * export so callers (a follow-on listener, downstream tooling) can
 * compose the same name with their own directory.
 */
export const BOOTSTRAP_SOCKET_BASENAME = 'bootstrap.sock';
harden(BOOTSTRAP_SOCKET_BASENAME);

/**
 * The Windows named-pipe path. Constant because Windows pipes do
 * not nest under per-user directories the way UDS does on POSIX.
 */
export const BOOTSTRAP_PIPE_WINDOWS = '\\\\.\\pipe\\endo-gateway';
harden(BOOTSTRAP_PIPE_WINDOWS);

/**
 * The directory the system-service-mode bootstrap socket lives in
 * on Linux. Matches the design's Feature 4 sketch and the systemd
 * unit's `RuntimeDirectory=endo-gateway` per Feature 10.
 */
export const SYSTEM_RUNTIME_DIR_LINUX = '/run/endo-gateway';
harden(SYSTEM_RUNTIME_DIR_LINUX);

/**
 * The directory holding the user-mode bootstrap socket, relative
 * to `$XDG_RUNTIME_DIR`. Mirrors `packages/where`'s `endo` slug
 * convention but uses `endo-gateway` to distinguish the gateway
 * socket from the per-user daemon's CapTP socket (`captp0.sock`).
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
 * @property {string} path The resolved socket / pipe path.
 * @property {'override' | 'system' | 'user-xdg' | 'user-darwin' | 'user-tmpdir' | 'windows'} source
 *   Where the path came from. Useful for diagnostics: when an
 *   operator misconfigures the override, the source name in the
 *   warning tells them which rule they hit.
 * @property {'unix-socket' | 'windows-named-pipe'} kind The
 *   listener shape. UDS on POSIX, named pipe on Windows. The
 *   listener helper switches on this discriminator.
 */

/**
 * Resolve the gateway's bootstrap socket / named-pipe path for a
 * given platform and environment. Pure: never touches the
 * filesystem.
 *
 * The `mode` argument selects the system-service vs user-mode
 * default; the `ENDO_GATEWAY_BOOTSTRAP_SOCK` environment variable
 * overrides both unconditionally.
 *
 * @param {object} args
 * @param {'system' | 'user'} args.mode The deployment posture.
 *   `system` resolves to `/run/endo-gateway/bootstrap.sock` on
 *   POSIX (system-service variant); `user` resolves to the
 *   `XDG_RUNTIME_DIR`-rooted path (per-user variant).
 * @param {string} args.platform `process.platform` value:
 *   `linux`, `darwin`, `win32`, ...
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
      X`Bootstrap socket mode must be 'system' or 'user', got ${q(mode)}`,
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
      // The override is taken verbatim; the operator is responsible
      // for the listener shape. We assume UDS on POSIX, named-pipe
      // on Windows; an operator who wants the other shape passes a
      // path with the appropriate prefix.
      kind: platform === 'win32' ? 'windows-named-pipe' : 'unix-socket',
    });
  }

  if (platform === 'win32') {
    return harden({
      path: BOOTSTRAP_PIPE_WINDOWS,
      source: 'windows',
      kind: 'windows-named-pipe',
    });
  }

  if (mode === 'system') {
    // System-service variant on POSIX. The design names this path
    // explicitly; downstream packaging (Feature 10) creates the
    // directory at install time with the `endo:endo` service user.
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
    // socket does not collide with the per-user daemon's CapTP
    // socket.
    const home = env.HOME ?? info.home;
    if (typeof home !== 'string' || home.length === 0) {
      throw makeError(
        X`Cannot resolve bootstrap socket: no HOME and no info.home on darwin`,
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
      X`Cannot resolve bootstrap socket: no TMPDIR and no info.temp`,
    );
  }
  if (typeof user !== 'string' || user.length === 0) {
    throw makeError(
      X`Cannot resolve bootstrap socket: no USER and no info.user`,
    );
  }
  return harden({
    path: `${temp}/endo-${user}/${USER_RUNTIME_SUBDIR}/${BOOTSTRAP_SOCKET_BASENAME}`,
    source: 'user-tmpdir',
    kind: 'unix-socket',
  });
};
harden(resolveBootstrapSocketPath);
