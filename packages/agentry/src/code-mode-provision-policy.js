// @ts-check
/// <reference types="ses"/>

/** @import { EndoProvisionPersistence, EndoProvisionPolicy, EndoProvisionSpec, GitGrant, MountGrant, NormalizeEndoProvisionOptions, NormalizedGitGrant, NormalizedGitRemoteSpec, NormalizedMountGrant } from './code-mode-provisioning-types.js' */

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
  'mounts',
  'gits',
  'gitRemotes',
  'piTools',
]);
const WORKSPACE_FIELDS = harden(['path', 'deniedSegments']);
const MOUNT_FIELDS = harden(['path', 'mode', 'deniedSegments']);
const GIT_FIELDS = harden(['mount', 'path', 'mode']);
const NORMALIZED_MOUNT_FIELDS = harden([
  'root',
  'mode',
  'deniedSegments',
  'guestBinding',
]);
const NORMALIZED_GIT_FIELDS = harden(['mount', 'path', 'root', 'mode']);
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
const PRODUCT_RESERVED_BINDINGS = harden([
  'E',
  'git',
  'gits',
  'mounts',
  'workspace',
]);
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
 * Remote names and named mounts become lexical bindings inside a strict
 * module compartment.
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
 * A Git grant may select the generated compatibility mount named workspace.
 * Every other mount reference must name an actual named mount.
 *
 * @param {string} name
 * @param {string} label
 */
const assertMountReferenceName = (name, label) => {
  if (name !== 'workspace') {
    assertBindingName(name, label);
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
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
const isWithinRoot = (root, candidate) => {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== '..' &&
      !fromRoot.startsWith(`..${sep}`))
  );
};

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
const normalizeDeniedSegments = (value, label) =>
  harden(
    [
      ...new Set(
        requireStringArray(value ?? defaultDeniedSegments, label).map(
          (segment, index) => {
            if (
              segment === '.' ||
              segment === '..' ||
              segment.includes('/') ||
              segment.includes('\\')
            ) {
              throw makeError(
                X`${q(`${label}[${index}]`)} must be one path segment`,
              );
            }
            return segment.toLowerCase();
          },
        ),
      ),
    ].sort(),
  );

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
 * @param {unknown} value
 * @param {string} name
 * @param {string} cwd
 * @returns {Promise<NormalizedMountGrant>}
 */
const normalizeMount = async (value, name, cwd) => {
  assertBindingName(name, `Mount grant name ${name}`);
  const grant = requirePlainRecord(value, `EndoProvisionSpec.mounts.${name}`);
  const label = `EndoProvisionSpec.mounts.${name}`;
  assertKnownFields(grant, MOUNT_FIELDS, label);
  if (!FS_MODES.includes(/** @type {any} */ (grant.mode))) {
    throw makeError(X`${q(`${label}.mode`)} must be readOnly or readWrite`);
  }
  const selector = requireString(grant.path, `${label}.path`);
  const root = await canonicalDirectory(
    resolve(cwd, selector),
    `${label}.path`,
  );
  return harden({
    root,
    mode: /** @type {'readOnly' | 'readWrite'} */ (grant.mode),
    deniedSegments: normalizeDeniedSegments(
      grant.deniedSegments,
      `${label}.deniedSegments`,
    ),
    guestBinding: true,
  });
};

/**
 * @param {unknown} value
 * @param {string} name
 * @param {Record<string, NormalizedMountGrant>} mounts
 * @param {string | undefined} pinnedRoot
 * @returns {Promise<NormalizedGitGrant>}
 */
