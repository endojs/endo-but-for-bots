// @ts-check

/**
 * Snapshot-mapper algorithm: produce a `CompartmentMap` document from
 * a `RegistryResolution` plus an entry-source descriptor.
 *
 * Per `designs/snapshot-mapper.md`, the mapper takes a pair of daemon
 * capabilities (an `EndoRegistry` resolution and an entry source) and
 * produces a `CompartmentMap` whose layout follows the
 * compartment-mapper archive precedent: a top-level
 * `compartment-map.json` plus peer directories named by package
 * (`<name>@<version>/` for registry-resolved entries, `<name>/` for
 * workspace members).
 *
 * The algorithmic core lives here. The daemon-side surface that
 * supplies the entry source and wires `compartment-mapper.importLocation`
 * against the synthesized `ReadPowers` is the consumer of this module,
 * and the integration layer (per
 * `designs/daemon-worker-import-from-mount.md`) calls into it from the
 * worker's `makeFromPackage` dispatch.
 *
 * @import { RegistryResolution } from '../types.js';
 */

import { satisfiesRange } from './mvs-resolver.js';

const utf8Decoder = new TextDecoder();

/**
 * The on-the-wire compartment-map shape this module emits. Mirrors
 * the `compartment-mapper`'s archive layout: each compartment is
 * named by a peer-directory key, the entry compartment is named by
 * the entry source's locator (default `'.'`), and the descriptor
 * carries the dependency edges the package descriptor walker would
 * have computed.
 *
 * The shape is intentionally minimal: callers thread it through
 * `compartment-mapper.importLocation`'s `compartmentMap` option,
 * which is already designed to consume an arbitrary
 * `CompartmentMapDescriptor`.
 *
 * @typedef {{
 *   tags?: string[],
 *   entry: {
 *     compartment: string,
 *     module: string,
 *   },
 *   compartments: Record<string, {
 *     label: string,
 *     name: string,
 *     location: string,
 *     modules: Record<string, unknown>,
 *     scopes?: Record<string, unknown>,
 *     parsers?: Record<string, string>,
 *     types?: Record<string, string>,
 *   }>,
 * }} CompartmentMapDescriptor
 */

/**
 * Decode a `package.json` payload (UTF-8 bytes or string).
 *
 * @param {Uint8Array | string} payload
 */
const decodePackageJson = payload => {
  const text =
    typeof payload === 'string' ? payload : utf8Decoder.decode(payload);
  return JSON.parse(text);
};
harden(decodePackageJson);

/**
 * Build the peer-directory key for a `(name, version)` selection.
 * Registry-resolved entries carry the version segment; workspace
 * members do not.
 *
 * @param {string} name
 * @param {string} version
 * @param {boolean} isWorkspace
 */
const peerDirectoryKey = (name, version, isWorkspace) =>
  isWorkspace ? name : `${name}@${version}`;
harden(peerDirectoryKey);

/**
 * Convert a `RegistryResolution` into a `CompartmentMapDescriptor`.
 *
 * The resolution's `packagesByKey` table is the source of truth for
 * the layout: registry-resolved entries are keyed `<name>@<version>`
 * (the key the resolver emits), workspace members are keyed by bare
 * name. The mapper emits one compartment per key and binds the entry
 * compartment's `dependencies` table to those peer-directory names.
 *
 * The mapper produces a *minimal* compartment-map: each compartment
 * carries an empty `modules` table because the package-descriptor walk
 * happens at link time inside `compartment-mapper.importLocation`.
 * This module's job is to seed the compartment table with the right
 * peer-directory keys; the importLocation walk fills in the per-module
 * entries.
 *
 * @param {{
 *   resolution: RegistryResolution,
 *   entryPackageJson: string | Uint8Array,
 *   entryCompartmentLabel?: string,
 *   entryModule?: string,
 *   workspaceMembers?: Map<string, { packageJson: string | Uint8Array }>,
 * }} options
 * @returns {CompartmentMapDescriptor}
 */
