// @ts-check
/**
 * Provides a per-call cache of `package.json` descriptors keyed by directory
 * URL, indexed for two questions used by the compartment mapper:
 *
 *  1. **Enclosing compartment root.** Given any path under an entry's tree,
 *     return the nearest ancestor directory whose `package.json` defines a
 *     compartment (has a non-empty `name`).
 *     The walk transparently skips past auxiliary descriptors
 *     (`package.json` files without a `name`, which exist solely to scope
 *     language-for-extension rules to a subtree).
 *
 *  2. **Layered language-for-extension overrides.** Given any path under
 *     the entry's tree, return the ordered list of descriptors from the
 *     compartment root down to the file's parent, shallowest first, with
 *     the compartment-defining descriptor as the first element followed by
 *     each auxiliary descriptor on the path.
 *
 * The cache memoizes one read per directory and classifies the descriptor
 * (compartment-defining vs. auxiliary) at insert time so neither lookup
 * needs to re-classify.
 *
 * See `../designs/compartment-mapper-auxiliary-package-json.md` for the design
 * this module implements.
 *
 * @module
 */

/**
 * @import {
 *   AuxiliaryDescriptor,
 *   ClassifiedDescriptor,
 *   CompartmentRootDescriptor,
 *   FileUrlString,
 *   MaybeReadFn,
 *   PackageDescriptor,
 *   PackageDescriptorCache,
 * } from './types.js'
 */

import { parseLocatedJson } from './json.js';

const { freeze } = Object;

const decoder = new TextDecoder();

// q, as in quote, for enquoting strings in error messages.
const { quote: q } = assert;

/**
 * @param {string} rel - a relative URL
 * @param {string|URL} abs - a fully qualified URL
 */
const resolveLocation = (rel, abs) => new URL(rel, abs).toString();

/**
 * @param {MaybeReadFn} maybeRead
 * @returns {PackageDescriptorCache}
 */
