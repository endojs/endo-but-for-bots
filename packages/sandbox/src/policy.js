// @ts-check

/**
 * Effective-state policy enforcement for confined slices.
 *
 * A `SlicePolicyRequest` is the machine-checkable half of a hosted-agent
 * deployment contract: the identity, namespaces, mount table, network
 * shape, and resource ceilings a slice must actually run under. This
 * module does two things and no I/O:
 *
 *   1. `assertSlicePolicyRequest` normalizes and validates the request,
 *      then `assemblePolicyArgv` translates it into the exact container
 *      flags the driver passes to every operation in the slice.
 *   2. `attestSlicePolicy` reads back what the runtime and the kernel
 *      actually did — the container runtime's own resolved view, the
 *      namespace links of the live process, the interface inventory of
 *      the network namespace it joined, and the quota recorded against
 *      each writable volume — and returns a `SlicePolicyAttestationV1`
 *      record only when every control is proved.
 *
 * The two halves are deliberately separate. Requested flags are a
 * statement of intent; a host can silently ignore `--pids-limit`, a
 * storage driver can refuse a quota, and a network namespace can carry a
 * routable interface the caller never asked for. An attestation derived
 * from the request would restate the intent. Every field below is
 * therefore derived from observation, and anything unobserved, absent,
 * or in an unrecognized shape throws rather than attesting: the safe
 * collapse for "the runtime reported something we do not understand" is
 * "this control is not proved", which fails provisioning, never
 * "provisioning succeeded under an unverified control".
 *
 * Byte quantities are `bigint`. Linux expresses cgroup ceilings as
 * unsigned 64-bit quantities, so a `number` would advertise
 * JavaScript's 2**53 limit as if it were the kernel's. Counts that the
 * kernel genuinely bounds well inside four bytes (uid, gid, pids, open
 * files, cores) stay `number`.
 */

import { makeError, q, X } from '@endo/errors';

/** @import { SlicePolicyRequest, SlicePolicyMount, SlicePolicyAttestation, ObservedSliceState } from './types.js' */

/**
 * The only policy profile this version implements. A profile names a
 * whole contract rather than a bag of independent switches, so a slice
 * cannot be provisioned under a partially-applied hardening posture.
 */
export const SLICE_POLICY_PROFILE = 'hosted-agent-v1';
harden(SLICE_POLICY_PROFILE);

/** Version tag carried by every attestation this module mints. */
export const SLICE_POLICY_ATTESTATION_VERSION = 'SlicePolicyAttestationV1';
harden(SLICE_POLICY_ATTESTATION_VERSION);

/**
 * Mount options the attestation reports. The effective option list a
 * container runtime returns also carries bookkeeping the contract does
 * not speak to (`rprivate`, `size=`, `mode=`, `rw`), so the attestation
 * reports the hardening subset and `attestSlicePolicy` separately
 * insists that `nosuid` and `nodev` are among them.
 */
const ATTESTED_MOUNT_OPTIONS = harden(['nodev', 'noexec', 'nosuid', 'ro']);

/** Options every mount in the table must carry, whatever else it has. */
const REQUIRED_MOUNT_OPTIONS = harden(['nodev', 'nosuid']);

/**
 * Interfaces a `broker-only` network namespace may contain. The broker's
 * in-namespace listener is reachable over loopback; anything else is a
 * routable path the contract does not permit.
 */
const BROKER_ONLY_INTERFACES = harden(['lo']);

/** Image references must be pinned by digest; tags are rejected. */
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Portable, bounded name for a volume, container, or mount role. */
const PORTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Absolute, normal, non-traversing destination path inside the slice. */
const INNER_PATH_PATTERN = /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;

/**
 * Assert a value is a positive integer that fits the four-byte range the
 * kernel uses for the quantity, and return it.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
const assertPositiveCount = (value, label) => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0xffff_ffff
  ) {
    throw makeError(X`slice policy ${q(label)} must be a positive count`);
  }
  return value;
};

/**
 * Assert a value is a non-negative byte quantity and return it.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {bigint}
 */
