// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';

/** @import { InstallArgvInput, RunArgvInput } from './types.js' */

const MANAGERS = harden(['npm', 'pnpm', 'yarn']);
const LOCKFILE_MODES = harden(['frozen', 'update']);

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} label
 * @returns {asserts value is T}
 */
const assertChoice = (value, allowed, label) => {
  if (!allowed.includes(/** @type {T} */ (value))) {
    throw makeError(X`${label} must be one of ${q(allowed.join(', '))}`);
  }
};

/**
 * @param {string} script
 */
const assertSafeScriptName = script => {
  if (script.length === 0 || script.startsWith('-')) {
    throw makeError(
      X`script name must be non-empty and must not begin with "-"`,
    );
  }
};

/**
 * @param {readonly string[]} args
 */
const assertDenseStringArray = args => {
  if (!Array.isArray(args)) {
    throw makeError(X`args must be an array of strings`);
  }
  for (let index = 0; index < args.length; index += 1) {
    if (typeof args[index] !== 'string') {
      throw makeError(X`args must be a dense array of strings`);
    }
  }
};

/**
 * @param {number | undefined} major
 * @param {number | undefined} minor
 * @returns {{ major: number, minor: number }}
 */
const normalizeYarnVersion = (major, minor) => {
  if (!Number.isInteger(major) || major === undefined || major < 1) {
    throw makeError(
      X`yarnMajorVersion must be supplied as a positive integer for Yarn`,
    );
  }
  if (
    major === 2 &&
    (!Number.isInteger(minor) || minor === undefined || minor < 4)
  ) {
    throw makeError(
      X`safe Yarn 2 installs require yarnMinorVersion 4 or later`,
    );
  }
  return harden({ major, minor: minor ?? 0 });
};

/**
 * Build fixed install argv for the selected manager. Never accepts free-form
 * manager flags; every option maps to a known flag.
 *
 * @param {InstallArgvInput} input
 * @returns {readonly string[]}
 */
export const buildInstallArgv = input => {
  const {
    manager,
    lockfileMode = 'frozen',
    offline = false,
    production = false,
    workspaceSelector,
    yarnMajorVersion,
    yarnMinorVersion,
  } = input;

  assertChoice(manager, MANAGERS, 'manager');
  assertChoice(lockfileMode, LOCKFILE_MODES, 'lockfileMode');
  if (
    workspaceSelector !== undefined &&
    (typeof workspaceSelector !== 'string' || workspaceSelector.length === 0)
  ) {
    throw makeError(X`workspaceSelector must be a non-empty string`);
  }

  /** @type {string[]} */
  const argv = [manager];

  if (manager === 'pnpm' && workspaceSelector !== undefined) {
    argv.push(`--filter=${workspaceSelector}`);
  } else if (manager === 'yarn' && workspaceSelector !== undefined) {
    argv.push('workspace', workspaceSelector);
  }

  if (manager === 'npm') {
    argv.push(lockfileMode === 'frozen' ? 'ci' : 'install');
    argv.push('--ignore-scripts');
    if (offline) {
      argv.push('--offline');
    }
    if (production) {
      argv.push('--omit=dev');
    }
    if (workspaceSelector !== undefined) {
      argv.push(`--workspace=${workspaceSelector}`);
    }
    return harden(argv);
  }

  if (manager === 'pnpm') {
    argv.push('install');
    if (lockfileMode === 'frozen') {
      argv.push('--frozen-lockfile');
    }
    argv.push('--ignore-scripts');
    if (offline) {
      argv.push('--offline');
    }
    if (production) {
      argv.push('--prod');
    }
    return harden(argv);
  }

  // yarn
  const { major: yarnMajor } = normalizeYarnVersion(
    yarnMajorVersion,
    yarnMinorVersion,
  );
  argv.push('install');
  if (lockfileMode === 'frozen') {
    if (yarnMajor <= 1) {
      argv.push('--frozen-lockfile');
    } else {
      argv.push('--immutable');
    }
  }
  if (yarnMajor <= 1) {
    argv.push('--ignore-scripts');
  } else if (yarnMajor === 2) {
    argv.push('--skip-builds');
  } else {
    argv.push('--mode=skip-build');
  }
  if (offline) {
    if (yarnMajor > 1) {
      throw makeError(X`offline installs are not supported by Yarn 2 or later`);
    }
    argv.push('--offline');
  }
  if (production) {
    if (yarnMajor > 1) {
      throw makeError(
        X`production-only installs are not supported by Yarn 2 or later`,
      );
    }
    argv.push('--production');
  }
  return harden(argv);
};
harden(buildInstallArgv);

/**
 * Build fixed named-script run argv. `args` are individual argv elements
 * after `--` where the manager requires it. Never accepts arbitrary
 * package-manager subcommands or a shell string.
 *
 * @param {RunArgvInput} input
 * @returns {readonly string[]}
 */
export const buildRunArgv = input => {
  const { manager, script, args = [], workspaceSelector } = input;
  assertChoice(manager, MANAGERS, 'manager');
  if (typeof script !== 'string') {
    throw makeError(X`script name must be a string`);
  }
  assertSafeScriptName(script);
  if (
    workspaceSelector !== undefined &&
    (typeof workspaceSelector !== 'string' || workspaceSelector.length === 0)
  ) {
    throw makeError(X`workspaceSelector must be a non-empty string`);
  }
  assertDenseStringArray(args);

  /** @type {string[]} */
  const argv = [manager];

  if (manager === 'npm') {
    argv.push('run', script);
    if (workspaceSelector !== undefined) {
      argv.push(`--workspace=${workspaceSelector}`);
    }
    if (args.length > 0) {
      argv.push('--', ...args);
    }
    return harden(argv);
  }

  if (manager === 'pnpm') {
    if (workspaceSelector !== undefined) {
      argv.push(`--filter=${workspaceSelector}`);
    }
    argv.push('run', script);
    if (args.length > 0) {
      argv.push('--', ...args);
    }
    return harden(argv);
  }

  // yarn
  if (workspaceSelector !== undefined) {
    argv.push('workspace', workspaceSelector);
  }
  argv.push('run', script);
  if (args.length > 0) {
    // Yarn passes script args directly; no `--` separator required.
    argv.push(...args);
  }
  return harden(argv);
};
harden(buildRunArgv);
