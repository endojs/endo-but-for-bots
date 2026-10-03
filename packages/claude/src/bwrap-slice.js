// @ts-check
//
// The kernel slice around `claudePath` (README.md § The `bwrap` slice). The
// slice root is an empty tmpfs holding only the system directories, the
// granted paths, and fresh `/tmp` and HOME, so the daemon socket has no path
// inside it. The network namespace is shared because `claude` must reach the
// inference API; a host loopback TCP listener stays reachable.
//
// `@endo/sandbox`'s `bwrap` driver is not reused: its argv assembler is not
// exported, and it takes capability-shaped `Mount`s through a slice factory,
// whereas this harness needs a `spawn` that runs host paths in place.

import fs from 'node:fs/promises';
import path from 'node:path';

import { makeError, X, q } from '@endo/errors';

/** @import { SpawnOptions, ChildProcess } from 'node:child_process' */
/** @import { SliceMount } from './claude.types.js' */

/** Host directories bound read-only (or recreated as symlinks) when present. */
export const SYSTEM_DIRECTORIES = harden([
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
]);

/** `/etc` entries for name resolution, TLS roots, users, and `ld.so.cache`. */
export const SYSTEM_ETC_ENTRIES = harden([
  '/etc/alternatives',
  '/etc/ca-certificates',
  '/etc/crypto-policies',
  '/etc/gai.conf',
  '/etc/group',
  '/etc/host.conf',
  '/etc/hosts',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/pki',
  '/etc/resolv.conf',
  '/etc/ssl',
]);

/** The scratch HOME inside the slice; a tmpfs discarded with the slice. */
export const DEFAULT_SCRATCH_HOME = '/home/endo-claude';

/**
 * Treat a missing path as absent; any other failure is not an absence.
 *
 * @param {any} error
 */
const absentIfMissing = error => {
  if (error?.code === 'ENOENT') return undefined;
  throw error;
};

/**
 * Resolve the system mounts present on this host. A top-level symlink such as
 * merged-usr `/bin -> usr/bin` is recreated as a symlink rather than bound.
 *
 * @param {object} [options]
 * @param {Pick<typeof fs, 'lstat' | 'readlink' | 'realpath'>} [options.fileSystem]
 * @returns {Promise<SliceMount[]>}
 */
export const resolveSystemMounts = async ({ fileSystem = fs } = {}) => {
  const directoryMounts = await Promise.all(
    SYSTEM_DIRECTORIES.map(async directory => {
      const stats = await fileSystem.lstat(directory).catch(absentIfMissing);
      if (stats === undefined) return [];
      /** @type {SliceMount} */
      const mount = stats.isSymbolicLink()
        ? {
            kind: 'symlink',
            source: await fileSystem.readlink(directory),
            target: directory,
          }
        : { kind: 'ro-bind', source: directory, target: directory };
      return [mount];
    }),
  );
  const etcMounts = await Promise.all(
    SYSTEM_ETC_ENTRIES.map(async entry => {
      const real = await fileSystem.realpath(entry).catch(absentIfMissing);
      /** @type {SliceMount[]} */
      const mounts =
        real === undefined
          ? []
          : [{ kind: 'ro-bind', source: real, target: entry }];
      return mounts;
    }),
  );
  return harden([...directoryMounts.flat(), ...etcMounts.flat()]);
};
harden(resolveSystemMounts);

/**
 * @param {string} value
 * @param {string} label
 */
const assertAbsolute = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw makeError(X`bwrap slice: ${q(label)} must be absolute: ${q(value)}`);
  }
};

/**
 * @param {string} outer
 * @param {string} inner
 */
