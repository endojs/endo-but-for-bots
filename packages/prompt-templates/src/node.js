// @ts-check

/**
 * @import {
 *   LoadPromptTemplatesResult,
 *   PromptTemplateSource,
 * } from './types.js'
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import harden from '@endo/harden';

import { loadPromptTemplates } from './load.js';

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
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

/**
 * List the working directory and its ancestors up to the enclosing repository
 * root, nearest first. Outside a repository, or where the home directory comes
 * first, only the working directory counts: an arbitrary ancestor such as
 * `/tmp` is not part of the project.
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
 * Leaf paths, relative to each rung of the conventional directory ladder.
 *
 * @typedef {object} ConventionalLeaves
 * @property {readonly string[]} [home] Under the home directory.
 * @property {readonly string[]} [project] Under each directory from the
 *   repository root down to the working directory.
 * @property {readonly string[]} [cwd] Under the working directory only.
 */

/**
 * Walk the home / repository-root / working-directory ladder that Pi-style
 * harnesses search, and return the candidate directories ordered from lowest
 * to highest precedence: every `home` leaf, then every `project` leaf from
 * the repository root down to the working directory, then every `cwd` leaf.
 * The walk stops at the enclosing repository root and never climbs to or past
 * the home directory, so an arbitrary ancestor such as `/tmp` is not part of
 * the project. This is the one walker shared with `@endo/skills`; a feature
 * differs only in its leaves.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} options.home
 * @param {ConventionalLeaves} options.leaves
 * @returns {Promise<readonly string[]>}
 */
export const listConventionalDirectories = async ({ cwd, home, leaves }) => {
  const { home: homeLeaves = [], project = [], cwd: cwdLeaves = [] } = leaves;
  const projectDirectories = await listProjectDirectories(cwd, home);
  return harden([
    ...homeLeaves.map(leaf => join(home, leaf)),
    ...[...projectDirectories]
      .reverse()
      .flatMap(directory => project.map(leaf => join(directory, leaf))),
    ...cwdLeaves.map(leaf => join(cwd, leaf)),
  ]);
};
harden(listConventionalDirectories);

/** The prompt-template leaves of the conventional ladder. */
export const PROMPT_TEMPLATE_LEAVES = harden({
  home: [join('.pi', 'agent', 'prompts'), join('.agents', 'prompts')],
  project: [join('.agents', 'prompts')],
  cwd: [join('.pi', 'prompts')],
});

/**
 * Name the directories that may hold prompt templates, ordered from lowest to
 * highest precedence: the user's own directories, then `.agents/prompts` from
 * the repository root down to the working directory, then the working
 * directory's `.pi/prompts`.
 *
 * @param {object} options
 * @param {string} options.homeDirectory
 * @param {string} options.workingDirectory
 * @returns {Promise<readonly string[]>}
 */
export const listPromptTemplateDirectories = ({
  homeDirectory,
  workingDirectory,
}) =>
  listConventionalDirectories({
    cwd: workingDirectory,
    home: homeDirectory,
    leaves: PROMPT_TEMPLATE_LEAVES,
  });
harden(listPromptTemplateDirectories);

/**
 * Expose a directory as a template source. A missing directory lists as empty,
 * since most of the conventional directories do not exist on a given machine.
 *
 * @param {string} directory
 * @returns {PromptTemplateSource}
 */
export const makeNodePromptTemplateSource = directory =>
  harden({
    label: directory,
    list: async () => {
      await null;
      try {
        return await readdir(directory);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          return [];
        }
        throw error;
      }
    },
    /** @param {string} entryName */
    readText: entryName => readFile(join(directory, entryName), 'utf-8'),
  });
harden(makeNodePromptTemplateSource);

/**
 * Scan the conventional directories and return the templates they define.
 *
 * @param {object} options
 * @param {string} options.homeDirectory
 * @param {string} options.workingDirectory
 * @returns {Promise<LoadPromptTemplatesResult>}
 */
export const discoverPromptTemplates = async options => {
  const directories = await listPromptTemplateDirectories(options);
  return loadPromptTemplates(directories.map(makeNodePromptTemplateSource));
};
harden(discoverPromptTemplates);
