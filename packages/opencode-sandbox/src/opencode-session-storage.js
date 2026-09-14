// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';

import {
  isNormalizedAbsolutePath,
  readSessionPlan,
} from './opencode-session-plan.js';

const StorageInterface = M.interface('OpencodeSessionStorage', {
  remove: M.call(M.string()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

/**
 * @param {string} name
 * @param {unknown} root
 * @returns {string}
 */
const assertRoot = (name, root) => {
  if (!isNormalizedAbsolutePath(root)) {
    throw Fail`Session storage root ${q(name)} must be a normalized absolute path`;
  }
  return root;
};

/**
 * Strictly inside the root and under this session's own directory there: the
 * first segment below the root must be the session's sandbox id, so a record
 * can never name a sibling session's storage.
 * @param {string} root
 * @param {string} child
 * @param {string} sessionId
 */
const withinSession = (root, child, sessionId) => {
  const path = relative(root, child);
  return (
    path !== '' &&
    !path.startsWith('..') &&
    !isAbsolute(path) &&
    path.split(sep)[0] === sessionId
  );
};

/**
 * Durable storage removal for one recorded plan, invoked by the daemon session
 * owner inside record removal after native cleanup has been acknowledged. The
 * plan names the storage; this owner only checks that each path lies inside
 * the root it was configured with at setup and removes it. The workspace
 * mount point is only ever removed as an empty directory. A failure retains
 * the record, and every step is safe to repeat.
 *
 * Roots and their ancestors must stay under stable host control, outside guest
 * writes; these checks do not defend against concurrent replacement of an
 * ancestor by another host process. Each recorded path must sit under the
 * session's own sandbox-id directory directly below its root, so one record
 * cannot name another session's storage. A recorded path that has become a
 * symbolic link is refused rather than removed: the link is not the recorded
 * storage.
 *
 * @param {object} powers
 * @param {{ removeSessionDirectory(sessionId: string): Promise<void> }} powers.stateStorage
 * @param {{ workspaceDir: string, mcpDir: string }} powers.roots
 * @param {(path: string) => Promise<void>} [powers.removeDirectory]
 * @param {(path: string) => Promise<void>} [powers.removeEmptyDirectory]
 * @param {typeof lstat} [powers.inspect]
 */
export const makeOpencodeSessionStorage = ({
  stateStorage,
  roots,
  removeDirectory = path => rm(path, { recursive: true, force: true }),
  removeEmptyDirectory = path => rmdir(path),
  inspect = lstat,
}) => {
  const workspaceRoot = assertRoot('workspace', roots.workspaceDir);
  const mcpRoot = assertRoot('mcp', roots.mcpDir);

  /** @param {string} text */
  const remove = async text => {
    await null;
    const plan = readSessionPlan(text);
    /** @type {readonly [string, string, string][]} */
    const targets = harden([
      ['mounterSocketDir', plan.mounterSocketDir, mcpRoot],
      ['mcpDir', plan.mcpDir, mcpRoot],
      // An operator-supplied workspace records no owned directory and is
      // never removed here.
      ...(plan.workspaceDir === undefined
        ? []
        : [
            /** @type {[string, string, string]} */ ([
              'workspaceDir',
              plan.workspaceDir,
              workspaceRoot,
            ]),
          ]),
    ]);
    // The mount point is bound to the session like the removable targets
    // but is never removed recursively (below), so it is checked here and
    // left out of the removal list.
    for (const [name, target, root] of [
      ...targets,
      ['workspaceMountPoint', plan.workspaceMountPoint, mcpRoot],
    ]) {
      withinSession(root, target, plan.sandboxSessionId) ||
        Fail`Session plan ${q(name)} ${q(target)} is outside this session's directory under ${q(root)}`;
    }
    for (const [name, target] of targets) {
      // eslint-disable-next-line no-await-in-loop
      const info = await inspect(target).catch(error => {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')
          return undefined;
        throw error;
      });
      !info?.isSymbolicLink() ||
        Fail`Session plan ${q(name)} is a symbolic link, not recorded storage`;
    }
    // The mount point is never removed recursively: through a still-mounted
    // point that would delete the guest's workspace. An empty directory is
    // what the mounter leaves after unmount; anything else (a live mount, a
    // populated directory) is a retained failure before any storage is
    // deleted, so removal can be retried once the mount is gone.
    await removeEmptyDirectory(plan.workspaceMountPoint).catch(error => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT')
        throw error;
    });
    for (const [, target] of targets) {
      // eslint-disable-next-line no-await-in-loop
      await removeDirectory(target);
    }
    // The socket, relay, and mount-point directories share one private
    // per-session parent directly under the MCP root. Remove it once all are
    // gone; anything else left there is not this plan's to delete.
    const parent = dirname(plan.mcpDir);
    if (
      parent === dirname(plan.mounterSocketDir) &&
      parent === dirname(plan.workspaceMountPoint) &&
      dirname(parent) === mcpRoot
    ) {
      await removeEmptyDirectory(parent).catch(error => {
        const { code } = /** @type {NodeJS.ErrnoException} */ (error);
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
      });
    }
    await E(stateStorage).removeSessionDirectory(plan.sandboxSessionId);
  };

  return makeExo('OpencodeSessionStorage', StorageInterface, {
    remove,
    help: () =>
      'Removes one recorded session plan’s workspace, private socket directories, and native state after the daemon owner has acknowledged native cleanup. Refuses paths outside the configured roots.',
  });
};
harden(makeOpencodeSessionStorage);
