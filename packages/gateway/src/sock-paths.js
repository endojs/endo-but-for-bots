// @ts-check

/**
 * @file Sock (UNIX-domain socket) path resolution for the gateway's
 *   bootstrap and admin channels.
 *
 * The "sock" name follows the Endo Daemon's convention: a local
 * stream socket whose listener shape is platform-bound. The gateway
 * targets Linux primarily and macOS secondarily; both implement the
 * sock as a UNIX-domain socket. Other server platforms are out of
 * scope for the gateway.
 *
 * The gateway exposes **two** local socks, distinct by file path
 * and (deployment-side) by access-control list. The semantics are:
 *
 *   - **Bootstrap sock** (`bootstrap.sock`): the registration channel
 *     any local user daemon may use to call `register` and
 *     `registerRelay`. Carries the `GatewayBootstrap` exo only; does
 *     **not** carry the `GatewayAdmin` exo. Mode `0600`, owned by
 *     the gateway operator.
 *   - **Admin sock** (`admin.sock`): the administrator's channel,
 *     carrying the `GatewayAdmin` exo (per `designs/gateway-package.md`
 *     § Feature 7). Mode `0600`, owned by the gateway operator. A
 *     deployment is responsible for placing the admin sock such that
 *     only the administrator's OS account can connect; on Linux a
 *     parent directory mode of `0700` is the default deployment
 *     shape, so non-administrators cannot resolve the sock path even
 *     to `connect(2)`. The bootstrap sock has no such expectation:
 *     its directory is permitted to be world-traversable so any
 *     local user daemon can connect.
 *
 * The two socks are deliberately separate so the bootstrap channel
 * does not double as an admin authority. Any local user daemon
 * holding a connection to the bootstrap sock can register itself;
 * those daemons do **not** have the authority to administer the
 * gateway. Admin authority is gated on the admin sock's access
 * control alone (`0600` plus a non-world-traversable parent).
 *
 * Per-sock-kind directory layout:
 *
 *   - **System service** on Linux (`mode='system'`):
 *     `/run/endo-gateway/{bootstrap,admin}.sock`, owned by the
 *     `endo:endo` service user. The bootstrap sock's parent is
 *     packaged `0755`; the admin sock's parent is packaged `0700`.
 *   - **User mode** on Linux (`mode='user'`, with
 *     `XDG_RUNTIME_DIR`):
 *     `${XDG_RUNTIME_DIR}/endo-gateway/{bootstrap,admin}.sock`. The
 *     directory inherits `XDG_RUNTIME_DIR`'s owner-only mode
 *     (`0700`), so both socks are effectively owner-only; the
 *     admin sock relies on the same.
 *   - **macOS user mode**:
 *     `${HOME}/Library/Application Support/Endo/endo-gateway/{bootstrap,admin}.sock`,
 *     parallel to `packages/where`'s existing `whereEndoSock` shape.
 *   - **Fallback** when neither `XDG_RUNTIME_DIR` nor the darwin
 *     path applies: `${TMPDIR}/endo-${user}/endo-gateway/{bootstrap,admin}.sock`,
 *     parallel to `packages/where`'s `whereEndoSock` shape on
 *     Linux without `XDG_RUNTIME_DIR`.
 *
 * Operators may override each sock independently via environment
 * variables: `ENDO_GATEWAY_BOOTSTRAP_SOCK` for the bootstrap sock,
 * `ENDO_GATEWAY_ADMIN_SOCK` for the admin sock. Overrides are taken
 * verbatim: the caller is responsible for any platform-shape
 * correctness, including placement under a parent directory with
 * the appropriate access mode for the admin variant.
 *
 * The resolver is pure; it never touches the filesystem. The
 * caller (a Node-backed listener in a follow-on PR) is responsible
 * for `mkdir -p` of the parent, for `chmod 0600` of the sock, for
 * `chmod 0700` of the admin sock's parent, and for `unlink` of a
 * stale sock.
 */

import { makeError, q, X } from '@endo/errors';