const assertByteCount = (value, label) => {
  if (typeof value !== 'bigint' || value < 0n) {
    throw makeError(
      X`slice policy ${q(label)} must be a non-negative byte count`,
    );
  }
  return value;
};

/**
 * Assert a value is a bounded portable name and return it.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const assertPortableName = (value, label) => {
  if (typeof value !== 'string' || !PORTABLE_NAME_PATTERN.test(value)) {
    throw makeError(X`slice policy ${q(label)} must be a portable name`);
  }
  return value;
};

/**
 * Assert an exact key set, so an unknown field is a rejection rather
 * than a silently ignored one.
 *
 * @param {unknown} record
 * @param {readonly string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
const assertExactKeys = (record, keys, label) => {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw makeError(X`slice policy ${q(label)} must be a record`);
  }
  const actual = Object.keys(record).sort().join(',');
  const expected = [...keys].sort().join(',');
  if (actual !== expected) {
    throw makeError(
      X`slice policy ${q(label)} has unknown or missing fields: expected ${q(expected)}, got ${q(actual)}`,
    );
  }
  return /** @type {Record<string, unknown>} */ (record);
};

/**
 * Parse a byte size the way container tooling writes one back: a bare
 * decimal count, or a decimal with a binary suffix (`4G`, `4GiB`).
 * Returns `null` for anything else, which callers treat as "no quota
 * recorded" and therefore as a failure to prove the ceiling.
 *
 * Suffixes are binary because every tool in this path (`podman
 * --tmpfs size=`, `--memory`, volume `size=`) reads them that way.
 *
 * @param {unknown} text
 * @returns {bigint | null}
 */
export const parseByteSize = text => {
  if (typeof text === 'bigint') return text >= 0n ? text : null;
  if (typeof text === 'number') {
    return Number.isSafeInteger(text) && text >= 0 ? BigInt(text) : null;
  }
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(\d+)\s*(|[kmgtp])(i?b)?$/i);
  if (match === null) return null;
  const scale = { '': 0n, k: 1n, m: 2n, g: 3n, t: 4n, p: 5n };
  const exponent =
    scale[/** @type {keyof typeof scale} */ (match[2].toLowerCase())];
  return BigInt(match[1]) * 1024n ** exponent;
};
harden(parseByteSize);

/**
 * Validate one entry of the requested mount table.
 *
 * @param {unknown} candidate
 * @returns {SlicePolicyMount}
 */
const assertPolicyMount = candidate => {
  const record = /** @type {Record<string, unknown>} */ (
    typeof candidate === 'object' && candidate !== null ? candidate : {}
  );
  const kind = record.kind;
  if (kind !== 'volume' && kind !== 'tmpfs') {
    throw makeError(
      X`slice policy mount kind must be "volume" or "tmpfs"; got ${q(kind)}`,
    );
  }
  const keys =
    kind === 'volume'
      ? ['role', 'kind', 'source', 'destination', 'sizeBytes']
      : ['role', 'kind', 'destination', 'sizeBytes'];
  assertExactKeys(record, keys, `mount ${q(record.role)}`);
  const role = assertPortableName(record.role, 'mount role');
  const destination = record.destination;
  if (
    typeof destination !== 'string' ||
    !INNER_PATH_PATTERN.test(destination) ||
    destination.includes('/../') ||
    destination.endsWith('/..')
  ) {
    throw makeError(
      X`slice policy mount ${q(role)} needs an absolute normal destination; got ${q(destination)}`,
    );
  }
  const sizeBytes = assertByteCount(
    record.sizeBytes,
    `mount ${role} sizeBytes`,
  );
  if (sizeBytes === 0n) {
    throw makeError(
      X`slice policy mount ${q(role)} must declare a positive writable ceiling`,
    );
  }
  if (kind === 'tmpfs') {
    return harden({ role, kind, destination, sizeBytes });
  }
  const source = assertPortableName(record.source, `mount ${role} source`);
  return harden({ role, kind, source, destination, sizeBytes });
};

