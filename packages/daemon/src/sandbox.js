// @ts-check

/**
 * The `sandbox` formula's daemon-side logic: profile validation, mount
 * projection, slice construction, and escalation telemetry.
 *
 * Everything here is platform-neutral. The two effects a slice actually
 * needs — a sandbox backend (bwrap / podman) and a 9P mount projector —
 * arrive as injected functions through the `DaemonicPowers` host-tool
 * seam (`host-tool-powers.js`), the same way `git` and `shell` receive
 * theirs, so the XS daemon bundle never sees `node:child_process`.
 *
 * ## What a slice is, and what survives a restart
 *
 * A slice is a live confined process namespace: a container or a bwrap
 * child, its bind mounts, and any 9P bridge sockets holding a projected
 * mount open. None of that is durable. The formula persists only the
 * *profile* — which mounts, which backend, which network posture — and
 * re-mints the slice on the first `provide()` after a restart. Processes
 * that were running are gone, their streams are closed, and no work is
 * replayed: a caller that needs a job to survive a restart must record
 * the job somewhere durable (a mount) and re-issue it.
 *
 * ## Why a slice is an escalation
 *
 * Every other daemon capability is confined by construction. A slice is
 * not: it runs native code the daemon did not compile, with OS-level
 * effects the object-capability graph cannot describe. So the profile
 * carries an explicit `escalation` — the reason the caller needs to
 * leave the graph, and the capability that asked — and every mint
 * records it, both in the diagnostics facet and as one line on stderr.
 */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { Far } from '@endo/pass-style';

/** @import { FormulaIdentifier, SandboxEscalationRecord, SandboxFormulaProfile, SandboxMountProjection } from './types.js' */

/**
 * Why a caller needs to leave the object-capability graph. The three
 * reasons are exhaustive by design: a request that fits none of them
 * does not need a slice.
 *
 * - `OS_EFFECT` — the work is an operating-system effect (a process
 *   tree, a signal, a device) that no confined capability expresses.
 * - `RESOURCE_LIMIT` — the work needs kernel-enforced resource bounds
 *   (cgroups, `prlimit`) rather than cooperative ones.
 * - `NATIVE_IMPLEMENTATION` — the implementation is native code the
 *   daemon neither compiled nor can confine in-process.
 *
 * @type {readonly string[]}
 */
export const sandboxEscalationReasons = harden([
  'OS_EFFECT',
  'RESOURCE_LIMIT',
  'NATIVE_IMPLEMENTATION',
]);

// The ladders below mirror `@endo/sandbox`'s own interface guards
// (`packages/sandbox/src/interfaces.js`). They are restated rather than
// imported because the daemon core must not depend on the sandbox
// package: the backend reaches the core through the host-tool seam. The
// factory re-checks every value at `make()` time, so a drift here costs
// a late error, never a widened profile.
const sandboxNetworkProfiles = harden([
  'none',
  'private',
  'host-loopback',
  'host-lan',
  'host-net',
]);

const sandboxBackendSelectors = harden([
  'auto',
  'bwrap',
  'podman',
  'lima',
  'containerization',
  'wsl',
]);

const sandboxMountModes = harden(['ro', 'rw']);

const sandboxLimitKeys = harden([
  'as',
  'cpu',
  'nproc',
  'nofile',
  'fsize',
  'core',
]);

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const requireNonEmptyString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw makeError(X`provideSandbox: ${q(label)} must be a non-empty string`);
  }
  return value;
};

/**
 * A slice's inner paths are namespace-absolute: the driver bind-mounts
 * onto them, and a relative path would resolve against whatever the
 * driver's own working directory happens to be. Reject one here rather
 * than persist a profile whose every incarnation fails at the driver.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const requireInnerPath = (value, label) => {
  const path = requireNonEmptyString(value, label);
  if (!path.startsWith('/')) {
    throw makeError(
      X`provideSandbox: ${q(label)} must be an absolute path inside the slice, got ${q(path)}`,
    );
  }
  return path;
};

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} label
 * @returns {string}
 */
