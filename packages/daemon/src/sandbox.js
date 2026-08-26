// @ts-check

/**
 * The `sandbox` formula's profile layer: validating and normalizing a
 * caller-supplied profile into the frozen record the formula persists, the
 * escalation ledger every mint writes to, and the predicate that decides
 * whether a granted mount may be bound directly rather than served over 9P.
 * Minting the live slice from a normalized profile is `sandbox-slice.js`.
 *
 * Every other daemon capability is confined by construction; a slice is not,
 * so the profile carries an explicit `escalation` that every mint records.
 */

import { Fail, makeError, q, X } from '@endo/errors';
import { M, mustMatch } from '@endo/patterns';
import {
  BackendSelectorShape,
  EnvShape,
  MountModeShape,
  NetworkProfileShape,
  backendRootfsKinds,
} from '@endo/sandbox/interfaces.js';

import { getMountBacking } from './mount.js';

/** @import { Pattern } from '@endo/patterns' */
/** @import { FormulaIdentifier, SandboxEscalationReason, SandboxEscalationRecord, SandboxFormulaProfile } from './types.js' */

/**
 * Why a caller needs to leave the object-capability graph. The three reasons
 * are exhaustive by design: a request that fits none does not need a slice.
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

// The ladders are `@endo/sandbox`'s own interface guards, not restatements:
// `@endo/sandbox/interfaces.js` imports nothing but `M`, so the XS bundle
// still sees no `node:` builtin. The backend reaches the core via the seam.

const EscalationReasonShape = M.or(...sandboxEscalationReasons);

// No profile-blob form: a blob is not passable across a restart, and a slice
// that came back with a different policy is worse than one that refuses.
const SeccompShape = M.or('default', 'unconfined');

const LimitKeyShape = M.or('as', 'cpu', 'nproc', 'nofile', 'fsize', 'core');

// `@endo/patterns` has no minimum-length string matcher; this is the same
// idiom `@endo/exo-git`'s remote policy reaches for.
const NonEmptyStringShape = M.and(M.string(), M.gt(''));

export const SandboxEscalationRecordShape = M.splitRecord({
  sandboxId: M.string(),
  reason: EscalationReasonShape,
  capability: NonEmptyStringShape,
  // The driver that took the escalation, once one has been selected;
  // the profile's selector when the attempt failed before selection.
  // The distinction is legible in the record: `'auto'` here means no
  // backend was ever chosen, because a resolved slice always reports a
  // concrete driver name.
  backend: BackendSelectorShape,
  network: NetworkProfileShape,
  projections: M.arrayOf(
    M.splitRecord({
      innerPath: M.string(),
      kind: M.or('physical', '9p'),
    }),
  ),
});
harden(SandboxEscalationRecordShape);

/**
 * Test a numeric limit while retaining the caller-facing distinction between
 * JavaScript integers and safe integers. The sandbox and shell policies use
 * the former; the HTTP client policy uses the latter because its exo contract
 * does.
 *
 * The description of what a value must be stays a literal at each assertion
 * below rather than travelling as a parameter: `q()` is for the data in a
 * message, and quoting a fragment of the message itself reads as if the
 * phrase were the caller's value.
 *
 * @param {unknown} value
 * @param {number} minimum
 * @param {boolean} safe
 * @returns {boolean}
 */
const isIntegerAtLeast = (value, minimum, safe) =>
  (safe ? Number.isSafeInteger(value) : Number.isInteger(value)) &&
  /** @type {number} */ (value) >= minimum;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export const assertNonNegativeInteger = (value, label) => {
  isIntegerAtLeast(value, 0, false) ||
    Fail`${q(label)} must be a non-negative integer`;
  return /** @type {number} */ (value);
};
harden(assertNonNegativeInteger);

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ safe?: boolean }} [options]
 * @returns {number}
 */
export const assertPositiveInteger = (value, label, { safe = false } = {}) => {
  if (safe) {
    isIntegerAtLeast(value, 1, true) ||
      Fail`${q(label)} must be a positive safe integer`;
  } else {
    isIntegerAtLeast(value, 1, false) ||
      Fail`${q(label)} must be a positive integer`;
  }
  return /** @type {number} */ (value);
};
harden(assertPositiveInteger);

