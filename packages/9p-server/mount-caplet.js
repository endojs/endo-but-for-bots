// @ts-check

/**
 * Unconfined caplet: mount an `@endo/platform/fs/extended` `Filesystem`
 * capability (possibly a remote CapTP presence) into the host Linux
 * kernel via 9P2000.L.
 *
 * Run it with, e.g.:
 *
 * ```sh
 * endo make-unconfined packages/9p-server/mount-caplet.js \
 *   --name fs-mounter --powers \@none
 * # then, from a caplet/REPL that holds both `fs-mounter` and an
 * # endo-fs `Filesystem` cap named `my-fs`:
 * #   const h = await E(fsMounter).mount(myFs, '/mnt/endo', {});
 * #   …
 * #   await E(h).unmount();           // or let teardown do it
 * ```
 *
 * `make()` returns a *mounter* exo.  Each `mount(fs, mountPoint,
 * options)` call:
 *   1. stands up a `makeFsBridge9p` 9P server on a per-mount Unix
 *      domain socket,
 *   2. shells out to `mount -t 9p -o trans=unix,version=9p2000.L,…`
 *      to attach the socket to `mountPoint`,
 *   3. returns a `MountHandle` exo whose `unmount()` reverses both
 *      steps.
 *
 * **Teardown.** The caplet wires the daemon's cancellation context
 * (`context.whenCancelled()`): when the caplet formula is cancelled
 * (worker terminated, formula removed, daemon shutdown) every live
 * mount begins cleanup. Native owners retain `makeFsMounterKit().close` and
 * await it before releasing storage; worker death is not proof of cleanup.
 *
 * **Privilege.** `mount(2)` / `umount(2)` need `CAP_SYS_ADMIN`.  The
 * daemon worker is rarely root, so by default this will fail with a
 * permission error unless the daemon runs privileged. Set operator environment
 * `NINEP_MOUNT_PROGRAM` / `NINEP_UMOUNT_PROGRAM` — or `NINEP_SUDO=1` —
 * to route through a privilege helper.
 *
 * @module
 */

import { makeResourceRegistry } from '@endo/daemon/resource-registry.js';
import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rmdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import nodePath from 'node:path';
import process from 'node:process';

import { makeFsBridge9p } from './src/fs-bridge.js';

/** @import { ERef } from '@endo/eventual-send' */

const execFileP = promisify(execFile);

// Fallback identity where the platform has no uid/gid (Windows). Matches the
// defaults in `src/fs-bridge.js` and `src/server.js`.
const DEFAULT_ID = 1000;

const MountHandleInterface = M.interface('Fs9pMountHandle', {
  unmount: M.call().returns(M.promise()),
  mountPoint: M.call().returns(M.string()),
  socketPath: M.call().returns(M.string()),
  help: M.call().returns(M.string()),
});

const MounterInterface = M.interface('Fs9pMounter', {
  mount: M.call(M.any(), M.string()).optional(M.record()).returns(M.promise()),
  list: M.call().returns(M.array()),
  help: M.call().returns(M.string()),
});

/**
 * The POSIX identity the 9P server reports as the owner of every node in the
 * projection. The capability filesystem has no ownership of its own, so this
 * is what decides whether the kernel lets the accessing process write (see the
 * Rgetattr comment in `src/server.js`).
 *
 * The worker's own uid/gid is the right answer for the case this exists for: a
 * rootless container whose root maps to the user running the caplet sees that
 * user as the owner, and so gets the writable view the caller asked for. Taken
 * from an injected `proc` rather than the ambient global so the fallback branch
 * is reachable from a test; `getuid`/`getgid` are absent on Windows.
 *
 * @param {{ getuid?: () => number, getgid?: () => number }} proc
 * @returns {{ uid: number, gid: number }}
 */
export const mountIdentity = proc =>
  harden({
    uid: typeof proc.getuid === 'function' ? proc.getuid() : DEFAULT_ID,
    gid: typeof proc.getgid === 'function' ? proc.getgid() : DEFAULT_ID,
  });
harden(mountIdentity);

/**
 * Pick a default directory for the per-mount UDS.  Prefer the XDG
 * runtime dir (tmpfs, 0700, per-user) so the socket — which carries
 * the *full authority* of the projected FS cap — is not world-visible.
 *
 * @param {Record<string, string>} env
 */
const defaultSocketDir = env =>
  env.XDG_RUNTIME_DIR || env.NINEP_SOCKET_DIR || os.tmpdir();