const requireMember = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw makeError(
      X`provideSandbox: ${q(label)} must be one of ${q(allowed)}, got ${q(value)}`,
    );
  }
  return value;
};

/**
 * @param {unknown} env
 * @returns {Record<string, string>}
 */
const normalizeEnv = env => {
  /** @type {Record<string, string>} */
  const normalized = {};
  if (env === undefined) {
    return normalized;
  }
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw makeError(
      X`provideSandbox: profile.env must be a record of string values`,
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw makeError(
        X`provideSandbox: profile.env[${q(key)}] must be a string`,
      );
    }
    normalized[key] = value;
  }
  return normalized;
};

/**
 * @param {unknown} limits
 * @returns {Record<string, number> | undefined}
 */
const normalizeLimits = limits => {
  if (limits === undefined) {
    return undefined;
  }
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw makeError(
      X`provideSandbox: profile.limits must be a record of resource caps`,
    );
  }
  /** @type {Record<string, number>} */
  const normalized = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!sandboxLimitKeys.includes(key)) {
      throw makeError(
        X`provideSandbox: profile.limits[${q(key)}] is not a recognized resource cap; expected one of ${q(sandboxLimitKeys)}`,
      );
    }
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
      throw makeError(
        X`provideSandbox: profile.limits[${q(key)}] must be a non-negative integer`,
      );
    }
    normalized[key] = /** @type {number} */ (value);
  }
  return normalized;
};

/**
 * Validate a caller-supplied sandbox profile and normalize it into the
 * frozen record the `sandbox` formula persists.
 *
 * Mount capabilities do not survive into a formula, so each is resolved
 * to its formula identifier here, at the host boundary where the
 * daemon-private cap-to-id table is reachable. Rejecting a malformed
 * profile up front means a doomed formula is never persisted — the same
 * contract as `normalizeShellPolicy` and `normalizeHttpClientPolicy`.
 *
 * @param {unknown} profile
 * @param {object} powers
 * @param {(cap: unknown, label: string) => FormulaIdentifier} powers.resolveMountId
 * @returns {SandboxFormulaProfile}
 */