/**
 * Normalize and validate a slice policy request.
 *
 * Every ceiling the contract names must be present: a policy with a
 * "leave this one to the host default" hole is exactly the shape whose
 * enforcement nobody can later prove.
 *
 * @param {unknown} request
 * @returns {SlicePolicyRequest}
 */
export const assertSlicePolicyRequest = request => {
  const record = assertExactKeys(
    request,
    [
      'profile',
      'imageDigest',
      'uid',
      'gid',
      'brokerSidecar',
      'resources',
      'mounts',
      'attestationArgv',
    ],
    'request',
  );
  if (record.profile !== SLICE_POLICY_PROFILE) {
    throw makeError(
      X`slice policy profile must be ${q(SLICE_POLICY_PROFILE)}; got ${q(record.profile)}`,
    );
  }
  const imageDigest = record.imageDigest;
  if (
    typeof imageDigest !== 'string' ||
    !IMAGE_DIGEST_PATTERN.test(imageDigest)
  ) {
    throw makeError(
      X`slice policy image must be pinned by SHA-256 digest; got ${q(imageDigest)}`,
    );
  }
  // uid/gid 0 would keep the slice's processes root inside the user
  // namespace, which is the identity `no-new-privileges` and a dropped
  // capability set exist to make unreachable.
  const uid = assertPositiveCount(record.uid, 'uid');
  const gid = assertPositiveCount(record.gid, 'gid');

  const sidecar = assertExactKeys(
    record.brokerSidecar,
    Object.hasOwn(
      /** @type {object} */ (record.brokerSidecar ?? {}),
      'netnsPath',
    )
      ? ['netnsPath']
      : ['container'],
    'brokerSidecar',
  );
  /** @type {SlicePolicyRequest['brokerSidecar']} */
  let brokerSidecar;
  if (Object.hasOwn(sidecar, 'netnsPath')) {
    const netnsPath = sidecar.netnsPath;
    if (
      typeof netnsPath !== 'string' ||
      !netnsPath.startsWith('/') ||
      netnsPath.includes('\0')
    ) {
      throw makeError(
        X`slice policy brokerSidecar.netnsPath must be an absolute path`,
      );
    }
    brokerSidecar = harden({ netnsPath });
  } else {
    brokerSidecar = harden({
      container: assertPortableName(
        sidecar.container,
        'brokerSidecar.container',
      ),
    });
  }

  const resourceRecord = assertExactKeys(
    record.resources,
    [
      'memoryBytes',
      'pids',
      'cpuCores',
      'openFiles',
      'coreBytes',
      'writableBytes',
    ],
    'resources',
  );
  const resources = harden({
    memoryBytes: assertByteCount(resourceRecord.memoryBytes, 'memoryBytes'),
    pids: assertPositiveCount(resourceRecord.pids, 'pids'),
    cpuCores: assertPositiveCount(resourceRecord.cpuCores, 'cpuCores'),
    openFiles: assertPositiveCount(resourceRecord.openFiles, 'openFiles'),
    coreBytes: assertByteCount(resourceRecord.coreBytes, 'coreBytes'),
    writableBytes: assertByteCount(
      resourceRecord.writableBytes,
      'writableBytes',
    ),
  });
  if (resources.memoryBytes === 0n) {
    throw makeError(X`slice policy memoryBytes must be positive`);
  }

  const mountList = record.mounts;
  if (!Array.isArray(mountList) || mountList.length === 0) {
    throw makeError(X`slice policy must declare its exact mount table`);
  }
  const mounts = harden(mountList.map(assertPolicyMount));
  const roles = new Set();
  const destinations = new Set();
  const sources = new Set();
  let writable = 0n;
  for (const mount of mounts) {
    if (roles.has(mount.role)) {
      throw makeError(
        X`slice policy mount role ${q(mount.role)} is duplicated`,
      );
    }
    roles.add(mount.role);
    if (destinations.has(mount.destination)) {
      throw makeError(
        X`slice policy mount destination ${q(mount.destination)} is duplicated`,
      );
    }
    destinations.add(mount.destination);
    if (mount.kind === 'volume') {
      if (sources.has(mount.source)) {
        throw makeError(
          X`slice policy volume ${q(mount.source)} is mounted twice`,
        );
      }
      sources.add(mount.source);
    }
    writable += mount.sizeBytes;
  }
  // The aggregate ceiling is the sum of the per-mount ceilings, not an
  // independent number: nothing enforces a total that no single mount
  // is bounded by, so a request whose parts do not add up to its whole
  // is asking for a control the host cannot apply.
  if (writable !== resources.writableBytes) {
    throw makeError(
      X`slice policy writableBytes ${q(resources.writableBytes)} does not equal the sum of its writable mounts ${q(writable)}`,
    );
  }

  const attestationArgv = record.attestationArgv;
  if (
    !Array.isArray(attestationArgv) ||
    attestationArgv.length === 0 ||
    attestationArgv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
  ) {
    throw makeError(
      X`slice policy attestationArgv must be a non-empty argv from the pinned image`,
    );
  }

  return harden({
    profile: SLICE_POLICY_PROFILE,
    imageDigest,
    uid,
    gid,
    brokerSidecar,
    resources,
    mounts,
    attestationArgv: harden([...attestationArgv]),
  });
};
harden(assertSlicePolicyRequest);

