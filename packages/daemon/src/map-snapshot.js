// @ts-check
/// <reference types="ses" />

import { mapPackageDescriptors } from '@endo/compartment-mapper/node-modules.js';
import { E } from '@endo/eventual-send';
import { Fail, q } from '@endo/errors';

import { makeMountReadPowers, packageLocationForKey } from './worker-import.js';

/** @import { RegistryResolution } from './registry.js' */

const textDecoder = new TextDecoder();

export const entryPackageLocation = 'file:///';
harden(entryPackageLocation);

/**
 * @param {string} version
 * @returns {[number, number, number] | undefined}
 */
const parseVersion = version => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * @param {string} a
 * @param {string} b
 */
const compareVersions = (a, b) => {
  const aParts = parseVersion(a);
  const bParts = parseVersion(b);
  if (aParts === undefined || bParts === undefined) {
    return a.localeCompare(b);
  }
  for (const index of [0, 1, 2]) {
    const difference = aParts[index] - bParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * @param {string} version
 * @param {string} range
 */
const satisfiesRange = (version, range) => {
  const specifier = range.startsWith('workspace:') ? range.slice(10) : range;
  if (specifier === '' || specifier === '*' || specifier === 'latest') {
    return true;
  }
  if (specifier === '^' || specifier === '~') {
    return true;
  }
  const versionParts = parseVersion(version);
  if (versionParts === undefined) {
    return version === specifier;
  }
  const [major, minor, patch] = versionParts;
  const caretMatch = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(specifier);
  if (caretMatch !== null) {
    const rangeMajor = Number(caretMatch[1]);
    const rangeMinor = Number(caretMatch[2] || 0);
    const rangePatch = Number(caretMatch[3] || 0);
    return (
      major === rangeMajor &&
      (minor > rangeMinor || (minor === rangeMinor && patch >= rangePatch))
    );
  }
  const majorMatch = /^(\d+)(?:\.x)?$/.exec(specifier);
  if (majorMatch !== null) {
    return major === Number(majorMatch[1]);
  }
  const exactParts = parseVersion(specifier);
  if (exactParts !== undefined) {
    return compareVersions(version, specifier) === 0;
  }
  return false;
};

/**
 * @param {Record<string, string>[]} maps
 * @param {string} dependencyName
 */
const dependencyRange = (maps, dependencyName) => {
  for (const map of maps) {
    const range = map[dependencyName];
    if (range !== undefined) {
      return range;
    }
  }
  return undefined;
};

/** @param {string | undefined} entry */
const normalizeEntry = entry => {
  const moduleSpecifier = entry || './index.js';
  if (
    moduleSpecifier === '.' ||
    moduleSpecifier.startsWith('./') ||
    moduleSpecifier.startsWith('../')
  ) {
    return moduleSpecifier;
  }
  return `./${moduleSpecifier}`;
};

/**
 * @param {object} args
 * @param {unknown} args.registry
 * @param {unknown} args.mount
 * @param {string} [args.entry]
 * @param {RegistryResolution} [args.resolution]
 * @param {object} [args.resolveOptions]
 * @param {object} [args.mapOptions]
 */
export const mapSnapshot = async ({
  registry,
  mount,
  entry,
  resolution: resolutionOption,
  resolveOptions = {},
  mapOptions = {},
}) => {
  const packageJsonBytes = await makeMountReadPowers({
    entryMount: mount,
    registry,
    resolution: harden({
      packagesByKey: {},
      keys: [],
      resolutionHash: 'sha256-empty',
      diagnostics: harden({
        unmetOptionals: [],
        workspaceVersionMismatches: [],
      }),
    }),
  }).read('file:///package.json');
  const packageDescriptor = JSON.parse(textDecoder.decode(packageJsonBytes));
  const resolution =
    resolutionOption ||
    (await E(/** @type {any} */ (registry)).resolve(
      packageJsonBytes,
      resolveOptions,
    ));
  const readPowers = makeMountReadPowers({
    entryMount: mount,
    registry,
    resolution,
  });

  const packageLocationByKey = new Map(
    Object.keys(resolution.packagesByKey).map(key => [
      key,
      packageLocationForKey(key),
    ]),
  );
  const keyByPackageLocation = new Map(
    [...packageLocationByKey.entries()].map(([key, location]) => [
      location,
      key,
    ]),
  );
  const packageRecords = Object.entries(resolution.packagesByKey);

  const dependencyLocationHook = async ({
    packageLocation,
    dependencyName,
    readDescriptor,
  }) => {
    const workspaceKey = packageLocationByKey.get(dependencyName);
    const workspaceRecord = resolution.packagesByKey[dependencyName];
    if (workspaceKey !== undefined && workspaceRecord?.workspace) {
      return harden({
        packageLocation: workspaceKey,
        packageDescriptor: workspaceRecord.packageJson,
      });
    }

    const importerKey = keyByPackageLocation.get(packageLocation);
    const importerDescriptor =
      packageLocation === entryPackageLocation
        ? packageDescriptor
        : importerKey === undefined
          ? undefined
          : resolution.packagesByKey[importerKey]?.packageJson;
    importerDescriptor !== undefined ||
      Fail`Cannot find importer descriptor for ${q(packageLocation)}`;

    const range = dependencyRange(
      [
        importerDescriptor.dependencies || {},
        importerDescriptor.peerDependencies || {},
        importerDescriptor.optionalDependencies || {},
      ],
      dependencyName,
    );

    const candidates = packageRecords
      .filter(([_key, record]) => !record.workspace)
      .filter(([_key, record]) => record.name === dependencyName)
      .filter(([_key, record]) =>
        range === undefined ? true : satisfiesRange(record.version, range),
      )
      .sort(([_aKey, a], [_bKey, b]) => compareVersions(b.version, a.version));

    const [key, record] = candidates[0] || [];
    if (key === undefined) {
      return undefined;
    }
    const targetLocation = packageLocationByKey.get(key);
    targetLocation !== undefined ||
      Fail`Cannot find package location for resolved dependency ${q(key)}`;
    const descriptor =
      record.packageJson || (await readDescriptor(targetLocation));
    descriptor !== undefined ||
      Fail`Cannot find package descriptor for resolved dependency ${q(key)}`;
    return harden({
      packageLocation: targetLocation,
      packageDescriptor: descriptor,
    });
  };

  const compartmentMap = await mapPackageDescriptors(
    readPowers,
    entryPackageLocation,
    new Set(),
    packageDescriptor,
    normalizeEntry(entry),
    harden({
      ...mapOptions,
      additionalLocations: [
        ...[...packageLocationByKey.values()].map(location =>
          harden({ location }),
        ),
        .../** @type {any} */ (mapOptions.additionalLocations || []),
      ],
      dependencyLocationHook,
      strict: true,
    }),
  );

  return harden({ compartmentMap, resolution, readPowers });
};
harden(mapSnapshot);
