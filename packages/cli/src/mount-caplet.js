// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { parseOptionalPetNamePath, parsePetNamePath } from './pet-name.js';

/**
 * Report the first misuse of the mount flags, or undefined when they agree.
 * `--registry` and `--offline` only describe how a mount's package.json
 * resolves, so they need `--mount`, which in turn excludes the other sources.
 *
 * @param {object} flags
 * @param {string | undefined} flags.mountName
 * @param {string | undefined} flags.registryName
 * @param {boolean | undefined} flags.offline
 * @param {string | undefined} flags.archiveName
 * @param {string | undefined} flags.importPath
 * @returns {string | undefined}
 */
export const checkMountFlags = ({
  mountName,
  registryName,
  offline,
  archiveName,
  importPath,
}) => {
  if (mountName === undefined) {
    if (registryName !== undefined || offline !== undefined) {
      return '--registry and --offline require --mount <name>';
    }
    return undefined;
  }
  if (archiveName !== undefined || importPath !== undefined) {
    return 'Specify only one of --mount, --archive, or --UNCONFINED';
  }
  return undefined;
};
harden(checkMountFlags);

/**
 * Make a caplet from a mount through the daemon's `makeFromMount`, which
 * picks `makeFromTree` or `makeFromPackage` from the mount's root.  Only the
 * flags the user gave are forwarded, so the daemon can refuse a package-only
 * flag on a compartment-map root.
 *
 * @param {unknown} agent
 * @param {object} options
 * @param {string} options.mountName
 * @param {string | undefined} options.entry
 * @param {string | undefined} options.registryName
 * @param {boolean | undefined} options.offline
 * @param {string | undefined} options.workerName
 * @param {string} options.powersName
 * @param {string | undefined} options.resultName
 * @param {Record<string, string>} options.env
 */
export const makeCapletFromMount = (
  agent,
  {
    mountName,
    entry,
    registryName,
    offline,
    workerName,
    powersName,
    resultName,
    env,
  },
) => {
  /** @type {Record<string, unknown>} */
  const options = {
    powersName: parsePetNamePath(powersName),
    env,
  };
  if (resultName !== undefined) {
    options.resultName = parsePetNamePath(resultName);
  }
  if (entry !== undefined) {
    options.entry = entry;
  }
  if (registryName !== undefined) {
    options.registryName = parsePetNamePath(registryName);
  }
  if (offline !== undefined) {
    options.offline = offline;
  }
  return E(/** @type {any} */ (agent)).makeFromMount(
    parseOptionalPetNamePath(workerName),
    parsePetNamePath(mountName),
    harden(options),
  );
};
harden(makeCapletFromMount);
