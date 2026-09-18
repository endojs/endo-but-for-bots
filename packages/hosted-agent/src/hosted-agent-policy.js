// @ts-check

import { Fail, makeError, q, X } from '@endo/errors';

/**
 * The machine-checkable outer sandbox contract a hosted agent runs under.
 *
 * Every adapter attests the same controls, namespaces, and limit ceilings;
 * what differs between them is only the mount table's fixed roles, which each
 * adapter declares and `makeHostedAgentPolicyVerifier` binds into its own
 * verifier.
 */
export const HOSTED_AGENT_POLICY_V1 = harden({
  version: 'HostedAgentPolicyV1',
  backend: 'rootless-podman',
  network: 'broker-only',
  uid: 1000,
  gid: 1000,
  readOnlyRoot: true,
  noNewPrivileges: true,
  dropAllCapabilities: true,
  seccomp: true,
  devices: 'none',
  hostSockets: 'none',
  hostHome: 'none',
  credentialInjection: 'broker-only',
  brokerTransport: 'loopback-sidecar',
  executionDomain: 'guest',
  descendantReaping: true,
  namespaces: harden({
    user: 'private',
    pid: 'private',
    ipc: 'private',
    mount: 'private',
  }),
  limits: harden({
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pids: 512,
    cpuCores: 4,
    openFiles: 4096,
    coreBytes: 0,
    writableBytes: 16 * 1024 * 1024 * 1024,
  }),
});
harden(HOSTED_AGENT_POLICY_V1);

const GiB = 1024n ** 3n;
const MiB = 1024n ** 2n;

/**
 * The slice resource profile every hosted adapter runs under.
 *
 * One policy anchor and one admitted operation have independent cgroups, so
 * each reserves half the aggregate memory, PID and CPU budget — which is why
 * the attested `limits` are these doubled, and why an adapter cannot pick its
 * own numbers without the hosted contract noticing.
 *
 * `writableBytes` is deliberately absent: it is not a profile constant but a
 * sum over the mount table, and `sliceWritableBytes` computes it.
 */
export const HOSTED_SLICE_RESOURCES = harden({
  memoryBytes: 2n * GiB,
  pids: 256,
  cpuCores: 2,
  openFiles: 4096,
  coreBytes: 0n,
  shmBytes: 64n * MiB,
  maxConcurrentOperations: 1,
});
harden(HOSTED_SLICE_RESOURCES);

/**
 * The argv every hosted slice's policy anchor runs.
 *
 * The anchor is a container that exists to be read: the driver attests the
 * slice's namespaces, identity and mount table of its PID 1 and each
 * operation joins it. It has to block, and it has to end when the daemon's
 * cgroup is told to stop.
 *
 * `/bin/sleep infinity` alone does the first and not the second. A
 * container's PID 1 receives no signal it has not installed a handler for —
 * the kernel's rule for init — so a bare `sleep` ignores SIGTERM, and
 * systemd's stop of `endo-daemon` waited its full `TimeoutStopSec` on every
 * anchor before SIGKILLing them all (observed on every stop from 2026-09-16
 * to 2026-09-18: 90 s, `Failed with result 'timeout'`). The shell installs
 * the handler, backgrounds the sleep so it is an ordinary process the shell
 * may kill, and `wait` is what blocks. The anchor then ends within a second
 * of the cgroup SIGTERM, conmon exits with it, and the daemon's stop takes
 * as long as the daemon takes.
 *
 * This is the whole of the decision the design recorded as open — whether
 * graceful daemon termination should await native release. It does not: the
 * daemon exits, systemd ends the cgroup, and the runtime's exact-label orphan
 * sweep on the next start reclaims what the kernel left. Awaiting native
 * release across every live slice on SIGTERM would need a bound and a
 * failure mode of its own, and the containment barrier is the cgroup either
 * way.
 *
 * Every pinned image has `/bin/sh` and `/bin/sleep`; the driver refuses an
 * argv that does not keep the anchor running while it is read.
 */