export const buildCompartmentMap = options => {
  const {
    resolution,
    entryPackageJson,
    entryCompartmentLabel,
    entryModule = '.',
    workspaceMembers,
  } = options;
  const entryPkg = decodePackageJson(entryPackageJson);
  const entryName = entryPkg.name || '<entry>';
  const entryVersion = entryPkg.version || '0.0.0';
  const entryLocation = '.';

  /** @type {CompartmentMapDescriptor['compartments']} */
  const compartments = {};

  // Build the entry compartment with its dependency edges. Each
  // dependency name maps to a peer-directory key, looked up against
  // `resolution.packagesByKey`. The look-up rule mirrors the walk's
  // own selection: workspace member wins; otherwise the major-matching
  // registry entry.
  /** @type {Record<string, { compartment: string }>} */
  const entryDependencies = {};
  const allDeps = {
    ...(entryPkg.dependencies || {}),
    ...(entryPkg.peerDependencies || {}),
    ...(entryPkg.optionalDependencies || {}),
  };
  for (const [name, declaredRange] of Object.entries(allDeps)) {
    const wsKey = name;
    const wsEntry = resolution.packagesByKey[wsKey];
    if (wsEntry && wsEntry.version && resolution.keys.includes(wsKey)) {
      // Workspace key matches the bare name. Workspace member shadows
      // any registry version regardless of the declared range.
      entryDependencies[name] = { compartment: wsKey };
    } else {
      // Find the registry-resolved entry whose name matches. When
      // multiple major versions coexist (multi-major), select the one
      // whose version satisfies the entry's declared range. The
      // entry's package.json carries the canonical range for each
      // dependency; we use it here to disambiguate so the binding the
      // link step reads is the major the entry's source actually
      // imports. If no candidate satisfies (the resolution carries a
      // major that does not match the entry's declared range but did
      // reach the closure through a transitive importer), fall back to
      // the first matching key so the binding is still populated.
      const candidates = resolution.keys.filter(key =>
        key.startsWith(`${name}@`),
      );
      const declaredString =
        typeof declaredRange === 'string' ? declaredRange : '';
      const satisfyingKey = candidates.find(key => {
        const entry = resolution.packagesByKey[key];
        return (
          entry &&
          declaredString !== '' &&
          satisfiesRange(entry.version, declaredString)
        );
      });
      const matchingKey = satisfyingKey ?? candidates[0];
      if (matchingKey !== undefined) {
        entryDependencies[name] = { compartment: matchingKey };
      }
    }
  }

  compartments[entryLocation] = {
    label: entryCompartmentLabel || entryName,
    name: entryName,
    location: entryLocation,
    modules: harden({}),
    // The compartment-mapper consumes per-compartment dependency
    // edges through `scopes`: each entry binds a bare specifier
    // (the dependency name) to the peer-directory key of the
    // compartment carrying that dependency. The `compartment` field
    // on a scope value names the resolved peer-directory key; the
    // compartment-mapper's link step reads the binding when it walks
    // the entry's import statements.
    scopes: harden(entryDependencies),
    parsers: harden({}),
    types: harden({}),
  };

  // Emit one compartment per peer directory.
  for (const key of resolution.keys) {
    const pkg = resolution.packagesByKey[key];
    // Workspace members keep the bare name; registry entries carry
    // the version segment.
    const isWorkspace = key === pkg.name;
    const dirKey = peerDirectoryKey(pkg.name, pkg.version, isWorkspace);
    // Duplicate keys are silently merged; this can happen when a
    // workspace member is also referenced by name across versions.
    // The compartment-mapper does not distinguish multiple entries
    // here.
    if (compartments[dirKey] === undefined) {
      compartments[dirKey] = {
        label: `${pkg.name}@${pkg.version}`,
        name: pkg.name,
        location: dirKey,
        modules: harden({}),
        scopes: harden({}),
        parsers: harden({}),
        types: harden({}),
      };
    }
  }

  // Workspace-member resolution may pass through extra `packageJson`
  // payloads the caller wants reflected in the compartment table.
  // This is the seam the daemon-side caller uses to walk additional
  // workspace-member dependency edges.
  if (workspaceMembers !== undefined) {
    for (const [memberName, member] of workspaceMembers) {
      const memberPkg = decodePackageJson(member.packageJson);
      if (compartments[memberName] === undefined) {
        compartments[memberName] = {
          label: memberName,
          name: memberPkg.name || memberName,
          location: memberName,
          modules: harden({}),
          scopes: harden({}),
          parsers: harden({}),
          types: harden({}),
        };
      }
    }
  }

  // Attach the entry compartment's dependency edges. The
  // compartment-mapper consumes this through its compartment-map
  // shape's `compartments[entry].modules` plus the cross-compartment
  // scope table; we record the binding as a typed annotation that
  // the link step reads when it walks the entry's import statements.
  // The descriptor's modules table stays empty until link time, when
  // compartment-mapper.importLocation fills it.
  /** @type {CompartmentMapDescriptor} */
  const descriptor = harden({
    tags: harden([`endo-snapshot-${entryName}-${entryVersion}`]),
    entry: harden({
      compartment: entryLocation,
      module: entryModule,
    }),
    compartments: harden(compartments),
  });

  return descriptor;
};
harden(buildCompartmentMap);

/**
 * Synthesize a `ReadPowers`-shaped object that resolves locations
 * against the registry's CAS trees plus an entry mount.
 *
 * Locations passed to `read` are parsed as the first path segment
 * (a peer-directory key, `<name>@<version>` or `<name>` for workspace
 * members, or `.` for the entry compartment) plus a relative module
 * path. The reader dispatches to the entry source or to the
 * appropriate `EndoReadableTree` capability from `packagesByKey`.
 *
 * This module returns a plain-object adapter; the daemon-side caller
 * may wrap it as a `Far` exo or a captp-marshalable handle before
 * crossing the worker boundary. Keeping the adapter platform-agnostic
 * here lets the same shape underwrite unit tests and the daemon-side
 * integration.
 *
 * @param {{
 *   entrySource: { readBytes(modulePath: string | string[]): Promise<Uint8Array> },
 *   resolution: RegistryResolution,
 *   registry?: { fetch(name: string, version: string): Promise<{ readBytes(modulePath: string | string[]): Promise<Uint8Array> }> },
 * }} options
 */