/**
 * The `--network` value that joins the slice to the broker's prepared
 * namespace. `none` would mint a fresh empty namespace the broker has
 * no listener in; joining is what makes loopback-only reachability and
 * a single provider peer the same fact.
 *
 * @param {SlicePolicyRequest['brokerSidecar']} sidecar
 * @returns {string}
 */
export const brokerNetworkArg = sidecar =>
  Object.hasOwn(sidecar, 'netnsPath')
    ? `ns:${/** @type {{ netnsPath: string }} */ (sidecar).netnsPath}`
    : `container:${/** @type {{ container: string }} */ (sidecar).container}`;
harden(brokerNetworkArg);

/**
 * Translate a validated policy into the container-create flags every
 * operation in the slice runs under.
 *
 * The result is the whole policy-bearing prefix: the driver appends
 * only naming, labelling, environment, and the operation's own argv, so
 * the configuration this function produces is the configuration the
 * attestation observes and the configuration every operation gets.
 *
 * @param {SlicePolicyRequest} policy
 * @param {{ seccompProfilePath?: string | null }} [extras]
 * @returns {string[]}
 */
export const assemblePolicyArgv = (policy, extras = {}) => {
  const { resources } = policy;
  /** @type {string[]} */
  const argv = [
    '--user',
    `${policy.uid}:${policy.gid}`,
    // Namespaces are named explicitly rather than left to the runtime
    // default so the attestation can read a definite value back instead
    // of an empty string that means "whatever this host does".
    '--userns',
    'private',
    '--pid',
    'private',
    '--ipc',
    'private',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--read-only',
    // Every writable path is declared below; the runtime's convenience
    // tmpfs set would add undeclared ones.
    '--read-only-tmpfs=false',
    '--network',
    brokerNetworkArg(policy.brokerSidecar),
    '--memory',
    `${resources.memoryBytes}`,
    // Equal memory and memory+swap ceilings leave no swap for the slice
    // to spill into, so the memory ceiling is the whole ceiling.
    '--memory-swap',
    `${resources.memoryBytes}`,
    '--pids-limit',
    `${resources.pids}`,
    '--cpus',
    `${resources.cpuCores}`,
    '--ulimit',
    `nofile=${resources.openFiles}:${resources.openFiles}`,
    '--ulimit',
    `core=${resources.coreBytes}:${resources.coreBytes}`,
  ];
  const seccompProfilePath = extras.seccompProfilePath ?? null;
  if (seccompProfilePath !== null) {
    argv.push('--security-opt', `seccomp=${seccompProfilePath}`);
  }
  for (const mount of policy.mounts) {
    if (mount.kind === 'tmpfs') {
      argv.push(
        '--tmpfs',
        `${mount.destination}:rw,nosuid,nodev,size=${mount.sizeBytes}`,
      );
    } else {
      argv.push(
        '--volume',
        `${mount.source}:${mount.destination}:rw,nosuid,nodev`,
      );
    }
  }
  return harden(argv);
};
harden(assemblePolicyArgv);

