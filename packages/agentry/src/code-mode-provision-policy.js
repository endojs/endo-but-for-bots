// @ts-check
/// <reference types="ses"/>

/** @import { EndoProvisionPersistence, EndoProvisionPolicy, EndoProvisionSpec, NormalizeEndoProvisionOptions, NormalizedGitRemoteSpec, NormalizedNestedGitSpec } from './code-mode-provisioning-types.js' */

import { defaultDeniedSegments } from '@endo/daemon/src/mount.js';
import { isPetName } from '@endo/daemon/pet-name.js';
import { makeError, q, X } from '@endo/errors';
import { normalizeGitRemotePolicy } from '@endo/exo-git';

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const ROOT_FIELDS = harden([
  'workspace',
  'fs',
  'git',
  'gits',
  'gitRemotes',
  'piTools',
]);
const WORKSPACE_FIELDS = harden(['path', 'deniedSegments']);
const NESTED_GIT_FIELDS = harden(['path', 'mode']);
const REMOTE_FIELDS = harden([
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
]);
const FS_MODES = harden(['readOnly', 'readWrite']);
const GIT_MODES = harden(['readOnly', 'readWrite', 'historyRewrite']);
const PI_TOOLS_MODES = harden(['preserve']);
const PRODUCT_RESERVED_BINDINGS = harden(['E', 'git', 'gits', 'workspace']);
const LANGUAGE_RESERVED_BINDINGS = harden([
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
const SECRET_NAME_RE = /(?:api.?key|authorization|password|secret|token)/iu;
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;
const HARNESS_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/u;
const SESSION_KEY_RE = /^session-[0-9a-f]{64}$/u;

/**
 * Accept ordinary objects and null-prototype dictionaries, but not arrays or
 * class instances.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainRecord = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
const requirePlainRecord = (value, label) => {
  if (!isPlainRecord(value)) {
    throw makeError(X`${q(label)} must be a plain object`);
  }
  return value;
};

/**
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} fields
 * @param {string} label
 */
const assertKnownFields = (record, fields, label) => {
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) {
      throw makeError(X`${q(label)} has unknown field ${q(field)}`);
    }
  }
};

/**
 * Reject obvious credential material before generic unknown-field reporting.
 * This produces an actionable error even when a caller accidentally supplies
 * a credential object in place of a host-side pet name.
 *
 * @param {unknown} value
 * @param {string} path
 */
const assertNoSecretFields = (value, path) => {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertNoSecretFields(child, `${path}[${index}]`),
    );
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_NAME_RE.test(key)) {
      throw makeError(
        X`${q(`${path}.${key}`)} looks like credential material; use a host-side credential pet name instead`,
      );
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
};

/**
 * Compare complete normalized persistence records without depending on record
 * key order, which is not retained by every daemon persistence backend.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export const equalEndoProvisionPersistence = (left, right) => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        equalEndoProvisionPersistence(value, right[index]),
      )
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      key =>
        Object.hasOwn(right, key) &&
        equalEndoProvisionPersistence(left[key], right[key]),
    )
  );
};
harden(equalEndoProvisionPersistence);

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const requireString = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw makeError(X`${q(label)} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw makeError(X`${q(label)} must not contain NUL bytes`);
  }
  return value;
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
const requireStringArray = (value, label) => {
  if (!Array.isArray(value)) {
    throw makeError(X`${q(label)} must be an array of strings`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | string[]}
 */
const normalizeCredentialPetNamePath = (value, label) => {
  const segments =
    typeof value === 'string' ? [value] : requireStringArray(value, label);
  if (segments.length === 0 || !segments.every(isPetName)) {
    throw makeError(X`${q(label)} must be a valid host-side pet name or path`);
  }
  return typeof value === 'string' ? segments[0] : harden([...segments]);
};

/**
 * Remote names become lexical bindings inside a strict module compartment.
 *
 * @param {string} name
 * @returns {boolean}
 */
