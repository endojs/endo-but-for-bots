// @ts-check

/**
 * Kernel-state observation for policy attestation.
 *
 * Everything here answers a question about a live process from
 * `procfs`, which is the kernel's own account of what it did, rather
 * than from the container runtime's echo of the flags it was asked
 * for. The distinction is the whole point of the attestation: a
 * runtime that silently ignored `--pid private` still reports
 * `"private"`, and a network namespace prepared with a routable
 * interface still reports the `--network` value that joined it.
 *
 * The readers take a small injected filesystem so the parsers can be
 * exercised against captured `procfs` text without a container.
 */

import { makeError, q, X } from '@endo/errors';

/**
 * @typedef {object} ProcReader
 * @property {(path: string) => Promise<string>} readFile   UTF-8 text.
 * @property {(path: string) => Promise<string>} readLink   Symlink target.
 */

/** Namespaces the hosted-agent profile requires to be private. */
const NAMESPACE_FILES = harden({
  user: 'user',
  pid: 'pid',
  ipc: 'ipc',
  mount: 'mnt',
});

/**
 * Extract the inode from a namespace symlink target such as
 * `net:[4026532567]`.
 *
 * @param {string} target
 * @returns {string | null}
 */
export const parseNamespaceInode = target => {
  const match = target.trim().match(/^([a-z_]+):\[(\d+)\]$/);
  return match === null ? null : `${match[1]}-${match[2]}`;
};
harden(parseNamespaceInode);

/**
 * Report, for each namespace the profile constrains, whether the target
 * process holds a different one from this process.
 *
 * A namespace link that cannot be read is reported as not unshared:
 * "we could not tell" and "it is shared" have the same safe collapse
 * here, because both leave the isolation unproved.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<{ user: boolean, pid: boolean, ipc: boolean, mount: boolean }>}
 */
export const readUnsharedNamespaces = async (proc, pid) => {
  const entries = await Promise.all(
    Object.entries(NAMESPACE_FILES).map(async ([kind, file]) => {
      await null;
      try {
        const [mine, theirs] = await Promise.all([
          proc.readLink(`/proc/self/ns/${file}`),
          proc.readLink(`/proc/${pid}/ns/${file}`),
        ]);
        const mineInode = parseNamespaceInode(mine);
        const theirsInode = parseNamespaceInode(theirs);
        return /** @type {const} */ ([
          kind,
          mineInode !== null &&
            theirsInode !== null &&
            mineInode !== theirsInode,
        ]);
      } catch {
        return /** @type {const} */ ([kind, false]);
      }
    }),
  );
  return harden(
    /** @type {{ user: boolean, pid: boolean, ipc: boolean, mount: boolean }} */ (
      Object.fromEntries(entries)
    ),
  );
};
harden(readUnsharedNamespaces);

/**
 * Parse the interface names out of `/proc/<pid>/net/dev`.
 *
 * The file's first two lines are column headings; every later line
 * begins with the interface name followed by a colon.
 *
 * @param {string} text
 * @returns {string[]}
 */
export const parseNetDev = text => {
  /** @type {string[]} */
  const names = [];
  for (const line of text.split('\n').slice(2)) {
    const colon = line.indexOf(':');
    // eslint-disable-next-line no-continue
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name !== '') names.push(name);
  }
  return harden(names);
};
harden(parseNetDev);

/**
 * Count the routes in `/proc/<pid>/net/route` that leave loopback.
 *
 * The first line is a heading and the first column is the interface.
 *
 * @param {string} text
 * @returns {number}
 */
export const countRoutableIpv4Routes = text => {
  let routable = 0;
  for (const line of text.split('\n').slice(1)) {
    const iface = line.trim().split(/\s+/)[0];
    if (iface !== undefined && iface !== '' && iface !== 'lo') routable += 1;
  }
  return routable;
};
harden(countRoutableIpv4Routes);

/**
 * Count the routes in `/proc/<pid>/net/ipv6_route` that leave loopback.
 *
 * The file has no heading and names the device in its last column.
 *
 * @param {string} text
 * @returns {number}
 */
export const countRoutableIpv6Routes = text => {
  let routable = 0;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const device = fields[fields.length - 1];
    if (fields.length < 2) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (device !== undefined && device !== '' && device !== 'lo') routable += 1;
  }
  return routable;
};
harden(countRoutableIpv6Routes);

/**
 * Describe the network namespace a live process is in: its identity,
 * the interfaces it contains, and how many routes leave loopback.
 *
 * An unreadable file is a hard error rather than an empty inventory:
 * "no interfaces observed" and "the inventory could not be read" must
 * not attest to the same thing.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<{ namespaceId: string, interfaces: string[], routableRoutes: number }>}
 */
