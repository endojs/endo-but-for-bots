// @ts-check
/* eslint-disable no-continue, no-await-in-loop */

/**
 * Eager MVS resolution over a package-registry directory tree.
 *
 * This function is deliberately ordinary same-vat JavaScript. It contains no
 * eventual-send import and invokes tree methods directly, so Node runs it in
 * the daemon manager beside `@registry` and Endor runs it inside the one XS
 * engine beside the Endor adapter. Only the resulting RegistryResolution needs
 * to cross a worker boundary.
 *
 * @import { EndoReadableTree, RegistryDirectory, RegistryHub, RegistryResolution, RegistryResolutionEntry, ResolveOptions } from '../types.js'
 */

import { makeError, X } from '@endo/errors';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { RegistryNotFoundError } from './errors.js';
import { parseRangeMajor, satisfiesRange } from './mvs-resolver.js';
import { comparePublishedVersions } from './registry-tree.js';

/** @param {string | Uint8Array} source */
const parsePackageJson = source => {
  const text = typeof source === 'string' ? source : decodeUtf8(source);
  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch (cause) {
    throw makeError(X`entry package.json is not valid JSON`, undefined, {
      cause: /** @type {Error} */ (cause),
    });
  }
  if (packageJson === null || typeof packageJson !== 'object') {
    throw makeError(X`entry package.json must contain an object`);
  }
  return packageJson;
};
harden(parsePackageJson);

/**
 * @param {readonly string[]} versions
 * @param {string} range
 */
const greatestSatisfying = (versions, range) => {
  const candidates = versions
    .filter(version => satisfiesRange(version, range))
    .sort(comparePublishedVersions);
  return candidates[candidates.length - 1];
};
harden(greatestSatisfying);

/** @param {EndoReadableTree} tree */
const readPackageJson = async tree => {
  const packageJsonBlob = await tree.lookup('package.json');
  if (
    packageJsonBlob === null ||
    typeof packageJsonBlob !== 'object' ||
    typeof (/** @type {any} */ (packageJsonBlob).text) !== 'function'
  ) {
    throw RegistryNotFoundError('selected package/package.json');
  }
  const text = await /** @type {{ text(): Promise<string> }} */ (
    packageJsonBlob
  ).text();
  return { text, packageJson: parsePackageJson(text) };
};
harden(readPackageJson);

/**
 * @param {RegistryDirectory} root
 * @param {string} name
 */
const lookupPackageDirectory = async (root, name) => {
  const npm = /** @type {RegistryHub} */ (await root.lookup('npm'));
  const directory = await npm.lookup(name);
  return /** @type {RegistryDirectory} */ (directory);
};
harden(lookupPackageDirectory);

/** @param {Uint8Array} bytes */
const fallbackHash = async bytes => {
  const modulus = 2n ** 256n;
  let accumulator = 0n;
  for (const byte of bytes) {
    accumulator = (accumulator * 257n + BigInt(byte)) % modulus;
  }
  return `nohash-${accumulator.toString(16).padStart(64, '0')}`;
};
harden(fallbackHash);

/**
 * @param {string | Uint8Array | Record<string, unknown>} entryPackageJson
 * @param {RegistryDirectory} registryRoot
 * @param {ResolveOptions} [options]
 * @returns {Promise<RegistryResolution>}
 */