/**
 * Basename for the bootstrap sock. The bootstrap channel hosts the
 * registrar exo (Feature 4); any local user daemon may connect.
 */
export const BOOTSTRAP_SOCKET_BASENAME = 'bootstrap.sock';
harden(BOOTSTRAP_SOCKET_BASENAME);

/**
 * Basename for the admin sock. The admin channel hosts the
 * `GatewayAdmin` exo (Feature 7); only the administrator may
 * connect, gated by the admin sock's access control. The basename
 * is deliberately distinct from the bootstrap sock's so a single
 * directory listing distinguishes the two channels, and a deployment
 * that wants the admin sock under a different parent directory can
 * do so without colliding with the bootstrap sock's name.
 */
export const ADMIN_SOCKET_BASENAME = 'admin.sock';
harden(ADMIN_SOCKET_BASENAME);

/**
 * The directory the system-service-mode socks live in on Linux.
 * Matches the design's Feature 4 sketch and the systemd unit's
 * `RuntimeDirectory=endo-gateway` per Feature 10. Both
 * `bootstrap.sock` and `admin.sock` live under this directory by
 * default; packaging is responsible for the admin sock's stricter
 * parent-directory mode (or for relocating the admin sock to a
 * sibling `admin/` subdirectory with `0700` if a deployment wants
 * the bootstrap sock's parent to stay world-traversable).
 */
export const SYSTEM_RUNTIME_DIR_LINUX = '/run/endo-gateway';
harden(SYSTEM_RUNTIME_DIR_LINUX);

/**
 * The directory holding the user-mode socks, relative to
 * `$XDG_RUNTIME_DIR`. Mirrors `packages/where`'s `endo` slug
 * convention but uses `endo-gateway` to distinguish the gateway
 * socks from the per-user daemon's CapTP sock (`captp0.sock`).
 */
export const USER_RUNTIME_SUBDIR = 'endo-gateway';
harden(USER_RUNTIME_SUBDIR);

/** Environment variable name for the bootstrap sock override. */
const BOOTSTRAP_OVERRIDE_ENV = 'ENDO_GATEWAY_BOOTSTRAP_SOCK';
/** Environment variable name for the admin sock override. */
const ADMIN_OVERRIDE_ENV = 'ENDO_GATEWAY_ADMIN_SOCK';

/**
 * @typedef {object} SocketPathInfo
 * @property {string} home Home directory for fallback resolution.
 * @property {string} user User name for fallback resolution.
 * @property {string} temp Temp directory for fallback resolution.
 */

/**
 * @typedef {object} SocketPathResolution
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
 * Aliases for backwards-compatibility with the phase-2 typedef
 * names. New code should use the `Socket`-prefixed names.
 *
 * @typedef {SocketPathInfo} BootstrapPathInfo
 */

/**
 * @typedef {SocketPathResolution} BootstrapPathResolution
 */

/**
 * Resolve a sock path for a given basename, environment-variable
 * override, and platform. Pure: never touches the filesystem.
 *
 * Shared between `resolveBootstrapSocketPath` and
 * `resolveAdminSocketPath`. The two callers differ only in the
 * basename and the override-variable name; the directory tree is
 * identical so a deployment that uses defaults gets the two socks
 * as siblings.
 *
 * @param {object} args
 * @param {string} args.basename The sock filename (with extension).
 * @param {string | undefined} args.override Operator-supplied
 *   override path; takes verbatim precedence over every other rule
 *   when non-empty.
 * @param {'system' | 'user'} args.mode The deployment posture.
 * @param {string} args.platform `process.platform` value.
 * @param {{[name: string]: string | undefined}} args.env Process
 *   environment.
 * @param {SocketPathInfo} args.info Platform info.
 * @returns {SocketPathResolution}
 */
