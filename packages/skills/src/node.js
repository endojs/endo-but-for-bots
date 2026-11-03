// @ts-check

/** @import { LoadSkillsResult, SkillSource } from './types.js' */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import harden from '@endo/harden';

import { loadSkills } from './load.js';

/** @param {unknown} error */
const isMissing = error => {
  const { code } = /** @type {NodeJS.ErrnoException} */ (error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
const pathExists = async path => {
  await null;
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * List the working directory and its ancestors up to the enclosing repository
 * root, nearest first. Outside a repository, or where the home directory comes
 * first, only the working directory counts.
 *
 * @param {string} workingDirectory
 * @param {string} homeDirectory
 * @returns {Promise<readonly string[]>}
 */
const listProjectDirectories = async (workingDirectory, homeDirectory) => {
  /** @type {string[]} */
  const directories = [];
  let directory = workingDirectory;
  while (directory !== homeDirectory) {
    directories.push(directory);
    // eslint-disable-next-line no-await-in-loop
    if (await pathExists(join(directory, '.git'))) {
      return directories;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return workingDirectory === homeDirectory ? [] : [workingDirectory];
};

/**
 * Name the directories that may hold skills, ordered from lowest to highest
 * precedence. With `crossHarness` (the default), Claude Code's and Codex's
 * skill directories come first, so a skill written for those harnesses loads
 * unless an Endo or Pi directory defines the same name. Then come the user's
 * `~/.pi/agent/skills` and `~/.agents/skills`, then `.agents/skills` from the
 * repository root down to the working directory, then the working directory's
 * `.claude/skills` (cross-harness) and `.pi/skills`.
 *
 * @param {object} options
 * @param {string} options.homeDirectory
 * @param {string} options.workingDirectory
 * @param {boolean} [options.crossHarness]
 * @returns {Promise<readonly string[]>}
 */
export const listSkillDirectories = async ({
  homeDirectory,
  workingDirectory,
  crossHarness = true,
}) => {
  const projectDirectories = await listProjectDirectories(
    workingDirectory,
    homeDirectory,
  );
  return harden([
    ...(crossHarness
      ? [
          join(homeDirectory, '.claude', 'skills'),
          join(homeDirectory, '.codex', 'skills'),
        ]
      : []),
    join(homeDirectory, '.pi', 'agent', 'skills'),
    join(homeDirectory, '.agents', 'skills'),
    ...projectDirectories
      .map(directory => join(directory, '.agents', 'skills'))
      .reverse(),
    ...(crossHarness ? [join(workingDirectory, '.claude', 'skills')] : []),
    join(workingDirectory, '.pi', 'skills'),
  ]);
};
harden(listSkillDirectories);

/**
 * Expose a directory of skill directories as a skill source. A missing
 * directory lists as empty, and an entry without a `SKILL.md` is skipped.
 *
 * @param {string} directory
 * @returns {SkillSource}
 */
export const makeNodeSkillSource = directory =>
  harden({
    label: directory,
    list: async () => {
      await null;
      try {
        return await readdir(directory);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }
    },
    /** @param {string} entryName */
    readSkillText: async entryName => {
      await null;
      try {
        return await readFile(join(directory, entryName, 'SKILL.md'), 'utf-8');
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },
    /** @param {string} entryName */
    locate: entryName =>
      harden({
        filePath: join(directory, entryName, 'SKILL.md'),
        baseDir: join(directory, entryName),
      }),
  });
harden(makeNodeSkillSource);

/**
 * Scan the conventional directories and return the skills they define.
 *
 * @param {object} options
 * @param {string} options.homeDirectory
 * @param {string} options.workingDirectory
 * @param {boolean} [options.crossHarness]
 * @returns {Promise<LoadSkillsResult>}
 */
export const discoverSkills = async options => {
  const directories = await listSkillDirectories(options);
  return loadSkills(directories.map(makeNodeSkillSource));
};
harden(discoverSkills);