/**
 * Read a field from a runtime inspect record, treating a missing field
 * as a failure to observe rather than as a default.
 *
 * @param {any} record
 * @param {string} path Dotted path, e.g. `HostConfig.PidsLimit`.
 * @returns {unknown}
 */
const observed = (record, path) => {
  let cursor = record;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = cursor[key];
  }
  return cursor;
};

/**
 * Fail with a uniform message so every unproved control reads the same
 * way in a provisioning log.
 *
 * @param {string} control
 * @param {unknown} [saw]
 * @returns {never}
 */
const unproved = (control, saw) => {
  throw saw === undefined
    ? makeError(X`slice policy control ${q(control)} is not enforced`)
    : makeError(
        X`slice policy control ${q(control)} is not enforced; runtime reported ${q(saw)}`,
      );
};

/**
 * Normalize the effective mount options a runtime reports. Runtimes
 * write them either as a list or as a comma-separated string, and both
 * carry bookkeeping alongside the hardening flags.
 *
 * @param {unknown} options
 * @returns {string[]}
 */
const effectiveMountOptions = options => {
  /** @type {string[]} */
  let parts;
  if (Array.isArray(options)) {
    parts = options.filter(option => typeof option === 'string');
  } else if (typeof options === 'string') {
    parts = options.split(',');
  } else {
    return [];
  }
  return parts.map(option => option.trim().split('=')[0]).filter(o => o !== '');
};

/**
 * Read the destination-keyed tmpfs map a runtime reports alongside its
 * `Mounts` array, as a plain record of option strings.
 *
 * @param {any} inspect
 * @returns {Record<string, string>}
 */
const tmpfsTable = inspect => {
  const table = observed(inspect, 'HostConfig.Tmpfs');
  if (typeof table !== 'object' || table === null) return harden({});
  /** @type {Record<string, string>} */
  const entries = {};
  for (const [destination, options] of Object.entries(table)) {
    if (typeof options === 'string') entries[destination] = options;
  }
  return harden(entries);
};

/**
 * Locate the effective mount the runtime reports at a destination,
 * across the two shapes a runtime uses: a `Mounts` array for volumes and
 * binds, and a destination-keyed tmpfs map.
 *
 * @param {any} inspect
 * @param {SlicePolicyMount} mount
 * @returns {{ source: string, options: string[], readOnly: boolean, sizeBytes: bigint | null } | null}
 */
const findEffectiveMount = (inspect, mount) => {
  if (mount.kind === 'tmpfs') {
    const entry = tmpfsTable(inspect)[mount.destination];
    if (entry !== undefined) {
      const size = entry
        .split(',')
        .find(option => option.startsWith('size='))
        ?.slice('size='.length);
      return harden({
        source: 'tmpfs',
        options: harden(effectiveMountOptions(entry)),
        readOnly: entry.split(',').includes('ro'),
        sizeBytes: size === undefined ? null : parseByteSize(size),
      });
    }
  }
  const mounts = observed(inspect, 'Mounts');
  if (!Array.isArray(mounts)) return null;
  for (const candidate of mounts) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      candidate.Destination !== mount.destination
    ) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (candidate.Type !== mount.kind) return null;
    const options = harden(effectiveMountOptions(candidate.Options));
    if (mount.kind === 'tmpfs') {
      const size = (
        Array.isArray(candidate.Options)
          ? candidate.Options
          : String(candidate.Options ?? '').split(',')
      )
        .map(String)
        .find((/** @type {string} */ option) => option.startsWith('size='))
        ?.slice('size='.length);
      return harden({
        source: 'tmpfs',
        options,
        readOnly: candidate.RW === false,
        sizeBytes: size === undefined ? null : parseByteSize(size),
      });
    }
    return harden({
      source: String(candidate.Name ?? candidate.Source ?? ''),
      options,
      readOnly: candidate.RW === false,
      // A volume's ceiling belongs to the volume, not to this mount of
      // it, so it is read from the storage driver rather than from here.
      sizeBytes: null,
    });
  }
  return null;
};