export const normalizeSandboxProfile = (profile, { resolveMountId }) => {
  if (!profile || typeof profile !== 'object') {
    throw makeError(X`provideSandbox: profile must be an object`);
  }
  const {
    rootfs,
    mounts,
    network,
    backend,
    seccomp,
    env,
    cwd,
    limits,
    escalation,
  } = /** @type {Record<string, unknown>} */ (profile);

  // Rootfs: either one of the tagged records the drivers understand, or
  // a mount capability rooted at a userland tree. The discrimination
  // matches the factory's own (`packages/sandbox/src/factory.js`
  // `resolveRootfs`): a record carries a `kind`, a capability does not.
  if (rootfs === undefined || rootfs === null) {
    throw makeError(X`provideSandbox: profile.rootfs is required`);
  }
  /** @type {SandboxFormulaProfile['rootfs']} */
  let normalizedRootfs;
  if (
    typeof rootfs === 'object' &&
    typeof (/** @type {any} */ (rootfs).kind) === 'string'
  ) {
    const { kind, ref } = /** @type {Record<string, unknown>} */ (rootfs);
    if (kind === 'host-bind' || kind === 'minimal') {
      normalizedRootfs = harden({ kind });
    } else if (kind === 'oci') {
      normalizedRootfs = harden({
        kind: /** @type {'oci'} */ ('oci'),
        ref: requireNonEmptyString(ref, 'profile.rootfs.ref'),
      });
    } else {
      throw makeError(
        X`provideSandbox: profile.rootfs.kind must be one of ${q(['host-bind', 'minimal', 'oci'])}, got ${q(kind)}`,
      );
    }
  } else {
    normalizedRootfs = harden({
      kind: /** @type {'mount'} */ ('mount'),
      mountId: resolveMountId(rootfs, 'profile.rootfs'),
    });
  }

  /** @type {SandboxFormulaProfile['mounts'][number][]} */
  const normalizedMounts = [];
  if (mounts !== undefined) {
    if (!Array.isArray(mounts)) {
      throw makeError(X`provideSandbox: profile.mounts must be an array`);
    }
    for (const [index, mount] of mounts.entries()) {
      if (!mount || typeof mount !== 'object') {
        throw makeError(
          X`provideSandbox: profile.mounts[${q(index)}] must be a record`,
        );
      }
      const { cap, innerPath, mode } = /** @type {Record<string, unknown>} */ (
        mount
      );
      normalizedMounts.push(
        harden({
          mountId: resolveMountId(cap, `profile.mounts[${index}].cap`),
          innerPath: requireInnerPath(
            innerPath,
            `profile.mounts[${index}].innerPath`,
          ),
          mode: /** @type {'ro' | 'rw'} */ (
            mode === undefined
              ? 'ro'
              : requireMember(
                  mode,
                  sandboxMountModes,
                  `profile.mounts[${index}].mode`,
                )
          ),
        }),
      );
    }
  }

  if (!escalation || typeof escalation !== 'object') {
    throw makeError(
      X`provideSandbox: profile.escalation is required; state why this work must leave the capability graph (${q(sandboxEscalationReasons)}) and which capability asked`,
    );
  }
  const { reason, capability } = /** @type {Record<string, unknown>} */ (
    escalation
  );
  const normalizedEscalation = harden({
    reason: /** @type {import('./types.js').SandboxEscalationReason} */ (
      requireMember(
        reason,
        sandboxEscalationReasons,
        'profile.escalation.reason',
      )
    ),
    capability: requireNonEmptyString(
      capability,
      'profile.escalation.capability',
    ),
  });

  // Seccomp: the profile-blob form (`{ profile }`) is deliberately not
  // accepted. A blob is not a passable the formula can carry across a
  // restart without a place to store it, and a slice that silently came
  // back with a *different* seccomp policy than it was minted with would
  // be worse than one that refuses.
  const normalizedSeccomp =
    seccomp === undefined
      ? 'default'
      : requireMember(
          seccomp,
          harden(['default', 'unconfined']),
          'profile.seccomp',
        );

  return harden({
    rootfs: normalizedRootfs,
    mounts: harden(normalizedMounts),
    network: /** @type {SandboxFormulaProfile['network']} */ (
      network === undefined
        ? 'none'
        : requireMember(network, sandboxNetworkProfiles, 'profile.network')
    ),
    backend: /** @type {SandboxFormulaProfile['backend']} */ (
      backend === undefined
        ? 'auto'
        : requireMember(backend, sandboxBackendSelectors, 'profile.backend')
    ),
    seccomp: /** @type {'default' | 'unconfined'} */ (normalizedSeccomp),
    env: harden(normalizeEnv(env)),
    ...(cwd !== undefined && {
      cwd: requireInnerPath(cwd, 'profile.cwd'),
    }),
    ...(limits !== undefined && { limits: harden(normalizeLimits(limits)) }),
    escalation: normalizedEscalation,
  });
};
harden(normalizeSandboxProfile);

/**
 * The daemon's escalation ledger: one record per slice mint, plus one
 * line on stderr.
 *
 * This is deliberately not a metrics system. It answers one question an
 * operator reading a daemon's logs actually asks — *what asked for a
 * sandbox, and why?* — and keeps a bounded window of the answers for the
 * diagnostics facet. A mint is not a happy path: it is the moment the
 * daemon hands out authority the capability graph cannot describe, so it
 * is worth a line even though library code is otherwise silent.
 *
 * @param {object} [options]
 * @param {number} [options.limit] Records retained; older ones are
 *   dropped. The ledger is an operator aid, not an audit log of record.
 */
