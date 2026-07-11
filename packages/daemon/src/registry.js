// @ts-check
/// <reference types="ses" />
/* eslint-disable max-classes-per-file -- Registry errors are local to this resolver. */
/* eslint-disable no-await-in-loop -- MVS advances a deterministic dependency frontier. */
/* eslint-disable no-continue -- Frontier edge classifiers are clearest as early exits. */
/* eslint-disable @jessie.js/safe-await-separator -- The resolver awaits inside the frontier loop. */

/**
 * @typedef {Record<string, string>} DependencyMap
 *
 * @typedef {{
 *   name: string;
 *   version: string;
 *   dependencies?: DependencyMap;
 *   peerDependencies?: DependencyMap;
 *   optionalDependencies?: DependencyMap;
 * }} PackageJson
 *
 * @typedef {{
 *   packageJson: PackageJson;
 *   integrity?: string;
 *   treeRef?: unknown;
 * }} RegistryPackageRecord
 *
 * @typedef {{
 *   name: string;
 *   version: string;
 *   packageJson: PackageJson;
 *   integrity: string;
 *   treeRef: unknown;
 * }} RegistryPackageSelection
 *
 * @typedef {{
 *   listVersions: (
 *     name: string,
 *     options?: { offline?: boolean },
 *   ) => Promise<string[]> | string[];
 *   fetchPackage: (
 *     name: string,
 *     version: string,
 *     options?: { offline?: boolean },
 *   ) => Promise<RegistryPackageRecord | undefined> | RegistryPackageRecord | undefined;
 * }} RegistryPackageSource
 *
 * @typedef {{
 *   packageJson: PackageJson;
 *   treeRef?: unknown;
 * }} WorkspacePackageRecord
 *
 * @typedef {{
 *   packages: Record<string, WorkspacePackageRecord | PackageJson>;
 * }} RegistryWorkspaceRoot
 *
 * @typedef {{
 *   offline?: boolean;
 *   workspaceRoot?: RegistryWorkspaceRoot;
 * }} RegistryResolveOptions
 *
 * @typedef {{
 *   importer: string;
 *   name: string;
 *   range: string;
 *   reason: string;
 * }} RegistryDependencyDiagnostic
 *
 * @typedef {{
 *   name: string;
 *   version: string;
 *   packageJson: PackageJson;
 *   treeRef: unknown;
 *   integrity: string;
 *   workspace?: boolean;
 * }} RegistryResolutionPackage
 *
 * @typedef {{
 *   packagesByKey: Record<string, RegistryResolutionPackage>;
 *   keys: string[];
 *   resolutionHash: string;
 *   diagnostics: {
 *     unmetOptionals: RegistryDependencyDiagnostic[];
 *     workspaceVersionMismatches: RegistryDependencyDiagnostic[];
 *   };
 * }} RegistryResolution
 *
 * @typedef {{
 *   resolve: (
 *     packageJsonBytes: Uint8Array | string | PackageJson,
 *     options?: RegistryResolveOptions,
 *   ) => Promise<RegistryResolution>;
 * }} RegistryResolver
 *
 * @typedef {{
 *   name: string;
 *   range: string;
 *   source: 'dependencies' | 'optionalDependencies';
 *   importer: string;
 * }} DependencyEdge
 *
 * @typedef {{
 *   importer: string;
 *   name: string;
 *   range: string;
 * }} PeerRequirement
 */

import { createHash } from 'node:crypto';

import { q } from '@endo/errors';

export class RegistryMissingPackageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RegistryMissingPackageError';
  }
}
harden(RegistryMissingPackageError);

export class RegistryOfflineError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RegistryOfflineError';
  }
}
harden(RegistryOfflineError);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * @param {Uint8Array | string | PackageJson} packageJsonBytes
 * @returns {PackageJson}
 */
const parsePackageJson = packageJsonBytes => {
  if (typeof packageJsonBytes === 'string') {
    return JSON.parse(packageJsonBytes);
  }
  if (packageJsonBytes instanceof Uint8Array) {
    return JSON.parse(textDecoder.decode(packageJsonBytes));
  }
  return packageJsonBytes;
};

/**
 * @param {PackageJson} packageJson
 * @returns {string}
 */