export const readNetworkNamespace = async (proc, pid) => {
  await null;
  let namespaceId;
  try {
    const target = await proc.readLink(`/proc/${pid}/ns/net`);
    namespaceId = parseNamespaceInode(target);
  } catch (e) {
    throw makeError(
      X`cannot read the slice network namespace: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  if (namespaceId === null) {
    throw makeError(X`slice network namespace has an unrecognized identity`);
  }
  let interfaces;
  try {
    interfaces = parseNetDev(await proc.readFile(`/proc/${pid}/net/dev`));
  } catch (e) {
    throw makeError(
      X`cannot read the slice interface inventory: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  let routableRoutes;
  try {
    routableRoutes =
      countRoutableIpv4Routes(await proc.readFile(`/proc/${pid}/net/route`)) +
      countRoutableIpv6Routes(
        await proc.readFile(`/proc/${pid}/net/ipv6_route`),
      );
  } catch (e) {
    throw makeError(
      X`cannot read the slice routing table: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  return harden({ namespaceId, interfaces, routableRoutes });
};
harden(readNetworkNamespace);

/**
 * Parse an id-map file (`uid_map` / `gid_map`) into its ranges.
 *
 * Each line is `<inside> <outside> <count>`.
 *
 * @param {string} text
 * @returns {Array<{ inside: number, outside: number, count: number }>}
 */
export const parseIdMap = text => {
  /** @type {Array<{ inside: number, outside: number, count: number }>} */
  const ranges = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // eslint-disable-next-line no-continue
    if (fields.length !== 3) continue;
    const [inside, outside, count] = fields.map(Number);
    if (
      Number.isInteger(inside) &&
      Number.isInteger(outside) &&
      Number.isInteger(count) &&
      count > 0
    ) {
      ranges.push(harden({ inside, outside, count }));
    }
  }
  return harden(ranges);
};
harden(parseIdMap);

/**
 * Translate an id this process can see into the id the target process
 * sees for itself, through the target's user-namespace map.
 *
 * @param {ReturnType<typeof parseIdMap>} ranges
 * @param {number} outside
 * @returns {number | null}
 */
export const mapIdInward = (ranges, outside) => {
  for (const range of ranges) {
    if (outside >= range.outside && outside < range.outside + range.count) {
      return range.inside + (outside - range.outside);
    }
  }
  return null;
};
harden(mapIdInward);

/**
 * `SECCOMP_MODE_FILTER` — the value `/proc/<pid>/status` reports for a
 * process running under a loaded BPF filter. Mode 0 is disabled and
 * mode 1 is the ancient strict mode, neither of which is the control a
 * container runtime's default profile is supposed to have installed.
 */
export const SECCOMP_MODE_FILTER = 2;
harden(SECCOMP_MODE_FILTER);

/**
 * Read what the kernel says about a live process: the uid and gid it
 * holds *inside its own user namespace*, and its seccomp mode.
 *
 * `/proc/<pid>/status` reports the ids in the reader's namespace, which
 * for a rootless container is the unprivileged host id the subuid range
 * mapped `--user` onto — not the id the contract names. Translating
 * through the target's own `uid_map` is what turns the host's view back
 * into the slice's.
 *
 * `seccompMode` is `null` on a kernel that reports no `Seccomp:` line,
 * which callers read as "no filter proved" rather than as "no filter".
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<{ uid: number, gid: number, seccompMode: number | null }>}
 */
export const readProcessStatus = async (proc, pid) => {
  await null;
  let status;
  try {
    status = await proc.readFile(`/proc/${pid}/status`);
  } catch (e) {
    throw makeError(
      X`cannot read the slice process status: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  const lines = status.split('\n');
  /**
   * @param {string} key
   * @param {number} field
   * @returns {number | null}
   */
  const numericField = (key, field) => {
    const line = lines.find(candidate => candidate.startsWith(`${key}:`));
    if (line === undefined) return null;
    const value = Number(line.trim().split(/\s+/)[field]);
    return Number.isInteger(value) ? value : null;
  };
  // `Uid:\t<real>\t<effective>\t<saved>\t<fs>`
  const outsideUid = numericField('Uid', 2);
  const outsideGid = numericField('Gid', 2);
  if (outsideUid === null || outsideGid === null) {
    throw makeError(X`slice process identity is not readable`);
  }
  const [uidMap, gidMap] = await Promise.all([
    proc.readFile(`/proc/${pid}/uid_map`).then(parseIdMap, () => harden([])),
    proc.readFile(`/proc/${pid}/gid_map`).then(parseIdMap, () => harden([])),
  ]);
  const uid = mapIdInward(uidMap, outsideUid);
  const gid = mapIdInward(gidMap, outsideGid);
  if (uid === null || gid === null) {
    throw makeError(
      X`slice process identity ${q(outsideUid)}:${q(outsideGid)} is outside the slice user namespace map`,
    );
  }
  return harden({ uid, gid, seccompMode: numericField('Seccomp', 1) });
};
harden(readProcessStatus);

/**
 * Build a `ProcReader` over Node's filesystem.
 *
 * @param {typeof import('fs')} fsModule
 * @returns {ProcReader}
 */
export const makeProcReader = fsModule =>
  harden({
    readFile: path => fsModule.promises.readFile(path, 'utf8'),
    readLink: path => fsModule.promises.readlink(path),
  });
harden(makeProcReader);
