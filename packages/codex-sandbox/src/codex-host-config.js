// @ts-check

/**
 * The one reader of the Codex host configuration blob.
 *
 * Codex is configured by a single JSON document rather than by the
 * `ENDO_CLAUDE_*` / `ENDO_OPENCODE_*` variables the other two adapters take,
 * and until now nothing parsed it: `JSON.parse(env.CODEX_HOST_CONFIG || '{}')`
 * handed whatever came out straight to the composition, so a missing key became
 * `undefined` deep inside a provisioner and a misspelled one silently selected
 * a default. Every setup entry point and the backend caplet itself read the
 * configuration through here, so a deployment is refused at setup with the
 * offending key named rather than per session with a stack trace.
 *
 * This reader validates *shape*. Placement, ownership and image pinning belong
 * to the host and are checked by `hosted-runtime-setup.js` and
 * `@endo/hosted-agent/hosted-setup.js` where they can reach the filesystem.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { readMounterEnv } from '@endo/hosted-agent/session-plan.js';
import { PORTABLE_NAME_PATTERN } from '@endo/sandbox/policy.js';
import { isAbsolute, normalize } from 'node:path';

import { readPinnedSliceImage } from './codex-image-reference.js';

/**
 * Every key a configuration may carry. An unknown key is a typo or a setting
 * from a version this code cannot honour; either way, silently ignoring it
 * would enable something other than what the operator wrote.
 */
const KNOWN_KEYS = harden([
  'accountRef',
  'diagnostics',
  'directory',
  'filesystem',
  'flockPath',
  'imageRef',
  'listenerImageRef',
  'maxSessions',
  'models',
  'mounterEnv',
  'ownerId',
  'projectIds',
  'publicInternet',
  'quotaCommand',
  'secretPath',
  'stateBytes',
  'sudoPath',
  'volumeRoot',
]);

const LISTENER_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const PET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MiB = 1024n ** 2n;

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
const assertNormalizedAbsolutePath = (key, value) => {
  (typeof value === 'string' &&
    value.length > 0 &&
    isAbsolute(value) &&
    normalize(value) === value &&
    value !== '/') ||
    Fail`Codex ${b(key)} must be a normalized, absolute, non-root path, got ${q(value)}`;
  return /** @type {string} */ (value);
};

/**
 * Byte budgets travel as decimal strings because JSON has no bigint and the
 * limits are MiB-aligned gibibyte-scale values. A number here would be a
 * configuration that silently lost precision.
 * @param {string} key
 * @param {unknown} value
 * @returns {bigint}
 */
const assertByteBudget = (key, value) => {
  (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) ||
    Fail`Codex ${b(key)} must be a positive decimal byte count written as a string, got ${q(value)}`;
  const bytes = BigInt(/** @type {string} */ (value));
  bytes % MiB === 0n ||
    Fail`Codex ${b(key)} must be MiB-aligned, got ${q(value)}`;
  return bytes;
};

/**
 * @param {unknown} value
 * @returns {{ first: number, last: number }}
 */
const assertProjectIds = value => {
  const refuse = () => {
    throw Fail`Codex ${b('projectIds')} must be {first, last} with 0 < first < last <= 4294967295, got ${q(value)}`;
  };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'first,last'
  ) {
    return refuse();
  }
  const { first, last } = /** @type {{ first: unknown, last: unknown }} */ (
    value
  );
  if (
    typeof first !== 'number' ||
    typeof last !== 'number' ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first <= 0 ||
    last <= first ||
    last > 0xffff_ffff
  ) {
    return refuse();
  }
  return harden({ first, last });
};

/**
 * The models Floot offers on this backend. Ids reach the broker policy, so an
 * id that is not a plain provider model name is refused here rather than
 * becoming an admitted route.
 * @param {unknown} value
 */
const assertModels = value => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw Fail`Codex ${b('models')} must be a non-empty array of at most 64 entries`;
  }
  for (const model of value) {
    (model &&
      typeof model === 'object' &&
      typeof model.id === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.id)) ||
      Fail`Codex ${b('models')} entries need a plain provider model id, got ${q(model)}`;
  }
  return harden(value.map(model => harden({ ...model })));
};

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const assertSecretPath = value => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    !value.every(
      name => typeof name === 'string' && PET_NAME_PATTERN.test(name),
    )
  ) {
    throw Fail`Codex ${b('secretPath')} must be a pet name path, got ${q(value)}`;
  }
  return harden([...value]);
};

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
const assertFlag = (key, value) => {
  typeof value === 'boolean' ||
    Fail`Codex ${b(key)} must be a boolean, got ${q(value)}`;
  return /** @type {boolean} */ (value);
};