export const makeSandboxEscalationLog = ({ limit = 128 } = {}) => {
  /** @type {SandboxEscalationRecord[]} */
  const records = [];

  /**
   * @param {SandboxEscalationRecord} entry
   * @returns {SandboxEscalationRecord}
   */
  const record = entry => {
    const frozen = harden({ ...entry });
    records.push(frozen);
    while (records.length > limit) {
      records.shift();
    }
    const projections = frozen.projections
      .map(({ innerPath, kind }) => `${innerPath}=${kind}`)
      .join(' ');
    console.error(
      `[endo sandbox] ${frozen.sandboxId} minted a slice: escalation ${frozen.reason} requested by ${frozen.capability}; backend ${frozen.backend}; network ${frozen.network}; mounts ${projections || '(none)'}`,
    );
    return frozen;
  };

  /** @returns {SandboxEscalationRecord[]} */
  const list = () => harden([...records]);

  return harden({ record, list });
};
harden(makeSandboxEscalationLog);

/**
 * Mint the live slice a `sandbox` formula evaluates to.
 *
 * The privileged parts are all injected, which is also what makes this
 * testable without a container runtime: a test supplies a fake factory
 * and a fake projector and observes the composition.
 *
 * @param {object} args
 * @param {SandboxFormulaProfile} args.profile
 * @param {FormulaIdentifier} args.sandboxId
 * @param {string} args.statePath Per-slice scratch/mountpoint root.
 * @param {(mountId: FormulaIdentifier) => Promise<unknown>} args.provideMount
 * @param {{ projectMount: (cap: unknown, options: object) => Promise<any> }} args.projector
 * @param {(powers: unknown, context: unknown, options?: object) => Promise<any>} args.makeSandboxFactory
 * @param {(path: string) => Promise<unknown>} args.makePath
 * @param {(...components: string[]) => string} args.joinPath
 * @param {{ record: (entry: SandboxEscalationRecord) => unknown }} args.escalations
 * @param {(cap: unknown, mode: 'ro' | 'rw', innerPath: string) => void} [args.assertMountGrant]
 *   Reincarnation-time gate on each resolved mount, e.g. refusing a
 *   writable bind over a read-only mount.
 * @param {unknown} [args.farContext] Cancellation context handed to the
 *   sandbox factory, which disposes every live slice when it settles.
 * @param {Record<string, string>} [args.env] Daemon-process environment
 *   the drivers read their own configuration from.
 * @param {unknown} [args.projectionPowers] The daemon-side half of a
 *   single-endpoint projection. Omitted when the supervisor supplies none, in
 *   which case `projectEndpoint` refuses rather than the slice silently
 *   getting a wider network profile.
 * @returns {Promise<{ slice: unknown, release: () => Promise<void> }>}
 */
