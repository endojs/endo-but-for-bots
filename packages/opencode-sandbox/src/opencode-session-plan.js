// @ts-check

import { readMountPrograms } from '@endo/9p-server/mount-caplet.js';
import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail, q } from '@endo/errors';
import { assertNativePodmanProfile } from '@endo/sandbox/native-podman-profile.js';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

/**
 * The recorded deployment resource profile. JSON carries no bigint, so the two
 * OCI int64 quantities travel as decimal digit strings and are widened here.
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
 * The approved plan for one logical session, recorded passively by the daemon
 * owner and read again by the native controller at activation and by the
 * storage owner at removal. Every path is host storage this plan owns; none
 * may contain another, and the controller's guest never sees these strings.
 * @typedef {object} MounterEnv
 * The operator's rootless mount settings, recorded verbatim as the subset of
 * the 9P mount caplet's environment a session's own mounter receives.
 * @property {'1'} [NINEP_SUDO]
 * @property {string} [NINEP_MOUNT_PROGRAM]
 * @property {string} [NINEP_UMOUNT_PROGRAM]
 */

/**
 * @typedef {object} SessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs Explicit effective image; no environment fallback.
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} [workspaceDir] Owned backing storage the workspace
 *   filesystem serves; absent when the workspace is an operator-supplied host
 *   path that this session's storage owner must never remove.
 * @property {string} [workspaceHostPath] The operator-supplied workspace the
 *   controller projects instead; recorded so a later request cannot silently
 *   rebind the session to different storage, and disjoint from every other
 *   recorded path so the guest never sees its own sockets or mount point.
 *   Never removed.
 * @property {string} workspaceMountPoint Kernel mount, distinct from backing storage.
 * @property {string} mcpDir Private, recorded native socket/relay directory.
 * @property {string} mounterSocketDir Private 9P socket parent, never guest-visible.
 * @property {ReturnType<typeof assertNativePodmanProfile>} nativeProfile
 * @property {MounterEnv} [mounterEnv] Absent means the host's `mount`/`umount`.
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [opencodeSessionId]
 */

/**
 * The plan as recorded: the same fields with the two OCI quantities still in
 * their decimal-string form. `readSessionPlan` widens it into a `SessionPlan`.
 * @typedef {Omit<SessionPlan, 'nativeProfile'> & { nativeProfile: PlanNativeProfile }} RecordedSessionPlan
 */

const NATURAL_TEXT = /^(0|[1-9][0-9]*)$/;
const NETWORK_POLICIES = harden(['off', 'public-internet']);
const RECORDED_PATHS = harden([
  'workspaceMountPoint',
  'mcpDir',
  'mounterSocketDir',
]);
const OPTIONAL_PATHS = harden(['workspaceDir', 'workspaceHostPath']);
const OPTIONAL_TEXT = harden(['model', 'systemPrompt', 'opencodeSessionId']);

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
 * The one spelling every host path in this package accepts: absolute,
 * already normalized, not the root, no trailing separator, no NUL. Callers
 * keep their own refusal message.
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
const readRecordedPath = (name, value) => {
  if (!isNormalizedAbsolutePath(value)) {
    throw Fail`Session plan requires a recorded absolute path for ${q(name)}`;
  }
  return value;
};

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
 * Parse recorded plan text. The result is the only plan shape the controller
 * activates and the storage owner removes; both refuse anything else rather
 * than defaulting a field.
 * @param {string} text
 * @returns {SessionPlan}
 */
export const readSessionPlan = text => {
  const value = JSON.parse(text);
  assertCopyData(harden(value));
  (typeof value === 'object' && value !== null && !Array.isArray(value)) ||
    Fail`Session plan must be a record`;
  /** @type {Record<string, unknown>} */
  const recorded = value;
  for (const name of ['sessionId', 'sandboxSessionId', 'rootfs']) {
    (typeof recorded[name] === 'string' && recorded[name] !== '') ||
      Fail`Missing session plan field ${q(name)}`;
  }
  NETWORK_POLICIES.includes(/** @type {string} */ (recorded.networkPolicy)) ||
    Fail`Unknown session plan network policy`;
  for (const name of OPTIONAL_TEXT) {
    recorded[name] === undefined ||
      typeof recorded[name] === 'string' ||
      Fail`Session plan field ${q(name)} must be text`;
  }
  /** @type {[string, string][]} */
  const paths = [];
  for (const name of [...RECORDED_PATHS, ...OPTIONAL_PATHS]) {
    if (OPTIONAL_PATHS.includes(name) && recorded[name] === undefined) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const nativePath = readRecordedPath(name, recorded[name]);
    for (const [otherName, other] of paths) {
      (!containsPath(other, nativePath) && !containsPath(nativePath, other)) ||
        Fail`Session plan paths ${q(otherName)} and ${q(name)} must be disjoint`;
    }
    paths.push([name, nativePath]);
  }
  if (recorded.workspaceHostPath !== undefined) {
    recorded.workspaceDir === undefined ||
      Fail`Session plan cannot record both an owned and an operator-supplied workspace`;
  } else {
    recorded.workspaceDir !== undefined ||
      Fail`Session plan must record an owned or an operator-supplied workspace`;
  }
  const nativeProfile = readNativeProfile(recorded.nativeProfile);
  const mounterEnv =
    recorded.mounterEnv === undefined
      ? undefined
      : readMounterEnv(recorded.mounterEnv);
  return harden(
    /** @type {SessionPlan} */ ({
      ...recorded,
      nativeProfile,
      ...(mounterEnv === undefined ? {} : { mounterEnv }),
    }),
  );
};
harden(readSessionPlan);

/**
 * Deterministic sandbox session id: a bounded lowercase path component
 * derived from the Floot session id, so a later create, destroy, or resume
 * addresses the same recorded storage and slice names.
 *
 * @param {string} name
 */
export const makeSandboxSessionId = name => {
  const slug =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'opencode';
  const digest = createHash('sha256')
    .update(String(name))
    .digest('hex')
    .slice(0, 12);
  return `${slug}-${digest}`;
};
harden(makeSandboxSessionId);