/**
 * `mustMatch`, but returning the specimen so a checked value reads as an
 * expression. `@endo/patterns` offers no value-returning form.
 *
 * The profile reaches this module through the `provideSandbox` method guard
 * (`interfaces.js`), which has already established that it is passable, so
 * matching against it here is safe.
 *
 * @param {unknown} value
 * @param {Pattern} shape
 * @param {string} label
 * @returns {string}
 */
const checked = (value, shape, label) => {
  mustMatch(value, shape, label);
  const stringValue = /** @type {string} */ (value);
  if (stringValue.includes('\0')) {
    throw makeError(X`${q(label)} must not contain NUL bytes`);
  }
  return stringValue;
};

/**
 * Inner paths are namespace-absolute; a relative one would resolve against
 * the driver's cwd. Reject before persisting the profile.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const requireInnerPath = (value, label) => {
  const path = checked(value, NonEmptyStringShape, `provideSandbox: ${label}`);
  // `@endo/patterns` has no string-predicate matcher — no prefix, regex, or
  // charset — so the absolute-path rule stays hand-rolled.
  if (!path.startsWith('/')) {
    throw makeError(
      X`provideSandbox: ${q(label)} must be an absolute path inside the slice, got ${q(path)}`,
    );
  }
  return path;
};

/**
 * @param {unknown} env
 * @returns {Record<string, string>}
 */
const normalizeEnv = env => {
  if (env === undefined) {
    return harden({});
  }
  mustMatch(env, EnvShape, 'provideSandbox: profile.env');
  return harden({ .../** @type {Record<string, string>} */ (env) });
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
    checked(key, LimitKeyShape, `provideSandbox: profile.limits[${q(key)}]`);
    normalized[key] = assertNonNegativeInteger(
      value,
      `provideSandbox: profile.limits[${q(key)}]`,
    );
  }
  return normalized;
};

/**
 * Validate a caller-supplied sandbox profile and normalize it into the
 * frozen record the `sandbox` formula persists.
 *
 * Mount capabilities do not survive into a formula, so each is resolved to
 * its formula identifier here, where the cap-to-id table is reachable. Same
 * contract as `normalizeShellPolicy` and `normalizeHttpClientPolicy`.
 *
 * @param {unknown} profile
 * @param {object} powers
 * @param {(cap: unknown, label: string, mode: 'ro' | 'rw') => FormulaIdentifier} powers.resolveMountId
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

  // Rootfs: a tagged record or a mount cap. Discriminated as the factory does
  // (`packages/sandbox/src/factory.js`): a record carries a `kind`.
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
        ref: checked(
          ref,
          NonEmptyStringShape,
          'provideSandbox: profile.rootfs.ref',
        ),
      });
    } else {
      throw makeError(
        X`provideSandbox: profile.rootfs.kind must be one of ${q(['host-bind', 'minimal', 'oci'])}, got ${q(kind)}`,
      );
    }
  } else {
    normalizedRootfs = harden({
      kind: /** @type {'mount'} */ ('mount'),
      mountId: resolveMountId(rootfs, 'profile.rootfs', 'ro'),
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
      const normalizedMode = /** @type {'ro' | 'rw'} */ (
        mode === undefined
          ? 'ro'
          : checked(
              mode,
              MountModeShape,
              `provideSandbox: profile.mounts[${q(index)}].mode`,
            )
      );
      normalizedMounts.push(
        harden({
          mountId: resolveMountId(
            cap,
            `profile.mounts[${index}].cap`,
            normalizedMode,
          ),
          innerPath: requireInnerPath(
            innerPath,
            `profile.mounts[${index}].innerPath`,
          ),
          mode: normalizedMode,
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
    reason: /** @type {SandboxEscalationReason} */ (
      checked(
        reason,
        EscalationReasonShape,
        'provideSandbox: profile.escalation.reason',
      )
    ),
    capability: checked(
      capability,
      NonEmptyStringShape,
      'provideSandbox: profile.escalation.capability',
    ),
  });

  const normalizedBackend = /** @type {SandboxFormulaProfile['backend']} */ (
    backend === undefined
      ? 'auto'
      : checked(
          backend,
          BackendSelectorShape,
          'provideSandbox: profile.backend',
        )
  );

  // A named backend that cannot materialise this rootfs is refused here
  // rather than at `prepareSlice`. Both are structured errors, but only
  // this one arrives before the formula is persisted, and only this one
  // can name the field the caller has to change: the driver sees a
  // resolved `SliceSpec` and can only report its own constraint. A
  // backend absent from the table — `'auto'`, or one of the
  // unimplemented names — carries no constraint, so availability stays
  // `make()`'s verdict to deliver.
  const supportedRootfsKinds = backendRootfsKinds[normalizedBackend];
  if (
    supportedRootfsKinds !== undefined &&
    !supportedRootfsKinds.includes(normalizedRootfs.kind)
  ) {
    throw makeError(
      X`provideSandbox: backend ${q(normalizedBackend)} cannot materialise rootfs kind ${q(normalizedRootfs.kind)}; it supports ${q([...supportedRootfsKinds])}`,
    );
  }

  return harden({
    rootfs: normalizedRootfs,
    mounts: harden(normalizedMounts),
    network: /** @type {SandboxFormulaProfile['network']} */ (
      network === undefined
        ? 'none'
        : checked(
            network,
            NetworkProfileShape,
            'provideSandbox: profile.network',
          )
    ),
    backend: normalizedBackend,
    seccomp: /** @type {'default' | 'unconfined'} */ (
      seccomp === undefined
        ? 'default'
        : checked(seccomp, SeccompShape, 'provideSandbox: profile.seccomp')
    ),
    env: normalizeEnv(env),
    ...(cwd !== undefined && {
      cwd: requireInnerPath(cwd, 'profile.cwd'),
    }),
    ...(limits !== undefined && { limits: harden(normalizeLimits(limits)) }),
    escalation: normalizedEscalation,
  });
};
harden(normalizeSandboxProfile);

