// @ts-check

import fs from 'fs/promises';
import path from 'path';

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';

import {
  installableKinds,
  pendingKinds,
  readPackageManifest,
} from './manifest.js';

/** @import { PackageManifest, PackageRecord, PackageSource } from './types.js' */

const resourceNamePatterns = harden({
  skills: /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  prompts: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/,
});

/**
 * @param {string} location
 * @returns {Promise<boolean>}
 */
const isPresent = async location =>
  fs.lstat(location).then(
    () => true,
    error => {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    },
  );

/**
 * A package is an untrusted tree. A symbolic link could carry a file from
 * outside the package into a directory other harnesses read, and a device or
 * pipe has no place in a skill, so only files and directories are admitted.
 *
 * @param {string} directory
 */
const assertOrdinaryTree = async directory => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await assertOrdinaryTree(location);
    } else if (!entry.isFile()) {
      throw Fail`Package file ${q(location)} is not a regular file or directory`;
    }
  }
};

/**
 * @param {string} packageRoot
 * @param {string} kind
 * @param {string} entry
 * @returns {Promise<string>}
 */
const openResourceDirectory = async (packageRoot, kind, entry) => {
  const key = `endo.${kind}`;
  const directory = path.join(packageRoot, entry);
  const status = await fs.lstat(directory).catch(() => undefined);
  if (status === undefined) {
    throw Fail`The ${q(key)} directory ${q(entry)} does not exist in the package`;
  }
  status.isDirectory() ||
    Fail`The ${q(key)} entry ${q(entry)} is not a directory`;
  // The lexical check on the manifest cannot see a link in a parent segment.
  const realRoot = await fs.realpath(packageRoot);
  const realDirectory = await fs.realpath(directory);
  realDirectory === realRoot ||
    realDirectory.startsWith(`${realRoot}${path.sep}`) ||
    Fail`The ${q(key)} entry ${q(entry)} escapes the package`;
  return directory;
};

/**
 * @param {string} packageRoot
 * @param {PackageManifest} manifest
 * @returns {Promise<{
 *   resources: Record<string, Map<string, string>>,
 *   warnings: string[],
 * }>} The source location of each installable resource by kind and name.
 */
const collectResources = async (packageRoot, { directories }) => {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, string>} */
  const skills = new Map();
  /** @type {Map<string, string>} */
  const prompts = new Map();

  /**
   * @param {Map<string, string>} found
   * @param {'skills' | 'prompts'} kind
   * @param {string} name
   * @param {string} location
   */
  const admit = (found, kind, name, location) => {
    resourceNamePatterns[kind].test(name) ||
      Fail`Package ${q(kind)} entry ${q(name)} has an invalid name`;
    !found.has(name) || Fail`Package declares ${q(name)} in ${q(kind)} twice`;
    found.set(name, location);
  };

  for (const entry of directories.skills) {
    // eslint-disable-next-line no-await-in-loop
    const directory = await openResourceDirectory(packageRoot, 'skills', entry);
    // eslint-disable-next-line no-await-in-loop
    await assertOrdinaryTree(directory);
    // eslint-disable-next-line no-await-in-loop
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, child.name);
      if (child.isDirectory() && !child.name.startsWith('.')) {
        const skillFile = path.join(location, 'SKILL.md');
        // eslint-disable-next-line no-await-in-loop
        const skillStatus = await fs.lstat(skillFile).catch(() => undefined);
        if (skillStatus !== undefined && skillStatus.isFile()) {
          admit(skills, 'skills', child.name, location);
        } else {
          warnings.push(`Skipped ${entry}/${child.name}: it has no SKILL.md`);
        }
      }
    }
  }

  for (const entry of directories.prompts) {
    // eslint-disable-next-line no-await-in-loop
    const directory = await openResourceDirectory(
      packageRoot,
      'prompts',
      entry,
    );
    // eslint-disable-next-line no-await-in-loop
    await assertOrdinaryTree(directory);
    // eslint-disable-next-line no-await-in-loop
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.md')) {
        admit(prompts, 'prompts', child.name, path.join(directory, child.name));
      }
    }
  }
  return { resources: { skills, prompts }, warnings };
};

