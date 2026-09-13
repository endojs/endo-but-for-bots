// @ts-check

/**
 * Adapter-agnostic primitives of a hosted session plan: the passive record a
 * daemon-owned session's controller activates and its storage owner removes.
 * Each CLI adapter composes these into its own parser with its own field
 * list; nothing here defaults a field.
 *
 * @module
 */

import { readMountPrograms } from '@endo/9p-server/mount-caplet.js';
import { Fail, q } from '@endo/errors';
import { assertNativePodmanProfile } from '@endo/sandbox/native-podman-profile.js';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

/**
 * The recorded deployment resource profile. JSON carries no bigint, so the two
 * OCI int64 quantities travel as decimal digit strings and are widened by
 * `readNativeProfile`.
 * @typedef {object} PlanNativeProfile
 * @property {number} uid
 * @property {number} gid
 * @property {string} memoryBytes
 * @property {string} cpuQuotaMicros
 * @property {number} pids
 * @property {number} cpuPeriodMicros
 * @property {number} maxConcurrentOperations
 */

/**
 * The operator's rootless mount settings, recorded verbatim as the subset of
 * the 9P mount caplet's environment a session's own mounter receives.
 * @typedef {object} MounterEnv
 * @property {'1'} [NINEP_SUDO]
 * @property {string} [NINEP_MOUNT_PROGRAM]
 * @property {string} [NINEP_UMOUNT_PROGRAM]
 */

const NATURAL_TEXT = /^(0|[1-9][0-9]*)$/;

/**
 * The plan is the parser's input edge for operator resource settings: refuse
 * anything but the exact recorded shape, with no defaults, before any scope
 * is acquired. The sandbox factory checks the same profile again at its own
 * boundary on every actual Podman operation.
 * @param {unknown} value
 */
export const readNativeProfile = value => {
  (typeof value === 'object' && value !== null) || Fail`Missing native profile`;
  const { memoryBytes, cpuQuotaMicros, ...counts } =
    /** @type {Record<string, unknown>} */ (value);
  for (const quantity of [memoryBytes, cpuQuotaMicros]) {
    (typeof quantity === 'string' && NATURAL_TEXT.test(quantity)) ||
      Fail`Native profile quantities must be decimal digit strings`;
  }
  return assertNativePodmanProfile(
    harden({
      ...counts,
      memoryBytes: BigInt(/** @type {string} */ (memoryBytes)),
      cpuQuotaMicros: BigInt(/** @type {string} */ (cpuQuotaMicros)),
    }),
  );
};
harden(readNativeProfile);

/**
 * Whether `child` is `parent` or lies beneath it, on already-normalized
 * absolute paths; aliases are the caller's concern.
 * @param {string} parent
 * @param {string} child
 */
export const containsPath = (parent, child) =>
  parent === child || child.startsWith(`${parent}/`);
harden(containsPath);

/**
 * The one spelling every host path in a hosted session's records accepts:
 * absolute, already normalized, not the root, no trailing separator, no NUL.
 * Callers keep their own refusal message.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isNormalizedAbsolutePath = value =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  normalize(value) === value &&
  value !== '/' &&
  !value.endsWith('/') &&
  !value.includes('\0');
harden(isNormalizedAbsolutePath);

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
export const readRecordedPath = (name, value) => {
  if (!isNormalizedAbsolutePath(value)) {
    throw Fail`Session plan requires a recorded absolute path for ${q(name)}`;
  }
  return value;
};
harden(readRecordedPath);

const MOUNTER_ENV_KEYS = harden([
  'NINEP_SUDO',
  'NINEP_MOUNT_PROGRAM',
  'NINEP_UMOUNT_PROGRAM',
]);

/**
 * Validate recorded mounter settings exactly as the mount caplet would at
 * construction, so setup and the plan writer refuse what a session start
 * would otherwise fail on. Only the three named keys are admitted: the
 * per-session socket directory is the controller's, never recorded here.
 * @param {unknown} value
 * @returns {MounterEnv}
 */
export const readMounterEnv = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw Fail`Mounter settings must be a record`;
  }
  const settings = /** @type {Record<string, unknown>} */ (value);
  for (const [name, setting] of Object.entries(settings)) {
    MOUNTER_ENV_KEYS.includes(name) || Fail`Unknown mounter setting ${q(name)}`;
    (typeof setting === 'string' &&
      setting !== '' &&
      !setting.includes('\0')) ||
      Fail`Mounter setting ${q(name)} must be non-empty text`;
  }
  settings.NINEP_SUDO === undefined ||
    settings.NINEP_SUDO === '1' ||
    Fail`Mounter setting "NINEP_SUDO" must be "1" when present`;
  /** @type {MounterEnv} */
  const mounterEnv = harden({ ...settings });
  readMountPrograms(mounterEnv);
  return mounterEnv;
};
harden(readMounterEnv);

/**
 * Deterministic sandbox session id: a bounded lowercase path component
 * derived from the Floot session id, so a later create, destroy, or resume
 * addresses the same recorded storage and slice names.
 *
 * @param {string} name
 * @param {string} [fallback] The slug when nothing of the name survives; an
 *   adapter keeps its own so recorded ids do not change under it.
 */
export const makeSandboxSessionId = (name, fallback = 'session') => {
  const slug =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || fallback;
  const digest = createHash('sha256')
    .update(String(name))
    .digest('hex')
    .slice(0, 12);
  return `${slug}-${digest}`;
};
harden(makeSandboxSessionId);