const resolveSocketPath = ({
  basename,
  override,
  mode,
  platform,
  env,
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

  if (override !== undefined && override !== '') {
    return harden({
      path: override,
      source: 'override',
      kind: 'unix-socket',
    });
  }

  if (mode === 'system') {
    return harden({
      path: `${SYSTEM_RUNTIME_DIR_LINUX}/${basename}`,
      source: 'system',
      kind: 'unix-socket',
    });
  }

  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== '') {
    return harden({
      path: `${env.XDG_RUNTIME_DIR}/${USER_RUNTIME_SUBDIR}/${basename}`,
      source: 'user-xdg',
      kind: 'unix-socket',
    });
  }

  if (platform === 'darwin') {
    const home = env.HOME ?? info.home;
    if (typeof home !== 'string' || home.length === 0) {
      throw makeError(
        X`Cannot resolve bootstrap sock: no HOME and no info.home on darwin`,
      );
    }
    return harden({
      path: `${home}/Library/Application Support/Endo/${USER_RUNTIME_SUBDIR}/${basename}`,
      source: 'user-darwin',
      kind: 'unix-socket',
    });
  }

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
    path: `${temp}/endo-${user}/${USER_RUNTIME_SUBDIR}/${basename}`,
    source: 'user-tmpdir',
    kind: 'unix-socket',
  });
};

/**
 * Resolve the gateway's bootstrap sock path. The bootstrap sock is
 * the registration channel any local user daemon may use; the
 * resolver does not enforce admin-only access on this path.
 *
 * @param {object} args
 * @param {'system' | 'user'} args.mode The deployment posture.
 *   `system` resolves to `/run/endo-gateway/bootstrap.sock` on
 *   Linux (system-service variant); `user` resolves to the
 *   `XDG_RUNTIME_DIR`-rooted path (per-user variant).
 * @param {string} args.platform `process.platform` value:
 *   `linux`, `darwin`, ...
 * @param {{[name: string]: string | undefined}} [args.env] Process
 *   environment, for `XDG_RUNTIME_DIR`, `TMPDIR`, etc.
 * @param {SocketPathInfo} args.info Platform info (home, user,
 *   temp). Parallel to `packages/where/types.d.ts`.
 * @returns {SocketPathResolution}
 */
export const resolveBootstrapSocketPath = ({
  mode,
  platform,
  env = {},
  info,
}) =>
  resolveSocketPath({
    basename: BOOTSTRAP_SOCKET_BASENAME,
    override: env[BOOTSTRAP_OVERRIDE_ENV],
    mode,
    platform,
    env,
    info,
  });
harden(resolveBootstrapSocketPath);

/**
 * Resolve the gateway's admin sock path. The admin sock carries the
 * `GatewayAdmin` exo (Feature 7); deployment is responsible for
 * placing it under a non-world-traversable parent directory so only
 * the administrator's OS account can `connect(2)` to it. The
 * resolver picks a path with the same shape as the bootstrap sock's
 * directory tree but a distinct basename (`admin.sock`); a
 * deployment that wants the admin sock under a stricter parent
 * (`0700` mode on a sibling directory) supplies an
 * `ENDO_GATEWAY_ADMIN_SOCK` override.
 *
 * The two socks (bootstrap and admin) are always distinct file
 * paths. A caller that supplies an override equal to the
 * bootstrap sock path conflates the two authorities and the
 * gateway (in the follow-on listener PR) rejects the configuration
 * at startup.
 *
 * @param {object} args
 * @param {'system' | 'user'} args.mode The deployment posture.
 * @param {string} args.platform `process.platform` value.
 * @param {{[name: string]: string | undefined}} [args.env] Process
 *   environment, for `XDG_RUNTIME_DIR`, `TMPDIR`, etc.
 * @param {SocketPathInfo} args.info Platform info.
 * @returns {SocketPathResolution}
 */
export const resolveAdminSocketPath = ({ mode, platform, env = {}, info }) =>
  resolveSocketPath({
    basename: ADMIN_SOCKET_BASENAME,
    override: env[ADMIN_OVERRIDE_ENV],
    mode,
    platform,
    env,
    info,
  });
harden(resolveAdminSocketPath);