/**
 * Mount options whose value is load-bearing for confinement: `trans`
 * pins the kernel mount to *this* bridge socket, `version` pins the
 * dialect, and `access` governs the uid model. A caller must not be
 * able to override them via `extraMountOptions` (which is appended last
 * and would win under v9fs's last-key-wins parsing) — e.g.
 * `extraMountOptions: 'trans=tcp,port=…'` would redirect the privileged
 * mount to an attacker-chosen 9P server. So we reject those keys.
 */
const PINNED_MOUNT_OPTION_KEYS = harden(['trans', 'version', 'access']);

const baseName = s => {
  const t = String(s);
  return t.slice(t.lastIndexOf('/') + 1);
};

/**
 * Reject `extraMountOptions` that try to override a pinned key.
 *
 * @param {unknown} extra
 */
const assertExtraMountOptions = extra => {
  if (extra === undefined || extra === '') return;
  if (typeof extra !== 'string') {
    throw makeError(
      X`extraMountOptions must be a string, got ${q(typeof extra)}`,
    );
  }
  for (const part of extra.split(',')) {
    const key = part.split('=')[0].trim();
    if (PINNED_MOUNT_OPTION_KEYS.includes(key)) {
      throw makeError(
        X`extraMountOptions may not set the pinned option ${q(key)} (it carries the mount's transport/confinement); got ${q(extra)}`,
      );
    }
  }
};

/**
 * Footgun guard (not a security boundary — the mounter cap is held only
 * by trusted callers): a caller-supplied `mount`/`umount` program vector
 * must actually invoke the expected command, so a typo like
 * `umountProgram: ['rm']` fails loudly instead of `rm`-ing the mount
 * point. The trailing element is the binary the fixed `9p` argv is
 * appended to; only its basename is checked, so a privilege-helper
 * prefix with flags (`['sudo', '-u', 'svc', 'mount']`) is preserved.
 *
 * @param {string[]} program
 * @param {string} expectedCommand  `'mount'` | `'umount'`
 * @param {string} label
 */
const assertProgram = (program, expectedCommand, label) => {
  if (!Array.isArray(program) || program.length === 0) {
    throw makeError(X`${q(label)} must be a non-empty array of strings`);
  }
  if (baseName(program[program.length - 1]) !== expectedCommand) {
    throw makeError(
      X`${q(label)} must invoke ${q(expectedCommand)}; got ${q(String(program[program.length - 1]))}`,
    );
  }
};

/**
 * The operator's mount/umount programs from caplet env. They are OPERATOR
 * configuration, never a per-call option: the mounter cap is handed to an
 * otherwise-untrusted party whose only granted authority is "mount any
 * files"; letting the caller choose the program would be arbitrary
 * privileged execution (e.g. `umountProgram: ['rm']` → `rm -- <mountPoint>`).
 * `NINEP_SUDO=1` routes through sudo; `NINEP_MOUNT_PROGRAM` /
 * `NINEP_UMOUNT_PROGRAM` (whitespace-separated) name a custom helper.
 * Exported so a host that records these settings elsewhere can refuse at
 * record time what the mounter refuses at construction.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ mountProgram: string[], umountProgram: string[] }}
 */
export const readMountPrograms = (env = {}) => {
  const sudo = env.NINEP_SUDO === '1';
  /** @param {string} v */
  const splitProgram = v => v.trim().split(/\s+/).filter(Boolean);
  const mountProgram = env.NINEP_MOUNT_PROGRAM
    ? splitProgram(env.NINEP_MOUNT_PROGRAM)
    : sudo
      ? ['sudo', 'mount']
      : ['mount'];
  const umountProgram = env.NINEP_UMOUNT_PROGRAM
    ? splitProgram(env.NINEP_UMOUNT_PROGRAM)
    : sudo
      ? ['sudo', 'umount']
      : ['umount'];
  assertProgram(mountProgram, 'mount', 'NINEP_MOUNT_PROGRAM');
  assertProgram(umountProgram, 'umount', 'NINEP_UMOUNT_PROGRAM');
  return harden({ mountProgram, umountProgram });
};
harden(readMountPrograms);

/**
 * Build the comma-separated `-o` value for `mount -t 9p`.
 *
 * @param {Record<string, unknown>} options
 */
