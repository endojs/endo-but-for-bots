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
import { Fail, b, q } from '@endo/errors';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import { assertAccountAuthority } from './account-authority.js';

import { assertCopyData } from './copy-data.js';

/**
 * The operator's rootless mount settings, recorded verbatim as the subset of
 * the 9P mount caplet's environment a session's own mounter receives.
 * @typedef {object} MounterEnv
 * @property {'1'} [NINEP_SUDO]
 * @property {string} [NINEP_MOUNT_PROGRAM]
 * @property {string} [NINEP_UMOUNT_PROGRAM]
 */

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

/**
 * Floot session ids double as pet-name and path components on the host, so
 * they are bounded to the session owner's namespace.
 */
export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
harden(SESSION_ID_PATTERN);

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export const assertSessionId = (value, label = 'Hosted') => {
  (typeof value === 'string' && SESSION_ID_PATTERN.test(value)) ||
    Fail`${b(label)} sessionId must be a bounded lowercase path component`;
  return /** @type {string} */ (value);
};
harden(assertSessionId);

const NETWORK_POLICIES = harden(['off', 'public-internet']);
const SUBSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WORKSPACE_FIELDS = harden(['workspaceDir', 'workspaceHostPath']);
/** The fields every hosted session plan records, whatever its runtime. */
const SHARED_FIELDS = harden([
  'sessionId',
  'sandboxSessionId',
  'rootfs',
  'accountRef',
  'networkPolicy',
  ...WORKSPACE_FIELDS,
  'workspaceMountPoint',
  'mounterSocketDir',
  'mounterEnv',
  'model',
  'reasoningEffort',
  'systemPrompt',
  'subscription',
]);
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * The one image field of every hosted session plan: the `oci:` reference of
 * the image the broker pinned, digest included, in the spelling the native
 * runtime admits (a registry port, no tag). A plan never selects a rootfs
 * keyword and never leaves the image to a default; the execution envelope
 * later holds the broker's evidence to this digest.
 * @param {unknown} value The recorded `rootfs`.
 * @param {string} [label] The adapter's name for messages.
 * @returns {{ rootfs: string, imageRef: string, imageDigest: string }}
 */
export const readPinnedRootfs = (value, label = 'Hosted') => {
  if (value === undefined) {
    throw Fail`Missing session plan field ${q('rootfs')}`;
  }
  if (
    typeof value !== 'string' ||
    !value.startsWith('oci:') ||
    value.length <= 4
  ) {
    throw Fail`${b(label)} plan rootfs must be an ${q('oci:<image>@<digest>')} reference`;
  }
  const imageRef = value.slice(4);
  const at = imageRef.indexOf('@');
  const imageDigest = at === -1 ? '' : imageRef.slice(at + 1);
  IMAGE_DIGEST.test(imageDigest) ||
    Fail`${b(label)} plan rootfs must be pinned to a digest, got ${q(imageRef)}`;
  PINNED_IMAGE_REFERENCE_PATTERN.test(imageRef) ||
    Fail`${b(label)} plan rootfs ${q(imageRef)} is not a pinned reference the native runtime will accept; drop the tag it was reached by and keep the digest`;
  return harden({ rootfs: value, imageRef, imageDigest });
};
harden(readPinnedRootfs);

/**
 * The placement every hosted session plan records, read the same way at
 * creation, activation and deletion: the identities, the pinned image, the
 * account authority, the network policy, the recorded paths (each a normalized absolute path,
 * pairwise disjoint), exactly one owned or operator-supplied workspace, the
 * pin, the persona, the pinned subscription and the mounter settings. Nothing
 * is defaulted, and nothing unknown is admitted: a plan with a field neither
 * this reader nor the adapter knows is refused, so a stale or misspelled
 * field cannot add storage or cleanup authority, and is recreated rather than
 * read around. An adapter reads its own fields from `recorded` and adds them
 * to `placement`.
 *
 * @param {string} text
 * @param {object} options
 * @param {string} options.label The adapter's name for messages.
 * @param {string} [options.sandboxIdFallback] The adapter's slug for sandbox
 *   id derivation.
 * @param {readonly string[]} [options.privatePaths] Further recorded private
 *   paths beyond the mount point and the 9P socket directory.
 * @param {readonly string[]} [options.fields] The adapter's own recorded
 *   fields; any other field is refused.
 * @param {(effort: string) => unknown} [options.assertEffort] The runtime's
 *   own check of a recorded effort, when it has such an axis.
 * @returns {{ placement: Record<string, any>, recorded: Record<string, any> }}
 */