/**
 * Prove the requested mount table is the effective mount table, and
 * report it.
 *
 * @param {SlicePolicyRequest} policy
 * @param {ObservedSliceState} state
 * @returns {SlicePolicyAttestation['mounts']}
 */
const attestMounts = (policy, state) => {
  const effectiveMounts = observed(state.inspect, 'Mounts');
  const effectiveTmpfs = tmpfsTable(state.inspect);
  const declaredDestinations = new Set(
    policy.mounts.map(mount => mount.destination),
  );
  // An undeclared mount is the failure this table exists to exclude, so
  // enumerate what the runtime actually attached before matching the
  // declared entries against it. An absent list is read as an empty one:
  // the declared entries are then reported as unattached, which is the
  // same rejection by a more specific name.
  if (effectiveMounts !== undefined && !Array.isArray(effectiveMounts)) {
    return unproved('mount table', effectiveMounts);
  }
  for (const candidate of effectiveMounts ?? []) {
    const destination = /** @type {any} */ (candidate)?.Destination;
    if (typeof destination !== 'string') {
      return unproved('mount table', candidate);
    }
    if (!declaredDestinations.has(destination)) {
      return unproved('mount table', `undeclared mount at ${destination}`);
    }
    if (/** @type {any} */ (candidate).Type === 'bind') {
      // A bind is the only mount shape that can reach host state — a
      // home directory, a credential store, a runtime socket. The
      // table has none, so `hostHome` and `hostSockets` follow from
      // the absence rather than from a path blocklist.
      return unproved('mount table', `host bind mount at ${destination}`);
    }
  }
  for (const destination of Object.keys(effectiveTmpfs)) {
    if (!declaredDestinations.has(destination)) {
      return unproved('mount table', `undeclared tmpfs at ${destination}`);
    }
  }

  return harden(
    policy.mounts.map(mount => {
      const effective = findEffectiveMount(state.inspect, mount);
      if (effective === null) {
        return unproved(`mount ${mount.role}`, 'not attached');
      }
      if (effective.readOnly) {
        return unproved(`mount ${mount.role}`, 'attached read-only');
      }
      if (mount.kind === 'volume' && effective.source !== mount.source) {
        return unproved(`mount ${mount.role}`, effective.source);
      }
      const missing = REQUIRED_MOUNT_OPTIONS.filter(
        option => !effective.options.includes(option),
      );
      if (missing.length > 0) {
        return unproved(`mount ${mount.role}`, `missing ${missing.join(',')}`);
      }
      // The writable ceiling: a tmpfs carries its own `size=`, a volume
      // carries a quota the storage driver recorded against it. Neither
      // is a flag we can take on faith, so both are read back.
      const ceiling =
        mount.kind === 'tmpfs'
          ? effective.sizeBytes
          : (state.volumeQuotas.get(mount.source) ?? null);
      if (ceiling === null) {
        return unproved(`mount ${mount.role} storage ceiling`);
      }
      if (ceiling !== mount.sizeBytes) {
        return unproved(`mount ${mount.role} storage ceiling`, ceiling);
      }
      return harden({
        role: mount.role,
        source: mount.kind === 'tmpfs' ? 'tmpfs' : `volume:${mount.source}`,
        destination: mount.destination,
        mode: /** @type {const} */ ('rw'),
        options: harden(
          ATTESTED_MOUNT_OPTIONS.filter(option =>
            effective.options.includes(option),
          ),
        ),
      });
    }),
  );
};

/**
 * Derive a `SlicePolicyAttestationV1` from observed runtime and kernel
 * state, or throw naming the first control that is not proved.
 *
 * @param {SlicePolicyRequest} policy
 * @param {ObservedSliceState} state
 * @returns {SlicePolicyAttestation}
 */