const isLexicalBindingName = name =>
  IDENTIFIER_RE.test(name) &&
  !LANGUAGE_RESERVED_BINDINGS.includes(name) &&
  !PRODUCT_RESERVED_BINDINGS.includes(name);

/**
 * @param {string} name
 * @param {string} label
 */
const assertBindingName = (name, label) => {
  if (!isPetName(name) || !isLexicalBindingName(name)) {
    throw makeError(
      X`${q(label)} must be a non-reserved JavaScript binding and pet name`,
    );
  }
};

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {NormalizedGitRemoteSpec}
 */
const normalizeRemote = (value, name) => {
  assertBindingName(name, `Git remote name ${name}`);
  const remote = requirePlainRecord(value, `gitRemotes.${name}`);
  assertKnownFields(remote, REMOTE_FIELDS, `gitRemotes.${name}`);
  const label = `gitRemotes.${name}`;
  const policy = normalizeGitRemotePolicy({
    name,
    policy: /** @type {any} */ (remote),
  });
  const parsed = new URL(policy.url);
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_NAME_RE.test(key)) {
      throw makeError(
        X`${q(`${label}.url`)} must not carry credential query fields`,
      );
    }
  }

  const credential =
    remote.credential === undefined
      ? undefined
      : normalizeCredentialPetNamePath(
          remote.credential,
          `${label}.credential`,
        );
  if (parsed.protocol === 'https:' && credential === undefined) {
    throw makeError(
      X`${q(`${label}.credential`)} must name a host credential for an https remote`,
    );
  }
  if (parsed.protocol !== 'https:' && credential !== undefined) {
    throw makeError(
      X`${q(`${label}.credential`)} is only valid for https remotes`,
    );
  }

  return harden({
    ...policy,
    ...(credential === undefined ? {} : { credential }),
  });
};

/**
 * @param {string} workspacePath
 * @param {string} candidate
 * @returns {boolean}
 */
const isWithinWorkspace = (workspacePath, candidate) => {
  const fromWorkspace = relative(workspacePath, candidate);
  return (
    fromWorkspace === '' ||
    (!isAbsolute(fromWorkspace) &&
      fromWorkspace !== '..' &&
      !fromWorkspace.startsWith(`..${sep}`))
  );
};

/**
 * @param {unknown} value
 * @param {string} name
 * @param {string} workspacePath
 * @param {string[]} deniedSegments
 * @param {unknown} fs
 * @returns {Promise<NormalizedNestedGitSpec>}
 */
const normalizeNestedGit = async (
  value,
  name,
  workspacePath,
  deniedSegments,
  fs,
) => {
  const label = `gits.${name}`;
  assertBindingName(name, `Git grant name ${name}`);
  const grant = requirePlainRecord(value, `EndoProvisionSpec.${label}`);
  assertKnownFields(grant, NESTED_GIT_FIELDS, `EndoProvisionSpec.${label}`);
  const mode = grant.mode;
  if (mode === undefined || !GIT_MODES.includes(/** @type {any} */ (mode))) {
    throw makeError(
      X`EndoProvisionSpec.${label}.mode must be readOnly, readWrite, or historyRewrite`,
    );
  }
  if (
    fs === 'readOnly' &&
    (mode === 'readWrite' || mode === 'historyRewrite')
  ) {
    throw makeError(
      X`EndoProvisionSpec: writable Git grant ${q(name)} requires a writable filesystem grant; fs: 'readOnly' cannot be combined with gits.${q(name)}.mode: ${q(mode)}`,
    );
  }
  const path = requireStringArray(
    grant.path,
    `EndoProvisionSpec.${label}.path`,
  ).map((segment, index) => {
    if (
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      throw makeError(
        X`${q(`EndoProvisionSpec.${label}.path[${index}]`)} must be one path segment inside the workspace`,
      );
    }
    if (deniedSegments.includes(segment.toLowerCase())) {
      throw makeError(
        X`${q(`EndoProvisionSpec.${label}.path[${index}]`)} names a denied workspace segment`,
      );
    }
    return segment;
  });
  const requestedPath = resolve(workspacePath, ...path);
  const nestedPath = await canonicalDirectory(
    requestedPath,
    `EndoProvisionSpec.${label}.path`,
  );
  if (!isWithinWorkspace(workspacePath, nestedPath)) {
    throw makeError(
      X`EndoProvisionSpec.${label}.path must stay inside the workspace`,
    );
  }
  return harden({
    path: nestedPath,
    mode: /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (mode),
  });
};