/**
 * Makes the installed-package ledger and resource directories of one scope:
 * a home directory for user-wide installs, a project directory otherwise.
 *
 * @param {string} root
 */
export const makePackageStore = root => {
  const agentsDirectory = path.join(root, '.agents');
  const stateDirectory = path.join(agentsDirectory, 'endo-packages');
  const recordsPath = path.join(stateDirectory, 'packages.json');

  /**
   * @param {string} kind
   * @param {string} name
   * @param {boolean} enabled
   */
  const resourcePath = (kind, name, enabled) =>
    enabled
      ? path.join(agentsDirectory, kind, name)
      : path.join(stateDirectory, 'disabled', kind, name);

  /** @returns {Promise<PackageRecord[]>} */
  const readRecords = async () => {
    const text = await fs.readFile(recordsPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (text === undefined) {
      return [];
    }
    const { packages } = /** @type {{ packages: PackageRecord[] }} */ (
      JSON.parse(text)
    );
    // Removal trusts these names as paths, so they are held to the same rule
    // as at install however the file came to say what it says.
    for (const { id, resources } of packages) {
      for (const kind of installableKinds) {
        for (const name of resources[kind]) {
          resourceNamePatterns[kind].test(name) ||
            Fail`The ${q(kind)} entry ${q(name)} of ${q(id)} in ${q(recordsPath)} has an invalid name`;
        }
      }
    }
    return packages;
  };

  /** @param {PackageRecord[]} packages */
  const writeRecords = async packages => {
    await fs.mkdir(stateDirectory, { recursive: true });
    const stagedPath = `${recordsPath}.staged`;
    await fs.writeFile(
      stagedPath,
      `${JSON.stringify({ version: 1, packages }, null, 2)}\n`,
    );
    await fs.rename(stagedPath, recordsPath);
  };

  /**
   * Runs a sequence of moves ending in a ledger write, undoing every move if
   * any step fails, so a failed install leaves the prior one in place.
   *
   * @param {(
   *   move: (from: string, to: string) => Promise<void>,
   *   stagingDirectory: string,
   * ) => Promise<void>} body
   */
  const transact = async body => {
    await fs.mkdir(stateDirectory, { recursive: true });
    const stagingDirectory = await fs.mkdtemp(
      path.join(stateDirectory, 'staging-'),
    );
    /** @type {Array<[string, string]>} */
    const moves = [];
    /**
     * @param {string} from
     * @param {string} to
     */
    const move = async (from, to) => {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      moves.push([from, to]);
    };
    try {
      await body(move, stagingDirectory);
    } catch (error) {
      for (const [from, to] of moves.reverse()) {
        // eslint-disable-next-line no-await-in-loop
        await fs.rename(to, from);
      }
      throw error;
    } finally {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
    }
  };

  /**
   * Moves an install's present resources out of the way. A resource the user
   * has already deleted is not an error.
   *
   * @param {PackageRecord} record
   * @param {(from: string, to: string) => Promise<void>} move
   * @param {string} stagingDirectory
   */
  const retireResources = async (record, move, stagingDirectory) => {
    for (const kind of installableKinds) {
      for (const name of record.resources[kind]) {
        const location = resourcePath(kind, name, record.enabled);
        // eslint-disable-next-line no-await-in-loop
        if (await isPresent(location)) {
          // eslint-disable-next-line no-await-in-loop
          await move(location, path.join(stagingDirectory, 'old', kind, name));
        }
      }
    }
  };

  /**
   * Installs or replaces the package at `packageRoot`. Everything is checked
   * and copied aside first, so a refused package changes nothing.
   *
   * @param {PackageSource} source
   * @param {string} packageRoot
   * @returns {Promise<{ record: PackageRecord, warnings: string[] }>}
   */
  const install = async (source, packageRoot) => {
    const manifest = await readPackageManifest(packageRoot);
    const { resources, warnings } = await collectResources(
      packageRoot,
      manifest,
    );
    /** @type {Record<string, string[]>} */
    const pending = {};
    for (const kind of pendingKinds) {
      pending[kind] = manifest.directories[kind];
    }

    const installedCount = installableKinds.reduce(
      (count, kind) => count + resources[kind].size,
      0,
    );
    installedCount > 0 ||
      Fail`The package ${q(manifest.name)} has no skills or prompts to install`;

    const records = await readRecords();
    const prior = records.find(({ id }) => id === source.id);
    const enabled = prior === undefined ? true : prior.enabled;
    for (const kind of installableKinds) {
      for (const name of resources[kind].keys()) {
        const owner = records.find(
          record => record !== prior && record.resources[kind].includes(name),
        );
        owner === undefined ||
          Fail`The ${q(kind)} entry ${q(name)} already belongs to ${q(owner.id)}`;
        const isOwnedByPrior =
          prior !== undefined && prior.resources[kind].includes(name);
        if (!isOwnedByPrior) {
          // eslint-disable-next-line no-await-in-loop
          (await isPresent(resourcePath(kind, name, true))) === false ||
            Fail`Refusing to overwrite ${q(resourcePath(kind, name, true))}, which no package installed`;
        }
      }
    }

    /** @type {PackageRecord} */
    const record = {
      id: source.id,
      source: source.text,
      pinned: source.pinned,
      enabled,
      name: manifest.name,
      version: manifest.version,
      resources: Object.fromEntries(
        installableKinds.map(kind => [
          kind,
          [...resources[kind].keys()].sort(),
        ]),
      ),
      pending,
    };

    await transact(async (move, stagingDirectory) => {
      for (const kind of installableKinds) {
        for (const [name, location] of resources[kind]) {
          // eslint-disable-next-line no-await-in-loop
          await fs.cp(
            location,
            path.join(stagingDirectory, 'new', kind, name),
            {
              recursive: true,
            },
          );
        }
      }
      if (prior !== undefined) {
        await retireResources(prior, move, stagingDirectory);
      }
      for (const kind of installableKinds) {
        for (const name of resources[kind].keys()) {
          // eslint-disable-next-line no-await-in-loop
          await move(
            path.join(stagingDirectory, 'new', kind, name),
            resourcePath(kind, name, enabled),
          );
        }
      }
      await writeRecords([
        ...records.filter(candidate => candidate !== prior),
        record,
      ]);
    });
    return harden({ record, warnings });
  };

  /** @param {string} id */
  const remove = async id => {
    const records = await readRecords();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) {
      throw Fail`No package ${q(id)} is installed`;
    }
    await transact(async (move, stagingDirectory) => {
      await retireResources(record, move, stagingDirectory);
      await writeRecords(records.filter(candidate => candidate !== record));
    });
  };

  /**
   * Disabling moves resources out of the discovery paths, because a discovery
   * walker reads those paths and knows nothing of this ledger.
   *
   * @param {string} id
   * @param {boolean} enabled
   */
  const setEnabled = async (id, enabled) => {
    const records = await readRecords();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) {
      throw Fail`No package ${q(id)} is installed`;
    }
    if (record.enabled === enabled) {
      return;
    }
    await transact(async move => {
      for (const kind of installableKinds) {
        for (const name of record.resources[kind]) {
          const from = resourcePath(kind, name, record.enabled);
          const to = resourcePath(kind, name, enabled);
          // eslint-disable-next-line no-await-in-loop
          (await isPresent(to)) === false ||
            Fail`Refusing to overwrite ${q(to)}, which no package installed`;
          // eslint-disable-next-line no-await-in-loop
          if (await isPresent(from)) {
            // eslint-disable-next-line no-await-in-loop
            await move(from, to);
          }
        }
      }
      await writeRecords(
        records.map(candidate =>
          candidate === record ? { ...candidate, enabled } : candidate,
        ),
      );
    });
  };

  return harden({ install, remove, setEnabled, list: readRecords });
};
harden(makePackageStore);
