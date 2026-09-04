// @ts-check
/// <reference types="ses"/>

import { makePackageManagerError } from './errors.js';

/** @import { ManagerSelection, PackageManagerName, SelectManagerInput } from './types.js' */

/** @type {readonly PackageManagerName[]} */
export const MANAGER_NAMES = harden(
  /** @type {const} */ (['npm', 'pnpm', 'yarn']),
);

/**
 * Manager marker files at an effective project root.
 * Presence of any marker for a manager counts as evidence for that manager.
 *
 * @type {Readonly<Record<PackageManagerName, readonly string[]>>}
 */
export const MANAGER_MARKERS = harden({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
  yarn: ['yarn.lock', '.yarnrc.yml', '.pnp.cjs'],
});

/**
 * Lockfiles required for frozen installs (workspace-only markers do not count).
 *
 * @type {Readonly<Record<PackageManagerName, readonly string[]>>}
 */
export const FROZEN_LOCKFILES = harden({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
});

// Semantic Versioning 2.0.0 exact-version grammar. Numeric identifiers reject
// leading zeroes, and prerelease/build identifiers reject empty components.
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Parse `package.json#packageManager` (Corepack form `name@version`).
 *
 * @param {unknown} field
 * @returns {{ manager: PackageManagerName, version: string } | undefined}
 */
export const parsePackageManagerField = field => {
  if (typeof field !== 'string') {
    return undefined;
  }
  const match = /^(npm|pnpm|yarn)@(.+)$/.exec(field);
  if (match === null || !EXACT_SEMVER.test(match[2])) {
    return undefined;
  }
  const [, manager, version] = match;
  return harden({
    manager: /** @type {PackageManagerName} */ (manager),
    version,
  });
};
harden(parsePackageManagerField);

/**
 * @param {Readonly<Record<string, boolean>> | readonly string[]} markersPresent
 * @returns {readonly string[]}
 */
const markerNames = markersPresent =>
  Array.isArray(markersPresent)
    ? [...markersPresent]
    : Object.entries(markersPresent)
        .filter(([, value]) => value)
        .map(([name]) => name);

/**
 * Collect managers evidenced by marker presence at one effective root.
 *
 * @param {Readonly<Record<string, boolean>> | readonly string[]} markersPresent
 * @returns {readonly PackageManagerName[]}
 */
export const managersFromMarkers = markersPresent => {
  /** @type {Set<string>} */
  const present = new Set(markerNames(markersPresent));

  /** @type {PackageManagerName[]} */
  const found = [];
  for (const manager of MANAGER_NAMES) {
    if (MANAGER_MARKERS[manager].some(name => present.has(name))) {
      found.push(manager);
    }
  }
  return harden(found);
};
harden(managersFromMarkers);

/**
 * Whether the selected manager has a frozen-mode lockfile present.
 *
 * @param {PackageManagerName} manager
 * @param {Readonly<Record<string, boolean>> | readonly string[]} markersPresent
 * @returns {boolean}
 */
export const hasFrozenLockfile = (manager, markersPresent) => {
  const present = new Set(markerNames(markersPresent));
  return FROZEN_LOCKFILES[manager].some(name => present.has(name));
};
harden(hasFrozenLockfile);

/**
 * Deterministic manager selection.
 *
 * Precedence: explicit request (when not `auto`) → `packageManager` field →
 * manager markers → host policy default. Contradictions throw structured
 * errors rather than silent priority tie-breaks.
 *
 * @param {SelectManagerInput} input
 * @returns {ManagerSelection}
 */