export const HOSTED_ANCHOR_ARGV = harden([
  '/bin/sh',
  '-c',
  'sleep infinity & trap "kill $!" TERM INT; wait',
]);
harden(HOSTED_ANCHOR_ARGV);

/**
 * What a slice can actually write, summed over what it was given.
 *
 * A tmpfs counts twice because the anchor and an admitted operation each get
 * one; shm likewise. A volume counts once — it is shared. An `attach` or a
 * `bind` counts for nothing: those bytes belong to a capability or to the
 * host, which bounds them where they live, and attesting a ceiling here would
 * attest one nothing enforces.
 *
 * The attestation recomputes this from the table it observed, so a number that
 * disagrees is refused rather than believed.
 *
 * @param {readonly {kind: string, sizeBytes?: bigint}[]} mounts
 * @param {bigint} [shmBytes]
 */
export const sliceWritableBytes = (
  mounts,
  shmBytes = HOSTED_SLICE_RESOURCES.shmBytes,
) =>
  mounts.reduce(
    (sum, mount) =>
      sum + (mount.sizeBytes ?? 0n) * (mount.kind === 'tmpfs' ? 2n : 1n),
    2n * shmBytes,
  );
harden(sliceWritableBytes);

/**
 * The key a declared runtime attach is known by. It names the attach's row
 * in the attested table (`attach:<key>`) and its mount role
 * (`attach-<key>`), so it is held to a role's alphabet. The floot attach
 * registrar derives keys as content hashes of (client, cap, inner path).
 */
const ATTACH_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** A role a profile fixes: the same alphabet, since it names a row too. */
const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
/**
 * Where a mount may land in the slice: an absolute, normal, bounded path.
 * Every segment must begin with an alphanumeric, which is what rejects `..`.
 *
 * An attach was once held to `/mnt/` alone, "so it can never shadow a role
 * the profile fixes elsewhere in the table" — a proxy for a property, resting
 * on the accident that no fixed role lived there. The property itself is now
 * checked directly, at both layers: no destination may nest with any other,
 * fixed or attached (`@endo/sandbox`'s `assertSlicePolicyRequest`, and
 * `assertAttaches` below). That is strictly stronger than the prefix rule —
 * it also closes attach-against-attach nesting, which `/mnt/` never covered —
 * and it is what lets a fixed role such as `/workspace` be capability-backed.
 */
const INNER_PATH_PATTERN = /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const ATTACH_DESTINATION_PATTERN = INNER_PATH_PATTERN;
/** The host mountpoint an attach binds: absolute, normal, bounded. */
const ATTACH_SOURCE_PATTERN = /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;

/**
 * Two destinations nest when one is the other or lies beneath it. Both would
 * be declared and both attested, but the attested table has no ordering, so
 * it could not say which projection the slice actually sees at the shadowed
 * path — a record that cannot describe the result.
 *
 * @param {string} a
 * @param {string} b
 */
/** Where a public-network session's generated nameserver file lands. */
const RESOLVER_DESTINATION = '/etc/resolv.conf';

const nests = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * @typedef {object} HostedFixedMount
 * @property {string} role The row's name in the attested table.
 * @property {'session' | 'tmpfs'} kind How the hosted policy names its source:
 * a `session` role is durable and named `<role>:<sessionId>`, so the record
 * carries no host path; a `tmpfs` role is named for what it is. This is the
 * hosted naming, not the slice's provisioning: whether the host backs a
 * session role with a quota volume or a 9P attach is the host's business and
 * does not change what the session was told it has.
 * @property {string} destination
 * @property {'ro' | 'rw'} mode
 */

/**
 * Validate an adapter's declared fixed roles. Held to the same shape as the
 * attested table they will be checked against, so a malformed declaration is
 * refused where it is written rather than becoming an expectation no attested
 * table could ever match.
 *
 * @param {unknown} candidates
 * @returns {readonly HostedFixedMount[]}
 */