/**
 * Parse and validate one Codex host configuration document.
 *
 * @param {unknown} input The parsed JSON document.
 * @returns {{
 *   accountRef: string,
 *   diagnostics: boolean,
 *   directory: string,
 *   filesystem: string,
 *   flockPath: string,
 *   imageRef: string,
 *   imageDigest: string,
 *   listenerImageRef: string,
 *   maxSessions: number,
 *   models: readonly any[],
 *   mounterEnv: Record<string, string>,
 *   ownerId: string,
 *   projectIds: { first: number, last: number },
 *   publicInternet: boolean,
 *   quotaCommand: string,
 *   secretPath: readonly string[],
 *   sudoPath: string,
 *   volumeLimits: { stateBytes: bigint },
 *   volumeRoot: string,
 * }}
 */
export const readCodexHostConfig = input => {
  (input && typeof input === 'object' && !Array.isArray(input)) ||
    Fail`Codex host configuration must be a JSON object`;
  const config = /** @type {Record<string, unknown>} */ (input);
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.includes(key));
  unknown.length === 0 ||
    Fail`Codex host configuration has unknown keys ${q(unknown)}; a setting this version cannot honour must not be silently ignored`;

  const { imageRef, imageDigest } = readPinnedSliceImage(
    /** @type {string} */ (config.imageRef ?? ''),
  );

  const listenerImageRef = config.listenerImageRef;
  if (
    typeof listenerImageRef !== 'string' ||
    !LISTENER_IMAGE_PATTERN.test(listenerImageRef)
  ) {
    throw Fail`Codex ${b('listenerImageRef')} must be a lowercase, digest-pinned image reference, got ${q(listenerImageRef)}`;
  }

  const accountRef = config.accountRef;
  if (typeof accountRef !== 'string' || !ACCOUNT_REF_PATTERN.test(accountRef)) {
    throw Fail`Codex ${b('accountRef')} must pin one account, got ${q(accountRef)}`;
  }

  // The Podman reconciliation label, the volume registry's recorded owner, and
  // the listener's lock name. Derived from the host identity at setup rather
  // than in the caplet, because the caplet no longer holds `@agent` to ask. A
  // registry already recording another owner refuses outright, so this is
  // effectively immutable once a deployment has run one session.
  const ownerId = config.ownerId;
  if (typeof ownerId !== 'string' || !PORTABLE_NAME_PATTERN.test(ownerId)) {
    throw Fail`Codex ${b('ownerId')} must match ${q(PORTABLE_NAME_PATTERN)}, got ${q(ownerId)}`;
  }

  const maxSessions = config.maxSessions;
  if (
    typeof maxSessions !== 'number' ||
    !Number.isInteger(maxSessions) ||
    maxSessions <= 0 ||
    maxSessions > 64
  ) {
    throw Fail`Codex ${b('maxSessions')} must be a positive integer of at most 64, got ${q(maxSessions)}`;
  }

  return harden({
    accountRef,
    diagnostics:
      config.diagnostics === undefined
        ? false
        : assertFlag('diagnostics', config.diagnostics),
    directory: assertNormalizedAbsolutePath('directory', config.directory),
    filesystem: assertNormalizedAbsolutePath('filesystem', config.filesystem),
    flockPath: assertNormalizedAbsolutePath(
      'flockPath',
      config.flockPath ?? '/usr/bin/flock',
    ),
    imageRef,
    imageDigest,
    listenerImageRef,
    maxSessions,
    models: assertModels(config.models),
    ownerId,
    projectIds: assertProjectIds(config.projectIds),
    publicInternet:
      config.publicInternet === undefined
        ? false
        : assertFlag('publicInternet', config.publicInternet),
    quotaCommand: assertNormalizedAbsolutePath(
      'quotaCommand',
      config.quotaCommand,
    ),
    secretPath:
      config.secretPath === undefined
        ? harden(['secrets', 'codex-subscription-auth'])
        : assertSecretPath(config.secretPath),
    sudoPath: assertNormalizedAbsolutePath(
      'sudoPath',
      config.sudoPath ?? '/usr/bin/sudo',
    ),
    // The operator's mount and umount programs. A session's workspace is a 9P
    // projection, so the host needs them exactly as the other two adapters
    // do; `readMounterEnv` is their reader, not a second one.
    mounterEnv:
      config.mounterEnv === undefined
        ? harden({})
        : readMounterEnv(config.mounterEnv),
    // Only the CLI's own home is a quota-backed volume; the workspace is a
    // 9P projection of a tree the host already holds.
    volumeLimits: harden({
      stateBytes: assertByteBudget('stateBytes', config.stateBytes),
    }),
    volumeRoot: assertNormalizedAbsolutePath('volumeRoot', config.volumeRoot),
  });
};
harden(readCodexHostConfig);

/**
 * Read the configuration out of a formula or process environment.
 * @param {Record<string, string | undefined>} env
 * @param {string} [name]
 */
export const readCodexHostConfigEnv = (env, name = 'CODEX_HOST_CONFIG') => {
  const text = env[name];
  (typeof text === 'string' && text.length > 0) || Fail`${b(name)} is required`;
  let parsed;
  try {
    parsed = JSON.parse(/** @type {string} */ (text));
  } catch (error) {
    throw Fail`${b(name)} is not valid JSON: ${q(/** @type {Error} */ (error).message)}`;
  }
  return readCodexHostConfig(parsed);
};
harden(readCodexHostConfigEnv);
