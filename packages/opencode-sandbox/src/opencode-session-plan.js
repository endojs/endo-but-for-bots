// @ts-check

import { assertCopyData } from '@endo/daemon/copy-data.js';
import { Fail, q } from '@endo/errors';
import { assertNativePodmanProfile } from '@endo/sandbox/native-podman-profile.js';
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
 * @typedef {object} SessionPlan
 * @property {string} sessionId
 * @property {string} sandboxSessionId
 * @property {string} rootfs Explicit effective image; no environment fallback.
 * @property {'off' | 'public-internet'} networkPolicy
 * @property {string} workspaceDir Backing storage the workspace filesystem serves.
 * @property {string} workspaceMountPoint Kernel mount, distinct from backing storage.
 * @property {string} mcpDir Private, recorded native socket/relay directory.
 * @property {string} mounterSocketDir Private 9P socket parent, never guest-visible.
 * @property {ReturnType<typeof assertNativePodmanProfile>} nativeProfile
 * @property {string} [model]
 * @property {string} [systemPrompt]
 * @property {string} [opencodeSessionId]
 */

const NATURAL_TEXT = /^(0|[1-9][0-9]*)$/;
const NETWORK_POLICIES = harden(['off', 'public-internet']);
const RECORDED_PATHS = harden([
  'workspaceDir',
  'workspaceMountPoint',
  'mcpDir',
  'mounterSocketDir',
]);
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
 * @param {string} parent
 * @param {string} child
 */
const contains = (parent, child) =>
  parent === child || child.startsWith(`${parent}/`);

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
  /** @type {string[]} */
  const paths = [];
  for (const name of RECORDED_PATHS) {
    const nativePath = readRecordedPath(name, recorded[name]);
    for (const [index, other] of paths.entries()) {
      (!contains(other, nativePath) && !contains(nativePath, other)) ||
        Fail`Session plan paths ${q(RECORDED_PATHS[index])} and ${q(name)} must be disjoint`;
    }
    paths.push(nativePath);
  }
  const nativeProfile = readNativeProfile(recorded.nativeProfile);
  return harden(/** @type {SessionPlan} */ ({ ...recorded, nativeProfile }));
};
harden(readSessionPlan);
