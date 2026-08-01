// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal } from '@endo/agent-tools/code-mode/evaluate-tool.js' */
/** @import { EndoGuest, EndoHost, EndoMount } from '@endo/daemon' */
/** @import { EndoProvisionPersistence, EndoProvisionPolicy, EndoProvisionResult, EndoProvisionSpec, GitRemoteSpec, NormalizeEndoProvisionOptions, NormalizedGitRemoteSpec, ProvisionEndoCodeModeOptions, ReconstructEndoCodeModeOptions } from './code-mode-provisioning-types.js' */

import { makeDaemonMountGlobal } from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeGitRemoteGlobal } from '@endo/agent-tools/code-mode-globals/git-remote.js';
import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';
import { makeCancelKit } from '@endo/cancel';
import { makeEndoClient } from '@endo/daemon';
import { defaultDeniedSegments } from '@endo/daemon/src/mount.js';
import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { whereEndoSock } from '@endo/where';

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { env, platform } from 'node:process';

const ROOT_FIELDS = harden(['workspace', 'fs', 'git', 'gitRemotes']);
const WORKSPACE_FIELDS = harden(['path', 'deniedSegments']);
const REMOTE_FIELDS = harden([
  'url',
  'allowedDirections',
  'fetchRefspecs',
  'pushRefspecs',
  'allowedBranches',
  'allowForcePush',
  'allowTags',
  'allowDelete',
  'allowLocalFileTransport',
  'credential',
]);
const FS_MODES = harden(['readOnly', 'readWrite']);
const GIT_MODES = harden(['readOnly', 'readWrite', 'historyRewrite']);
const RESERVED_BINDINGS = harden(['E', 'git', 'workspace']);
const SECRET_FIELD_RE = /(?:api.?key|authorization|password|secret|token)/iu;
const SECRET_QUERY_RE = /(?:api.?key|authorization|password|secret|token)/iu;
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;
const SESSION_KEY_RE = /^session-[0-9a-f]{64}$/u;

/** @typedef {{ audience(): Promise<string> }} GitCredential */
/** @typedef {{ inspect(): Promise<{ available: boolean, revoked?: boolean }> }} GitCredentialController */

/**
 * An actionable reconstruction failure for a durable credential whose
 * process-local material did not survive a daemon restart.
 */
export class EndoCredentialUnavailableError extends Error {
  /**
   * @param {string} remoteName
   * @param {string | string[]} credentialPetName
   */
  constructor(remoteName, credentialPetName) {
    super(
      `Git credential ${JSON.stringify(credentialPetName)} for remote ${JSON.stringify(remoteName)} is unavailable; reprovision the credential on the host and retry`,
    );
    this.name = 'EndoCredentialUnavailableError';
    this.code = 'ENDO_CREDENTIAL_UNAVAILABLE';
    this.remoteName = remoteName;
    this.credentialPetName = credentialPetName;
  }
}
harden(EndoCredentialUnavailableError);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value => {
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
const requireRecord = (value, label) => {
  if (!isRecord(value)) {
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
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key)) {
      throw makeError(
        X`${q(`${path}.${key}`)} looks like credential material; use a host-side credential pet name instead`,
      );
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
};

/**
 * Compare normalized plain policy data without depending on record key order,
 * which is not retained by every daemon persistence backend.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
const samePlainData = (left, right) => {
  const canonicalize = value => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(key => [key, canonicalize(value[key])]),
      );
    }
    return value;
  };
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  );
};

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
 * @param {boolean} fallback
 * @param {string} label
 * @returns {boolean}
 */
const requireBoolean = (value, fallback, label) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw makeError(X`${q(label)} must be a boolean`);
  }
  return value;
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | string[]}
 */
const normalizePetName = (value, label) => {
  const segments =
    typeof value === 'string' ? [value] : requireStringArray(value, label);
  /** @param {string} part */
  const isPetName = part =>
    part.length <= 255 &&
    !part.includes('/') &&
    !part.includes('@') &&
    part !== '.' &&
    part !== '..';
  if (segments.length === 0 || !segments.every(isPetName)) {
    throw makeError(X`${q(label)} must be a valid host-side pet name or path`);
  }
  return typeof value === 'string' ? segments[0] : harden([...segments]);
};

