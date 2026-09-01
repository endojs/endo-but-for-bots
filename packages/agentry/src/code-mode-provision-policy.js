// @ts-check
/// <reference types="ses"/>

/** @import { EndoCodeModeGitAccess, EndoCodeModeProvisionPersistence, EndoCodeModeProvisionRequest, EndoCodeModeProvisionSpec, NormalizeEndoCodeModeProvisionOptions } from './code-mode-provisioning-types.js' */
/** @import { EndoGuestAuthority } from '@endo/daemon/provision.js' */

import { isName, isPetName, namePathFrom } from '@endo/daemon/pet-name.js';
import { assertNoSecretSearchParams } from '@endo/daemon/provision.js';
import { makeError, q, X } from '@endo/errors';
import { normalizeGitRemotePolicy } from '@endo/exo-git';

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const HARNESS_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/u;
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;
const ACCESS = harden(['readOnly', 'readWrite', 'historyRewrite']);
const RESERVED_BINDINGS = harden([
  'E',
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/**
 * @param {unknown} value
 * @param {string} label
 */
const plainRecord = (value, label) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw makeError(X`${q(label)} must be an ordinary copy record`);
  }
  return /** @type {Record<string, any>} */ (value);
};

/**
 * Define an own entry on an ordinary record, including for `__proto__`.
 * @param {Record<string, any>} record
 * @param {string} name
 * @param {unknown} value
 */
const defineEntry = (record, name, value) => {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

/**
 * @param {Record<string, any>} record
 * @param {string[]} allowed
 * @param {string} label
 */
const assertFields = (record, allowed, label) => {
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) {
      throw makeError(X`${q(label)} has unknown field ${q(field)}`);
    }
  }
};

/**
 * @param {string} name
 * @param {string} label
 */
const assertBinding = (name, label) => {
  if (
    !isPetName(name) ||
    !IDENTIFIER_RE.test(name) ||
    RESERVED_BINDINGS.includes(name)
  ) {
    throw makeError(
      X`${q(label)} must be a non-reserved JavaScript binding and pet name`,
    );
  }
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {EndoCodeModeGitAccess}
 */
const accessMode = (value, label) => {
  if (!ACCESS.includes(/** @type {any} */ (value))) {
    throw makeError(
      X`${q(label)} must be readOnly, readWrite, or historyRewrite`,
    );
  }
  return /** @type {EndoCodeModeGitAccess} */ (value);
};

/**
 * @param {unknown} value
 * @param {string} label
 */
const stringList = (value, label) => {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw makeError(X`${q(label)} must be an array of strings`);
  }
  return harden([...value]);
};

/**
 * Fail loud on an unresolvable or non-directory candidate, matching the
 * daemon's own `canonicalDirectory` (`@endo/daemon/src/provision/index.js`)
 * so a bad `cwd` is caught here instead of silently deferring to whichever
 * daemon-side check happens to run against a stale, non-canonical path.
 *
 * @param {string} candidate
 * @param {string} label
 */
const canonicalDirectory = async (candidate, label) => {
  await null;
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw makeError(X`${q(label)} does not exist or cannot be resolved`);
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw makeError(X`${q(label)} must resolve to a directory`);
  }
  return canonical;
};

/**
 * @param {Pick<NormalizeEndoCodeModeProvisionOptions, 'harness' | 'sessionId'>} options
 * @returns {EndoCodeModeProvisionPersistence}
 */
export const makeEndoCodeModeProvisionPersistence = options => {
  if (
    typeof options?.harness !== 'string' ||
    !HARNESS_KEY_RE.test(options.harness)
  ) {
    throw makeError(X`harness must match /^[a-z][a-z0-9-]{0,31}$/`);
  }
  if (
    typeof options?.sessionId !== 'string' ||
    options.sessionId.length === 0
  ) {
    throw makeError(X`sessionId must be a non-empty string`);
  }
  const sessionHash = createHash('sha256')
    .update(options.sessionId)
    .digest('hex');
  return harden({
    version: /** @type {4} */ (4),
    guestName: `code-mode-${options.harness}-${sessionHash}`,
  });
};
harden(makeEndoCodeModeProvisionPersistence);

/**
 * Translate code-mode conveniences into the daemon's neutral named graph.
 * Relative paths stop at this adapter. The returned request is ephemeral;
 * callers persist only its opaque `persistence` identity.
 *
 * @param {EndoCodeModeProvisionSpec | undefined} specInput
 * @param {NormalizeEndoCodeModeProvisionOptions} options
 * @returns {Promise<EndoCodeModeProvisionRequest>}
 */
