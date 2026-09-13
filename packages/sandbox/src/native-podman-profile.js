// @ts-check

import { Fail, q } from '@endo/errors';
import { M, mustMatch } from '@endo/patterns';

import {
  mapIdInward,
  parseIdMap,
  parseMountInfo,
  readMountTable,
  readNamespaceIdentities,
  readProcessStatus,
  SECCOMP_MODE_FILTER,
} from './observe.js';

/** @import { NativePodmanProfile, HostIdentity } from './native-podman-profile-types.js' */
/** @import { ProcReader } from './observe.js' */

const ProfileShape = harden({
  uid: M.number(),
  gid: M.number(),
  memoryBytes: M.bigint(),
  pids: M.number(),
  cpuQuotaMicros: M.bigint(),
  cpuPeriodMicros: M.number(),
  maxConcurrentOperations: M.number(),
});

/**
 * Linux uid_t/gid_t reserve UINT32_MAX for an unmapped identity.
 * @param {number} value
 */
const assertIdentity = value => {
  (Number.isInteger(value) && value >= 0 && value < 0xffff_ffff) ||
    Fail`Invalid native process identity ${q(value)}`;
};

/**
 * This is operator configuration, separate from bwrap rlimits and the previous
 * slice attestation policy. Counts deliberately use a positive 32-bit profile;
 * byte/quota quantities retain the OCI signed 64-bit domain. Kernel rejection
 * of unsupported resource values remains a launch failure, never a default.
 * @param {unknown} value
 * @returns {NativePodmanProfile}
 */
export const assertNativePodmanProfile = value => {
  mustMatch(harden(value), ProfileShape, 'native Podman profile');
  const profile = /** @type {NativePodmanProfile} */ (value);
  assertIdentity(profile.uid);
  assertIdentity(profile.gid);
  for (const count of [profile.pids, profile.maxConcurrentOperations]) {
    (Number.isInteger(count) && count > 0 && count <= 0xffff_ffff) ||
      Fail`Native Podman operation counts must be positive uint32 values`;
  }
  for (const quantity of [profile.memoryBytes, profile.cpuQuotaMicros]) {
    (quantity > 0n && quantity <= 0x7fff_ffff_ffff_ffffn) ||
      Fail`Native Podman resource quantities must be positive OCI int64 values`;
  }
  (Number.isInteger(profile.cpuPeriodMicros) &&
    profile.cpuPeriodMicros >= 1000 &&
    profile.cpuPeriodMicros <= 1_000_000) ||
    Fail`Native Podman CPU period must be between 1000 and 1000000 microseconds`;
  profile.cpuQuotaMicros >= 1000n ||
    Fail`Native Podman CPU quota must be at least 1000 microseconds`;
  return profile;
};
harden(assertNativePodmanProfile);

/**
 * Launch requests only; the observer below must check the actual gate process.
 * Networking, declared mounts, image identity and admission counts belong to
 * the driver. Equal memory and memory-swap request zero additional swap.
 *
 * The observer reads controls from the gate process's own cgroup. crun writes
 * the requested limits into exactly that cgroup on entry, including the
 * `container` sub-cgroup its systemd driver creates beneath the scope
 * (`libcrun_cgroup_enter` then `update_cgroup_resources(status->path)`), so
 * no launch flag steers cgroup placement here. Moving the process into the
 * systemd-managed scope itself would let systemd later re-apply its own view
 * of the limits, which is not the deterministic leaf the observer attests.
 * @param {NativePodmanProfile} profile
 * @returns {readonly string[]}
 */
export const nativePodmanProfileArgs = profile => {
  assertNativePodmanProfile(profile);
  return harden([
    `--userns=keep-id:uid=${profile.uid},gid=${profile.gid}`,
    `--user=${profile.uid}:${profile.gid}`,
    '--pid=private',
    '--ipc=private',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    '--read-only',
    `--memory=${profile.memoryBytes}`,
    `--memory-swap=${profile.memoryBytes}`,
    `--pids-limit=${profile.pids}`,
    `--cpu-period=${profile.cpuPeriodMicros}`,
    `--cpu-quota=${profile.cpuQuotaMicros}`,
  ]);
};
harden(nativePodmanProfileArgs);

/**
 * Validate map framing/ranges before using the shared translation helper.
 * @param {string} text
 */
const checkedIdMap = text => {
  const lines = text.trim().split('\n');
  for (const line of lines) {
    /^\s*[0-9]+\s+[0-9]+\s+[0-9]+\s*$/.test(line) ||
      Fail`Unrecognized native process identity map`;
    const [inside, outside, count] = line.trim().split(/\s+/).map(BigInt);
    (count > 0n &&
      inside + count <= 0xffff_ffffn &&
      outside + count <= 0xffff_ffffn) ||
      Fail`Invalid native process identity map range`;
  }
  const ranges = parseIdMap(text);
  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      for (const key of /** @type {const} */ (['inside', 'outside'])) {
        const a = ranges[i];
        const b = ranges[j];
        a[key] >= b[key] + b.count ||
          b[key] >= a[key] + a.count ||
          Fail`Overlapping native process identity map ranges`;
      }
    }
  }
  return ranges;
};

/**
 * Only a full cgroup2 mount in the observer's namespace is supported. Do not
 * guess translations for delegated bind roots or resolve traversal components.
 * @param {string} text
 */