/**
 * @param {string} ref
 * @param {string} label
 */
const assertQualifiedRef = (ref, label) => {
  if (
    !ref.startsWith('refs/') ||
    ref.includes('..') ||
    ref.includes('\\') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    ref.endsWith('/')
  ) {
    throw makeError(X`${q(label)} contains an invalid fully-qualified ref`);
  }
};

/**
 * @param {string} value
 * @param {string} label
 * @returns {{ force: boolean, src: string, dst: string }}
 */
const parseRefspec = (value, label) => {
  const refspec = requireString(value, label);
  const force = refspec.startsWith('+');
  const body = force ? refspec.slice(1) : refspec;
  const colon = body.indexOf(':');
  if (colon < 0 || body.indexOf(':', colon + 1) >= 0) {
    throw makeError(X`${q(label)} must be one [ + ]<src>:<dst> refspec`);
  }
  const src = body.slice(0, colon);
  const dst = body.slice(colon + 1);
  if (dst === '') {
    throw makeError(X`${q(label)} destination must not be empty`);
  }
  return harden({ force, src, dst });
};

/**
 * @param {string} src
 * @param {string} dst
 * @param {string} label
 */
const assertWildcardShape = (src, dst, label) => {
  const count = text => [...text].filter(char => char === '*').length;
  const srcCount = count(src);
  const dstCount = count(dst);
  if (
    srcCount > 1 ||
    dstCount > 1 ||
    srcCount !== dstCount ||
    (srcCount === 1 && (!src.endsWith('/*') || !dst.endsWith('/*')))
  ) {
    throw makeError(
      X`${q(label)} has incompatible wildcard source and destination`,
    );
  }
};

/**
 * @param {string} refspec
 * @param {NormalizedGitRemoteSpec} policy
 * @param {string} remoteName
 * @param {string} label
 */
const validateFetchRefspec = (refspec, policy, remoteName, label) => {
  const { src, dst } = parseRefspec(refspec, label);
  assertQualifiedRef(dst, `${label} destination`);
  if (!dst.startsWith(`refs/remotes/${remoteName}/`)) {
    throw makeError(
      X`${q(label)} destination must stay under ${q(`refs/remotes/${remoteName}/`)}`,
    );
  }
  if (src === '') {
    if (!policy.allowDelete || dst.includes('*')) {
      throw makeError(X`${q(label)} deletion is outside the configured policy`);
    }
    return;
  }
  assertQualifiedRef(src, `${label} source`);
  if (
    (src.startsWith('refs/tags/') || dst.startsWith('refs/tags/')) &&
    !policy.allowTags
  ) {
    throw makeError(X`${q(label)} tag refs require allowTags`);
  }
  assertWildcardShape(src, dst, label);
};

/**
 * @param {string} refspec
 * @param {NormalizedGitRemoteSpec} policy
 * @param {string} label
 */
const validatePushRefspec = (refspec, policy, label) => {
  const { force, src, dst } = parseRefspec(refspec, label);
  if (force && !policy.allowForcePush) {
    throw makeError(X`${q(label)} force push requires allowForcePush`);
  }
  assertQualifiedRef(dst, `${label} destination`);
  if (src === '') {
    if (!policy.allowDelete || dst.includes('*')) {
      throw makeError(X`${q(label)} deletion is outside the configured policy`);
    }
    return;
  }
  assertQualifiedRef(src, `${label} source`);
  if (!src.startsWith('refs/heads/') && !src.startsWith('refs/tags/')) {
    throw makeError(X`${q(label)} source must be a local branch or tag ref`);
  }
  if (
    (src.startsWith('refs/tags/') || dst.startsWith('refs/tags/')) &&
    !policy.allowTags
  ) {
    throw makeError(X`${q(label)} tag refs require allowTags`);
  }
  assertWildcardShape(src, dst, label);
};