export const resolveRegistryTree = async (
  entryPackageJson,
  registryRoot,
  options = {},
) => {
  const entry =
    typeof entryPackageJson === 'object' &&
    !(entryPackageJson instanceof Uint8Array)
      ? entryPackageJson
      : parsePackageJson(entryPackageJson);
  const workspaceLookup = options.workspaceLookup;

  /** @type {Array<{ name: string, range: string, source: string, importer: string }>} */
  const frontier = [];
  /** @type {Array<{ importer: string, name: string, range: string }>} */
  const peerRequirements = [];
  /** @type {Array<{ importer: string, name: string, range: string, reason: string }>} */
  const unmetOptionals = [];
  /** @type {Array<{ importer: string, name: string, range: string, version: string }>} */
  const workspaceMismatches = [];

  /**
   * @param {Record<string, unknown>} packageJson
   * @param {string} importer
   */
  const enqueueDependencies = (packageJson, importer) => {
    for (const source of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const dependencies = /** @type {Record<string, string> | undefined} */ (
        packageJson[source]
      );
      if (dependencies === undefined) continue;
      for (const [name, range] of Object.entries(dependencies)) {
        frontier.push({ name, range, source, importer });
      }
    }
  };

  enqueueDependencies(
    /** @type {Record<string, unknown>} */ (entry),
    typeof entry.name === 'string' ? entry.name : '<entry>',
  );

  /** @type {Map<string, Map<string, RegistryResolutionEntry & { isWorkspace?: boolean }>>} */
  const selections = new Map();

  while (frontier.length > 0) {
    const edge = /** @type {NonNullable<typeof frontier[0]>} */ (
      frontier.shift()
    );
    const { importer, name, range, source } = edge;
    const isWorkspaceSpecifier = range.startsWith('workspace:');

    if (workspaceLookup !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      const workspace = await workspaceLookup(name);
      if (workspace !== undefined) {
        const workspacePackageJson = parsePackageJson(workspace.packageJson);
        const workspaceVersion =
          typeof workspacePackageJson.version === 'string'
            ? workspacePackageJson.version
            : '0.0.0';
        let slots = selections.get(name);
        if (slots === undefined) {
          slots = new Map();
          selections.set(name, slots);
        }
        if (!slots.has('workspace')) {
          slots.set('workspace', {
            name,
            version: workspaceVersion,
            treeRef: workspace.treeRef,
            integrity: 'workspace:',
            packageJson:
              typeof workspace.packageJson === 'string'
                ? workspace.packageJson
                : decodeUtf8(workspace.packageJson),
            isWorkspace: true,
          });
          enqueueDependencies(workspacePackageJson, name);
        }
        if (!isWorkspaceSpecifier && !satisfiesRange(workspaceVersion, range)) {
          workspaceMismatches.push({
            importer,
            name,
            range,
            version: workspaceVersion,
          });
        }
        if (source === 'peerDependencies') {
          peerRequirements.push({ importer, name, range });
        }
        continue;
      }
    }

    if (isWorkspaceSpecifier) {
      throw RegistryNotFoundError(`workspace package ${name}`);
    }

    let packageDirectory;
    let versions;
    try {
      // All calls are same-vat direct dispatch. Do not replace these with E().
      // eslint-disable-next-line no-await-in-loop
      packageDirectory = await lookupPackageDirectory(registryRoot, name);
      // eslint-disable-next-line no-await-in-loop
      versions = await packageDirectory.list();
    } catch (error) {
      if (source === 'optionalDependencies') {
        unmetOptionals.push({
          importer,
          name,
          range,
          reason: /** @type {Error} */ (error).message,
        });
        continue;
      }
      if (source === 'peerDependencies') {
        peerRequirements.push({ importer, name, range });
        continue;
      }
      throw error;
    }

    const selectedVersion = greatestSatisfying(versions, range);
    if (selectedVersion === undefined) {
      if (source === 'optionalDependencies') {
        unmetOptionals.push({
          importer,
          name,
          range,
          reason: `no published version satisfies ${range}`,
        });
        continue;
      }
      throw RegistryNotFoundError(`${name}@${range}`);
    }

    const majorSlot = parseRangeMajor(range);
    let slots = selections.get(name);
    if (slots === undefined) {
      slots = new Map();
      selections.set(name, slots);
    }
    const previous = slots.get(majorSlot);
    if (
      previous !== undefined &&
      comparePublishedVersions(previous.version, selectedVersion) >= 0
    ) {
      if (source === 'peerDependencies') {
        peerRequirements.push({ importer, name, range });
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const tree = /** @type {EndoReadableTree} */ (
      await packageDirectory.lookup(selectedVersion)
    );
    // eslint-disable-next-line no-await-in-loop
    const { text, packageJson } = await readPackageJson(tree);
    const info =
      typeof tree.getInfo === 'function'
        ? // eslint-disable-next-line no-await-in-loop
          await tree.getInfo()
        : {};
    const integrity =
      typeof (/** @type {any} */ (info).integrity) === 'string'
        ? /** @type {any} */ (info).integrity
        : '';
    slots.set(majorSlot, {
      name,
      version: selectedVersion,
      treeRef: tree,
      integrity,
      packageJson: text,
    });
    enqueueDependencies(packageJson, name);
    if (source === 'peerDependencies') {
      peerRequirements.push({ importer, name, range });
    }
  }

  for (const peer of peerRequirements) {
    const slots = selections.get(peer.name);
    const satisfied =
      slots !== undefined &&
      [...slots.values()].some(selection =>
        satisfiesRange(selection.version, peer.range),
      );
    if (!satisfied) {
      throw RegistryNotFoundError(
        `${peer.importer} peer ${peer.name}@${peer.range}`,
      );
    }
  }

  /** @type {Record<string, RegistryResolutionEntry>} */
  const packagesByKey = {};
  for (const [name, slots] of selections) {
    for (const selection of slots.values()) {
      const key = selection.isWorkspace ? name : `${name}@${selection.version}`;
      packagesByKey[key] = harden({
        name,
        version: selection.version,
        treeRef: selection.treeRef,
        integrity: selection.integrity,
        ...(selection.packageJson === undefined
          ? {}
          : { packageJson: selection.packageJson }),
      });
    }
  }
  const keys = harden(Object.keys(packagesByKey).sort());
  const hashPreimage = keys
    .map(key => `${key}\t${packagesByKey[key].integrity}`)
    .join('\n');
  const resolutionHash = await (options.sha256 ?? fallbackHash)(
    encodeUtf8(hashPreimage),
  );

  return harden({
    packagesByKey: harden(packagesByKey),
    keys,
    resolutionHash,
    unmetOptionals: harden(unmetOptionals),
    workspaceMismatches: harden(workspaceMismatches),
  });
};
harden(resolveRegistryTree);