const cgroupPath = text => {
  const match = /^0::(\/[^\r\n]*)\n?$/.exec(text);
  if (match === null) throw Fail`Unrecognized native cgroup membership`;
  const path = match[1];
  // Refuse procfs escape/control ambiguity instead of normalizing a host path.
  // eslint-disable-next-line no-control-regex
  const hasControl = /[\\\u0000-\u001f\u007f]/.test(path);
  (path !== '/' &&
    !path.endsWith(' (deleted)') &&
    !hasControl &&
    path
      .slice(1)
      .split('/')
      .every(part => part !== '' && part !== '.' && part !== '..')) ||
    Fail`Unsafe native cgroup path ${q(path)}`;
  return path;
};

/**
 * @param {string} text
 * @param {string} name
 */
const naturalControl = (text, name) => {
  /^(0|[1-9][0-9]*)\n?$/.test(text) ||
    Fail`Missing, unbounded or unrecognized native cgroup control ${q(name)}`;
  return BigInt(text.trim());
};

/**
 * Snapshot the gate process, blocked at startup awaiting release, using the
 * observer's procfs and cgroupfs. The native host must provide stable, visible
 * procfs and a full cgroup2 mount at /sys/fs/cgroup: mountinfo alone cannot
 * prove an ancestor overmount has not hidden that filesystem. The driver must
 * own its immutable container/PID identity and hold the gate throughout
 * observation. This is not a process-lifetime proof.
 * Controls are read from the process's own cgroup, which must itself carry the
 * profile's limits; ancestors are never consulted, so a leaf reading `max`
 * beneath a limited scope is refused as unbounded. This attests the values on
 * that cgroup, not the hierarchy's topology.
 * Namespace identities are returned for sibling PID/IPC/mount exclusion;
 * keep-id user namespaces may be shared by siblings, but not with the observer.
 * Seccomp mode proves a filter is installed, not its contents. Read-only root
 * does not attest declared binds.
 * Exact memory equality intentionally refuses kernel-rounded configurations.
 *
 * @param {{proc: ProcReader, pid: number, profile: NativePodmanProfile} & HostIdentity} options
 */
export const observeNativePodmanProfile = async ({
  proc,
  pid,
  profile,
  hostUid,
  hostGid,
}) => {
  assertNativePodmanProfile(profile);
  assertIdentity(hostUid);
  assertIdentity(hostGid);
  (Number.isInteger(pid) && pid > 0 && pid <= 0x7fff_ffff) ||
    Fail`Invalid native gate PID`;
  const [status, namespaces, mounts, uidText, gidText, membership, hostMounts] =
    await Promise.all([
      readProcessStatus(proc, pid),
      readNamespaceIdentities(proc, pid),
      readMountTable(proc, pid),
      proc.readFile(`/proc/${pid}/uid_map`),
      proc.readFile(`/proc/${pid}/gid_map`),
      proc.readFile(`/proc/${pid}/cgroup`),
      proc.readFile('/proc/self/mountinfo').then(parseMountInfo),
    ]);
  (status.uid === profile.uid &&
    status.gid === profile.gid &&
    mapIdInward(checkedIdMap(uidText), hostUid) === profile.uid &&
    mapIdInward(checkedIdMap(gidText), hostGid) === profile.gid) ||
    Fail`Native gate identity does not map to the configured host identity`;
  (status.noNewPrivs === true &&
    status.seccompMode === SECCOMP_MODE_FILTER &&
    status.effectiveCapabilities === 0n &&
    status.permittedCapabilities === 0n &&
    status.boundingCapabilities === 0n) ||
    Fail`Native gate privilege restrictions are not proved`;
  for (const kind of /** @type {const} */ (['user', 'pid', 'ipc', 'mount'])) {
    namespaces[kind].unshared ||
      Fail`Native gate ${q(kind)} namespace is not private from the observer`;
  }
  mounts.get('/')?.options.includes('ro') ||
    Fail`Native gate root filesystem is not read-only`;
  const cgroupMount = hostMounts.get('/sys/fs/cgroup');
  (cgroupMount?.fstype === 'cgroup2' && cgroupMount.root === '/') ||
    Fail`Observer requires a full cgroup2 mount at /sys/fs/cgroup`;
  const path = cgroupPath(membership);
  const directory = `/sys/fs/cgroup${path}`;
  // Refuse evident nested mounts too. This does not replace the host's stable
  // visible cgroupfs precondition above (mountinfo includes hidden mounts).
  for (const mountPoint of hostMounts.keys()) {
    !mountPoint.startsWith('/sys/fs/cgroup/') ||
      !(
        directory === mountPoint ||
        directory.startsWith(`${mountPoint}/`) ||
        mountPoint.startsWith(`${directory}/`)
      ) ||
      Fail`Native cgroup controls are shadowed by another observer mount`;
  }
  const [memory, swap, pids, cpu] = await Promise.all(
    ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map(name =>
      proc.readFile(`${directory}/${name}`),
    ),
  );
  const cpuMatch = /^(0|[1-9][0-9]*) (0|[1-9][0-9]*)\n?$/.exec(cpu);
  (naturalControl(memory, 'memory.max') === profile.memoryBytes &&
    naturalControl(swap, 'memory.swap.max') === 0n &&
    naturalControl(pids, 'pids.max') === BigInt(profile.pids) &&
    cpuMatch !== null &&
    BigInt(cpuMatch[1]) === profile.cpuQuotaMicros &&
    BigInt(cpuMatch[2]) === BigInt(profile.cpuPeriodMicros)) ||
    Fail`Native gate cgroup controls do not match the operator profile`;
  return harden({ namespaces, cgroupPath: path, status });
};
harden(observeNativePodmanProfile);