const normalizeGitGrant = async (value, name, mounts, pinnedRoot) => {
  const label = `EndoProvisionSpec.gits.${name}`;
  const grant = requirePlainRecord(value, label);
  assertKnownFields(grant, GIT_FIELDS, label);
  const mountName =
    grant.mount === undefined
      ? 'workspace'
      : requireString(grant.mount, `${label}.mount`);
  assertMountReferenceName(mountName, `${label}.mount`);
  const selectedMount = mounts[mountName];
  if (selectedMount === undefined) {
    throw makeError(
      X`${q(`${label}.mount`)} names an ungranted mount ${q(mountName)}`,
    );
  }
  const mode = grant.mode;
  if (mode === undefined || !GIT_MODES.includes(/** @type {any} */ (mode))) {
    throw makeError(
      X`${q(`${label}.mode`)} must be readOnly, readWrite, or historyRewrite`,
    );
  }
  const writable = mode === 'readWrite' || mode === 'historyRewrite';
  if (selectedMount.mode === 'readOnly' && writable) {
    throw makeError(
      X`Git grant ${q(name)} cannot be ${q(mode)} on read-only mount ${q(mountName)}`,
    );
  }
  if (writable && !selectedMount.guestBinding) {
    throw makeError(
      X`writable Git grant ${q(name)} requires its selected mount ${q(mountName)} to be guest-bound (grant an fs or mount binding the guest can see)`,
    );
  }
  const path = requireStringArray(grant.path, `${label}.path`).map(
    (segment, index) => {
      if (
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        isAbsolute(segment)
      ) {
        throw makeError(
          X`${q(`${label}.path[${index}]`)} must be one relative path segment inside the selected mount`,
        );
      }
      if (selectedMount.deniedSegments.includes(segment.toLowerCase())) {
        throw makeError(
          X`${q(`${label}.path[${index}]`)} names a denied segment of mount ${q(mountName)}`,
        );
      }
      return segment;
    },
  );
  const requestedRoot = resolve(selectedMount.root, ...path);
  // Persistence pins the canonical worktree root. Revalidation must check
  // that pinned root itself still exists and remains confined, without
  // following a selector that may have been replaced by a symlink after the
  // first normalization.
  const root = await canonicalDirectory(
    pinnedRoot ?? requestedRoot,
    `${label}.path`,
  );
  if (!isWithinRoot(selectedMount.root, root)) {
    throw makeError(
      X`${q(`${label}.path`)} must stay inside selected mount ${q(mountName)}`,
    );
  }
  return harden({
    mount: mountName,
    path: harden([...path]),
    root,
    mode: /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (mode),
  });
};

/**
 * @param {EndoProvisionSpec | undefined} spec
 * @param {string} cwd
 * @param {Record<string, string> | undefined} pinnedGitRoots
 * @returns {Promise<{ workspacePath: string, policy: EndoProvisionPolicy }>}
 */