export const normalizeEndoCodeModeProvisionSpec = async (
  specInput,
  options,
) => {
  await null;
  const persistence = makeEndoCodeModeProvisionPersistence(options);
  if (typeof options?.cwd !== 'string' || options.cwd.length === 0) {
    throw makeError(X`cwd must be a non-empty string`);
  }
  const spec = plainRecord(specInput ?? {}, 'EndoCodeModeProvisionSpec');
  assertFields(
    spec,
    ['mount', 'git', 'gitRemote', 'introducedNames', 'piTools'],
    'EndoCodeModeProvisionSpec',
  );
  if (spec.piTools !== undefined && spec.piTools !== 'preserve') {
    throw makeError(X`piTools must be preserve`);
  }
  const canonicalCwd = await canonicalDirectory(options.cwd, 'cwd');

  /** @type {Record<string, any>} */
  const mount = {};
  for (const [name, value] of Object.entries(
    spec.mount === undefined ? {} : plainRecord(spec.mount, 'mount'),
  )) {
    assertBinding(name, `mount.${name}`);
    const grant = plainRecord(value, `mount.${name}`);
    assertFields(grant, ['path', 'mode', 'deniedSegments'], `mount.${name}`);
    if (typeof grant.path !== 'string') {
      throw makeError(X`${q(`mount.${name}.path`)} must be a string`);
    }
    const mode = accessMode(grant.mode, `mount.${name}.mode`);
    if (mode === 'historyRewrite') {
      throw makeError(
        X`${q(`mount.${name}.mode`)} must be readOnly or readWrite`,
      );
    }
    defineEntry(
      mount,
      name,
      harden({
        path: resolve(canonicalCwd, grant.path),
        readOnly: mode === 'readOnly',
        ...(grant.deniedSegments === undefined
          ? {}
          : {
              deniedSegments: stringList(
                grant.deniedSegments,
                `mount.${name}.deniedSegments`,
              ),
            }),
      }),
    );
  }

  /** @type {Record<string, any>} */
  const git = {};
  for (const [name, value] of Object.entries(
    spec.git === undefined ? {} : plainRecord(spec.git, 'git'),
  )) {
    assertBinding(name, `git.${name}`);
    const grant = plainRecord(value, `git.${name}`);
    assertFields(grant, ['mount', 'path', 'mode'], `git.${name}`);
    if (typeof grant.mount !== 'string') {
      throw makeError(X`${q(`git.${name}.mount`)} must select a mount binding`);
    }
    const mode = accessMode(grant.mode, `git.${name}.mode`);
    defineEntry(
      git,
      name,
      harden({
        mount: grant.mount,
        path: stringList(grant.path, `git.${name}.path`),
        readOnly: mode === 'readOnly',
        allowHistoryRewrite: mode === 'historyRewrite',
      }),
    );
  }

  /** @type {Record<string, any>} */
  const gitRemote = {};
  for (const [binding, value] of Object.entries(
    spec.gitRemote === undefined
      ? {}
      : plainRecord(spec.gitRemote, 'gitRemote'),
  )) {
    assertBinding(binding, `gitRemote.${binding}`);
    const remote = plainRecord(value, `gitRemote.${binding}`);
    assertFields(
      remote,
      [
        'git',
        'name',
        'url',
        'allowedDirections',
        'fetchRefspecs',
        'pushRefspecs',
        'defaultPullRef',
        'allowedBranches',
        'allowForcePush',
        'allowTags',
        'allowDelete',
        'allowLocalFileTransport',
        'credential',
      ],
      `gitRemote.${binding}`,
    );
    if (typeof remote.git !== 'string' || typeof remote.name !== 'string') {
      throw makeError(
        X`${q(`gitRemote.${binding}`)} must select git and name its protocol remote`,
      );
    }
    if (typeof remote.url !== 'string') {
      throw makeError(X`${q(`gitRemote.${binding}.url`)} must be a URL`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(remote.url);
    } catch {
      throw makeError(X`${q(`gitRemote.${binding}.url`)} must be a URL`);
    }
    if (parsedUrl.username !== '' || parsedUrl.password !== '') {
      throw makeError(
        X`${q(`gitRemote.${binding}.url`)} must not embed credentials`,
      );
    }
    assertNoSecretSearchParams(parsedUrl, `gitRemote.${binding}.url`);
    const policy = normalizeGitRemotePolicy({
      name: remote.name,
      policy: /** @type {any} */ ({
        url: remote.url,
        ...(remote.allowedDirections === undefined
          ? {}
          : { allowedDirections: remote.allowedDirections }),
        ...(remote.fetchRefspecs === undefined
          ? {}
          : { fetchRefspecs: remote.fetchRefspecs }),
        ...(remote.pushRefspecs === undefined
          ? {}
          : { pushRefspecs: remote.pushRefspecs }),
        ...(remote.defaultPullRef === undefined
          ? {}
          : { defaultPullRef: remote.defaultPullRef }),
        ...(remote.allowedBranches === undefined
          ? {}
          : { allowedBranches: remote.allowedBranches }),
        ...(remote.allowForcePush === undefined
          ? {}
          : { allowForcePush: remote.allowForcePush }),
        ...(remote.allowTags === undefined
          ? {}
          : { allowTags: remote.allowTags }),
        ...(remote.allowDelete === undefined
          ? {}
          : { allowDelete: remote.allowDelete }),
        ...(remote.allowLocalFileTransport === undefined
          ? {}
          : { allowLocalFileTransport: remote.allowLocalFileTransport }),
      }),
    });
    let credential;
    if (remote.credential !== undefined) {
      let path;
      try {
        path = namePathFrom(remote.credential);
      } catch {
        throw makeError(
          X`${q(`gitRemote.${binding}.credential`)} must be a host pet name or name path`,
        );
      }
      credential =
        typeof remote.credential === 'string'
          ? remote.credential
          : harden([...path]);
    }
    defineEntry(
      gitRemote,
      binding,
      harden({
        ...policy,
        git: remote.git,
        name: remote.name,
        ...(credential === undefined ? {} : { credential }),
      }),
    );
  }

  const introducedInput =
    spec.introducedNames === undefined
      ? {}
      : plainRecord(spec.introducedNames, 'introducedNames');
  const introducedGuestNames = new Set();
  const introducedNames = harden(
    Object.fromEntries(
      Object.entries(introducedInput)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([hostName, guestName]) => {
          if (!isName(hostName) || typeof guestName !== 'string') {
            throw makeError(
              X`introducedNames must map host names to guest names`,
            );
          }
          assertBinding(guestName, `introducedNames.${hostName}`);
          if (introducedGuestNames.has(guestName)) {
            throw makeError(
              X`introducedNames must use a distinct guest binding for every host name`,
            );
          }
          introducedGuestNames.add(guestName);
          return [hostName, guestName];
        }),
    ),
  );

  const authority = /** @type {EndoGuestAuthority} */ (
    harden({
      ...(Object.keys(mount).length === 0 ? {} : { mount: harden(mount) }),
      ...(Object.keys(git).length === 0 ? {} : { git: harden(git) }),
      ...(Object.keys(gitRemote).length === 0
        ? {}
        : { gitRemote: harden(gitRemote) }),
    })
  );
  return harden({ persistence, authority, introducedNames });
};
harden(normalizeEndoCodeModeProvisionSpec);

/**
 * @param {unknown} value
 * @returns {Promise<EndoCodeModeProvisionPersistence>}
 */
export const validateEndoCodeModeProvisionPersistence = async value => {
  await null;
  const record = plainRecord(value, 'EndoCodeModeProvisionPersistence');
  assertFields(
    record,
    ['version', 'guestName'],
    'EndoCodeModeProvisionPersistence',
  );
  if (record.version !== 4 || !isPetName(record.guestName)) {
    throw makeError(X`EndoCodeModeProvisionPersistence is invalid`);
  }
  return harden({
    version: /** @type {4} */ (4),
    guestName: record.guestName,
  });
};
harden(validateEndoCodeModeProvisionPersistence);

// Internal aliases for the Pi session adapter. The public package entry point
// exports only the EndoCodeMode-prefixed names.
export const normalizeEndoProvisionSpec = normalizeEndoCodeModeProvisionSpec;
harden(normalizeEndoProvisionSpec);
export const makeEndoProvisionPersistence =
  makeEndoCodeModeProvisionPersistence;
harden(makeEndoProvisionPersistence);
export const validateEndoProvisionPersistence =
  validateEndoCodeModeProvisionPersistence;
harden(validateEndoProvisionPersistence);