export const makeMountReadPowers = options => {
  const { entrySource, resolution, registry } = options;
  /** @type {Map<string, { readBytes(modulePath: string | string[]): Promise<Uint8Array> }>} */
  const treeRefs = new Map();
  for (const key of resolution.keys) {
    const entry = resolution.packagesByKey[key];
    treeRefs.set(
      key,
      /** @type {{ readBytes(modulePath: string | string[]): Promise<Uint8Array> }} */ (
        /** @type {unknown} */ (entry.treeRef)
      ),
    );
  }

  /**
   * Parse a location string into a (compartmentKey, modulePath) pair.
   * Format: `<compartmentKey>/<modulePath>` where `<compartmentKey>`
   * is `.` for the entry compartment.
   *
   * @param {string} location
   */
  const parseLocation = location => {
    if (location === '' || location === '.') {
      return { compartmentKey: '.', modulePath: '' };
    }
    // A leading `./<file>` denotes a path in the entry compartment.
    if (location.startsWith('./')) {
      return { compartmentKey: '.', modulePath: location.slice(2) };
    }
    // Scoped peer keys (`@scope/name@version/...`) carry two slashes
    // before the module path begins; locate the split by recognizing
    // the second `/` for scoped packages, otherwise the first.
    if (location.startsWith('@')) {
      const firstSlash = location.indexOf('/');
      if (firstSlash < 0) return { compartmentKey: location, modulePath: '' };
      const secondSlash = location.indexOf('/', firstSlash + 1);
      if (secondSlash < 0) {
        return { compartmentKey: location, modulePath: '' };
      }
      return {
        compartmentKey: location.slice(0, secondSlash),
        modulePath: location.slice(secondSlash + 1),
      };
    }
    const firstSlash = location.indexOf('/');
    if (firstSlash < 0) return { compartmentKey: location, modulePath: '' };
    return {
      compartmentKey: location.slice(0, firstSlash),
      modulePath: location.slice(firstSlash + 1),
    };
  };

  return harden({
    /**
     * Read the bytes at `location` from the appropriate compartment.
     *
     * @param {string} location
     */
    async read(location) {
      await null;
      const { compartmentKey, modulePath } = parseLocation(location);
      if (compartmentKey === '.') {
        return entrySource.readBytes(modulePath);
      }
      let treeRef = treeRefs.get(compartmentKey);
      if (treeRef === undefined && registry !== undefined) {
        // Late-bind via the registry capability the closure also
        // holds. This path is rare: the pre-resolution closure should
        // cover everything the mapper walks, but the closure keeps
        // the read function self-sufficient rather than forcing a
        // re-dispatch into the worker for a single missing package.
        const atIndex = compartmentKey.lastIndexOf('@');
        if (atIndex > 0) {
          const name = compartmentKey.slice(0, atIndex);
          const version = compartmentKey.slice(atIndex + 1);
          treeRef =
            /** @type {{ readBytes(modulePath: string | string[]): Promise<Uint8Array> }} */ (
              /** @type {unknown} */ (await registry.fetch(name, version))
            );
          if (treeRef !== undefined) {
            treeRefs.set(compartmentKey, treeRef);
          }
        }
      }
      if (treeRef === undefined) {
        throw Error(
          `mapSnapshot read: no compartment for ${compartmentKey} (location: ${location})`,
        );
      }
      return treeRef.readBytes(modulePath);
    },
    /**
     * Canonicalize a location. For this archive-shaped layout, the
     * input is already the canonical form.
     *
     * @param {string} location
     */
    async canonical(location) {
      return location;
    },
  });
};
harden(makeMountReadPowers);

/**
 * The top-level `mapSnapshot` entry: takes the resolution plus an
 * entry source descriptor and produces the trio
 * `{ compartmentMap, resolution, readPowers }` the worker's
 * `importLocation` invocation consumes.
 *
 * The daemon-integration consumer calls this between the registry
 * resolve and the `importLocation` call.
 *
 * @param {{
 *   resolution: RegistryResolution,
 *   entrySource: { readBytes(modulePath: string | string[]): Promise<Uint8Array> },
 *   entryPackageJson: string | Uint8Array,
 *   entryModule?: string,
 *   entryCompartmentLabel?: string,
 *   registry?: { fetch(name: string, version: string): Promise<{ readBytes(modulePath: string | string[]): Promise<Uint8Array> }> },
 *   workspaceMembers?: Map<string, { packageJson: string | Uint8Array }>,
 * }} options
 */
export const mapSnapshot = async options => {
  await null;
  const compartmentMap = buildCompartmentMap({
    resolution: options.resolution,
    entryPackageJson: options.entryPackageJson,
    entryCompartmentLabel: options.entryCompartmentLabel,
    entryModule: options.entryModule,
    workspaceMembers: options.workspaceMembers,
  });
  const readPowers = makeMountReadPowers({
    entrySource: options.entrySource,
    resolution: options.resolution,
    registry: options.registry,
  });
  return harden({
    compartmentMap,
    resolution: options.resolution,
    readPowers,
  });
};
harden(mapSnapshot);