const packageName = packageJson => packageJson.name || '<entry>';

/**
 * @param {DependencyEdge[]} frontier
 * @param {PackageJson} packageJson
 */
const enqueueRuntimeDependencies = (frontier, packageJson) => {
  const importer = packageName(packageJson);
  for (const [name, range] of Object.entries(packageJson.dependencies || {})) {
    frontier.push({ name, range, source: 'dependencies', importer });
  }
  for (const [name, range] of Object.entries(
    packageJson.optionalDependencies || {},
  )) {
    frontier.push({ name, range, source: 'optionalDependencies', importer });
  }
};

/**
 * @param {PeerRequirement[]} peerRequirements
 * @param {PackageJson} packageJson
 */
const recordPeerDependencies = (peerRequirements, packageJson) => {
  const importer = packageName(packageJson);
  for (const [name, range] of Object.entries(
    packageJson.peerDependencies || {},
  )) {
    peerRequirements.push({ importer, name, range });
  }
};

/** @param {string} specifier */
const isWorkspaceSpecifier = specifier => specifier.startsWith('workspace:');

/**
 * @param {RegistryWorkspaceRoot | undefined} workspaceRoot
 * @param {string} name
 * @returns {WorkspacePackageRecord | undefined}
 */
const getWorkspacePackage = (workspaceRoot, name) => {
  if (workspaceRoot === undefined) {
    return undefined;
  }
  const record = workspaceRoot.packages[name];
  if (record === undefined) {
    return undefined;
  }
  if ('packageJson' in record) {
    return record;
  }
  return { packageJson: record };
};

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
 * @param {string} version
 * @returns {number | undefined}
 */
const versionMajor = version => parseVersion(version)?.[0];

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
 * @returns {boolean}
 */
