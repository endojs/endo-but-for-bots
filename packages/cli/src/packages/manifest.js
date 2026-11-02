// @ts-check

import fs from 'fs/promises';
import path from 'path';

import harden from '@endo/harden';
import { Fail, q } from '@endo/errors';

/** @import { Stats } from 'fs' */
/** @import { PackageManifest, PackageSource } from './types.js' */

const sourcePrefixPattern = /^(?:npm|git|file):/;
const npmSourcePattern =
  /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([A-Za-z0-9][A-Za-z0-9.+_-]*))?$/;
const gitSourcePattern =
  /^([A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+)(?:@([A-Za-z0-9][A-Za-z0-9._/-]*))?$/;
const exactVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+/;

/**
 * Whether a command-line argument names a package rather than a pet name.
 *
 * @param {string} text
 * @returns {boolean}
 */
export const isPackageSource = text => sourcePrefixPattern.test(text);
harden(isPackageSource);

/**
 * The patterns admit only ordinary registry names, host paths, and references,
 * so no source reaches `npm` or `git` as an option or as a transport URL.
 *
 * @param {string} text
 * @param {string} workingDirectory
 * @returns {PackageSource}
 */
export const parsePackageSource = (text, workingDirectory) => {
  if (text.startsWith('npm:')) {
    const match = npmSourcePattern.exec(text.slice('npm:'.length));
    if (match === null) {
      throw Fail`Invalid npm package source ${q(text)}`;
    }
    const [, name, version] = match;
    const specifier = version === undefined ? name : `${name}@${version}`;
    return harden({
      kind: 'npm',
      id: `npm:${name}`,
      text: `npm:${specifier}`,
      pinned: version !== undefined && exactVersionPattern.test(version),
      specifier,
    });
  }
  if (text.startsWith('git:')) {
    const match = gitSourcePattern.exec(text.slice('git:'.length));
    if (match === null) {
      throw Fail`Invalid git package source ${q(text)}`;
    }
    const [, location, reference] = match;
    return harden({
      kind: 'git',
      id: `git:${location}`,
      text:
        reference === undefined
          ? `git:${location}`
          : `git:${location}@${reference}`,
      pinned: reference !== undefined,
      url: `https://${location}`,
      ...(reference === undefined ? {} : { reference }),
    });
  }
  const localPath = text.startsWith('file:')
    ? text.slice('file:'.length)
    : text;
  const isLocalPath =
    text.startsWith('file:') ||
    localPath.startsWith('./') ||
    localPath.startsWith('../') ||
    path.isAbsolute(localPath);
  if (!isLocalPath || localPath === '') {
    throw Fail`Unrecognized package source ${q(text)}; expected npm:, git:, file:, or a path beginning with ./, ../, or /`;
  }
  const directory = path.resolve(workingDirectory, localPath);
  const id = `file:${directory}`;
  return harden({ kind: 'file', id, text: id, pinned: false, directory });
};
harden(parsePackageSource);

/** Resource kinds this installer can place today. */
export const installableKinds = harden(['skills', 'prompts']);
/** Resource kinds the design names whose destinations do not exist yet. */
export const pendingKinds = harden(['guests', 'providers']);
const resourceKinds = harden([...installableKinds, ...pendingKinds]);

/**
 * @param {string} packageRoot
 * @param {string} kind
 * @param {string} entry
 */
const assertContainedEntry = (packageRoot, kind, entry) => {
  typeof entry === 'string' ||
    Fail`The ${q(`endo.${kind}`)} manifest entries must be strings, got ${q(entry)}`;
  const relative = path.relative(packageRoot, path.resolve(packageRoot, entry));
  const escapes =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(entry) ||
    path.isAbsolute(relative);
  !escapes ||
    Fail`The ${q(`endo.${kind}`)} manifest entry ${q(entry)} escapes the package`;
};

/**
 * @param {string} location
 * @returns {Promise<Stats | undefined>}
 */
const linkStatusIfPresent = async location =>
  fs.lstat(location).catch(error => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });

/**
 * Reads the `endo` key of a package's `package.json`.
 * Without that key, every conventionally named directory that exists is a
 * resource directory. Unknown keys are ignored, so a newer manifest still
 * installs under an older reader.
 *
 * @param {string} packageRoot
 * @returns {Promise<PackageManifest>}
 */
export const readPackageManifest = async packageRoot => {
  const descriptorPath = path.join(packageRoot, 'package.json');
  const descriptorText = await fs.readFile(descriptorPath, 'utf8').catch(() => {
    throw Fail`No readable package.json at ${q(descriptorPath)}`;
  });
  let descriptor;
  try {
    descriptor = JSON.parse(descriptorText);
  } catch (error) {
    throw Fail`Invalid JSON in ${q(descriptorPath)}: ${q(/** @type {Error} */ (error).message)}`;
  }
  const { name, version, endo } = descriptor;
  typeof name === 'string' ||
    Fail`The package at ${q(packageRoot)} has no name in its package.json`;

  /** @type {Record<string, string[]>} */
  const directories = {};
  if (endo === undefined) {
    for (const kind of resourceKinds) {
      // eslint-disable-next-line no-await-in-loop
      const status = await linkStatusIfPresent(path.join(packageRoot, kind));
      directories[kind] = status === undefined ? [] : [`./${kind}`];
    }
  } else {
    (typeof endo === 'object' && endo !== null && !Array.isArray(endo)) ||
      Fail`The endo key of ${q(descriptorPath)} must be an object`;
    for (const kind of resourceKinds) {
      const entries = endo[kind] === undefined ? [] : endo[kind];
      Array.isArray(entries) ||
        Fail`The ${q(`endo.${kind}`)} key of ${q(descriptorPath)} must be an array`;
      for (const entry of entries) {
        assertContainedEntry(packageRoot, kind, entry);
      }
      directories[kind] = entries;
    }
  }
  return harden({
    name,
    version: typeof version === 'string' ? version : undefined,
    directories,
  });
};
harden(readPackageManifest);