export const assertFixedMounts = candidates => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw makeError(X`hosted agent profile must declare its fixed mounts`);
  }
  const roles = new Set();
  /** @type {string[]} */
  const destinations = [];
  /** @type {HostedFixedMount[]} */
  const validated = [];
  for (const candidate of candidates) {
    (typeof candidate === 'object' &&
      candidate !== null &&
      Object.keys(candidate).sort().join(',') ===
        'destination,kind,mode,role') ||
      Fail`fixed mount has unknown or missing fields`;
    const { role, kind, destination, mode } = candidate;
    (typeof role === 'string' && ROLE_PATTERN.test(role)) ||
      Fail`fixed mount role ${q(role)} is not a portable role name`;
    // `resolver` is added by the verifier from the network policy, and an
    // `attach-` row is a runtime attach; neither may be claimed as fixed.
    (role !== 'resolver' && !role.startsWith('attach-')) ||
      Fail`fixed mount role ${q(role)} is reserved`;
    kind === 'session' ||
      kind === 'tmpfs' ||
      Fail`fixed mount ${q(role)} kind must be "session" or "tmpfs"`;
    (typeof destination === 'string' && INNER_PATH_PATTERN.test(destination)) ||
      Fail`fixed mount ${q(role)} destination must be an absolute normal path`;
    mode === 'ro' ||
      mode === 'rw' ||
      Fail`fixed mount ${q(role)} mode must be "ro" or "rw"`;
    !roles.has(role) || Fail`fixed mount role ${q(role)} is duplicated`;
    for (const taken of destinations) {
      !nests(destination, taken) ||
        Fail`fixed mount destination ${q(destination)} nests with ${q(taken)}`;
    }
    roles.add(role);
    destinations.push(destination);
    validated.push(harden({ role, kind, destination, mode }));
  }
  return harden(validated);
};
harden(assertFixedMounts);

/**
 * Validate the runtime attaches a session spec declares
 * (designs/runtime-container-fs-mount.md). Each names a host 9P
 * mountpoint an operator-held bridge minted for a capability the session
 * holds, a destination in the slice, and a mode. The slice binds each as a
 * `kind: 'attach'` policy mount, and the sandbox attestation proves the
 * bind is a 9P projection rather than host data.
 *
 * Runs at every boundary the spec crosses — the resource provisioner, the
 * slice factory, and the backend factory's authority handoff — so no layer
 * trusts the one before it to have looked.
 *
 * @param {unknown} candidates
 * @param {readonly HostedFixedMount[]} [fixedMounts] The profile's fixed
 * roles, so an attach that would shadow one is refused here rather than
 * further in.
 * @returns {readonly { key: string, source: string, destination: string, mode: 'ro' | 'rw' }[]}
 */