export const attestSlicePolicy = (policy, state) => {
  const { inspect, resources: hostResources } = state;

  if (!state.rootless) {
    return unproved('rootless backend');
  }
  if (observed(inspect, 'State.Running') !== true) {
    return unproved('live slice anchor');
  }
  if (observed(inspect, 'HostConfig.Privileged') === true) {
    return unproved('unprivileged container');
  }

  // Identity. `--user` is echoed back verbatim; the process's own
  // reported uid/gid is what the kernel actually gave it.
  if (state.processIdentity.uid !== policy.uid) {
    return unproved('uid', state.processIdentity.uid);
  }
  if (state.processIdentity.gid !== policy.gid) {
    return unproved('gid', state.processIdentity.gid);
  }

  // Image identity: the manifest digest the runtime resolved this
  // container's image to. Deliberately not the image ID, which is the
  // digest of a different blob and would compare equal to nothing the
  // operator approved.
  const imageDigest = observed(inspect, 'ImageDigest');
  if (
    typeof imageDigest !== 'string' ||
    !IMAGE_DIGEST_PATTERN.test(imageDigest) ||
    imageDigest !== policy.imageDigest
  ) {
    return unproved('image digest', imageDigest);
  }

  // Namespaces. A runtime's own report of "private" is a restatement of
  // the flag; the kernel's answer is whether the anchor's namespace
  // links differ from the ones this process holds.
  for (const kind of /** @type {const} */ (['user', 'pid', 'ipc', 'mount'])) {
    if (state.unsharedNamespaces[kind] !== true) {
      return unproved(`${kind} namespace`);
    }
  }
  /** @type {SlicePolicyAttestation['namespaces']} */
  const namespaces = harden({
    user: /** @type {const} */ ('private'),
    pid: /** @type {const} */ ('private'),
    ipc: /** @type {const} */ ('private'),
    mount: /** @type {const} */ ('private'),
  });

  // Filesystem and privilege posture.
  if (observed(inspect, 'HostConfig.ReadonlyRootfs') !== true) {
    return unproved('read-only root');
  }
  const securityOpts = observed(inspect, 'HostConfig.SecurityOpt');
  const securityOptList = Array.isArray(securityOpts)
    ? securityOpts.map(String)
    : [];
  if (!securityOptList.some(option => option.startsWith('no-new-privileges'))) {
    return unproved('no-new-privileges', securityOptList.join(' '));
  }
  if (securityOptList.some(option => option === 'seccomp=unconfined')) {
    return unproved('seccomp', 'unconfined');
  }
  // An empty effective capability set is the kernel's answer, not the
  // `--cap-drop ALL` we asked for.
  const effectiveCaps = observed(inspect, 'EffectiveCaps');
  if (!Array.isArray(effectiveCaps) || effectiveCaps.length !== 0) {
    return unproved('dropped capabilities', effectiveCaps);
  }
  const devices = observed(inspect, 'HostConfig.Devices');
  if (!Array.isArray(devices) || devices.length !== 0) {
    return unproved('device isolation', devices);
  }

  // Network. `broker-only` is loopback plus the broker's in-namespace
  // listener and nothing else, so the proof is the interface inventory
  // of the namespace the anchor actually joined.
  const interfaces = [...state.network.interfaces].sort();
  if (interfaces.join(',') !== [...BROKER_ONLY_INTERFACES].sort().join(',')) {
    return unproved('broker-only network', interfaces.join(','));
  }
  if (state.network.routableRoutes !== 0) {
    return unproved(
      'broker-only network',
      `${state.network.routableRoutes} routable routes`,
    );
  }
  const networkNamespaceId = state.network.namespaceId;
  if (
    typeof networkNamespaceId !== 'string' ||
    !PORTABLE_NAME_PATTERN.test(networkNamespaceId)
  ) {
    return unproved('network namespace identity', networkNamespaceId);
  }

  // Resource ceilings, read back from the runtime's resolved view. A
  // host that silently ignored a flag reports the ignored value here.
  const memory = parseByteSize(observed(inspect, 'HostConfig.Memory'));
  if (memory === null || memory !== policy.resources.memoryBytes) {
    return unproved('memory ceiling', memory);
  }
  const memorySwap = parseByteSize(observed(inspect, 'HostConfig.MemorySwap'));
  if (memorySwap === null || memorySwap !== policy.resources.memoryBytes) {
    return unproved('swap ceiling', memorySwap);
  }
  if (observed(inspect, 'HostConfig.PidsLimit') !== policy.resources.pids) {
    return unproved('pid ceiling', observed(inspect, 'HostConfig.PidsLimit'));
  }
  const quota = observed(inspect, 'HostConfig.CpuQuota');
  const period = observed(inspect, 'HostConfig.CpuPeriod');
  const nanoCpus = observed(inspect, 'HostConfig.NanoCpus');
  const quotaCores =
    typeof quota === 'number' && typeof period === 'number' && period > 0
      ? quota / period
      : typeof nanoCpus === 'number' && nanoCpus > 0
        ? nanoCpus / 1e9
        : null;
  if (quotaCores !== policy.resources.cpuCores) {
    return unproved('cpu ceiling', quotaCores);
  }
  const ulimits = observed(inspect, 'HostConfig.Ulimits');
  /**
   * @param {string} name
   * @param {bigint} expected
   */
  const assertUlimit = (name, expected) => {
    if (!Array.isArray(ulimits)) return unproved(`${name} ceiling`, ulimits);
    const entry = ulimits.find(
      candidate =>
        typeof candidate?.Name === 'string' &&
        candidate.Name.replace(/^RLIMIT_/, '').toLowerCase() === name,
    );
    const soft = parseByteSize(entry?.Soft);
    const hard = parseByteSize(entry?.Hard);
    if (
      soft === null ||
      hard === null ||
      soft !== expected ||
      hard !== expected
    ) {
      return unproved(`${name} ceiling`, entry);
    }
    return expected;
  };
  assertUlimit('nofile', BigInt(policy.resources.openFiles));
  assertUlimit('core', policy.resources.coreBytes);

  // A cgroup ceiling the host cannot delegate is a ceiling nothing
  // applies, whatever the runtime echoed back.
  const missingControllers = ['memory', 'pids', 'cpu'].filter(
    controller => !hostResources.cgroupControllers.includes(controller),
  );
  if (missingControllers.length > 0) {
    return unproved('cgroup delegation', missingControllers.join(','));
  }

  const mounts = attestMounts(policy, state);

  // Descendant reaping: a private pid namespace puts every descendant,
  // however it detached itself, inside the container the driver removes,
  // and the driver's exact-label reconciliation covers the case where
  // the daemon that owned it died first.
  if (!state.descendantReaping) {
    return unproved('descendant reaping');
  }

  return harden({
    version: SLICE_POLICY_ATTESTATION_VERSION,
    profile: policy.profile,
    backend: /** @type {const} */ ('rootless-podman'),
    imageDigest,
    network: /** @type {const} */ ('broker-only'),
    networkNamespaceId,
    uid: policy.uid,
    gid: policy.gid,
    readOnlyRoot: /** @type {const} */ (true),
    noNewPrivileges: /** @type {const} */ (true),
    dropAllCapabilities: /** @type {const} */ (true),
    seccomp: /** @type {const} */ (true),
    devices: /** @type {const} */ ('none'),
    hostSockets: /** @type {const} */ ('none'),
    hostHome: /** @type {const} */ ('none'),
    descendantReaping: /** @type {const} */ (true),
    namespaces,
    limits: harden({
      memoryBytes: policy.resources.memoryBytes,
      pids: policy.resources.pids,
      cpuCores: policy.resources.cpuCores,
      openFiles: policy.resources.openFiles,
      coreBytes: policy.resources.coreBytes,
      writableBytes: policy.resources.writableBytes,
    }),
    mounts,
  });
};
harden(attestSlicePolicy);