export const readSessionPlacement = (
  text,
  {
    label,
    sandboxIdFallback = 'session',
    privatePaths = [],
    fields = [],
    assertEffort,
  },
) => {
  const value = JSON.parse(text);
  assertCopyData(harden(value));
  (typeof value === 'object' && value !== null && !Array.isArray(value)) ||
    Fail`Session plan must be a record`;
  /** @type {Record<string, any>} */
  const recorded = value;
  const known = new Set([...SHARED_FIELDS, ...privatePaths, ...fields]);
  for (const name of Object.keys(recorded)) {
    known.has(name) ||
      Fail`Unknown session plan field ${q(name)}; recreate this hosted session plan`;
  }
  for (const name of ['sessionId', 'sandboxSessionId']) {
    (typeof recorded[name] === 'string' && recorded[name] !== '') ||
      Fail`Missing session plan field ${q(name)}`;
  }
  assertSessionId(recorded.sessionId, label);
  recorded.sandboxSessionId ===
    makeSandboxSessionId(recorded.sessionId, sandboxIdFallback) ||
    Fail`${b(label)} sandbox identity must derive from its session`;
  NETWORK_POLICIES.includes(recorded.networkPolicy) ||
    Fail`Unknown session plan network policy`;
  /** @type {[string, string][]} */
  const paths = [];
  for (const name of [
    'workspaceMountPoint',
    ...privatePaths,
    'mounterSocketDir',
    ...WORKSPACE_FIELDS,
  ]) {
    if (WORKSPACE_FIELDS.includes(name) && recorded[name] === undefined) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const nativePath = readRecordedPath(name, recorded[name]);
    for (const [otherName, other] of paths) {
      (!containsPath(other, nativePath) && !containsPath(nativePath, other)) ||
        Fail`Session plan paths ${q(otherName)} and ${q(name)} must be disjoint; ${q(name)} overlaps ${q(otherName)}`;
    }
    paths.push([name, nativePath]);
  }
  if (recorded.workspaceHostPath !== undefined) {
    recorded.workspaceDir === undefined ||
      Fail`Session plan must record exactly one workspace; it cannot record both an owned and an operator-supplied workspace`;
  } else {
    recorded.workspaceDir !== undefined ||
      Fail`Session plan must record exactly one workspace; it must record an owned or an operator-supplied workspace`;
  }
  for (const name of ['model', 'reasoningEffort', 'systemPrompt']) {
    recorded[name] === undefined ||
      typeof recorded[name] === 'string' ||
      Fail`Session plan field ${q(name)} must be text`;
  }
  if (recorded.reasoningEffort !== undefined && assertEffort !== undefined) {
    assertEffort(recorded.reasoningEffort);
  }
  // Which of the provider's subscriptions the session uses: absent leaves it
  // to the broker's pool (`auto` is never recorded); an id pins it.
  recorded.subscription === undefined ||
    (typeof recorded.subscription === 'string' &&
      SUBSCRIPTION_ID.test(recorded.subscription) &&
      recorded.subscription !== 'auto') ||
    Fail`Session plan subscription must be a subscription id; auto is never recorded`;
  const mounterEnv =
    recorded.mounterEnv === undefined
      ? undefined
      : readMounterEnv(recorded.mounterEnv);
  const { rootfs } = readPinnedRootfs(recorded.rootfs, label);
  // The account authority the session is bound to (`account-authority.js`).
  recorded.accountRef !== undefined ||
    Fail`Missing session plan field ${q('accountRef')}`;
  const accountRef = assertAccountAuthority(recorded.accountRef, label);
  const placement = harden({
    sessionId: recorded.sessionId,
    sandboxSessionId: recorded.sandboxSessionId,
    rootfs,
    accountRef,
    networkPolicy: recorded.networkPolicy,
    ...Object.fromEntries(paths),
    ...Object.fromEntries(
      ['model', 'reasoningEffort', 'systemPrompt', 'subscription']
        .filter(name => recorded[name] !== undefined)
        .map(name => [name, recorded[name]]),
    ),
    ...(mounterEnv === undefined ? {} : { mounterEnv }),
  });
  return harden({ placement, recorded });
};
harden(readSessionPlacement);