export const makePackageDescriptorCache = maybeRead => {
  /**
   * Memo of one read per directory, indexed by directory URL. The value
   * resolves to `undefined` when no `package.json` exists at that exact
   * directory, otherwise the classified descriptor.
   *
   * @type {Map<string, Promise<ClassifiedDescriptor | undefined>>}
   */
  const memo = new Map();

  /**
   * @param {string} directory - directory URL ending with `/`
   * @returns {Promise<ClassifiedDescriptor | undefined>}
   */
  const readClassified = directory => {
    let promise = memo.get(directory);
    if (promise !== undefined) {
      return promise;
    }
    promise = (async () => {
      const descriptorLocation = resolveLocation('package.json', directory);
      const descriptorBytes = await maybeRead(descriptorLocation);
      if (descriptorBytes === undefined) {
        return undefined;
      }
      const descriptorText = decoder.decode(descriptorBytes);
      const descriptor = parseLocatedJson(descriptorText, descriptorLocation);
      if (
        typeof descriptor === 'function' ||
        Object(descriptor) !== descriptor
      ) {
        throw Error(
          `Package descriptor at ${q(descriptorLocation)} must be a plain object`,
        );
      }
      /** @type {PackageDescriptor} */
      const packageDescriptor = /** @type {any} */ (descriptor);
      const { name } = packageDescriptor;
      const isCompartmentDefining = typeof name === 'string' && name !== '';
      return { packageDescriptor, isCompartmentDefining };
    })();
    memo.set(directory, promise);
    return promise;
  };

  /**
   * Walks upward from `directory`, collecting classified descriptors until
   * a compartment-defining ancestor is found. Returns the path in
   * shallowest-first order: `[compartment root, ...auxiliary descriptors]`.
   *
   * Throws the PR 70 diagnostic when the walk reaches the filesystem
   * boundary without finding a named ancestor.
   *
   * @param {string} startingDirectory
   * @returns {Promise<{
   *   compartmentDirectory: string,
   *   compartmentDescriptor: PackageDescriptor,
   *   auxiliaries: Array<AuxiliaryDescriptor>,
   * }>}
   */
  const walkToCompartmentRoot = async startingDirectory => {
    await null;
    /** @type {Array<{location: string, packageDescriptor: PackageDescriptor}>} */
    const auxiliariesDeepFirst = [];
    let directory = startingDirectory;
    let topmostDescriptorLocation = resolveLocation('package.json', directory);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const classified = await readClassified(directory);
      if (classified !== undefined) {
        topmostDescriptorLocation = resolveLocation('package.json', directory);
        if (classified.isCompartmentDefining) {
          // Auxiliaries collected deep-first; reverse to shallow-first.
          /** @type {Array<AuxiliaryDescriptor>} */
          const auxiliaries = auxiliariesDeepFirst
            .slice()
            .reverse()
            .map(entry => {
              const location = /** @type {FileUrlString} */ (entry.location);
              return freeze({
                location,
                packageDescriptor: entry.packageDescriptor,
              });
            });
          return {
            compartmentDirectory: directory,
            compartmentDescriptor: classified.packageDescriptor,
            auxiliaries,
          };
        }
        // Auxiliary: collect and keep walking.
        auxiliariesDeepFirst.push({
          location: directory,
          packageDescriptor: classified.packageDescriptor,
        });
      }
      const parent = resolveLocation('../', directory);
      // Stop at the filesystem root. Also stop at a `node_modules`
      // directory boundary, but only once we have already collected an
      // auxiliary descriptor — i.e. the entry's own package has an unnamed
      // `package.json` and we are looking for the named ancestor that
      // scopes it. In that case the named ancestor must live within the
      // same package subtree, below `node_modules`; a `package.json` above
      // `node_modules` describes a different package (matching Node.js's
      // `LOOKUP_PACKAGE_SCOPE`, which never ascends past `node_modules`),
      // so reaching the boundary means the entry's package is genuinely
      // anonymous and the PR 70 diagnostic must fire.
      //
      // When no descriptor has been encountered yet (the entry sits in a
      // directory with no `package.json` of its own, such as a bare module
      // dropped under `node_modules`), keep climbing past the boundary so
      // behavior matches the existing `searchCompartmentDescriptor`, which
      // adopts the nearest enclosing named package regardless of
      // `node_modules` boundaries.
      const atNodeModulesBoundary =
        parent.endsWith('/node_modules/') && auxiliariesDeepFirst.length > 0;
      if (parent === directory || atNodeModulesBoundary) {
        // Reached a boundary without finding a named ancestor. Surface the
        // PR 70 diagnostic, blaming the topmost `package.json` we
        // encountered (matches the behavior of the existing walk).
        throw Error(
          `package.json at ${q(topmostDescriptorLocation)} must have a "name" field; consider naming it after the parent directory`,
        );
      }
      directory = parent;
    }
  };

  /**
   * @param {string} path
   * @returns {Promise<CompartmentRootDescriptor>}
   */
  const findEnclosingCompartmentRoot = async path => {
    const startingDirectory = resolveLocation('./', path);
    const { compartmentDirectory, compartmentDescriptor, auxiliaries } =
      await walkToCompartmentRoot(startingDirectory);
    return freeze({
      packageLocation: /** @type {FileUrlString} */ (compartmentDirectory),
      packageDescriptor: compartmentDescriptor,
      auxiliaryDescriptors: freeze(auxiliaries),
    });
  };

  /**
   * @param {string} path
   * @returns {Promise<ReadonlyArray<PackageDescriptor>>}
   */
  const collectLanguageOverrides = async path => {
    const startingDirectory = resolveLocation('./', path);
    const { compartmentDescriptor, auxiliaries } =
      await walkToCompartmentRoot(startingDirectory);
    const layered = [
      compartmentDescriptor,
      ...auxiliaries.map(({ packageDescriptor }) => packageDescriptor),
    ];
    return freeze(layered);
  };

  /**
   * Memoized single-directory read exposed so callers can share the
   * memoization for their own walks.
   *
   * @param {string} packageLocation
   * @returns {Promise<PackageDescriptor | undefined>}
   */
  const readDescriptor = async packageLocation => {
    const classified = await readClassified(packageLocation);
    if (classified === undefined) {
      return undefined;
    }
    return classified.packageDescriptor;
  };

  return freeze({
    findEnclosingCompartmentRoot,
    collectLanguageOverrides,
    readDescriptor,
  });
};
