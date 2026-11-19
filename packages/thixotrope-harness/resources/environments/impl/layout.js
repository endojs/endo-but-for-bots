// @ts-check
/**
 * The environments adapter's state layout (`designs/m6-interfaces.md` 5.1):
 *
 * ```
 * <state>/environments/
 *   tag                       this state's container label value
 *   sessions/e<n>/workspace/  the git repository (/workspace); `.thix-ready` in .git
 *   sessions/e<n>/home/       /home/node (R3-46)
 *   sessions/e<n>/run/        the fake runtime's process-group records
 *   trash/                    releases in progress; emptied at bind
 * ```
 *
 * Directories are 0700. The tag is `sha256(realpath(state))[0:16]`: path
 * dependent on purpose, so a cloned state (a test template) gets its own
 * containers. The key is the manager's `e<n>` and nothing else: anything
 * else is refused before it names a path.
 *
 * A workspace is made on first use (D-M6-3): `git.js`
 * `initWorkspaceRepository` (branch `main`, one empty commit, git run as
 * every host-side git call is), then the ready marker. A directory without the marker is a
 * creation a kill interrupted (K5): nothing the session made can be in it
 * yet, so it is wiped and made again. A release renames the session's
 * directory into `trash/` (one rename, so a kill leaves it whole or gone
 * from `sessions/`), fsyncs, then deletes it; `sweepTrash` deletes what a
 * kill left there.
 *
 * Node only (adapter).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  syncDirectory,
  writeFileAtomicSync,
} from '../../agent-host/impl/files.js';
import { initWorkspaceRepository } from './git.js';

/** The ready marker, inside `.git` so no worktree listing shows it. */
export const READY_MARKER = '.thix-ready';

/**
 * The manager's counter keys (`e<n>`; the runner names the sessions
 * directory through `e0`, which no environment has).
 */
const KEY_PATTERN = /^e[0-9]{1,16}$/;

/** Directory mode of everything the layout makes. */
const DIR_MODE = 0o700;

/**
 * The environments directory of a state directory.
 * @param {string} stateDir
 */
export const environmentsDirIn = stateDir => join(stateDir, 'environments');
harden(environmentsDirIn);

/**
 * @param {unknown} key
 * @returns {string}
 */
const assertKey = key => {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key))
    throw Error('environments: not an environment key');
  return key;
};

/**
 * @typedef {object} EnvironmentDirs
 * @property {string} workspace
 * @property {string} home
 * @property {string} run
 */

/**
 * @typedef {object} Layout
 * @property {() => string} tag this state's tag (the `tag` file written on first use)
 * @property {(key: string) => EnvironmentDirs} dirsOf
 * @property {(key: string) => Promise<void>} ensureWorkspace the repository,
 *   home and run directories, made once behind the marker (serial per key)
 * @property {(key: string) => Promise<void>} release delete the
 *   environment's directories through `trash/` (idempotent)
 * @property {() => Promise<number>} sweepTrash delete what releases left; how many
 * @property {() => Promise<string[]>} keys the environments on disk (the
 *   bind's sweep removes their stale git locks, `git.js` `removeStaleLock`)
 */

/**
 * @param {object} options
 * @param {string} options.stateDir
 * @param {string} [options.incarnation] names trash entries of this incarnation
 * @returns {Layout}
 */
export const makeLayout = ({
  stateDir,
  incarnation = randomBytes(4).toString('hex'),
}) => {
  const root = environmentsDirIn(stateDir);
  const sessions = join(root, 'sessions');
  const trash = join(root, 'trash');
  /** @type {string | undefined} */
  let tagValue;
  let trashSerial = 0;
  /**
   * Creations in flight, one per key; deleted when they settle.
   * @type {Map<string, Promise<void>>}
   */
  const creating = new Map();

  /** @param {string} key */
  const dirsOf = key => {
    const base = join(sessions, assertKey(key));
    return harden({
      workspace: join(base, 'workspace'),
      home: join(base, 'home'),
      run: join(base, 'run'),
    });
  };

  /** @param {string} key */
  const create = async key => {
    const dirs = dirsOf(key);
    const marker = join(dirs.workspace, '.git', READY_MARKER);
    if (!existsSync(marker)) {
      await rm(dirs.workspace, { recursive: true, force: true });
      await mkdir(dirs.workspace, { recursive: true, mode: DIR_MODE });
      await initWorkspaceRepository(dirs.workspace);
      await writeFile(marker, `${key}\n`, { mode: 0o600 });
    }
    await mkdir(dirs.home, { recursive: true, mode: DIR_MODE });
    await mkdir(dirs.run, { recursive: true, mode: DIR_MODE });
  };

  /** Session keys present on disk. */
  const keysOnDisk = async () => {
    const names = await readdir(sessions).catch(() => []);
    return names.filter(name => KEY_PATTERN.test(name));
  };

  return harden({
    tag: () => {
      if (tagValue === undefined) {
        mkdirSync(root, { recursive: true, mode: DIR_MODE });
        tagValue = createHash('sha256')
          .update(realpathSync(stateDir))
          .digest('hex')
          .slice(0, 16);
        writeFileAtomicSync(join(root, 'tag'), `${tagValue}\n`, {
          mode: 0o600,
        });
      }
      return tagValue;
    },
    dirsOf,
    ensureWorkspace: key => {
      assertKey(key);
      let creation = creating.get(key);
      if (creation === undefined) {
        creation = create(key).finally(() => creating.delete(key));
        creating.set(key, creation);
      }
      return creation;
    },
    release: async key => {
      const base = join(sessions, assertKey(key));
      if (!existsSync(base)) return;
      await mkdir(trash, { recursive: true, mode: DIR_MODE });
      trashSerial += 1;
      const target = join(trash, `${key}-${incarnation}-${trashSerial}`);
      await rename(base, target);
      await syncDirectory(sessions);
      await rm(target, { recursive: true, force: true });
    },
    sweepTrash: async () => {
      const names = await readdir(trash).catch(() => []);
      for (const name of names)
        // eslint-disable-next-line no-await-in-loop -- one at a time, at bind
        await rm(join(trash, name), { recursive: true, force: true });
      return names.length;
    },
    keys: keysOnDisk,
  });
};
harden(makeLayout);
