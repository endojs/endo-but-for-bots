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
 * @property {(path: string) => Promise<bigint>} readInode  Inode number.
 */

/**
 * Recognize "this file is not here", which for some `procfs` entries is
 * an answer rather than a failure to get one.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
const isMissing = error =>
  /** @type {{ code?: string }} */ (error)?.code === 'ENOENT';

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
 * Report, for each namespace the profile constrains, which one the
 * target process holds and whether it differs from this process's.
 *
 * A namespace link that cannot be read is reported as not unshared and
 * without an identity: "we could not tell" and "it is shared" have the
 * same safe collapse here, because both leave the isolation unproved.
 *
 * `unshared` says the namespace is not the observer's. It does not by
 * itself say the namespace is nobody else's — that takes comparing the
 * `id` against the other namespaces in play, which is why the id is
 * reported rather than folded away into the boolean.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<Record<'user' | 'pid' | 'ipc' | 'mount', { id: string | null, unshared: boolean }>>}
 */
export const readNamespaceIdentities = async (proc, pid) => {
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
          harden({
            id: theirsInode,
            unshared:
              mineInode !== null &&
              theirsInode !== null &&
              mineInode !== theirsInode,
          }),
        ]);
      } catch {
        return /** @type {const} */ ([
          kind,
          harden({ id: null, unshared: false }),
        ]);
      }
    }),
  );
  return harden(
    /** @type {Record<'user' | 'pid' | 'ipc' | 'mount', { id: string | null, unshared: boolean }>} */ (
      Object.fromEntries(entries)
    ),
  );
};
harden(readNamespaceIdentities);

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
    routableRoutes = countRoutableIpv4Routes(
      await proc.readFile(`/proc/${pid}/net/route`),
    );
  } catch (e) {
    throw makeError(
      X`cannot read the slice routing table: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  try {
    routableRoutes += countRoutableIpv6Routes(
      await proc.readFile(`/proc/${pid}/net/ipv6_route`),
    );
  } catch (e) {
    // A kernel booted with `ipv6.disable=1` has no `ipv6_route` at all,
    // and no IPv6 routes either, so its absence is zero rather than a
    // refusal. Every other failure still is one. This is the only read
    // here that can be answered by its own absence: an empty interface
    // inventory and an unreadable one must not collapse together, but a
    // missing IPv6 route table and an empty one genuinely do.
    if (!isMissing(e)) {
      throw makeError(
        X`cannot read the slice IPv6 routing table: ${q(/** @type {Error} */ (e).message)}`,
      );
    }
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
 * holds *inside its own user namespace*, its seccomp mode, whether it
 * can regain privileges, and its capability masks. All three masks are
 * reported, because an empty effective set beside a populated permitted
 * or bounding set is a posture the process can undo.
 *
 * `/proc/<pid>/status` reports the ids in the reader's namespace, which
 * for a rootless container is the unprivileged host id the subuid range
 * mapped `--user` onto — not the id the contract names. Translating
 * through the target's own `uid_map` is what turns the host's view back
 * into the slice's.
 *
 * One level of translation is enough however deeply the target's user
 * namespace is nested, because the kernel writes `uid_map`'s outside
 * column in the namespace of whoever opens the file (see
 * `user_namespaces(7)`) — for this reader, the daemon's own. Walking a
 * parent chain here would translate through the same namespaces twice.
 *
 * A field this kernel does not report comes back `null`, which callers
 * read as "not proved" rather than as an answer either way.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<{ uid: number, gid: number, seccompMode: number | null, noNewPrivs: boolean | null, effectiveCapabilities: bigint | null, permittedCapabilities: bigint | null, boundingCapabilities: bigint | null }>}
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
  /**
   * Capability sets are reported as a fixed-width hexadecimal mask. It
   * is a bit set, not a quantity, so it is read as a `bigint` rather
   * than narrowed to whatever fits a double.
   *
   * @param {string} key
   * @returns {bigint | null}
   */
  const capabilityField = key => {
    const line = lines.find(candidate => candidate.startsWith(`${key}:`));
    if (line === undefined) return null;
    const mask = line.trim().split(/\s+/)[1];
    return mask !== undefined && /^[0-9a-fA-F]+$/.test(mask)
      ? BigInt(`0x${mask}`)
      : null;
  };
  // `Uid:\t<real>\t<effective>\t<saved>\t<fs>` — all four, because
  // `setuid()` back to the real or the saved id needs no capability at
  // all. A process whose effective id is 1000 while its saved id is 0
  // is one call away from being root inside its user namespace, which
  // is the identity a policy is not even allowed to ask for.
  const outsideUids = [1, 2, 3, 4].map(field => numericField('Uid', field));
  const outsideGids = [1, 2, 3, 4].map(field => numericField('Gid', field));
  if (
    outsideUids.some(value => value === null) ||
    outsideGids.some(value => value === null)
  ) {
    throw makeError(X`slice process identity is not readable`);
  }
  const [uidMap, gidMap] = await Promise.all([
    proc.readFile(`/proc/${pid}/uid_map`).then(parseIdMap, () => harden([])),
    proc.readFile(`/proc/${pid}/gid_map`).then(parseIdMap, () => harden([])),
  ]);
  const uids = outsideUids.map(value =>
    mapIdInward(uidMap, /** @type {number} */ (value)),
  );
  const gids = outsideGids.map(value =>
    mapIdInward(gidMap, /** @type {number} */ (value)),
  );
  if (
    uids.some(value => value === null) ||
    gids.some(value => value === null)
  ) {
    throw makeError(
      X`slice process identity ${q(outsideUids)}:${q(outsideGids)} is outside the slice user namespace map`,
    );
  }
  const [uid] = /** @type {number[]} */ (uids);
  const [gid] = /** @type {number[]} */ (gids);
  if (uids.some(value => value !== uid) || gids.some(value => value !== gid)) {
    throw makeError(
      X`slice process holds more than one identity: uids ${q(uids)}, gids ${q(gids)}`,
    );
  }
  const noNewPrivs = numericField('NoNewPrivs', 1);
  return harden({
    uid,
    gid,
    seccompMode: numericField('Seccomp', 1),
    noNewPrivs: noNewPrivs === null ? null : noNewPrivs === 1,
    effectiveCapabilities: capabilityField('CapEff'),
    permittedCapabilities: capabilityField('CapPrm'),
    boundingCapabilities: capabilityField('CapBnd'),
  });
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
    readInode: async path => {
      await null;
      // `bigint: true` because an inode number is a 64-bit kernel
      // quantity, and namespace identity is exactly the case where
      // silently rounding one would compare two namespaces equal.
      const stats = await fsModule.promises.stat(path, { bigint: true });
      return stats.ino;
    },
  });
harden(makeProcReader);

/**
 * Identify the network namespace a bind-mounted `netns` path names.
 *
 * A namespace pinned at a path is not a symlink into `nsfs`, so it has
 * no `net:[…]` target to read; its inode is the same number the
 * `/proc/<pid>/ns/net` link of a process inside it reports.
 *
 * @param {ProcReader} proc
 * @param {string} netnsPath
 * @returns {Promise<string>}
 */
export const readNetworkNamespaceIdAtPath = async (proc, netnsPath) => {
  await null;
  let inode;
  try {
    inode = await proc.readInode(netnsPath);
  } catch (e) {
    throw makeError(
      X`cannot identify the network namespace at ${q(netnsPath)}: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  return `net-${inode}`;
};
harden(readNetworkNamespaceIdAtPath);

/**
 * Decode the octal escapes `/proc/<pid>/mountinfo` uses for the four
 * characters that would otherwise break its whitespace framing: space
 * (`\040`), tab (`\011`), newline (`\012`) and backslash (`\134`).
 *
 * @param {string} field
 * @returns {string}
 */
const unescapeMountInfoField = field =>
  field.replace(/\\(040|011|012|134)/g, (_match, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );

/**
 * Parse `/proc/<pid>/mountinfo` into the mount the kernel has at each
 * mount point of that process's mount namespace.
 *
 * Each line is `id parent major:minor root mountPoint options
 * [optional…] - fstype source superOptions`. The optional fields end at
 * the lone `-` separator, which is how the two halves are told apart.
 * Later lines for one mount point are mounts stacked on top of earlier
 * ones, and the topmost is what a process at that path sees, so the
 * last line wins.
 *
 * `root` and `deviceId` are kept because an attestation needs more than
 * the filesystem type: `deviceId` (the `major:minor` of the superblock)
 * says WHICH filesystem is mounted, and `root` says how much of it —
 * `/` for the whole tree, a subpath for a bind of one subtree. Without
 * them a proof can say only that something of the right type is at a
 * path, which the runtime's own record already claimed.
 *
 * A line in any other shape throws. This file is evidence for an
 * attestation, and "we could not read this" must fail the proof rather
 * than silently drop a mount from it.
 *
 * @param {string} text
 * @returns {Map<string, { fstype: string, source: string, root: string, deviceId: string, options: readonly string[], superOptions: readonly string[] }>}
 */
export const parseMountInfo = text => {
  /** @type {Map<string, { fstype: string, source: string, root: string, deviceId: string, options: readonly string[], superOptions: readonly string[] }>} */
  const table = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      // eslint-disable-next-line no-continue
      continue;
    }
    const tokens = line.split(' ');
    const separator = tokens.indexOf('-');
    if (separator < 6 || tokens.length < separator + 4) {
      throw makeError(X`unrecognized mountinfo line ${q(line)}`);
    }
    const deviceId = tokens[2];
    const root = unescapeMountInfoField(tokens[3]);
    const mountPoint = unescapeMountInfoField(tokens[4]);
    const options = harden(tokens[5].split(','));
    const fstype = unescapeMountInfoField(tokens[separator + 1]);
    const source = unescapeMountInfoField(tokens[separator + 2]);
    const superOptions = harden(tokens[separator + 3].split(','));
    table.set(
      mountPoint,
      harden({ fstype, source, root, deviceId, options, superOptions }),
    );
  }
  return table;
};
harden(parseMountInfo);

/**
 * Read the mount table of a live process's own mount namespace.
 *
 * A policy attach is a bind of a host path the attestation must prove
 * is a 9P projection rather than host data, and the container runtime's
 * inspect record cannot say what filesystem sits under a bind source.
 * The kernel can: inside the anchor's private mount namespace the bind
 * at the attach destination carries the filesystem type of what it was
 * bound from.
 *
 * @param {ProcReader} proc
 * @param {number} pid
 * @returns {Promise<ReturnType<typeof parseMountInfo>>}
 */
export const readMountTable = async (proc, pid) => {
  await null;
  let text;
  try {
    text = await proc.readFile(`/proc/${pid}/mountinfo`);
  } catch (e) {
    throw makeError(
      X`cannot read the mount table of pid ${q(pid)}: ${q(/** @type {Error} */ (e).message)}`,
    );
  }
  return parseMountInfo(text);
};
harden(readMountTable);
