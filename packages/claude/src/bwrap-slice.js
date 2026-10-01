// @ts-check
//
// The kernel slice around `claudePath` (README.md § The `bwrap` slice). The
// slice root is an empty tmpfs holding only the system directories, the
// granted paths, and fresh `/tmp` and HOME, so the daemon socket has no path
// inside it. The network namespace is shared because `claude` must reach the
// inference API; a host loopback TCP listener stays reachable.

import fs from 'node:fs/promises';
import path from 'node:path';

import { makeError, X, q } from '@endo/errors';

/** @import { SpawnOptions, ChildProcess } from 'node:child_process' */

/**
 * @typedef {object} SliceMount
 * @property {'ro-bind' | 'bind' | 'symlink'} kind
 * @property {string} source - the host path, or the link text of a symlink.
 * @property {string} target - the path inside the slice.
 */

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

/**
 * `/etc` entries `claude`, `node`, and `/bin/sh` read: name resolution, TLS
 * roots, the user database, and the dynamic linker's cache. A symlinked entry
 * (`/etc/resolv.conf` into `/run/systemd/resolve`) is bound from its target, so
 * `/run` itself stays unbound.
 */
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
      const stats = await fileSystem.lstat(directory).catch(() => undefined);
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
      const real = await fileSystem.realpath(entry).catch(() => undefined);
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
  /** @type {string[]} */
  const argv = [
    '--unshare-all',
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
  return argv;
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
