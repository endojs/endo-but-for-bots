// @ts-check

import { Fail, q } from '@endo/errors';

import { PORTABLE_NAME_PATTERN } from './policy.js';
import { assertPrivateDirectory } from './private-directory.js';

/**
 * Acquire an exclusive marker before any owner-scoped probe or resource creation.
 * Existing markers are always refused. Parent death alone does not prove that
 * in-flight Podman control descendants have stopped; stale recovery is external.
 * The caller must finish all resource cleanup before releasing this marker.
 *
 * @param {{ directory: string, ownerId: string }} config
 * @param {{ fs?: typeof import('node:fs/promises') }} [powers]
 */
export const acquireRuntimeOwnership = async (
  { directory, ownerId },
  { fs: fsPower } = {},
) => {
  PORTABLE_NAME_PATTERN.test(ownerId) ||
    Fail`Invalid runtime owner ${q(ownerId)}`;
  const fs = fsPower ?? (await import('node:fs/promises'));
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const parent = await assertPrivateDirectory(directory, fs);
  const marker = path.join(parent, `${ownerId}.owner`);
  // The nonce distinguishes successive acquisitions even in the same process.
  // It is published in the exclusive symlink syscall, with no empty-file window.
  const token = `endo-sandbox-owner-v1-${randomUUID()}`;
  /** @param {string} directoryPath */
  const syncDirectory = async directoryPath => {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  // Include the ancestry: the host may have just created the private directory.
  // No effect-producing owner is returned until its exclusion is durable.
  let ancestor = parent;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await syncDirectory(ancestor);
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  let removed = false;
  /** @type {Promise<void> | undefined} */
  let releaseFlight;
  const release = () => {
    releaseFlight ??= (async () => {
      if (!removed) {
        (await fs.readlink(marker)) === token ||
          Fail`Runtime ownership changed: ${q(marker)}`;
        await fs.unlink(marker);
        removed = true;
      }
      // Retry a failed flush without unlinking a successor's marker.
      await syncDirectory(parent);
    })().catch(error => {
      releaseFlight = undefined;
      throw error;
    });
    return releaseFlight;
  };
  const ownership = harden({ directory: parent, release });
  // A failed publication flush leaves the exclusive marker in place. No native
  // effect has been admitted; later opens must not guess that marker is stale.
  await fs.symlink(token, marker);
  await syncDirectory(parent);
  return ownership;
};
harden(acquireRuntimeOwnership);