export const assertAttaches = (candidates, fixedMounts = []) => {
  if (candidates === undefined) return harden([]);
  if (!Array.isArray(candidates)) {
    throw makeError(X`containerMounts must be an array`);
  }
  const keys = new Set();
  /** @type {string[]} */
  const destinations = [];
  const sources = new Set();
  /** @type {{ key: string, source: string, destination: string, mode: 'ro' | 'rw' }[]} */
  const validated = [];
  // Iterated, not mapped: `map` skips array holes, so a sparse input would
  // return a list whose `length` counts entries no check ever saw — and
  // that length is what the attested table is sized against.
  for (const candidate of candidates) {
    (typeof candidate === 'object' &&
      candidate !== null &&
      Object.keys(candidate).sort().join(',') ===
        'destination,key,mode,source') ||
      Fail`container mount has unknown or missing fields`;
    const { key, source, destination, mode } = candidate;
    (typeof key === 'string' && ATTACH_KEY_PATTERN.test(key)) ||
      Fail`container mount key ${q(key)} is not a portable key`;
    (typeof source === 'string' && ATTACH_SOURCE_PATTERN.test(source)) ||
      Fail`container mount ${q(key)} source must be an absolute normal host mountpoint`;
    (typeof destination === 'string' &&
      ATTACH_DESTINATION_PATTERN.test(destination)) ||
      Fail`container mount ${q(key)} destination must be an absolute normal path`;
    mode === 'ro' ||
      mode === 'rw' ||
      Fail`container mount ${q(key)} mode must be "ro" or "rw"`;
    !keys.has(key) || Fail`container mount key ${q(key)} is duplicated`;
    !sources.has(source) ||
      Fail`container mount source ${q(source)} is mounted twice`;
    // An attach may not land on, or inside, a role the profile fixes. This
    // is what the old `/mnt/`-only rule stood in for, said directly.
    for (const fixed of fixedMounts) {
      !nests(destination, fixed.destination) ||
        Fail`container mount ${q(key)} destination ${q(destination)} shadows the ${q(fixed.role)} role at ${q(fixed.destination)}`;
    }
    !destinations.includes(destination) ||
      Fail`container mount destination ${q(destination)} is duplicated`;
    // Nor may one destination sit inside another: the attested table has no
    // ordering, so it could not say which projection wins at a shadowed path.
    for (const taken of destinations) {
      !nests(destination, taken) ||
        Fail`container mount destination ${q(destination)} nests with ${q(taken)}`;
    }
    keys.add(key);
    destinations.push(destination);
    sources.add(source);
    validated.push(harden({ key, source, destination, mode }));
  }
  return harden(validated);
};
harden(assertAttaches);

/**
 * Bind the shared hosted-agent attestation checks to one adapter's profile.
 *
 * The contract itself — controls, namespaces, limit ceilings, the exactness
 * of every field — is the same for all three adapters. What an adapter brings
 * is its fixed mount table: which durable roles its CLI needs and where they
 * land. The verifier admits that table, the resolver row when the session's
 * network policy calls for it, and exactly the runtime attaches the session
 * declared — nothing else.
 *
 * @param {{ fixedMounts: unknown }} profile
 */