/**
 * One record per slice mint attempt, plus one line on stderr. A mint attempt
 * is the moment the daemon assembles authority the capability graph cannot
 * describe, so it earns a line even when backend creation later fails.
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
    mustMatch(entry, SandboxEscalationRecordShape, 'sandbox escalation record');
    const frozen = harden({ ...entry });
    records.push(frozen);
    while (records.length > limit) {
      records.shift();
    }
    const projections = frozen.projections
      .map(({ innerPath, kind }) => `${innerPath}=${kind}`)
      .join(' ');
    console.error(
      `[endo sandbox] ${frozen.sandboxId} attempted a slice mint: escalation ${frozen.reason} requested by ${frozen.capability}; backend ${frozen.backend}; network ${frozen.network}; mounts ${projections || '(none)'}`,
    );
    return frozen;
  };

  /** @returns {SandboxEscalationRecord[]} */
  const list = () => harden([...records]);

  return harden({ record, list });
};
harden(makeSandboxEscalationLog);

/**
 * Enforce the daemon's mount attenuation and projection policy at mint time.
 * This is shared by production and composition tests so the two gates cannot
 * drift.
 * A physical bind is always rejected because it cannot constrain symlink
 * traversal to the mount's confinement root; 9P retains those checks.
 *
 * @param {unknown} cap
 * @param {'ro' | 'rw'} mode
 * @param {string} innerPath
 * @param {{ kind: string }} [projection]
 */
export const assertSandboxMountGrant = (cap, mode, innerPath, projection) => {
  const backing = getMountBacking(cap);
  if (mode === 'rw') {
    if (backing === undefined) {
      throw makeError(
        X`Sandbox cannot bind a mount with unknown write authority read-write at ${q(innerPath)}`,
      );
    }
    if (backing.readOnly) {
      throw makeError(
        X`Sandbox cannot bind a read-only mount read-write at ${q(innerPath)}`,
      );
    }
  }
  if (projection?.kind === 'physical') {
    throw makeError(
      X`Sandbox cannot bind ${q(innerPath)} directly; this supervisor has no kernel-enforced symlink confinement for physical mounts`,
    );
  }
};
harden(assertSandboxMountGrant);