/**
 * @param {string} branch
 * @param {string} label
 * @returns {string}
 */
const branchRefFromAllowedBranch = (branch, label) => {
  const value = requireString(branch, label);
  if (
    value.startsWith('+') ||
    value.includes(':') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    (value.startsWith('refs/') && !value.startsWith('refs/heads/')) ||
    (value.includes('*') && !value.startsWith('refs/heads/'))
  ) {
    throw makeError(X`${q(label)} is not a valid branch selector`);
  }
  const ref = value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
  assertQualifiedRef(ref, label);
  const wildcardCount = [...ref].filter(char => char === '*').length;
  if (wildcardCount > 1 || (wildcardCount === 1 && !ref.endsWith('/*'))) {
    throw makeError(X`${q(label)} has an invalid wildcard`);
  }
  return ref;
};

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {NormalizedGitRemoteSpec}
 */
const normalizeRemote = (value, name) => {
  if (
    name.length > 255 ||
    !IDENTIFIER_RE.test(name) ||
    RESERVED_BINDINGS.includes(name)
  ) {
    throw makeError(
      X`Git remote name ${q(name)} must be a non-reserved JavaScript binding and pet name`,
    );
  }
  const remote = requireRecord(value, `gitRemotes.${name}`);
  assertKnownFields(remote, REMOTE_FIELDS, `gitRemotes.${name}`);
  const label = `gitRemotes.${name}`;
  const allowLocalFileTransport = requireBoolean(
    remote.allowLocalFileTransport,
    false,
    `${label}.allowLocalFileTransport`,
  );
  const urlText = requireString(remote.url, `${label}.url`);
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    throw makeError(X`${q(`${label}.url`)} must be a valid URL`);
  }
  if (
    parsed.protocol !== 'https:' &&
    !(allowLocalFileTransport && parsed.protocol === 'file:')
  ) {
    throw makeError(
      X`${q(`${label}.url`)} must use https, or file with allowLocalFileTransport`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw makeError(X`${q(`${label}.url`)} must not embed credentials`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) {
      throw makeError(
        X`${q(`${label}.url`)} must not carry credential query fields`,
      );
    }
  }

  const credential =
    remote.credential === undefined
      ? undefined
      : normalizePetName(remote.credential, `${label}.credential`);
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

  const directions = requireStringArray(
    remote.allowedDirections ?? ['fetch'],
    `${label}.allowedDirections`,
  );
  if (
    directions.length === 0 ||
    directions.some(direction => direction !== 'fetch' && direction !== 'push')
  ) {
    throw makeError(
      X`${q(`${label}.allowedDirections`)} must contain fetch and/or push`,
    );
  }
  const allowedDirections = harden(
    /** @type {Array<'fetch' | 'push'>} */ ([...new Set(directions)].sort()),
  );
  const fetchRefspecs = harden(
    [
      ...new Set(
        requireStringArray(
          remote.fetchRefspecs ?? [],
          `${label}.fetchRefspecs`,
        ),
      ),
    ].sort(),
  );
  const explicitPushRefspecs = requireStringArray(
    remote.pushRefspecs ?? [],
    `${label}.pushRefspecs`,
  );
  const allowedBranches =
    remote.allowedBranches === undefined
      ? []
      : requireStringArray(remote.allowedBranches, `${label}.allowedBranches`);
  if (allowedBranches.length > 0 && explicitPushRefspecs.length > 0) {
    throw makeError(
      X`${q(label)} must choose allowedBranches or pushRefspecs, not both`,
    );
  }
  const pushRefspecs = harden(
    [
      ...new Set(
        allowedBranches.length > 0
          ? allowedBranches.map((branch, index) => {
              const ref = branchRefFromAllowedBranch(
                branch,
                `${label}.allowedBranches[${index}]`,
              );
              return `${ref}:${ref}`;
            })
          : explicitPushRefspecs,
      ),
    ].sort(),
  );
  const normalized = harden({
    url: parsed.href,
    allowedDirections,
    fetchRefspecs,
    pushRefspecs,
    allowForcePush: requireBoolean(
      remote.allowForcePush,
      false,
      `${label}.allowForcePush`,
    ),
    allowTags: requireBoolean(remote.allowTags, false, `${label}.allowTags`),
    allowDelete: requireBoolean(
      remote.allowDelete,
      false,
      `${label}.allowDelete`,
    ),
    allowLocalFileTransport,
    ...(credential === undefined ? {} : { credential }),
  });
  normalized.fetchRefspecs.forEach((refspec, index) =>
    validateFetchRefspec(
      refspec,
      normalized,
      name,
      `${label}.fetchRefspecs[${index}]`,
    ),
  );
  normalized.pushRefspecs.forEach((refspec, index) =>
    validatePushRefspec(refspec, normalized, `${label}.pushRefspecs[${index}]`),
  );
  if (
    normalized.allowedDirections.includes('push') &&
    normalized.pushRefspecs.length === 0
  ) {
    throw makeError(
      X`${q(label)} allows push but has no pushRefspecs or allowedBranches`,
    );
  }
  return normalized;
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
  const root = requireRecord(spec ?? {}, 'EndoProvisionSpec');
  assertNoSecretFields(root, 'EndoProvisionSpec');
  assertKnownFields(root, ROOT_FIELDS, 'EndoProvisionSpec');
  const workspace =
    root.workspace === undefined
      ? {}
      : requireRecord(root.workspace, 'EndoProvisionSpec.workspace');
  assertKnownFields(workspace, WORKSPACE_FIELDS, 'EndoProvisionSpec.workspace');

  const { fs, git } = root;
  if (fs !== undefined && !FS_MODES.includes(/** @type {any} */ (fs))) {
    throw makeError(X`EndoProvisionSpec.fs must be readOnly or readWrite`);
  }
  if (git !== undefined && !GIT_MODES.includes(/** @type {any} */ (git))) {
    throw makeError(
      X`EndoProvisionSpec.git must be readOnly, readWrite, or historyRewrite`,
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

  const gitRemotesRecord =
    root.gitRemotes === undefined
      ? undefined
      : requireRecord(root.gitRemotes, 'EndoProvisionSpec.gitRemotes');
  if (
    gitRemotesRecord !== undefined &&
    git !== 'readWrite' &&
    git !== 'historyRewrite'
  ) {
    throw makeError(X`Git remotes require writable Git authority`);
  }
  /** @type {Record<string, NormalizedGitRemoteSpec>} */
  const gitRemotes = {};
  for (const name of Object.keys(gitRemotesRecord ?? {}).sort()) {
    gitRemotes[name] = normalizeRemote(
      /** @type {Record<string, unknown>} */ (gitRemotesRecord)[name],
      name,
    );
  }

  /** @type {EndoProvisionPolicy} */
  const policy = harden({
    workspace: harden({ deniedSegments }),
    ...(fs === undefined
      ? {}
      : { fs: /** @type {'readOnly' | 'readWrite'} */ (fs) }),
    ...(git === undefined
      ? {}
      : {
          git: /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (git),
        }),
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
  const sessionId = requireString(options?.sessionId, 'sessionId');
  if (sessionId.length > 1024) {
    throw makeError(X`sessionId must be at most 1024 characters`);
  }
  const cwd = requireString(options?.cwd, 'cwd');
  const sessionKey = `session-${createHash('sha256').update(sessionId).digest('hex')}`;
  const { workspacePath, policy } = await normalizePolicy(spec, cwd);
  return harden({
    version: 1,
    guestPetName: harden(['pi-code', sessionKey, 'guest-handle']),
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
  const record = requireRecord(value, 'Endo provision persistence');
  assertKnownFields(
    record,
    harden(['version', 'guestPetName', 'workspacePath', 'policy']),
    'Endo provision persistence',
  );
  if (record.version !== 1) {
    throw makeError(X`Endo provision persistence version must be 1`);
  }
  const guestPetName = requireStringArray(
    record.guestPetName,
    'Endo provision persistence.guestPetName',
  );
  if (
    guestPetName.length !== 3 ||
    guestPetName[0] !== 'pi-code' ||
    !SESSION_KEY_RE.test(guestPetName[1]) ||
    guestPetName[2] !== 'guest-handle'
  ) {
    throw makeError(
      X`Endo provision persistence has an invalid guest pet name`,
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
  const policyRecord = requireRecord(
    record.policy,
    'Endo provision persistence.policy',
  );
  const workspacePolicy = requireRecord(
    policyRecord.workspace,
    'Endo provision persistence.policy.workspace',
  );
  const reconstructedSpec = harden({
    workspace: harden({
      path: workspacePath,
      deniedSegments: workspacePolicy.deniedSegments,
    }),
    ...(policyRecord.fs === undefined ? {} : { fs: policyRecord.fs }),
    ...(policyRecord.git === undefined ? {} : { git: policyRecord.git }),
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
    guestPetName: harden([...guestPetName]),
    workspacePath: normalized.workspacePath,
    policy: normalized.policy,
  });
  if (!samePlainData(persistence, record)) {
    throw makeError(X`Endo provision persistence is not in normalized form`);
  }
  return persistence;
};
harden(validateEndoProvisionPersistence);

/**
 * Select prompt descriptors from normalized policy. This helper is exported
 * from the source module for focused tests; the public subpath filters it out.
 *
 * @param {EndoProvisionPersistence} persistence
 * @returns {CodeModeGlobal[]}
 */
export const makeEndoProvisionGlobals = persistence => {
  const { policy } = persistence;
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  if (policy.fs !== undefined) {
    globals.push(
      makeDaemonMountGlobal({
        name: 'workspace',
        readOnly: policy.fs === 'readOnly',
      }),
    );
  }
  if (policy.git !== undefined) {
    globals.push(
      makeGitGlobal({
        name: 'git',
        readOnly: policy.git === 'readOnly',
        historyRewrite: policy.git === 'historyRewrite',
      }),
    );
  }
  for (const name of Object.keys(policy.gitRemotes ?? {}).sort()) {
    globals.push(makeGitRemoteGlobal({ name }));
  }
  return normalizeGlobals(globals);
};
harden(makeEndoProvisionGlobals);

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 * @returns {Promise<boolean>}
 */
const hasPath = async (host, namePath) => {
  await null;
  for (let length = 1; length <= namePath.length; length += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...namePath.slice(0, length)))) {
      return false;
    }
  }
  return true;
};

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 */
const ensureDirectory = async (host, namePath) => {
  await null;
  if (!(await hasPath(host, namePath))) {
    await E(host).makeDirectory(namePath);
  }
};

/**
 * @param {EndoHost} host
 * @param {string[]} namePath
 * @param {() => Promise<unknown>} provide
 * @returns {Promise<unknown>}
 */
const provideOrLookup = async (host, namePath, provide) => {
  await null;
  if (await hasPath(host, namePath)) {
    return E(host).lookup(namePath);
  }
  return provide();
};

/**
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<Map<string, GitCredential>>}
 */
const prepareCredentials = async (host, persistence) => {
  await null;
  /** @type {Map<string, GitCredential>} */
  const credentials = new Map();
  for (const [name, remote] of Object.entries(
    persistence.policy.gitRemotes ?? {},
  )) {
    if (remote.credential !== undefined) {
      // Sequential by design: credential diagnostics stay deterministic and no
      // host lookup is left outstanding after the first failure.
      let lookedUp;
      try {
        // eslint-disable-next-line no-await-in-loop
        lookedUp = await E(host).lookup(remote.credential);
      } catch {
        throw new EndoCredentialUnavailableError(name, remote.credential);
      }
      const credential = /** @type {GitCredential} */ (lookedUp);
      let controller;
      try {
        // eslint-disable-next-line no-await-in-loop
        controller = await E(host).getGitCredentialController(credential);
      } catch {
        throw makeError(
          X`Credential pet name ${q(JSON.stringify(remote.credential))} for remote ${q(name)} does not name a daemon-minted Git credential`,
        );
      }
      const credentialController = /** @type {GitCredentialController} */ (
        controller
      );
      // eslint-disable-next-line no-await-in-loop
      const inspection = await E(credentialController).inspect();
      if (
        !inspection ||
        inspection.available !== true ||
        inspection.revoked === true
      ) {
        throw new EndoCredentialUnavailableError(name, remote.credential);
      }
      // eslint-disable-next-line no-await-in-loop
      const audience = await E(credential).audience();
      const expectedAudience = new URL(remote.url).origin;
      if (audience !== expectedAudience) {
        throw makeError(
          X`Credential audience ${q(audience)} does not match remote ${q(name)} audience ${q(expectedAudience)}`,
        );
      }
      credentials.set(name, credential);
    }
  }
  return credentials;
};

/**
 * @param {EndoHost} host
 * @param {EndoProvisionPersistence} persistence
 * @param {Map<string, GitCredential>} credentials
 * @returns {Promise<EndoGuest>}
 */
const realizeProvision = async (host, persistence, credentials) => {
  const controllerPath = persistence.guestPetName.slice(0, -1);
  const guestAgentPath = harden([...controllerPath, 'guest-agent']);
  const persistencePath = harden([...controllerPath, 'persistence']);
  await ensureDirectory(host, ['pi-code']);
  await ensureDirectory(host, controllerPath);

  /** @type {Array<[string, string[]]>} */
  const grants = [];
  if (persistence.policy.fs !== undefined) {
    const workspaceAlias = harden([...controllerPath, 'workspace']);
    await provideOrLookup(host, workspaceAlias, () =>
      E(host).provideMount(persistence.workspacePath, workspaceAlias, {
        readOnly: persistence.policy.fs === 'readOnly',
        deniedSegments: persistence.policy.workspace.deniedSegments,
      }),
    );
    grants.push(['workspace', workspaceAlias]);
  }

  if (persistence.policy.git !== undefined) {
    const gitMountAlias = harden([...controllerPath, 'git-workspace']);
    const gitAlias = harden([...controllerPath, 'git']);
    const gitMount = /** @type {EndoMount} */ (
      await provideOrLookup(host, gitMountAlias, () =>
        E(host).provideMount(persistence.workspacePath, gitMountAlias, {
          readOnly: persistence.policy.git === 'readOnly',
          deniedSegments: persistence.policy.workspace.deniedSegments,
        }),
      )
    );
    const git = await provideOrLookup(host, gitAlias, () =>
      E(host).provideGit(gitMount, gitAlias, {
        allowHistoryRewrite: persistence.policy.git === 'historyRewrite',
      }),
    );
    grants.push(['git', gitAlias]);

    for (const [name, remote] of Object.entries(
      persistence.policy.gitRemotes ?? {},
    )) {
      const remoteAlias = harden([...controllerPath, name]);
      // eslint-disable-next-line no-await-in-loop
      await provideOrLookup(host, remoteAlias, () =>
        E(host).provideGitRemote(git, remoteAlias, {
          name,
          url: remote.url,
          allowedDirections: remote.allowedDirections,
          fetchRefspecs: remote.fetchRefspecs,
          pushRefspecs: remote.pushRefspecs,
          allowForcePush: remote.allowForcePush,
          allowTags: remote.allowTags,
          allowDelete: remote.allowDelete,
          allowLocalFileTransport: remote.allowLocalFileTransport,
          ...(remote.credential === undefined
            ? {}
            : { credential: credentials.get(name) }),
        }),
      );
      grants.push([name, remoteAlias]);
    }
  }

  const hasHandle = await hasPath(host, persistence.guestPetName);
  const hasAgent = await hasPath(host, guestAgentPath);
  if (hasHandle !== hasAgent) {
    throw makeError(
      X`Retained code-mode guest is incomplete; its handle and agent paths disagree`,
    );
  }
  const guest = /** @type {EndoGuest} */ (
    hasAgent
      ? await E(host).lookup(guestAgentPath)
      : await E(host).provideGuest(persistence.guestPetName, {
          agentName: guestAgentPath,
        })
  );

  for (const [guestName, controllerAlias] of grants) {
    // eslint-disable-next-line no-await-in-loop
    const id = await E(host).identify(...controllerAlias);
    if (typeof id !== 'string') {
      throw makeError(
        X`Controller alias ${q(controllerAlias.join('/'))} has no formula identifier`,
      );
    }
    // Identifier sharing preserves the controller alias and binds the exact
    // same retained formula into the guest under its simple lexical pet name.
    // eslint-disable-next-line no-await-in-loop
    await E(guest).storeIdentifier(guestName, id);
  }

  if (!(await hasPath(host, persistencePath))) {
    await E(host).storeValue(persistence, persistencePath);
  }
  return guest;
};

/**
 * @param {string | undefined} sockPath
 * @returns {string}
 */
const selectSockPath = sockPath => {
  if (sockPath !== undefined) {
    return requireString(sockPath, 'sockPath');
  }
  const user = userInfo().username;
  return whereEndoSock(platform, env, {
    home: homedir(),
    user,
    temp: tmpdir(),
  });
};

/**
 * @param {EndoProvisionPersistence} persistence
 * @param {string | undefined} sockPath
 * @returns {Promise<EndoProvisionResult>}
 */
const connectAndRealize = async (persistence, sockPath) => {
  await null;
  const { cancelled, cancel } = makeCancelKit();
  /** @type {Promise<void> | undefined} */
  let closed;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    cancel(makeError(X`Code-mode provisioning session closed`));
    await closed?.catch(() => {});
  };

  try {
    const sessionKey = persistence.guestPetName[1];
    const client = await makeEndoClient(
      `pi-code-${sessionKey.slice('session-'.length, 'session-'.length + 12)}`,
      selectSockPath(sockPath),
      cancelled,
    );
    closed = client.closed;
    closed.catch(() => {});
    const bootstrap = await client.getBootstrap();
    const host = /** @type {EndoHost} */ (await E(bootstrap).host());
    const controllerPath = persistence.guestPetName.slice(0, -1);
    const persistencePath = harden([...controllerPath, 'persistence']);
    if (await hasPath(host, persistencePath)) {
      const stored = await E(host).lookup(persistencePath);
      const normalizedStored = await validateEndoProvisionPersistence(stored);
      if (!samePlainData(normalizedStored, persistence)) {
        throw makeError(
          X`Reconstruction cannot widen or change a retained code-mode provision policy`,
        );
      }
    }
    const credentials = await prepareCredentials(host, persistence);
    const guest = await realizeProvision(host, persistence, credentials);
    return harden({
      powers: guest,
      globals: makeEndoProvisionGlobals(persistence),
      persistence,
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/**
 * Provision or recover one deterministic retained daemon guest from inert
 * caller policy. Filesystem and Git grants are selected independently; their
 * effective authority is the union, so writable Git can mutate the repository
 * behind an otherwise read-only workspace view.
 *
 * @param {ProvisionEndoCodeModeOptions} options
 * @returns {Promise<EndoProvisionResult>}
 */
export const provisionEndoCodeMode = async options => {
  const persistence = await normalizeEndoProvisionSpec(options?.spec, {
    sessionId: options?.sessionId,
    cwd: options?.cwd,
  });
  return connectAndRealize(persistence, options?.sockPath);
};
harden(provisionEndoCodeMode);

/**
 * Reconnect to a retained guest from its normalized, non-secret persistence
 * record. A host-retained copy of the original record is compared before any
 * capability is reused, so descriptor tampering cannot widen authority.
 *
 * @param {ReconstructEndoCodeModeOptions} options
 * @returns {Promise<EndoProvisionResult>}
 */
export const reconstructEndoCodeMode = async options => {
  const persistence = await validateEndoProvisionPersistence(
    options?.persistence,
  );
  return connectAndRealize(persistence, options?.sockPath);
};
harden(reconstructEndoCodeMode);