const buildMountOptionString = options => {
  const {
    trans = 'unix',
    version = '9p2000.L',
    // The bridge's server caps msize at 128 KiB (DEFAULT_MSIZE in
    // src/server.js); offering more just gets shrunk in the Rversion
    // reply, so default to the value the kernel will actually get.
    msize = 131_072,
    access = 'any',
    cache = 'none',
    readOnly = false,
    extraMountOptions = '',
  } = options;
  const parts = [
    `trans=${trans}`,
    `version=${version}`,
    `msize=${msize}`,
    `access=${access}`,
    `cache=${cache}`,
  ];
  if (readOnly) parts.push('ro');
  assertExtraMountOptions(extraMountOptions);
  if (extraMountOptions) parts.push(String(extraMountOptions));
  return parts.join(',');
};

/**
 * Resolve the caplet's cancellation promise from whatever shape the
 * daemon handed us as `context`.  Mirrors the tolerant resolution in
 * `packages/lal/agent.js` and `packages/fae/agent.js`: a context
 * presence exposes `whenCancelled()`; an in-process context exposes a
 * `cancelled` promise; `null`/absent means "no teardown signal".
 *
 * @param {Promise<any> | any} context
 * The record keeps the lifetime promise from being assimilated by this async
 * helper: construction waits for the context, never for its cancellation.
 *
 * @returns {Promise<{cancelledP: Promise<never> | null}>}
 */
const resolveCancelled = async context => {
  if (!context) return harden({ cancelledP: null });
  const resolved = await context;
  if (!resolved) return harden({ cancelledP: null });
  if (typeof resolved.whenCancelled === 'function') {
    return harden({ cancelledP: E(resolved).whenCancelled() });
  }
  if (resolved.cancelled) {
    return harden({ cancelledP: resolved.cancelled });
  }
  return harden({ cancelledP: null });
};

/**
 * Build a public mounter and host-only close control from injected effects.  `make()` wires the real
 * Node bindings (`execFile`, `fs.mkdir`/`rmdir`, `makeFsBridge9p`);
 * tests inject fakes so the privileged `mount(2)` path can be exercised
 * without root or a real kernel.
 *
 * The caller owns each mount point and socket path exclusively. Native session
 * controllers must supply a private socket directory, stop all filesystem users
 * (including sandbox bind mounts) before close, and retain close across failures.
 * makeBridge must be inert until start, and runProgram must settle only after
 * the command has exited. Hung effects remain pending; this is not crash recovery.
 *
 * @param {object} deps
 * @param {Record<string, string>} [deps.env] - caplet env (e.g. NINEP_SUDO).
 * @param {Promise<never> | null} [deps.cancelledP] - settles on caplet teardown.
 * @param {(file: string, args: string[]) => Promise<unknown>} deps.runProgram - `execFile`-shaped runner.
 * @param {(path: string, opts: { recursive: boolean }) => Promise<unknown>} deps.makeDir
 * @param {(path: string) => Promise<unknown>} deps.removeDir
 * @param {(opts: { fs: ERef<any>, socketPath: string, cancelled?: Promise<unknown>, uid?: number, gid?: number }) => any} deps.makeBridge
 * @param {number} [deps.uid]
 * @param {number} [deps.gid]
 */