export const selectManager = input => {
  const {
    explicit = 'auto',
    packageManagerField,
    markers = {},
    allowedManagers,
    defaultManager,
  } = input;

  if (
    explicit !== 'auto' &&
    explicit !== 'npm' &&
    explicit !== 'pnpm' &&
    explicit !== 'yarn'
  ) {
    throw makePackageManagerError(
      'manager-mismatch',
      `unsupported manager choice ${String(explicit)}`,
    );
  }

  const markerManagers = managersFromMarkers(markers);
  const markersPresent = markerNames(markers);

  const allowed =
    allowedManagers === undefined ? undefined : new Set(allowedManagers);

  const assertAllowed = (/** @type {PackageManagerName} */ manager) => {
    if (allowed !== undefined && !allowed.has(manager)) {
      throw makePackageManagerError(
        'manager-mismatch',
        `manager ${manager} is not in the host allowedManagers policy`,
        { manager, allowedManagers: [...(allowedManagers || [])] },
      );
    }
  };

  const fromManifest = parsePackageManagerField(packageManagerField);
  if (packageManagerField !== undefined && fromManifest === undefined) {
    throw makePackageManagerError(
      'manager-mismatch',
      `packageManager field must name npm, pnpm, or yarn with an exact version`,
      { packageManagerField },
    );
  }

  // Multiple incompatible manager markers at one root are always a conflict when
  // detection must choose among them (auto or marker-driven).
  if (markerManagers.length > 1) {
    // Explicit or manifest that uniquely names one of them still requires
    // agreement with every present lockfile family, else mismatch.
    const preferred =
      explicit !== 'auto'
        ? explicit
        : fromManifest !== undefined
          ? fromManifest.manager
          : undefined;
    if (preferred === undefined) {
      throw makePackageManagerError(
        'manager-ambiguous',
        `multiple package-manager markers at one root: ${markerManagers.join(', ')}`,
        { candidates: markerManagers, markersPresent },
      );
    }
    if (!markerManagers.includes(preferred)) {
      throw makePackageManagerError(
        'manager-mismatch',
        `selected manager ${preferred} disagrees with manager markers for ${markerManagers.join(', ')}`,
        { selected: preferred, candidates: markerManagers, markersPresent },
      );
    }
    // Preferred is one of the marker managers, but another family is also
    // present — that is still ambiguous/mismatched evidence.
    if (markerManagers.some(m => m !== preferred)) {
      throw makePackageManagerError(
        'manager-mismatch',
        `manager ${preferred} coexists with conflicting markers for ${markerManagers.filter(m => m !== preferred).join(', ')}`,
        { selected: preferred, candidates: markerManagers, markersPresent },
      );
    }
  }

  /** @type {ManagerSelection | undefined} */
  let selection;

  if (explicit !== 'auto') {
    if (fromManifest !== undefined && fromManifest.manager !== explicit) {
      throw makePackageManagerError(
        'manager-mismatch',
        `explicit manager ${explicit} disagrees with packageManager field ${String(packageManagerField)}`,
        {
          explicit,
          manifest: fromManifest.manager,
          markersPresent,
        },
      );
    }
    if (markerManagers.length === 1 && markerManagers[0] !== explicit) {
      throw makePackageManagerError(
        'manager-mismatch',
        `explicit manager ${explicit} disagrees with manager markers for ${markerManagers[0]}`,
        {
          explicit,
          candidates: markerManagers,
          markersPresent,
        },
      );
    }
    selection = {
      manager: explicit,
      source: 'explicit',
      markerManagers,
      markersPresent,
      ...(fromManifest?.version !== undefined
        ? { versionRequest: fromManifest.version }
        : {}),
    };
  } else if (fromManifest !== undefined) {
    if (
      markerManagers.length === 1 &&
      markerManagers[0] !== fromManifest.manager
    ) {
      throw makePackageManagerError(
        'manager-mismatch',
        `packageManager field ${fromManifest.manager} disagrees with manager markers for ${markerManagers[0]}`,
        {
          manifest: fromManifest.manager,
          candidates: markerManagers,
          markersPresent,
        },
      );
    }
    selection = {
      manager: fromManifest.manager,
      source: 'manifest',
      markerManagers,
      markersPresent,
      ...(fromManifest.version !== undefined
        ? { versionRequest: fromManifest.version }
        : {}),
    };
  } else if (markerManagers.length === 1) {
    selection = {
      manager: markerManagers[0],
      source: 'marker',
      markerManagers,
      markersPresent,
    };
  } else if (defaultManager !== undefined) {
    selection = {
      manager: defaultManager,
      source: 'default',
      markerManagers,
      markersPresent,
    };
  } else {
    throw makePackageManagerError(
      'manager-undetected',
      'no explicit, packageManager field, manager marker, or policy default manager',
      { markersPresent },
    );
  }

  assertAllowed(selection.manager);
  return harden(selection);
};
harden(selectManager);