const isWithin = (outer, inner) => {
  const relative = path.relative(outer, inner);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/**
 * A later bind shadows an earlier one at or beneath its path, so a writable
 * grant that overlaps a read-only one in either direction would decide which
 * of the two wins by argv order. Refuse any overlap instead.
 *
 * @param {ReadonlyArray<string>} readOnlyPaths
 * @param {ReadonlyArray<string>} writablePaths
 */
const assertDisjointGrants = (readOnlyPaths, writablePaths) => {
  for (const readOnly of readOnlyPaths) {
    for (const writable of writablePaths) {
      if (isWithin(readOnly, writable) || isWithin(writable, readOnly)) {
        throw makeError(
          X`bwrap slice: read-only path ${q(readOnly)} overlaps writable path ${q(writable)}`,
        );
      }
    }
  }
};

/**
 * The `bwrap` argv for one command. Mount order matters: `bwrap` applies
 * mounts in argv order, so the `/tmp` and HOME tmpfs come before the granted
 * binds, which may live beneath either.
 *
 * @param {object} options
 * @param {ReadonlyArray<SliceMount>} options.systemMounts
 * @param {ReadonlyArray<string>} options.readOnlyPaths - host paths bound
 *   read-only at the same path.
 * @param {ReadonlyArray<string>} options.writablePaths - host paths bound
 *   writable at the same path.
 * @param {string} [options.home]
 * @param {string} options.cwd
 * @param {string} options.command
 * @param {ReadonlyArray<string>} options.commandArguments
 * @returns {string[]}
 */
export const assembleBwrapArgv = ({
  systemMounts,
  readOnlyPaths,
  writablePaths,
  home = DEFAULT_SCRATCH_HOME,
  cwd,
  command,
  commandArguments,
}) => {
  for (const [label, value] of [
    ['home', home],
    ['cwd', cwd],
    ['command', command],
    ...readOnlyPaths.map(granted => ['read-only path', granted]),
    ...writablePaths.map(granted => ['writable path', granted]),
  ]) {
    assertAbsolute(value, label);
  }
  assertDisjointGrants(readOnlyPaths, writablePaths);
  /** @type {string[]} */
  // `--disable-userns` stops the confined tree from creating a nested user
  // namespace to regain capabilities; it needs an explicit `--unshare-user`.
  const argv = [
    '--unshare-all',
    '--unshare-user',
    '--disable-userns',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
  ];
  for (const { kind, source, target } of systemMounts) {
    argv.push(`--${kind}`, source, target);
  }
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  argv.push('--tmpfs', home);
  for (const granted of readOnlyPaths) {
    argv.push('--ro-bind', granted, granted);
  }
  for (const granted of writablePaths) {
    argv.push('--bind', granted, granted);
  }
  argv.push(
    '--setenv',
    'HOME',
    home,
    '--chdir',
    cwd,
    '--',
    command,
    ...commandArguments,
  );
  return harden(argv);
};
harden(assembleBwrapArgv);

/**
 * Wrap a `spawn` so every command it runs is run inside the slice. The
 * environment passes through unchanged (it is the constructed allowlist), plus
 * HOME, set inside the slice only.
 *
 * @param {object} options
 * @param {(command: string, commandArguments: readonly string[], options: SpawnOptions) => ChildProcess} options.spawn
 * @param {string} options.bwrapPath - absolute path of `bwrap`.
 * @param {ReadonlyArray<SliceMount>} options.systemMounts
 * @param {ReadonlyArray<string>} options.readOnlyPaths
 * @param {ReadonlyArray<string>} options.writablePaths
 * @param {string} [options.home]
 */
export const makeBwrapSpawn = ({
  spawn,
  bwrapPath,
  systemMounts,
  readOnlyPaths,
  writablePaths,
  home,
}) => {
  assertAbsolute(bwrapPath, 'bwrapPath');
  for (const granted of [...readOnlyPaths, ...writablePaths]) {
    assertAbsolute(granted, 'granted path');
  }
  assertDisjointGrants(readOnlyPaths, writablePaths);
  /**
   * @param {string} command
   * @param {readonly string[]} commandArguments
   * @param {SpawnOptions} spawnOptions
   */
  const slicedSpawn = (command, commandArguments, spawnOptions) => {
    const { cwd } = spawnOptions;
    if (typeof cwd !== 'string') {
      throw makeError(X`bwrap slice: spawn needs an explicit cwd`);
    }
    return spawn(
      bwrapPath,
      assembleBwrapArgv({
        systemMounts,
        readOnlyPaths,
        writablePaths,
        home,
        cwd,
        command,
        commandArguments,
      }),
      spawnOptions,
    );
  };
  return slicedSpawn;
};
harden(makeBwrapSpawn);
