// @ts-check
/* global process */

/**
 * Establish the one host resource `reclaimRecordedMount` exists to take down.
 *
 * A hosted session's workspace reaches its slice as a 9P mount: a bridge in
 * this worker serves a filesystem over a unix socket in the session's private
 * socket directory, an external `mount` program attaches it at the session's
 * private mount point, and the slice binds that mount point. The slice sees a
 * projection of a tree, not the host directory underneath it, which is what
 * lets `@endo/sandbox` attest the bind: the anchor's own mount table must show
 * `9p` at the destination, rooted at `/`, in the declared mode.
 *
 * Every adapter did this identically and separately, in prose comments that
 * had to agree with each other:
 *
 * - The mounter's settings are composed in one order — the operator's trusted
 *   configuration, then the plan's recorded overrides, then this session's own
 *   socket directory, which is never a recorded setting. `reclaimRecordedMount`
 *   already says it must "compose the mounter settings exactly as activation
 *   does", and could only say so because activation was somewhere else.
 * - The mount is established with `removeMountPointOnUnmount`, which is the
 *   promise reclamation relies on when it removes the mount point itself.
 *
 * Both now live here, beside the reclaimer that depends on them.
 *
 * Construction performs no I/O and establishes nothing. It returns a handle
 * the caller can retain for teardown before `mount()` is ever called, so a
 * failed mount is still closed by the caller's ordinary cleanup — and so the
 * kit is closed only after the slice that holds the mount is gone.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  makeFsMounterKit,
  mountIdentity,
} from '@endo/9p-server/mount-caplet.js';
import { makeFsBridge9p } from '@endo/9p-server/src/fs-bridge.js';
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeNodeFilesystem } from '@endo/platform/fs/extended/node-fs.js';

/**
 * The mounter every adapter used: the operator's `mount`/`umount` programs
 * from the composed settings, a 9P bridge served in this process, and this
 * process's own uid/gid, so the projection is owned by the worker that made
 * it.
 *
 * @param {Record<string, string>} env
 */
export const makeDefaultMounter = env =>
  makeFsMounterKit({
    env,
    runProgram: promisify(execFile),
    makeDir: mkdir,
    removeDir: rmdir,
    makeBridge: makeFsBridge9p,
    ...mountIdentity(process),
  });
harden(makeDefaultMounter);

/**
 * @param {object} plan The session's recorded native placement.
 * @param {string} plan.workspaceRootPath The host tree to project: the
 * operator-supplied worktree when the session has one, else the adapter's own
 * per-session directory. This path never reaches the guest.
 * @param {string} plan.workspaceMountPoint Where the projection is attached.
 * @param {string} plan.mounterSocketDir This session's private socket
 * directory, which the caller pre-creates and owns. Its liveness is the
 * evidence `reclaimRecordedMount` reads.
 * @param {Record<string, string>} [plan.mounterEnv] The plan's recorded
 * mount settings.
 * @param {object} [powers]
 * @param {Record<string, string>} [powers.env] The operator's trusted
 * configuration for this worker.
 * @param {(env: Record<string, string>) => any} [powers.makeMounter]
 * @param {(rootPath: string) => any} [powers.makeFilesystem]
 */
export const makeWorkspaceProjection = (
  { workspaceRootPath, workspaceMountPoint, mounterSocketDir, mounterEnv = {} },
  {
    env = {},
    makeMounter = makeDefaultMounter,
    makeFilesystem = rootPath => makeNodeFilesystem({ rootPath }),
  } = {},
) => {
  (typeof workspaceRootPath === 'string' && workspaceRootPath !== '') ||
    Fail`A workspace root path is required to project it`;
  (typeof workspaceMountPoint === 'string' && workspaceMountPoint !== '') ||
    Fail`A workspace mount point is required to project a workspace`;
  (typeof mounterSocketDir === 'string' && mounterSocketDir !== '') ||
    Fail`A private 9P socket directory is required to project a workspace`;
  // The recorded mount settings are the operator's; the socket directory is
  // this session's and is never recorded as a setting.
  const kit = makeMounter({
    ...env,
    ...mounterEnv,
    XDG_RUNTIME_DIR: mounterSocketDir,
    NINEP_SOCKET_DIR: mounterSocketDir,
  });
  return harden({
    mountPoint: workspaceMountPoint,
    /**
     * Establish the kernel mount. The mounter creates the mount point and
     * must remove it on unmount; the storage owner refuses to `rm -rf` a path
     * that may still be mounted, and reclamation removes it on the mounter's
     * behalf when the worker that made it is gone.
     */
    mount: () =>
      E(kit.mounter).mount(
        makeFilesystem(workspaceRootPath),
        workspaceMountPoint,
        harden({ removeMountPointOnUnmount: true }),
      ),
    /**
     * Release the bridge. Call only once whatever holds the mount — the
     * slice — is gone; a kit closed early strands a mount nothing serves.
     */
    close: () => kit.close(),
  });
};
harden(makeWorkspaceProjection);
