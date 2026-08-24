// @ts-check

/** @import { EndoGuest, EndoHost, EndoMount } from '@endo/daemon' */
/** @import { EndoCodeModeProvisionForkOptions, EndoCodeModeProvisionPersistence } from './code-mode-provisioning-types.js' */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

import { validateEndoCodeModeProvisionPersistence } from './code-mode-provision-policy.js';

/**
 * @param {unknown} left
 * @param {unknown} right
 */
const sameData = (left, right) => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameData(value, right[index]))
    );
  }
  if (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null
  ) {
    const leftRecord = /** @type {Record<string, unknown>} */ (left);
    const rightRecord = /** @type {Record<string, unknown>} */ (right);
    const keys = Object.keys(leftRecord).sort();
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every(key => sameData(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
};

/**
 * Project the code-mode adapter's retained name and authority onto an existing
 * Endo host. Connection ownership stays with the caller.
 *
 * @param {EndoHost} host
 * @param {EndoCodeModeProvisionPersistence} persistence
 * @param {EndoCodeModeProvisionForkOptions} [options]
 * @returns {Promise<EndoGuest>}
 */
export const provideEndoCodeModeGuest = async (
  host,
  persistence,
  options = {},
) => {
  const normalized =
    await validateEndoCodeModeProvisionPersistence(persistence);
  if (options.forkFrom !== undefined) {
    const parent = await validateEndoCodeModeProvisionPersistence(
      options.forkFrom,
    );
    if (parent.guestName === normalized.guestName) {
      throw makeError(
        X`A code-mode fork requires a distinct retained guest name`,
      );
    }
    if (!sameData(parent.authority, normalized.authority)) {
      throw makeError(X`A code-mode fork cannot change retained authority`);
    }
    if (
      parent.internalGit?.path !== normalized.internalGit?.path ||
      (parent.internalGit === undefined) !==
        (normalized.internalGit === undefined)
    ) {
      throw makeError(X`A code-mode fork cannot change internal Git authority`);
    }
  }
  if (normalized.internalGit !== undefined) {
    const { path, mountName, gitName } = normalized.internalGit;
    const mount = /** @type {EndoMount} */ (
      (await E(host).has(mountName))
        ? await E(host).lookup(mountName)
        : await E(host).provideMount(path, mountName, { readOnly: true })
    );
    if (!(await E(host).has(gitName))) {
      await E(host).provideGit(mount, gitName, {
        readOnly: true,
        allowHistoryRewrite: false,
      });
    }
  }
  await Promise.all(
    Object.keys(normalized.introducedNames).map(async hostName => {
      if (!(await E(host).has(hostName))) {
        throw makeError(
          X`Endo code-mode introduced source ${q(hostName)} is unavailable`,
        );
      }
    }),
  );
  try {
    return await E(host).provideGuest(normalized.guestName, {
      authority: normalized.authority,
      ...(Object.keys(normalized.introducedNames).length === 0
        ? {}
        : { introducedNames: normalized.introducedNames }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('ENDO_CREDENTIAL_UNAVAILABLE:')
    ) {
      throw makeError(X`The configured Git credential is unavailable`, Error, {
        cause: error,
        code: 'ENDO_CREDENTIAL_UNAVAILABLE',
      });
    }
    throw error;
  }
};
harden(provideEndoCodeModeGuest);