/**
 * Convert a canonical nested Git path from persistence back to the
 * workspace-relative segments accepted by the inert provisioning spec.
 *
 * @param {string} workspacePath
 * @param {string} nestedPath
 * @param {string} label
 * @returns {string[]}
 */
const nestedPathSegments = (workspacePath, nestedPath, label) => {
  const fromWorkspace = relative(workspacePath, nestedPath);
  if (!isWithinWorkspace(workspacePath, nestedPath)) {
    throw makeError(X`${q(label)} must stay inside the workspace`);
  }
  return fromWorkspace === '' ? [] : fromWorkspace.split(sep);
};

/**
 * @param {string} candidate
 * @param {string} label
 * @returns {Promise<string>}
 */
const canonicalDirectory = async (candidate, label) => {
  await null;
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw makeError(X`${q(label)} does not exist or cannot be resolved`);
  }
  let info;
  try {
    info = await stat(canonical);
  } catch {
    throw makeError(X`${q(label)} cannot be inspected`);
  }
  if (!info.isDirectory()) {
    throw makeError(X`${q(label)} must resolve to a directory`);
  }
  return canonical;
};

/**
 * @param {EndoProvisionSpec | undefined} spec
 * @param {string} cwd
 * @returns {Promise<{ workspacePath: string, policy: EndoProvisionPolicy }>}
 */