export const makeSandboxSlice = async ({
  profile,
  sandboxId,
  statePath,
  provideMount,
  projector,
  makeSandboxFactory,
  makePath,
  joinPath,
  escalations,
  assertMountGrant = () => {},
  farContext,
  env = {},
  projectionPowers,
}) => {
  /** @type {Array<{ innerPath: string, projection: any }>} */
  const projections = [];
  const hostPathForCap = new Map();

  /**
   * Release every kernel mount this slice's projections created, most
   * recent first. Best-effort by construction: `release()` reports its
   * own failures rather than throwing, so one busy mount cannot strand
   * the rest.
   */
  const releaseProjections = async () => {
    for (const { projection } of [...projections].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await projection.release();
    }
    projections.length = 0;
  };

  try {
    // Project each granted mount to a host path the driver can bind: the
    // mount's own directory when the daemon minted it over one, a 9P
    // projection when it did not (a peer-hosted mount, say, whose bytes
    // live on another node).
    let index = 0;
    /**
     * @param {FormulaIdentifier} mountId
     * @param {string} innerPath
     * @param {'ro' | 'rw'} mode
     */
    const project = async (mountId, innerPath, mode) => {
      const cap = await provideMount(mountId);
      assertMountGrant(cap, mode, innerPath);
      const projection = await projector.projectMount(cap, {
        mountPoint: joinPath(statePath, 'mnt', `${index}`),
        readOnly: mode === 'ro',
        label: innerPath,
      });
      index += 1;
      projections.push({ innerPath, projection });
      hostPathForCap.set(cap, projection.hostPath);
      return cap;
    };

    /** @type {unknown} */
    let rootfsArg;
    if (profile.rootfs.kind === 'mount') {
      rootfsArg = await project(profile.rootfs.mountId, '/', 'ro');
    } else {
      rootfsArg = harden({ ...profile.rootfs });
    }

    /** @type {Array<{ cap: unknown, innerPath: string, mode: 'ro' | 'rw' }>} */
    const mountArgs = [];
    for (const mount of profile.mounts) {
      // Sequential: each projection may stand up a kernel mount, and a
      // failure halfway through must leave a set we can unwind, not a
      // race between concurrent `mount(8)` invocations.
      // eslint-disable-next-line no-await-in-loop
      const cap = await project(mount.mountId, mount.innerPath, mount.mode);
      mountArgs.push(
        harden({ cap, innerPath: mount.innerPath, mode: mount.mode }),
      );
    }

    // The slice's writable upper layer. Ephemeral like the slice itself:
    // it is re-created empty when the formula reincarnates.
    const scratchPath = joinPath(statePath, 'scratch');
    await makePath(scratchPath);
    const scratchToken = Far('SandboxScratch', {});

    // The factory's whole privileged surface, narrowed to this slice:
    // it can resolve the mounts this formula declared and its own
    // scratch, and nothing else. A factory that asked for the host path
    // of some other daemon-minted mount is refused here, which is the
    // difference between `provideSandbox` and handing a worker the
    // host's `provideHostPath`.
    const scratchProvider = Far('SandboxMountResolver', {
      provideScratchMount: async () => scratchToken,
      /** @param {unknown} cap */
      provideHostPath: async cap => {
        if (cap === scratchToken) {
          return scratchPath;
        }
        const hostPath = hostPathForCap.get(cap);
        if (hostPath === undefined) {
          throw makeError(
            X`sandbox ${q(sandboxId)} was not granted this mount; only mounts named in its profile are resolvable`,
          );
        }
        return hostPath;
      },
    });

    const factory = await makeSandboxFactory(scratchProvider, farContext, {
      env,
      ownerId: sandboxId,
      ...(projectionPowers === undefined ? {} : { projectionPowers }),
    });

    const slice = await E(factory).make(
      harden({
        rootfs: rootfsArg,
        mounts: harden(mountArgs),
        network: profile.network,
        backend: profile.backend,
        seccomp: profile.seccomp,
        env: profile.env,
        ...(profile.cwd !== undefined && { cwd: profile.cwd }),
        ...(profile.limits !== undefined && { limits: profile.limits }),
      }),
    );

    escalations.record(
      harden({
        sandboxId,
        reason: profile.escalation.reason,
        capability: profile.escalation.capability,
        backend: profile.backend,
        network: profile.network,
        projections: harden(
          projections.map(({ innerPath, projection }) =>
            harden({
              innerPath,
              kind: /** @type {SandboxMountProjection} */ (projection.kind),
            }),
          ),
        ),
      }),
    );

    const release = async () => {
      try {
        await E(slice).dispose();
      } catch (error) {
        console.error(`[endo sandbox] ${sandboxId} dispose failed`, error);
      }
      await releaseProjections();
    };

    return harden({ slice, release });
  } catch (error) {
    // Unwind the projections this attempt stood up; a half-built slice
    // must not leave kernel mounts behind.
    await releaseProjections();
    throw error;
  }
};
harden(makeSandboxSlice);