export const makeFsMounterKit = ({
  env = {},
  cancelledP = null,
  runProgram,
  makeDir,
  removeDir,
  makeBridge,
  uid,
  gid,
}) => {
  /** @type {Set<{ unmount: () => Promise<void> }>} */
  const handles = new Set();

  const resources = makeResourceRegistry();
  /** @type {Set<string>} */
  const mountPoints = new Set();
  /** @type {Set<string>} */
  const socketPaths = new Set();
  let mountCounter = 0n;
  let cancelled = false;
  const close = () => {
    cancelled = true;
    return resources.shutdown();
  };
  if (cancelledP) {
    void Promise.resolve(cancelledP)
      .then(close, close)
      .catch(error => {
        // Cancellation starts cleanup; only an awaited close proves completion.
        console.error('[9p mount-caplet] cleanup remains pending', error);
      });
  }

  // mount/umount programs are OPERATOR configuration (env), never a
  // per-call option; see `readMountPrograms`.
  const { mountProgram, umountProgram } = readMountPrograms(env);

  /**
   * @param {ERef<any>} fs - endo-fs `Filesystem` capability to project.
   * @param {string} mountPoint - host path to mount onto.
   * @param {object} [mountOptions]
   */
  const mount = async (fs, mountPoint, mountOptions = {}) => {
    if (cancelled) {
      throw makeError(X`mounter is cancelled; refusing to mount`);
    }
    // Defensively copy + harden the caller's options before any field
    // flows toward a privileged `mount(2)`.  `mountOptions` arrives
    // over CapTP from a potentially adversarial caller; the shallow
    // spread reads every own-enumerable property exactly once,
    // defeating a `Proxy`-backed record whose per-access getter could
    // otherwise differentiate the value validated here from the one
    // passed to `mount`, and `harden` freezes the result (deep-harden
    // every structured input before it flows toward a privileged
    // syscall).
    const opts = /** @type {Record<string, unknown>} */ (
      harden({ ...mountOptions })
    );

    mountCounter += 1n;
    const resolvedMountPoint = nodePath.resolve(mountPoint);
    // The UDS path is internal plumbing, not a free-form caller input:
    // the bridge `unlink()`s it before binding, so an arbitrary
    // caller-chosen path would be an arbitrary-delete primitive with the
    // daemon's authority. A caller may still pin a name, but only inside
    // the socket directory; otherwise we generate a random one (the UDS
    // carries the projected FS cap's full authority, so on the
    // world-writable `os.tmpdir()` fallback an unpredictable name keeps a
    // local user from pre-positioning and connecting).
    const socketDir = defaultSocketDir(env);
    let socketPath;
    if (typeof opts.socketPath === 'string') {
      socketPath = nodePath.resolve(opts.socketPath);
      const rel = nodePath.relative(socketDir, socketPath);
      if (rel === '' || rel.startsWith('..') || nodePath.isAbsolute(rel)) {
        throw makeError(
          X`socketPath must be inside the socket directory ${q(socketDir)}; got ${q(opts.socketPath)}`,
        );
      }
    } else {
      socketPath = nodePath.join(
        socketDir,
        `endo-9p-${randomBytes(12).toString('base64url')}`,
      );
    }
    // Unix socket names are byte-bounded (104 bytes including the terminator
    // on Darwin, 108 on Linux). A long name may be silently truncated by the
    // bind implementation, leaving chmod/unlink aimed at a nonexistent path.
    // Keep generated names compact with 96 bits of entropy, and reject even
    // explicit names before creating a bridge or mutating mount directories.
    if (new TextEncoder().encode(socketPath).byteLength > 103) {
      throw makeError(
        X`9P socket path exceeds 103 bytes; configure a shorter socket directory: ${q(socketDir)}`,
      );
    }

    // The program is operator config, not a caller option (see above);
    // reject a caller that tries to choose it.
    if (opts.mountProgram !== undefined || opts.umountProgram !== undefined) {
      throw makeError(
        X`mountProgram/umountProgram are operator configuration (NINEP_SUDO / NINEP_MOUNT_PROGRAM env), not a per-call option`,
      );
    }
    const removeMountPointOnUnmount = opts.removeMountPointOnUnmount === true;
    // Lazy detach can leave kernel users holding the filesystem after umount
    // succeeds. It cannot establish the release barrier this owner promises.
    if (opts.lazyUnmount === true || env.NINEP_LAZY_UMOUNT === '1') {
      throw makeError(X`lazyUnmount cannot prove filesystem release`);
    }
    const optionString = buildMountOptionString(opts);
    if (mountPoints.has(resolvedMountPoint)) {
      throw makeError(
        X`mount point is already owned: ${q(resolvedMountPoint)}`,
      );
    }
    if (socketPaths.has(socketPath)) {
      throw makeError(X`socket path is already owned: ${q(socketPath)}`);
    }
    const resourceId = String(mountCounter);
    /** @type {any} */
    let bridge;
    /** @type {any} */
    let handle;
    let needsUnmount = false;
    let removeDirectory = false;
    let released = false;
    /** @type {Promise<void> | undefined} */
    let cleanupFlight;
    const { promise: acquisitionDone, resolve: acquired } = makePromiseKit();

    const doCleanup = async () => {
      // Acquisition settles before rollback calls this function, so waiting here
      // does not wait on the outer mount operation that itself needs cleanup.
      await acquisitionDone;
      if (needsUnmount) {
        const [bin, ...prefix] = umountProgram;
        await runProgram(bin, [...prefix, '--', resolvedMountPoint]);
        needsUnmount = false;
      }
      if (bridge) {
        await E(bridge).stop();
        bridge = undefined;
      }
      if (removeDirectory) {
        try {
          await removeDir(resolvedMountPoint);
        } catch (error) {
          if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') {
            throw error;
          }
        }
        removeDirectory = false;
      }
      released = true;
      handles.delete(handle);
      mountPoints.delete(resolvedMountPoint);
      socketPaths.delete(socketPath);
      resources.release(resourceId, cleanup);
    };
    const cleanup = () => {
      if (released) return Promise.resolve();
      if (!cleanupFlight) {
        cleanupFlight = doCleanup().finally(() => {
          cleanupFlight = undefined;
        });
      }
      return cleanupFlight;
    };
    const assertAcquiring = () => {
      if (cancelled) {
        throw makeError(
          X`mounter cancelled during mount of ${q(resolvedMountPoint)}`,
        );
      }
    };
    // Ownership precedes the first native effect, including mkdir/start failures
    // that may have acquired something before reporting failure.
    mountPoints.add(resolvedMountPoint);
    socketPaths.add(socketPath);
    resources.retain(resourceId, cleanup);
    try {
      try {
        removeDirectory = removeMountPointOnUnmount;
        if (opts.makeMountPoint !== false) {
          await makeDir(resolvedMountPoint, { recursive: true });
          assertAcquiring();
        }
        // Mounter cleanup orders kernel unmount before bridge shutdown. Passing
        // its cancellation signal to the bridge would bypass that ordering.
        bridge = makeBridge({
          fs,
          socketPath,
          ...(uid === undefined ? {} : { uid }),
          ...(gid === undefined ? {} : { gid }),
        });
        try {
          await E(bridge).start();
        } catch (cause) {
          throw makeError(
            X`9p bridge failed to start on ${q(socketPath)}: ${q(/** @type {Error} */ (cause).message)}`,
          );
        }
        assertAcquiring();
        const [bin, ...prefix] = mountProgram;
        // A failed command can have partially mounted the tree. Require a
        // successful unmount before releasing its transport or storage.
        needsUnmount = true;
        try {
          await runProgram(bin, [
            ...prefix,
            '-t',
            '9p',
            '-o',
            optionString,
            '--',
            socketPath,
            resolvedMountPoint,
          ]);
        } catch (cause) {
          throw makeError(
            X`9p mount of ${q(socketPath)} onto ${q(resolvedMountPoint)} failed: ${q(/** @type {Error} */ (cause).message)}`,
          );
        }
        assertAcquiring();
      } finally {
        acquired(undefined);
      }
    } catch (cause) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [cause, cleanupError],
          '9p mount failed and cleanup remains pending',
          { cause: cleanupError },
        );
      }
      throw cause;
    }

    handle = makeExo('Fs9pMountHandle', MountHandleInterface, {
      unmount: cleanup,
      mountPoint() {
        return resolvedMountPoint;
      },
      socketPath() {
        return socketPath;
      },
      help() {
        return `9P2000.L mount at ${resolvedMountPoint}. Call unmount() to detach and drain its bridge. Failed cleanup remains retryable.`;
      },
    });
    handles.add(handle);
    return handle;
  };

  const mounter = makeExo('Fs9pMounter', MounterInterface, {
    mount,
    list() {
      return harden([...handles]);
    },
    help() {
      return `endo-fs → 9P mounter. mount(fs, mountPoint, options?) returns a handle with retryable unmount(). The operator owns mount/umount programs. Paths are reserved until cleanup succeeds; the caller must prevent overlapping owners outside this kit. Cancellation starts cleanup; the native owner must await the kit's close() before releasing storage.`;
    },
  });
  return harden({ mounter, close });
};
harden(makeFsMounterKit);

/**
 * Capability-only convenience entrypoint. Native session owners must retain the
 * kit instead, so failed acquisition cleanup has an explicit retry path.
 * @param {Parameters<typeof makeFsMounterKit>[0]} deps
 */
export const makeFsMounter = deps => makeFsMounterKit(deps).mounter;
harden(makeFsMounter);

/**
 * `make-unconfined` entry point.  Resolves the daemon cancellation
 * context and wires the real Node effects into {@link makeFsMounter}.
 *
 * @param {unknown} _powers - guest powers (unused; mounting uses the
 *   worker's ambient Node authority, which is what `--UNCONFINED`
 *   grants).
 * @param {Promise<any> | any} context - daemon cancellation context.
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (_powers, context, options = {}) => {
  const { cancelledP } = await resolveCancelled(context);
  return makeFsMounter({
    env: options.env ?? {},
    cancelledP,
    runProgram: execFileP,
    makeDir: mkdir,
    removeDir: rmdir,
    makeBridge: makeFsBridge9p,
    ...mountIdentity(process),
  });
};
harden(make);