const normalizePolicy = async (spec, cwd) => {
  const root = requirePlainRecord(spec ?? {}, 'EndoProvisionSpec');
  assertNoSecretFields(root, 'EndoProvisionSpec');
  assertKnownFields(root, ROOT_FIELDS, 'EndoProvisionSpec');
  const workspace =
    root.workspace === undefined
      ? {}
      : requirePlainRecord(root.workspace, 'EndoProvisionSpec.workspace');
  assertKnownFields(workspace, WORKSPACE_FIELDS, 'EndoProvisionSpec.workspace');

  const { fs, git, piTools } = root;
  if (fs !== undefined && !FS_MODES.includes(/** @type {any} */ (fs))) {
    throw makeError(X`EndoProvisionSpec.fs must be readOnly or readWrite`);
  }
  if (git !== undefined && !GIT_MODES.includes(/** @type {any} */ (git))) {
    throw makeError(
      X`EndoProvisionSpec.git must be readOnly, readWrite, or historyRewrite`,
    );
  }
  if (
    piTools !== undefined &&
    !PI_TOOLS_MODES.includes(/** @type {any} */ (piTools))
  ) {
    throw makeError(X`EndoProvisionSpec.piTools must be preserve`);
  }
  if (fs === 'readOnly' && (git === 'readWrite' || git === 'historyRewrite')) {
    throw makeError(
      X`EndoProvisionSpec: writable Git requires a writable filesystem grant; fs: 'readOnly' cannot be combined with git: 'readWrite' or 'historyRewrite'`,
    );
  }

  const canonicalCwd = await canonicalDirectory(resolve(cwd), 'cwd');
  const requestedPath =
    workspace.path === undefined
      ? canonicalCwd
      : resolve(
          canonicalCwd,
          requireString(workspace.path, 'EndoProvisionSpec.workspace.path'),
        );
  const workspacePath = await canonicalDirectory(
    requestedPath,
    'EndoProvisionSpec.workspace.path',
  );
  const deniedSegments = harden(
    [
      ...new Set(
        requireStringArray(
          workspace.deniedSegments ?? defaultDeniedSegments,
          'EndoProvisionSpec.workspace.deniedSegments',
        ).map((segment, index) => {
          if (
            segment === '.' ||
            segment === '..' ||
            segment.includes('/') ||
            segment.includes('\\')
          ) {
            throw makeError(
              X`${q(`EndoProvisionSpec.workspace.deniedSegments[${index}]`)} must be one path segment`,
            );
          }
          return segment.toLowerCase();
        }),
      ),
    ].sort(),
  );

  const gitsRecord =
    root.gits === undefined
      ? undefined
      : requirePlainRecord(root.gits, 'EndoProvisionSpec.gits');
  /** @type {Array<[string, NormalizedNestedGitSpec]>} */
  const normalizedGits = [];
  for (const name of Object.keys(gitsRecord ?? {}).sort()) {
    // eslint-disable-next-line no-await-in-loop
    const grant = await normalizeNestedGit(
      /** @type {Record<string, unknown>} */ (gitsRecord)[name],
      name,
      workspacePath,
      deniedSegments,
      fs,
    );
    normalizedGits.push([name, grant]);
  }
  const gits = /** @type {Record<string, NormalizedNestedGitSpec>} */ (
    Object.fromEntries(normalizedGits)
  );

  const gitRemotesRecord =
    root.gitRemotes === undefined
      ? undefined
      : requirePlainRecord(root.gitRemotes, 'EndoProvisionSpec.gitRemotes');
  if (
    gitRemotesRecord !== undefined &&
    git !== 'readWrite' &&
    git !== 'historyRewrite'
  ) {
    throw makeError(X`Git remotes require writable Git authority`);
  }
  const gitRemotes = /** @type {Record<string, NormalizedGitRemoteSpec>} */ (
    Object.fromEntries(
      Object.keys(gitRemotesRecord ?? {})
        .sort()
        .map(name => [
          name,
          normalizeRemote(
            /** @type {Record<string, unknown>} */ (gitRemotesRecord)[name],
            name,
          ),
        ]),
    )
  );
  for (const name of Object.keys(gits)) {
    if (Object.hasOwn(gitRemotes, name)) {
      throw makeError(
        X`Git grant binding ${q(name)} is declared both in gits and gitRemotes`,
      );
    }
  }

  /** @type {EndoProvisionPolicy} */
  const policy = harden({
    workspace: harden({ deniedSegments }),
    ...(piTools === undefined
      ? {}
      : { piTools: /** @type {'preserve'} */ (piTools) }),
    ...(fs === undefined
      ? {}
      : { fs: /** @type {'readOnly' | 'readWrite'} */ (fs) }),
    ...(git === undefined
      ? {}
      : {
          git: /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (git),
        }),
    ...(Object.keys(gits).length === 0 ? {} : { gits: harden(gits) }),
    ...(Object.keys(gitRemotes).length === 0
      ? {}
      : { gitRemotes: harden(gitRemotes) }),
  });
  return harden({ workspacePath, policy });
};

/**
 * Normalize plain provisioning intent into the versioned persistence record.
 * The workspace path is made absolute and canonical even for a no-grant spec;
 * the policy itself continues to omit every unrequested capability.
 *
 * @param {EndoProvisionSpec | undefined} spec
 * @param {NormalizeEndoProvisionOptions} options
 * @returns {Promise<EndoProvisionPersistence>}
 */
export const normalizeEndoProvisionSpec = async (spec, options) => {
  const harness = requireString(options?.harness, 'harness');
  if (!HARNESS_KEY_RE.test(harness)) {
    throw makeError(X`harness must match /^[a-z][a-z0-9-]{0,31}$/`);
  }
  const sessionId = requireString(options?.sessionId, 'sessionId');
  if (sessionId.length > 1024) {
    throw makeError(X`sessionId must be at most 1024 characters`);
  }
  const cwd = requireString(options?.cwd, 'cwd');
  const sessionKey = `session-${createHash('sha256').update(sessionId).digest('hex')}`;
  const { workspacePath, policy } = await normalizePolicy(spec, cwd);
  return harden({
    version: 1,
    guestHandlePath: harden(['code-mode', harness, sessionKey, 'guest-handle']),
    workspacePath,
    policy,
  });
};
harden(normalizeEndoProvisionSpec);