const satisfiesRange = (version, range) => {
  const workspaceSpecifier = isWorkspaceSpecifier(range);
  const specifier = workspaceSpecifier ? range.slice(10) : range;
  if (specifier === '' || specifier === '*' || specifier === 'latest') {
    return true;
  }
  if (workspaceSpecifier && (specifier === '^' || specifier === '~')) {
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
    const hasMinor = caretMatch[2] !== undefined;
    const hasPatch = caretMatch[3] !== undefined;
    const rangeMinor = Number(caretMatch[2] || 0);
    const rangePatch = Number(caretMatch[3] || 0);
    if (
      compareVersions(version, `${rangeMajor}.${rangeMinor}.${rangePatch}`) < 0
    ) {
      return false;
    }
    if (rangeMajor > 0 || !hasMinor) {
      return major === rangeMajor;
    }
    if (rangeMinor > 0 || !hasPatch) {
      return major === 0 && minor === rangeMinor;
    }
    return major === 0 && minor === 0 && patch === rangePatch;
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
 * @param {string} range
 * @param {string[]} versions
 * @returns {number[]}
 */
const majorsForRange = (range, versions) => {
  const specifier = isWorkspaceSpecifier(range) ? range.slice(10) : range;
  const caretMatch = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(specifier);
  if (caretMatch !== null) {
    return [Number(caretMatch[1])];
  }
  const majorMatch = /^(\d+)(?:\.x)?$/.exec(specifier);
  if (majorMatch !== null) {
    return [Number(majorMatch[1])];
  }
  const exactParts = parseVersion(specifier);
  if (exactParts !== undefined) {
    return [exactParts[0]];
  }
  let selectedMajor;
  let selectedVersion;
  for (const version of versions) {
    const major = versionMajor(version);
    if (major !== undefined && satisfiesRange(version, range)) {
      if (
        selectedVersion === undefined ||
        compareVersions(selectedVersion, version) < 0
      ) {
        selectedVersion = version;
        selectedMajor = major;
      }
    }
  }
  return selectedMajor === undefined ? [] : [selectedMajor];
};

/**
 * @param {string} name
 * @param {string} version
 */
const registryKey = (name, version) => `${name}@${version}`;

/** @param {string} name */
const workspaceKey = name => name;

/**
 * @param {Record<string, RegistryResolutionPackage>} packagesByKey
 */
const computeResolutionHash = packagesByKey => {
  const keys = Object.keys(packagesByKey).sort();
  const hash = createHash('sha256');
  for (const key of keys) {
    const entry = packagesByKey[key];
    hash.update(key);
    hash.update('\0');
    hash.update(entry.integrity);
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
};

/**
 * @param {RegistryPackageSource} packageSource
 * @param {string} name
 * @param {number} major
 * @param {string[]} requirements
 * @param {{ offline?: boolean }} options
 * @returns {Promise<RegistryPackageSelection | undefined>}
 */
const selectGreatestSatisfying = async (
  packageSource,
  name,
  major,
  requirements,
  options,
) => {
  const versions = await packageSource.listVersions(name, options);
  let selectedVersion;
  for (const version of versions) {
    if (versionMajor(version) !== major) {
      continue;
    }
    if (!requirements.every(range => satisfiesRange(version, range))) {
      continue;
    }
    if (
      selectedVersion === undefined ||
      compareVersions(selectedVersion, version) < 0
    ) {
      selectedVersion = version;
    }
  }
  if (selectedVersion === undefined) {
    return undefined;
  }
  const record = await packageSource.fetchPackage(
    name,
    selectedVersion,
    options,
  );
  if (record === undefined) {
    return undefined;
  }
  const { packageJson, treeRef = registryKey(name, selectedVersion) } = record;
  return {
    name,
    version: selectedVersion,
    packageJson,
    treeRef,
    integrity:
      record.integrity || `sha512-${registryKey(name, selectedVersion)}`,
  };
};

/**
 * @param {RegistryPackageSource} packageSource
 * @returns {RegistryResolver}
 */
export const makeRegistryResolver = packageSource => {
  const resolve = async (packageJsonBytes, options = {}) => {
    const root = parsePackageJson(packageJsonBytes);
    /** @type {DependencyEdge[]} */
    const frontier = [];
    /** @type {PeerRequirement[]} */
    const peerRequirements = [];
    /** @type {RegistryDependencyDiagnostic[]} */
    const unmetOptionals = [];
    /** @type {RegistryDependencyDiagnostic[]} */
    const workspaceVersionMismatches = [];
    /** @type {Record<string, RegistryResolutionPackage>} */
    const packagesByKey = {};
    /** @type {Map<string, Map<number, { requirements: Set<string>, selection?: RegistryPackageSelection }>>} */
    const registrySelections = new Map();
    const seenWorkspacePackages = new Set();

    enqueueRuntimeDependencies(frontier, root);
    recordPeerDependencies(peerRequirements, root);

    while (frontier.length > 0) {
      const edge = /** @type {DependencyEdge} */ (frontier.shift());
      const workspaceRecord = getWorkspacePackage(
        options.workspaceRoot,
        edge.name,
      );
      if (workspaceRecord !== undefined) {
        const { packageJson } = workspaceRecord;
        if (!satisfiesRange(packageJson.version, edge.range)) {
          workspaceVersionMismatches.push({
            importer: edge.importer,
            name: edge.name,
            range: edge.range,
            reason: `${edge.name}@${packageJson.version} does not satisfy ${edge.range}`,
          });
        }
        const key = workspaceKey(edge.name);
        packagesByKey[key] = harden({
          name: edge.name,
          version: packageJson.version,
          packageJson,
          treeRef: workspaceRecord.treeRef || key,
          integrity: `workspace:${edge.name}@${packageJson.version}`,
          workspace: true,
        });
        if (!seenWorkspacePackages.has(edge.name)) {
          seenWorkspacePackages.add(edge.name);
          enqueueRuntimeDependencies(frontier, packageJson);
          recordPeerDependencies(peerRequirements, packageJson);
        }
        continue;
      }

      if (isWorkspaceSpecifier(edge.range)) {
        if (edge.source === 'optionalDependencies') {
          unmetOptionals.push({
            importer: edge.importer,
            name: edge.name,
            range: edge.range,
            reason:
              'workspace dependency declared but no enclosing workspace root',
          });
          continue;
        }
        throw new RegistryMissingPackageError(
          `workspace dependency ${q(edge.name)} declared but no enclosing workspace root`,
        );
      }

      const versions = await packageSource.listVersions(edge.name, {
        offline: options.offline,
      });
      const majors = majorsForRange(edge.range, versions);
      if (majors.length === 0) {
        const reason = `no ${edge.name} versions satisfy ${edge.range}`;
        if (edge.source === 'optionalDependencies') {
          unmetOptionals.push({
            importer: edge.importer,
            name: edge.name,
            range: edge.range,
            reason,
          });
          continue;
        }
        throw new RegistryMissingPackageError(reason);
      }

      let nameSelections = registrySelections.get(edge.name);
      if (nameSelections === undefined) {
        nameSelections = new Map();
        registrySelections.set(edge.name, nameSelections);
      }

      for (const major of majors) {
        let majorSelection = nameSelections.get(major);
        if (majorSelection === undefined) {
          majorSelection = { requirements: new Set() };
          nameSelections.set(major, majorSelection);
        }
        const nextRequirements = [...majorSelection.requirements, edge.range];

        const selected = await selectGreatestSatisfying(
          packageSource,
          edge.name,
          major,
          nextRequirements,
          { offline: options.offline },
        );
        if (selected === undefined) {
          const reason = `no ${edge.name} ${major}.x version satisfies ${[
            ...nextRequirements,
          ].join(', ')}`;
          if (edge.source === 'optionalDependencies') {
            unmetOptionals.push({
              importer: edge.importer,
              name: edge.name,
              range: edge.range,
              reason,
            });
            continue;
          }
          throw new RegistryMissingPackageError(reason);
        }

        const previousVersion = majorSelection.selection?.version;
        majorSelection.requirements.add(edge.range);
        majorSelection.selection = selected;
        if (
          previousVersion !== undefined &&
          previousVersion !== selected.version
        ) {
          delete packagesByKey[registryKey(edge.name, previousVersion)];
        }
        packagesByKey[registryKey(edge.name, selected.version)] = harden({
          name: edge.name,
          version: selected.version,
          packageJson: selected.packageJson,
          treeRef: selected.treeRef,
          integrity: selected.integrity,
        });
        if (previousVersion !== selected.version) {
          enqueueRuntimeDependencies(frontier, selected.packageJson);
          recordPeerDependencies(peerRequirements, selected.packageJson);
        }
      }
    }

    for (const peer of peerRequirements) {
      const matchingKeys = Object.keys(packagesByKey).filter(key => {
        const entry = packagesByKey[key];
        return (
          entry.name === peer.name && satisfiesRange(entry.version, peer.range)
        );
      });
      if (matchingKeys.length === 0) {
        throw new RegistryMissingPackageError(
          `package ${q(peer.importer)} declares unmet peer dependency ${q(
            peer.name,
          )} ${q(peer.range)}`,
        );
      }
    }

    const keys = Object.keys(packagesByKey).sort();
    const resolutionHash = computeResolutionHash(packagesByKey);
    return harden({
      packagesByKey,
      keys,
      resolutionHash,
      diagnostics: harden({
        unmetOptionals,
        workspaceVersionMismatches,
      }),
    });
  };

  return harden({ resolve });
};
harden(makeRegistryResolver);

/**
 * @param {Record<string, Record<string, RegistryPackageRecord | PackageJson>>} packages
 * @param {{ offlineNames?: string[] }} [options]
 * @returns {RegistryPackageSource}
 */
export const makeMemoryRegistryPackageSource = (packages, options = {}) => {
  const offlineNames = new Set(options.offlineNames || []);
  return harden({
    listVersions: (name, listOptions = {}) => {
      if (listOptions.offline && offlineNames.has(name)) {
        throw new RegistryOfflineError(
          `offline registry cache has no metadata for ${q(name)}`,
        );
      }
      return Object.keys(packages[name] || {}).sort(compareVersions);
    },
    fetchPackage: (name, version, fetchOptions = {}) => {
      if (fetchOptions.offline && offlineNames.has(name)) {
        throw new RegistryOfflineError(
          `offline registry cache has no package ${q(registryKey(name, version))}`,
        );
      }
      const record = packages[name]?.[version];
      if (record === undefined) {
        return undefined;
      }
      if ('packageJson' in record) {
        return record;
      }
      return { packageJson: record };
    },
  });
};
harden(makeMemoryRegistryPackageSource);

export const encodePackageJson = packageJson =>
  textEncoder.encode(JSON.stringify(packageJson));
harden(encodePackageJson);