const normalizePolicy = async (spec, cwd, pinnedGitRoots = undefined) => {
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

  const canonicalCwd = await canonicalDirectory(resolve(cwd), 'cwd');
  const requestedWorkspacePath =
    workspace.path === undefined
      ? canonicalCwd
      : resolve(
          canonicalCwd,
          requireString(workspace.path, 'EndoProvisionSpec.workspace.path'),
        );
  const workspacePath = await canonicalDirectory(
    requestedWorkspacePath,
    'EndoProvisionSpec.workspace.path',
  );
  const workspaceDeniedSegments = normalizeDeniedSegments(
    workspace.deniedSegments,
    'EndoProvisionSpec.workspace.deniedSegments',
  );

  const mountsRecord =
    root.mounts === undefined
      ? undefined
      : requirePlainRecord(root.mounts, 'EndoProvisionSpec.mounts');
  /** @type {Record<string, NormalizedMountGrant>} */
  const mounts = {};
  for (const name of Object.keys(mountsRecord ?? {}).sort()) {
    // eslint-disable-next-line no-await-in-loop
    mounts[name] = await normalizeMount(
      /** @type {Record<string, unknown>} */ (mountsRecord)[name],
      name,
      canonicalCwd,
    );
  }

  const gitsRecord =
    root.gits === undefined
      ? undefined
      : requirePlainRecord(root.gits, 'EndoProvisionSpec.gits');
  const needsWorkspaceMount =
    fs !== undefined ||
    git !== undefined ||
    Object.keys(gitsRecord ?? {}).some(name => {
      const grant = requirePlainRecord(
        /** @type {Record<string, unknown>} */ (gitsRecord)[name],
        `EndoProvisionSpec.gits.${name}`,
      );
      return grant.mount === undefined || grant.mount === 'workspace';
    });

  const workspaceGitModes = [
    ...(git === undefined ? [] : [git]),
    ...Object.keys(gitsRecord ?? {}).flatMap(name => {
      const grant = /** @type {Record<string, unknown>} */ (gitsRecord)[name];
      const grantRecord = isPlainRecord(grant) ? grant : undefined;
      const mount =
        grantRecord !== undefined && grantRecord.mount !== undefined
          ? grantRecord.mount
          : 'workspace';
      return mount === 'workspace' && typeof grantRecord?.mode === 'string'
        ? [grantRecord.mode]
        : [];
    }),
  ];
  if (
    fs !== 'readWrite' &&
    workspaceGitModes.some(
      mode => mode === 'readWrite' || mode === 'historyRewrite',
    )
  ) {
    throw makeError(
      X`writable Git requires a writable filesystem grant; declare fs: 'readWrite' or an explicit guest-bound writable mount; the compatibility workspace cannot use fs: 'readOnly' or omitted fs for a writable Git grant`,
    );
  }
  if (needsWorkspaceMount && mounts.workspace === undefined) {
    const workspaceMode =
      fs === 'readWrite' ||
      workspaceGitModes.some(
        mode => mode === 'readWrite' || mode === 'historyRewrite',
      )
        ? 'readWrite'
        : 'readOnly';
    mounts.workspace = harden({
      root: workspacePath,
      mode: /** @type {'readOnly' | 'readWrite'} */ (workspaceMode),
      deniedSegments: workspaceDeniedSegments,
      guestBinding: fs !== undefined,
    });
  }

  /** @type {Array<[string, NormalizedGitGrant]>} */
  const normalizedGits = [];
  if (git !== undefined) {
    normalizedGits.push([
      'git',
      await normalizeGitGrant(
        { mount: 'workspace', path: [], mode: git },
        'git',
        mounts,
        pinnedGitRoots?.git,
      ),
    ]);
  }
  for (const name of Object.keys(gitsRecord ?? {}).sort()) {
    assertBindingName(name, `Git grant name ${name}`);
    if (name === 'git') {
      throw makeError(
        X`Git grant name ${q(name)} is reserved for the compatibility root git input`,
      );
    }
    normalizedGits.push([
      name,
      // eslint-disable-next-line no-await-in-loop
      await normalizeGitGrant(
        /** @type {Record<string, unknown>} */ (gitsRecord)[name],
        name,
        mounts,
        pinnedGitRoots?.[name],
      ),
    ]);
  }
  const gits = /** @type {Record<string, NormalizedGitGrant>} */ (
    Object.fromEntries(
      normalizedGits.sort(([left], [right]) => left.localeCompare(right)),
    )
  );

  const gitRemotesRecord =
    root.gitRemotes === undefined
      ? undefined
      : requirePlainRecord(root.gitRemotes, 'EndoProvisionSpec.gitRemotes');
  if (gitRemotesRecord !== undefined && git === undefined) {
    throw makeError(X`Git remotes require the compatibility root git grant`);
  }
  if (
    gitRemotesRecord !== undefined &&
    git !== 'readWrite' &&
    git !== 'historyRewrite'
  ) {
    throw makeError(X`Git remotes require writable root Git authority`);
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

  const allNames = new Map();
  for (const name of Object.keys(mounts)) {
    allNames.set(name, 'mount');
  }
  for (const name of Object.keys(gits)) {
    if (allNames.has(name)) {
      throw makeError(
        X`Binding name ${q(name)} is declared for both a mount and a Git grant`,
      );
    }
    allNames.set(name, 'git');
  }
  for (const name of Object.keys(gitRemotes)) {
    if (allNames.has(name)) {
      throw makeError(
        X`Binding name ${q(name)} is declared for a mount, Git grant, or remote more than once`,
      );
    }
    allNames.set(name, 'remote');
  }

  /** @type {EndoProvisionPolicy} */
  const policy = harden({
    ...(piTools === undefined
      ? {}
      : { piTools: /** @type {'preserve'} */ (piTools) }),
    mounts: harden(
      Object.fromEntries(
        Object.entries(mounts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
    ...(Object.keys(gits).length === 0 ? {} : { gits: harden(gits) }),
    ...(Object.keys(gitRemotes).length === 0
      ? {}
      : { gitRemotes: harden(gitRemotes) }),
  });
  return harden({ workspacePath, policy });
};

/**
 * Normalize plain provisioning intent into the versioned persistence record.
 * Canonical host roots are retained only in this trusted record; guest-facing
 * globals are generated from the capability graph without exposing them.
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
    version: /** @type {2} */ (2),
    guestHandlePath: harden(['code-mode', harness, sessionKey, 'guest-handle']),
    workspacePath,
    policy,
  });
};
harden(normalizeEndoProvisionSpec);

/**
 * Validate and re-normalize caller-held persistence before reconstruction.
 * This re-resolves every canonical root and every mount-relative Git selector,
 * so moved or symlink-swapped roots fail closed before host realization.
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
  if (record.version !== 2) {
    throw makeError(X`Endo provision persistence version must be 2`);
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
  assertKnownFields(
    policyRecord,
    harden(['mounts', 'gits', 'gitRemotes', 'piTools']),
    'Endo provision persistence.policy',
  );
  const persistedMounts = requirePlainRecord(
    policyRecord.mounts,
    'Endo provision persistence.policy.mounts',
  );
  const persistedGits =
    policyRecord.gits === undefined
      ? undefined
      : requirePlainRecord(
          policyRecord.gits,
          'Endo provision persistence.policy.gits',
        );

  /** @type {Record<string, MountGrant>} */
  const mounts = {};
  /** @type {{ path: string, deniedSegments: string[] } | undefined} */
  let workspaceMount;
  /** @type {'readOnly' | 'readWrite' | undefined} */
  let fs;
  /** @type {'readOnly' | 'readWrite' | 'historyRewrite' | undefined} */
  let rootGitMode;
  /** @type {Record<string, string>} */
  const pinnedGitRoots = {};
  for (const name of Object.keys(persistedMounts).sort()) {
    const label = `Endo provision persistence.policy.mounts.${name}`;
    const mount = requirePlainRecord(
      /** @type {Record<string, unknown>} */ (persistedMounts)[name],
      label,
    );
    assertKnownFields(mount, NORMALIZED_MOUNT_FIELDS, label);
    const root = requireString(mount.root, `${label}.root`);
    if (!isAbsolute(root)) {
      throw makeError(X`${q(`${label}.root`)} must be absolute`);
    }
    if (!FS_MODES.includes(/** @type {any} */ (mount.mode))) {
      throw makeError(X`${q(`${label}.mode`)} must be readOnly or readWrite`);
    }
    if (typeof mount.guestBinding !== 'boolean') {
      throw makeError(X`${q(`${label}.guestBinding`)} must be a boolean`);
    }
    const deniedSegments = requireStringArray(
      mount.deniedSegments,
      `${label}.deniedSegments`,
    );
    if (name === 'workspace') {
      workspaceMount = { path: root, deniedSegments };
      if (mount.guestBinding) {
        fs = /** @type {'readOnly' | 'readWrite'} */ (mount.mode);
      }
    } else {
      if (!mount.guestBinding) {
        throw makeError(
          X`${q(label)} must be guest-bound when named explicitly`,
        );
      }
      mounts[name] = {
        path: root,
        mode: /** @type {'readOnly' | 'readWrite'} */ (mount.mode),
        deniedSegments,
      };
    }
  }

  /** @type {Record<string, GitGrant>} */
  const gits = {};
  for (const name of Object.keys(persistedGits ?? {}).sort()) {
    const label = `Endo provision persistence.policy.gits.${name}`;
    const grant = requirePlainRecord(
      /** @type {Record<string, unknown>} */ (persistedGits)[name],
      label,
    );
    assertKnownFields(grant, NORMALIZED_GIT_FIELDS, label);
    const mount = requireString(grant.mount, `${label}.mount`);
    const path = requireStringArray(grant.path, `${label}.path`);
    const grantRoot = requireString(grant.root, `${label}.root`);
    if (!isAbsolute(grantRoot)) {
      throw makeError(X`${q(`${label}.root`)} must be absolute`);
    }
    if (!GIT_MODES.includes(/** @type {any} */ (grant.mode))) {
      throw makeError(
        X`${q(`${label}.mode`)} must be readOnly, readWrite, or historyRewrite`,
      );
    }
    if (name === 'git') {
      if (mount !== 'workspace' || path.length !== 0) {
        throw makeError(
          X`Persisted compatibility root git must select workspace at its root`,
        );
      }
      rootGitMode = /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (
        grant.mode
      );
      pinnedGitRoots.git = grantRoot;
    } else {
      pinnedGitRoots[name] = grantRoot;
      gits[name] = {
        mount,
        path,
        mode: /** @type {'readOnly' | 'readWrite' | 'historyRewrite'} */ (
          grant.mode
        ),
      };
    }
  }

  const reconstructedSpec = harden({
    ...(policyRecord.piTools === undefined
      ? {}
      : { piTools: policyRecord.piTools }),
    ...(workspaceMount === undefined
      ? {}
      : {
          workspace: harden({
            path: workspaceMount.path,
            deniedSegments: harden([...workspaceMount.deniedSegments]),
          }),
        }),
    ...(fs === undefined ? {} : { fs }),
    ...(rootGitMode === undefined ? {} : { git: rootGitMode }),
    ...(Object.keys(mounts).length === 0 ? {} : { mounts }),
    ...(Object.keys(gits).length === 0 ? {} : { gits }),
    ...(policyRecord.gitRemotes === undefined
      ? {}
      : { gitRemotes: policyRecord.gitRemotes }),
  });
  const normalized = await normalizePolicy(
    /** @type {EndoProvisionSpec} */ (reconstructedSpec),
    workspacePath,
    pinnedGitRoots,
  );
  /** @type {EndoProvisionPersistence} */
  const persistence = harden({
    version: /** @type {2} */ (2),
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