/**
 * Validate and re-normalize caller-held persistence before reconstruction.
 *
 * @param {unknown} value
 * @returns {Promise<EndoProvisionPersistence>}
 */
export const validateEndoProvisionPersistence = async value => {
  const record = requirePlainRecord(value, 'Endo provision persistence');
  assertKnownFields(
    record,
    harden(['version', 'guestHandlePath', 'workspacePath', 'policy']),
    'Endo provision persistence',
  );
  if (record.version !== 1) {
    throw makeError(X`Endo provision persistence version must be 1`);
  }
  const guestHandlePath = requireStringArray(
    record.guestHandlePath,
    'Endo provision persistence.guestHandlePath',
  );
  if (
    guestHandlePath.length !== 4 ||
    guestHandlePath[0] !== 'code-mode' ||
    !HARNESS_KEY_RE.test(guestHandlePath[1]) ||
    !SESSION_KEY_RE.test(guestHandlePath[2]) ||
    guestHandlePath[3] !== 'guest-handle'
  ) {
    throw makeError(
      X`Endo provision persistence has an invalid guest handle path`,
    );
  }
  const workspacePath = requireString(
    record.workspacePath,
    'Endo provision persistence.workspacePath',
  );
  if (!isAbsolute(workspacePath)) {
    throw makeError(
      X`Endo provision persistence workspace path must be absolute`,
    );
  }
  const policyRecord = requirePlainRecord(
    record.policy,
    'Endo provision persistence.policy',
  );
  const workspacePolicy = requirePlainRecord(
    policyRecord.workspace,
    'Endo provision persistence.policy.workspace',
  );
  const persistedGits =
    policyRecord.gits === undefined
      ? undefined
      : requirePlainRecord(
          policyRecord.gits,
          'Endo provision persistence.policy.gits',
        );
  const reconstructedGits =
    persistedGits === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(persistedGits).map(([name, grantValue]) => {
            const label = `Endo provision persistence.policy.gits.${name}`;
            const grant = requirePlainRecord(grantValue, label);
            assertKnownFields(grant, NESTED_GIT_FIELDS, label);
            const canonicalPath = requireString(grant.path, `${label}.path`);
            return [
              name,
              {
                path: nestedPathSegments(
                  workspacePath,
                  canonicalPath,
                  `${label}.path`,
                ),
                mode: grant.mode,
              },
            ];
          }),
        );
  const reconstructedSpec = harden({
    workspace: harden({
      path: workspacePath,
      deniedSegments: workspacePolicy.deniedSegments,
    }),
    ...(policyRecord.fs === undefined ? {} : { fs: policyRecord.fs }),
    ...(policyRecord.git === undefined ? {} : { git: policyRecord.git }),
    ...(reconstructedGits === undefined ? {} : { gits: reconstructedGits }),
    ...(policyRecord.piTools === undefined
      ? {}
      : { piTools: policyRecord.piTools }),
    ...(policyRecord.gitRemotes === undefined
      ? {}
      : { gitRemotes: policyRecord.gitRemotes }),
  });
  const normalized = await normalizePolicy(
    /** @type {EndoProvisionSpec} */ (reconstructedSpec),
    workspacePath,
  );
  /** @type {EndoProvisionPersistence} */
  const persistence = harden({
    version: /** @type {1} */ (1),
    guestHandlePath: harden([...guestHandlePath]),
    workspacePath: normalized.workspacePath,
    policy: normalized.policy,
  });
  if (!equalEndoProvisionPersistence(persistence, record)) {
    throw makeError(X`Endo provision persistence is not in normalized form`);
  }
  return persistence;
};
harden(validateEndoProvisionPersistence);
