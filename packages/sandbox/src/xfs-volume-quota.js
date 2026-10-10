// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Kernel quota evidence for an operator-owned, ordinary Podman volume.
 * @typedef {object} VolumeQuotaEvidence
 * @property {'VolumeQuotaEvidenceV1'} version
 * @property {string} name
 * @property {string} mountpoint
 * @property {string} device
 * @property {string} inode
 * @property {number} projectId XFS project IDs are unsigned 32-bit integers.
 * @property {bigint} hardBytes
 * @property {true} enforced
 * @property {true} projectInherited
 */

/**
 * Read XFS project quota state through explicitly supplied host authority.
 *
 * `run` must execute the supplied absolute executable with the exact argv,
 * LC_ALL=C, a bounded output buffer, and a deadline, rejecting unsuccessful
 * exits and stderr diagnostics. It needs permission to read XFS project quotas
 * in the initial user namespace; it must not run inside the model's slice.
 * This module neither invokes sudo nor accepts command text from its caller.
 *
 * Provisioning must have recursively assigned a unique project ID to an empty
 * volume before first use, and set its hard limit. The trusted host must retain
 * exclusive authority over quota assignment and the volume's parent directory.
 * A caller in the initial user namespace that owns these files can change their
 * project IDs; the model must remain in its separate user namespace.
 *
 * @param {object} powers
 * @param {string} powers.volumeRoot canonical Podman volumes directory
 * @param {string} powers.filesystem canonical XFS mountpoint
 * @param {(path: string) => Promise<{dev: bigint, ino: bigint, isDirectory: () => boolean}>} powers.stat
 * @param {(path: string) => Promise<string>} powers.realpath
 * @param {(executable: string, argv: string[]) => Promise<string>} powers.run
 */
export const makeXfsVolumeQuotaObserver = ({
  volumeRoot,
  filesystem,
  stat,
  realpath,
  run,
}) => {
  const canonical = /^(\/[A-Za-z0-9_.-]+)+$/;
  (canonical.test(volumeRoot) && canonical.test(filesystem)) ||
    Fail`XFS quota roots must be canonical absolute paths`;

  /** @param {string} path */
  const readAttributes = async path => {
    const output = await run('/usr/sbin/xfs_io', ['-r', '-c', 'stat', path]);
    const project = /^fsxattr\.projid = ([0-9]+)$/m.exec(output);
    const flags = /^fsxattr\.xflags = (0x[0-9a-f]+) \[[^\r\n]*\]$/m.exec(
      output,
    );
    const inode = /^stat\.ino = ([0-9]+)$/m.exec(output);
    if (!project || !flags || !inode) {
      throw makeError(X`Unreadable XFS project attributes`);
    }
    const projectId = Number(project[1]);
    // FS_XFLAG_PROJINHERIT; XFS's on-disk project ID is uint32.
    (projectId > 0 &&
      projectId <= 0xffff_ffff &&
      // eslint-disable-next-line no-bitwise
      (BigInt(flags[1]) & 0x200n) !== 0n) ||
      Fail`XFS volume must inherit a nonzero project quota`;
    return { projectId, inode: inode[1] };
  };

  /**
   * @param {{name: string, mountpoint: string}} request
   * @returns {Promise<VolumeQuotaEvidence>}
   */
  const observe = async ({ name, mountpoint }) => {
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ||
      Fail`Invalid quota volume name`;
    mountpoint === `${volumeRoot}/${name}/_data` ||
      Fail`Quota volume is outside the operator volume root`;
    const resolved = await realpath(mountpoint);
    (resolved === mountpoint &&
      (await realpath(volumeRoot)) === volumeRoot &&
      (await realpath(filesystem)) === filesystem) ||
      Fail`Quota volume paths must not contain symbolic links`;
    const before = await stat(mountpoint);
    const fs = await stat(filesystem);
    (before.isDirectory() && fs.isDirectory() && before.dev === fs.dev) ||
      Fail`Quota volume is not on the selected filesystem`;
    const attributes = await readAttributes(mountpoint);
    attributes.inode === `${before.ino}` || Fail`Quota volume changed identity`;
    const state = await run('/usr/sbin/xfs_quota', [
      '-x',
      '-c',
      'state -p',
      filesystem,
    ]);
    (/^Project quota state on /m.test(state) &&
      /^ {2}Accounting: ON$/m.test(state) &&
      /^ {2}Enforcement: ON$/m.test(state)) ||
      Fail`XFS project quotas are not enforced`;
    const quota = await run('/usr/sbin/xfs_quota', [
      '-x',
      '-c',
      `quota -p -N -n -b -v ${attributes.projectId}`,
      filesystem,
    ]);
    // -v includes newly provisioned projects with zero current usage.
    // Numeric quota output uses 1KiB blocks (not XFS's raw 512-byte units).
    const lines = quota.trim().split('\n');
    const row =
      lines.length === 1
        ? /^(\S+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+[0-9]+\s+\[[^\]]*\]\s+(\S+)$/.exec(
            lines[0],
          )
        : null;
    if (!row || row[5] !== filesystem || BigInt(row[4]) === 0n) {
      throw makeError(X`Unreadable XFS project hard limit`);
    }
    const after = await stat(mountpoint);
    const later = await readAttributes(mountpoint);
    ((await realpath(mountpoint)) === mountpoint &&
      after.isDirectory() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      later.inode === attributes.inode &&
      later.projectId === attributes.projectId) ||
      Fail`Quota volume changed during observation`;
    return harden({
      version: 'VolumeQuotaEvidenceV1',
      name,
      mountpoint,
      device: `${after.dev}`,
      inode: `${after.ino}`,
      projectId: attributes.projectId,
      hardBytes: BigInt(row[4]) * 1024n,
      enforced: true,
      projectInherited: true,
    });
  };
  return makeExo(
    'XfsVolumeQuotaObserver',
    M.interface('XfsVolumeQuotaObserver', {
      observe: M.callWhen({ name: M.string(), mountpoint: M.string() }).returns(
        M.record(),
      ),
    }),
    { observe },
  );
};
harden(makeXfsVolumeQuotaObserver);
