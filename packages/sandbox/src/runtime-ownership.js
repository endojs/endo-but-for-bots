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
  /** @type {Promise<void> | undefined} */
  let releaseFlight;
  const release = () => {
    releaseFlight ??= (async () => {
      (await fs.readlink(marker)) === token ||
        Fail`Runtime ownership changed: ${q(marker)}`;
      await fs.unlink(marker);
    })().catch(error => {
      releaseFlight = undefined;
      throw error;
    });
    return releaseFlight;
  };
  const ownership = harden({ directory: parent, release });
  // Last acquisition: after publication, immediately return its cleanup owner.
  await fs.symlink(token, marker);
  return ownership;
};
harden(acquireRuntimeOwnership);
