// @ts-check

import { Fail, q } from '@endo/errors';

import { assertPrivateDirectory } from './private-directory.js';
import { makeResourceRegistry } from './resource-registry.js';

/** @import { ValidatedGeneratedFile } from './generated-file-types.js' */
/** @import { GeneratedFileMount, GeneratedFileStage, GeneratedFileStorage } from './generated-file-storage-types.js' */

/**
 * Count UTF-8 payload before allocating an encoded copy.
 * @param {string} text
 */
const utf8Length = text => {
  let bytes = 0n;
  for (const character of text) {
    const first = character.charCodeAt(0);
    bytes +=
      character.length === 2 ? 4n : first < 0x80 ? 1n : first < 0x800 ? 2n : 3n;
  }
  return bytes;
};

/**
 * Create an exclusively owned, fresh storage root under a private host directory.
 * Existing roots are refused, including empty roots left by a crashed owner.
 * The runtime must reap that owner's containers before reconciling stale storage.
 * This allocator never performs that recovery or removes an existing root.
 *
 * Budgets count retained UTF-8 payload and entries (including directories), not
 * physical filesystem blocks. Callers must keep the root's ancestry outside guest
 * write authority and release stages only after their container users are gone.
 *
 * @param {{ directory: string, maxBytes: bigint, maxEntries: bigint }} config
 * @param {{ fs?: typeof import('node:fs/promises') }} [powers]
 * @returns {Promise<GeneratedFileStorage>}
 */
export const makeGeneratedFileStorage = async (
  { directory, maxBytes, maxEntries },
  { fs: fsPower } = {},
) => {
  (typeof maxBytes === 'bigint' &&
    maxBytes >= 0n &&
    typeof maxEntries === 'bigint' &&
    maxEntries >= 1n) ||
    Fail`Generated storage requires explicit nonnegative byte and positive entry budgets`;
  const fs = fsPower ?? (await import('node:fs/promises'));
  const path = await import('node:path');
  (path.isAbsolute(directory) && !directory.includes('\0')) ||
    Fail`Generated storage requires an absolute host directory`;
  const absolute = path.resolve(directory);
  const parent = await assertPrivateDirectory(path.dirname(absolute), fs);
  const root = path.join(parent, path.basename(absolute));
  root !== parent || Fail`Generated storage must have a distinct root`;
  const registry = makeResourceRegistry();
  let usedBytes = 0n;
  let usedEntries = 1n; // The exclusive storage root itself.
  let nextStage = 0n;
  /** @type {Promise<void> | undefined} */
  let closeFlight;

  /**
   * @param {readonly ValidatedGeneratedFile[]} files
   * @param {readonly string[]} writableHostPaths
   * @returns {GeneratedFileStage}
   */
  const makeStage = (files, writableHostPaths) => {
    registry.assertOpen();
    const stageId = String(nextStage);
    nextStage += 1n;
    const contents = harden(files.map(file => harden({ ...file })));
    const writablePaths = harden([...writableHostPaths]);
    const bytes = contents.reduce(
      (sum, file) => sum + utf8Length(file.contents),
      0n,
    );
    const entries = contents.length === 0 ? 0n : BigInt(contents.length) + 1n;
    let charged = false;
    let releasing = false;
    /** @type {string | undefined} */
    let stageDirectory;
    /** @type {readonly GeneratedFileMount[] | undefined} */
    let mounts;
    let pending = Promise.resolve();
    /** @type {Promise<void> | undefined} */
    let releaseFlight;

    const stillInUse = async () => {
      Fail`Generated file stage still in use; remove its containers before release`;
    };
    const erase = async () => {
      if (stageDirectory !== undefined) {
        await fs.rm(stageDirectory, { recursive: true, force: true });
        stageDirectory = undefined;
      }
      mounts = undefined;
      if (charged) {
        usedBytes -= bytes;
        usedEntries -= entries;
        charged = false;
        registry.release(stageId, stillInUse);
      }
    };
    const prepare = () => {
      !releasing || Fail`Generated file stage is releasing`;
      const result = registry.inOrder(stageId, async () => {
        // Recheck on every use; a host mount alias can change between spawns.
        for (const source of writablePaths) {
          // eslint-disable-next-line no-await-in-loop
          const canonical = await fs.realpath(source);
          const outside = relative =>
            relative === '..' ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative);
          (outside(path.relative(canonical, root)) &&
            outside(path.relative(root, canonical))) ||
            Fail`Generated storage overlaps a writable guest bind: ${q(source)}`;
        }
        registry.assertOpen();
        !releasing || Fail`Generated file stage is releasing`;
        if (mounts !== undefined) return mounts;
        if (contents.length === 0) {
          mounts = harden([]);
          return mounts;
        }
        // A failed materialization must be deleted before it can be retried.
        await erase();
        registry.assertOpen();
        !releasing || Fail`Generated file stage is releasing`;
        (usedBytes + bytes <= maxBytes &&
          usedEntries + entries <= maxEntries) ||
          Fail`Generated storage budget exhausted`;
        usedBytes += bytes;
        usedEntries += entries;
        charged = true;
        registry.retain(stageId, stillInUse);
        try {
          if (contents.length > 0) {
            stageDirectory = await fs.mkdtemp(path.join(root, 'stage-'));
          }
          const staged = [];
          for (const [index, file] of contents.entries()) {
            const hostPath = path.join(
              /** @type {string} */ (stageDirectory),
              String(index),
            );
            // Exclusive creation cannot follow a preexisting final symlink.
            // The private parent prevents access outside the individual binds.
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(
              hostPath,
              new TextEncoder().encode(file.contents),
              { flag: 'wx', mode: 0o600 },
            );
            // Set final read permissions independently of the host umask.
            // eslint-disable-next-line no-await-in-loop
            await fs.chmod(hostPath, 0o444);
            staged.push(
              harden({
                hostPath,
                innerPath: file.innerPath,
                mode: /** @type {const} */ ('ro'),
              }),
            );
          }
          registry.assertOpen();
          !releasing || Fail`Generated file stage is releasing`;
          mounts = harden(staged);
          return mounts;
        } catch (error) {
          try {
            await erase();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Generated file staging cleanup pending',
            );
          }
          throw error;
        }
      });
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const release = () => {
      releasing = true;
      releaseFlight ??= pending.then(erase).catch(error => {
        releaseFlight = undefined;
        throw error;
      });
      return releaseFlight;
    };
    return harden({ prepare, release });
  };
  const close = () => {
    // Registry shutdown fences and drains allocation, but retained owners
    // refuse deletion while a consumer may still have these files mounted.
    closeFlight ??= registry
      .shutdown()
      .then(() => fs.rmdir(root))
      .catch(error => {
        closeFlight = undefined;
        throw error;
      });
    return closeFlight;
  };
  const storage = harden({ makeStage, close });
  // This is the constructor's last acquisition. Do not add a failing await
  // after it without retaining an owner for the newly created directory.
  await fs.mkdir(root, { mode: 0o700 });
  return storage;
};
harden(makeGeneratedFileStorage);
