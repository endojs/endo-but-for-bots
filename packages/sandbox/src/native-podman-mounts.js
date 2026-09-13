// @ts-check

import { Fail, q } from '@endo/errors';
import { M, mustMatch } from '@endo/patterns';

import { readMountTable } from './observe.js';

/** @import { ProcReader } from './observe.js' */

/**
 * A driver-owned declaration. `generated` means the driver's literal-file
 * staging mechanism, never a caller-provided native source or claimed label.
 * This record conveys no host source authority.
 * @typedef {Readonly<{innerPath: string, mode: 'ro' | 'rw', kind: 'bind' | 'generated'}>} NativePodmanMount
 */

const MountShape = harden({
  innerPath: M.string(),
  mode: M.or('ro', 'rw'),
  kind: M.or('bind', 'generated'),
});

const protectedRoots = harden([
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
]);

/**
 * @param {string} parent
 * @param {string} child
 */
const contains = (parent, child) =>
  parent === child || child.startsWith(`${parent}/`);

/**
 * Protect the pinned image's startup shell, env executable and loader closure
 * before the gate runs. The host must approve that image and ensure its data
 * destinations have no symlink aliases into the protected executable/config
 * tree. Lexical exclusions cannot establish that image property. Arbitrary
 * data-root names remain usable; no new per-vendor root configuration is needed.
 *
 * Host-granted source trees can contain sockets or other authority. This helper
 * does not approve those sources or turn a native path into a safe file tree.
 *
 * @param {readonly NativePodmanMount[]} declarations
 * @returns {readonly NativePodmanMount[]}
 */
export const validateNativePodmanMounts = declarations => {
  mustMatch(
    harden(declarations),
    M.arrayOf(MountShape),
    'native Podman mounts',
  );
  /** @type {string[]} */
  const occupied = [];
  for (const declaration of declarations) {
    const { innerPath, mode, kind } = declaration;
    (innerPath.startsWith('/') &&
      !innerPath.includes('\0') &&
      innerPath
        .slice(1)
        .split('/')
        .every(part => part !== '' && part !== '.' && part !== '..')) ||
      Fail`Native mount destination must be canonical, absolute, and non-root: ${q(innerPath)}`;
    kind !== 'generated' ||
      mode === 'ro' ||
      Fail`Native generated mounts must be read-only`;
    if (!(kind === 'generated' && innerPath === '/etc/resolv.conf')) {
      for (const root of protectedRoots) {
        (!contains(root, innerPath) && !contains(innerPath, root)) ||
          Fail`Native mount destination ${q(innerPath)} overlaps protected image or kernel path ${q(root)}`;
      }
    }
    for (const other of occupied) {
      (!contains(other, innerPath) && !contains(innerPath, other)) ||
        Fail`Native mount destinations ${q(innerPath)} and ${q(other)} overlap`;
    }
    occupied.push(innerPath);
  }
  return declarations;
};
harden(validateNativePodmanMounts);

/**
 * Check the gate process's actual declared mount flags and reject writable
 * cgroup filesystems anywhere in its mount namespace. Read-only declarations
 * must remain read-only throughout their submounts; nodev applies to every
 * declared mount and submount. Read-write declarations may contain more
 * restrictive read-only submounts.
 *
 * The driver launches declared mounts with nosuid as well, but this observer
 * does not require it: the profile observer proves no-new-privileges with an
 * empty bounding set, which leaves a setuid bit inert, whereas an existing
 * device node on a granted host source is usable without nodev regardless of
 * capabilities.
 *
 * As with the profile observer, the driver holds the gate and owns its original
 * process identity. These are kernel mount-flag observations, not host-source
 * identity attestation or a substitute for the pinned image's no-alias contract.
 * A mount at a symlink-resolved target instead of its declaration is refused;
 * this later check alone cannot make an untrusted startup image safe.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @param {readonly NativePodmanMount[]} declarations
 */
export const observeNativePodmanMounts = async (proc, pid, declarations) => {
  validateNativePodmanMounts(declarations);
  const table = await readMountTable(proc, pid);
  for (const [path, mount] of table) {
    if (mount.fstype === 'cgroup' || mount.fstype === 'cgroup2') {
      (mount.options.includes('ro') && !mount.options.includes('rw')) ||
        Fail`Native gate has a writable or unproved cgroup mount at ${q(path)}`;
    }
  }
  for (const { innerPath, mode } of declarations) {
    const exact = table.get(innerPath);
    if (exact === undefined) {
      throw Fail`Native gate declared mount is missing at ${q(innerPath)}`;
    }
    (exact.options.includes(mode) &&
      !exact.options.includes(mode === 'ro' ? 'rw' : 'ro')) ||
      Fail`Native gate mount mode differs at ${q(innerPath)}`;
    for (const [path, mount] of table) {
      if (contains(innerPath, path)) {
        mount.options.includes('nodev') ||
          Fail`Native gate declared mount permits devices at ${q(path)}`;
        mode !== 'ro' ||
          (mount.options.includes('ro') && !mount.options.includes('rw')) ||
          Fail`Native gate read-only mount contains a writable submount at ${q(path)}`;
      }
    }
  }
};
harden(observeNativePodmanMounts);