export const makeHostedAgentPolicyVerifier = profile => {
  const fixedMounts = assertFixedMounts(profile?.fixedMounts);

  /**
   * Validate the runtime attaches a session declared, against this profile's
   * fixed roles.
   *
   * @param {unknown} candidates
   */
  const assertContainerMounts = candidates =>
    assertAttaches(candidates, fixedMounts);
  harden(assertContainerMounts);

  /**
   * Assert the machine-checkable outer sandbox contract required before a
   * hosted CLI may run with its inner approval prompts disabled.
   *
   * The mount table is the profile's fixed roles plus exactly the runtime
   * attaches `requirements.containerMounts` declares, each reported as
   * `attach:<key>` in its declared mode. An attach the table carries but the
   * requirements do not, or the reverse, is the undeclared mount this check
   * exists to refuse.
   *
   * @param {any} policy
   * @param {{ imageDigest?: string, sessionId?: string, containerMounts?: unknown, networkPolicy?: string }} [requirements]
   */
  const assertHostedAgentPolicyV1 = (policy, requirements = {}) => {
    const expected = HOSTED_AGENT_POLICY_V1;
    const publicNetwork = requirements.networkPolicy === 'public-internet';
    !publicNetwork ||
      policy?.networkPolicy === 'public-internet' ||
      Fail`Sandbox public network policy missing`;
    const containerMounts = assertContainerMounts(requirements.containerMounts);
    if (publicNetwork) {
      // The resolver row is the verifier's, not the profile's, so
      // `assertContainerMounts` cannot see it — but an attach that shadowed
      // it would hand the slice a nameserver file no bridge minted.
      for (const attach of containerMounts) {
        !nests(attach.destination, RESOLVER_DESTINATION) ||
          Fail`container mount ${q(attach.key)} destination ${q(attach.destination)} shadows the resolver at ${q(RESOLVER_DESTINATION)}`;
      }
    }
    const imageDigest = policy?.imageDigest;
    if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest || '')) {
      throw makeError(X`hosted agent image must be pinned by SHA-256 digest`);
    }
    if (requirements.imageDigest && imageDigest !== requirements.imageDigest) {
      throw makeError(X`hosted agent image digest is not operator-approved`);
    }
    if (
      typeof policy?.sessionId !== 'string' ||
      policy.sessionId === '' ||
      (requirements.sessionId && policy.sessionId !== requirements.sessionId)
    ) {
      throw makeError(X`sandbox attestation has the wrong session identity`);
    }
    for (const key of [
      'version',
      'backend',
      'network',
      'uid',
      'gid',
      'readOnlyRoot',
      'noNewPrivileges',
      'dropAllCapabilities',
      'seccomp',
      'devices',
      'hostSockets',
      'hostHome',
      'credentialInjection',
      'brokerTransport',
      'executionDomain',
      'descendantReaping',
    ]) {
      if (policy?.[key] !== expected[key]) {
        throw makeError(X`sandbox policy field ${q(key)} is not enforced`);
      }
    }
    for (const [key, value] of Object.entries(expected.namespaces)) {
      if (policy?.namespaces?.[key] !== value) {
        throw makeError(X`sandbox namespace ${q(key)} is not private`);
      }
    }
    for (const [key, value] of Object.entries(expected.limits)) {
      if (key === 'writableBytes') {
        const actual = policy?.limits?.writableBytes;
        if (
          typeof actual !== 'number' ||
          !Number.isInteger(actual) ||
          actual <= 0 ||
          actual > value
        ) {
          throw makeError(X`sandbox writable byte ceiling is not enforced`);
        }
      } else if (policy?.limits?.[key] !== value) {
        throw makeError(X`sandbox limit ${q(key)} is not enforced`);
      }
    }
    const expectedTopLevelKeys = [
      ...Object.keys(expected),
      'imageDigest',
      'mounts',
      'networkNamespaceId',
      'sessionId',
      ...(publicNetwork ? ['networkPolicy'] : []),
    ].sort();
    if (
      Object.keys(policy || {})
        .sort()
        .join(',') !== expectedTopLevelKeys.join(',')
    ) {
      throw makeError(X`sandbox attestation has unknown or missing fields`);
    }
    if (
      Object.keys(policy.namespaces).sort().join(',') !==
      Object.keys(expected.namespaces).sort().join(',')
    ) {
      throw makeError(X`sandbox namespace attestation is not exact`);
    }
    if (
      Object.keys(policy.limits).sort().join(',') !==
      Object.keys(expected.limits).sort().join(',')
    ) {
      throw makeError(X`sandbox limit attestation is not exact`);
    }
    if (
      typeof policy.networkNamespaceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(policy.networkNamespaceId)
    ) {
      throw makeError(X`sandbox network namespace identity is invalid`);
    }
    const mounts = policy?.mounts;
    if (!Array.isArray(mounts)) {
      throw makeError(X`sandbox policy omitted its effective mount table`);
    }
    const expectedMounts = harden({
      ...Object.fromEntries(
        fixedMounts.map(mount => [
          mount.role,
          harden({
            // A durable role is named by session, so the record carries no
            // host path: how the host provides the bytes is the host's
            // business, and the role is what an audit entry refers to.
            source:
              mount.kind === 'session'
                ? `${mount.role}:${policy.sessionId}`
                : 'tmpfs',
            destination: mount.destination,
            mode: mount.mode,
          }),
        ]),
      ),
      ...(publicNetwork
        ? {
            resolver: harden({
              source: 'resolver:public',
              destination: RESOLVER_DESTINATION,
              mode: 'ro',
            }),
          }
        : {}),
      ...Object.fromEntries(
        containerMounts.map(attach => [
          `attach-${attach.key}`,
          harden({
            source: `attach:${attach.key}`,
            destination: attach.destination,
            mode: attach.mode,
          }),
        ]),
      ),
    });
    // Counted against the table this function actually expects, rather than
    // a literal that would silently desynchronize if a fixed role were ever
    // added — at which point the table would become unattestable.
    if (mounts.length !== Object.keys(expectedMounts).length) {
      throw makeError(X`sandbox attestation contains an undeclared mount`);
    }
    const seenRoles = new Set();
    for (const mount of mounts) {
      if (
        typeof mount?.role !== 'string' ||
        !Object.hasOwn(expectedMounts, mount.role)
      ) {
        throw makeError(X`sandbox mount table is not the exact session table`);
      }
      const expectedMount = expectedMounts[mount?.role];
      if (
        !expectedMount ||
        seenRoles.has(mount.role) ||
        Object.keys(mount || {})
          .sort()
          .join(',') !== 'destination,mode,options,role,source' ||
        mount.source !== expectedMount.source ||
        mount.destination !== expectedMount.destination ||
        mount.mode !== expectedMount.mode ||
        !Array.isArray(mount.options) ||
        [...mount.options].sort().join(',') !== 'nodev,nosuid'
      ) {
        throw makeError(X`sandbox mount table is not the exact session table`);
      }
      seenRoles.add(mount.role);
    }
    if (seenRoles.size !== Object.keys(expectedMounts).length) {
      throw makeError(X`sandbox mount table omitted a required role`);
    }
    return harden({ ...policy, mounts: harden([...mounts]) });
  };
  harden(assertHostedAgentPolicyV1);

  /**
   * Restate a slice's own attestation as this profile's hosted policy, so it
   * can be checked a second time at the authority handoff.
   *
   * The slice proves its confinement to the runtime. This proves the same
   * slice is the one this session was promised: the same controls, this
   * session's roles, and limits that are the per-cgroup halves the runtime
   * reported, doubled — one cgroup for the policy anchor and one for an
   * admitted operation.
   *
   * Sources are renamed by role rather than carried across. A durable role
   * becomes `<role>:<sessionId>` and an attach becomes `attach:<key>`, so the
   * hosted record holds no host path: where the bytes sit is the host's
   * business, and the role is what an audit entry refers to.
   *
   * @param {object} input
   * @param {any} input.attestation The slice's `policy()`.
   * @param {string} input.sessionId
   * @param {string} input.credentialInjection From the broker's evidence.
   * @param {string} input.brokerTransport From the broker's evidence.
   * @param {string} input.executionDomain From runtime verification.
   * @param {string} [input.networkPolicy]
   */
  const hostedPolicyFromSlice = ({
    attestation,
    sessionId,
    credentialInjection,
    brokerTransport,
    executionDomain,
    networkPolicy,
  }) => {
    const { limits, mounts } = attestation;
    const controls = Object.fromEntries(
      Object.entries(attestation).filter(
        ([key]) => !['version', 'profile', 'limits', 'mounts'].includes(key),
      ),
    );
    const durable = new Set(
      fixedMounts
        .filter(mount => mount.kind === 'session')
        .map(mount => mount.role),
    );
    return harden({
      ...controls,
      version: HOSTED_AGENT_POLICY_V1.version,
      sessionId,
      ...(networkPolicy ? { networkPolicy } : {}),
      credentialInjection,
      brokerTransport,
      executionDomain,
      limits: {
        memoryBytes: Number(limits.memoryBytes * 2n),
        pids: limits.pids * 2,
        cpuCores: limits.cpuCores * 2,
        openFiles: limits.openFiles,
        coreBytes: Number(limits.coreBytes),
        writableBytes: Number(limits.writableBytes),
      },
      mounts: mounts.map((/** @type {any} */ mount) => ({
        ...mount,
        source: durable.has(mount.role)
          ? `${mount.role}:${sessionId}`
          : mount.role === 'resolver'
            ? 'resolver:public'
            : mount.role.startsWith('attach-')
              ? `attach:${mount.role.slice('attach-'.length)}`
              : mount.source,
      })),
    });
  };
  harden(hostedPolicyFromSlice);

  return harden({
    fixedMounts,
    assertContainerMounts,
    assertHostedAgentPolicyV1,
    hostedPolicyFromSlice,
  });
};
harden(makeHostedAgentPolicyVerifier);
