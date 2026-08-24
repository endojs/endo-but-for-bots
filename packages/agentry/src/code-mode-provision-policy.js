// @ts-check
/// <reference types="ses"/>

/** @import { EndoCodeModeGitAccess, EndoCodeModeProvisionPersistence, EndoCodeModeProvisionSpec, NormalizeEndoCodeModeProvisionOptions } from './code-mode-provisioning-types.js' */
/** @import { EndoGuestAuthority } from '@endo/daemon/provision.js' */

import { isName, isPetName } from '@endo/daemon/pet-name.js';
import { makeError, q, X } from '@endo/errors';

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const HARNESS_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/u;
const IDENTIFIER_RE = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;
const SECRET_QUERY_KEY_RE = harden(
  /(?:api.?key|authorization|password|secret|token)/iu,
);
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
  'git',
  'gits',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'mounts',
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
  'workspace',
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
 * Translate code-mode conveniences into the daemon's neutral named graph.
 * Relative paths and compatibility binding names stop at this adapter.
 *
 * @param {EndoCodeModeProvisionSpec | undefined} specInput
 * @param {NormalizeEndoCodeModeProvisionOptions} options
 * @returns {Promise<EndoCodeModeProvisionPersistence>}
 */
export const normalizeEndoCodeModeProvisionSpec = async (
  specInput,
  options,
) => {
  await null;
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
  if (typeof options?.cwd !== 'string' || options.cwd.length === 0) {
    throw makeError(X`cwd must be a non-empty string`);
  }
  const spec = plainRecord(specInput ?? {}, 'EndoCodeModeProvisionSpec');
  assertFields(
    spec,
    [
      'workspace',
      'git',
      'mounts',
      'gits',
      'gitRemotes',
      'introducedNames',
      'piTools',
    ],
    'EndoCodeModeProvisionSpec',
  );
  if (spec.piTools !== undefined && spec.piTools !== 'preserve') {
    throw makeError(X`piTools must be preserve`);
  }
  const sessionHash = createHash('sha256')
    .update(options.sessionId)
    .digest('hex');
  let canonicalCwd = options.cwd;
  try {
    canonicalCwd = await realpath(options.cwd);
  } catch {
    // Preserve the existing deferred path validation for missing workspaces.
  }

  /** @type {Record<string, any>} */
  const mount = {};
  if (spec.workspace !== undefined) {
    const workspace = plainRecord(spec.workspace, 'workspace');
    assertFields(workspace, ['path', 'mode', 'deniedSegments'], 'workspace');
    const mode = accessMode(workspace.mode, 'workspace.mode');
    if (mode === 'historyRewrite') {
      throw makeError(X`workspace.mode must be readOnly or readWrite`);
    }
    defineEntry(
      mount,
      'workspace',
      harden({
        path:
          workspace.path === undefined
            ? canonicalCwd
            : resolve(options.cwd, workspace.path),
        readOnly: mode === 'readOnly',
        ...(workspace.deniedSegments === undefined
          ? {}
          : {
              deniedSegments: stringList(
                workspace.deniedSegments,
                'workspace.deniedSegments',
              ),
            }),
      }),
    );
  }
  for (const [name, value] of Object.entries(
    spec.mounts === undefined ? {} : plainRecord(spec.mounts, 'mounts'),
  )) {
    assertBinding(name, `mounts.${name}`);
    const grant = plainRecord(value, `mounts.${name}`);
    assertFields(grant, ['path', 'mode', 'deniedSegments'], `mounts.${name}`);
    const mode = accessMode(grant.mode, `mounts.${name}.mode`);
    if (mode === 'historyRewrite') {
      throw makeError(
        X`${q(`mounts.${name}.mode`)} must be readOnly or readWrite`,
      );
    }
    defineEntry(
      mount,
      name,
      harden({
        path: resolve(options.cwd, grant.path),
        readOnly: mode === 'readOnly',
        ...(grant.deniedSegments === undefined
          ? {}
          : {
              deniedSegments: stringList(
                grant.deniedSegments,
                `mounts.${name}.deniedSegments`,
              ),
            }),
      }),
    );
  }

  /** @type {Record<string, any>} */
  const git = {};
  /** @type {EndoCodeModeProvisionPersistence['internalGit']} */
  let internalGit;
  if (spec.git !== undefined) {
    const mode = accessMode(spec.git, 'git');
    if (mount.workspace === undefined) {
      if (mode !== 'readOnly') {
        throw makeError(
          X`writable compatibility git requires a guest-visible workspace`,
        );
      }
      internalGit = harden({
        path: canonicalCwd,
        mountName: `code-mode-internal-mount-${options.harness}-${sessionHash}`,
        gitName: `code-mode-internal-git-${options.harness}-${sessionHash}`,
      });
    } else {
      defineEntry(
        git,
        'git',
        harden({
          mount: 'workspace',
          path: harden([]),
          readOnly: mode === 'readOnly',
          allowHistoryRewrite: mode === 'historyRewrite',
        }),
      );
    }
  }
  for (const [name, value] of Object.entries(
    spec.gits === undefined ? {} : plainRecord(spec.gits, 'gits'),
  )) {
    assertBinding(name, `gits.${name}`);
    const grant = plainRecord(value, `gits.${name}`);
    assertFields(grant, ['mount', 'path', 'mode'], `gits.${name}`);
    if (typeof grant.mount !== 'string') {
      throw makeError(
        X`${q(`gits.${name}.mount`)} must select a mount binding`,
      );
    }
    const mode = accessMode(grant.mode, `gits.${name}.mode`);
    defineEntry(
      git,
      name,
      harden({
        mount: grant.mount,
        path: stringList(grant.path, `gits.${name}.path`),
        readOnly: mode === 'readOnly',
        allowHistoryRewrite: mode === 'historyRewrite',
      }),
    );
  }

  /** @type {Record<string, any>} */
  const gitRemote = {};
  for (const [binding, value] of Object.entries(
    spec.gitRemotes === undefined
      ? {}
      : plainRecord(spec.gitRemotes, 'gitRemotes'),
  )) {
    assertBinding(binding, `gitRemotes.${binding}`);
    const remote = plainRecord(value, `gitRemotes.${binding}`);
    if (typeof remote.git !== 'string' || typeof remote.name !== 'string') {
      throw makeError(
        X`${q(`gitRemotes.${binding}`)} must select git and name its protocol remote`,
      );
    }
    if (typeof remote.url === 'string') {
      let parsed;
      try {
        parsed = new URL(remote.url);
      } catch {
        throw makeError(X`${q(`gitRemotes.${binding}.url`)} must be a URL`);
      }
      for (const key of parsed.searchParams.keys()) {
        if (SECRET_QUERY_KEY_RE.test(key)) {
          throw makeError(
            X`${q(`gitRemotes.${binding}.url`)} must not carry credential query fields`,
          );
        }
      }
    }
    defineEntry(gitRemote, binding, harden({ ...remote }));
  }

  const introducedInput =
    spec.introducedNames === undefined
      ? {}
      : plainRecord(spec.introducedNames, 'introducedNames');
  const introducedGuestNames = new Set();
  const userIntroducedNames = harden(
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
  const introducedNames = harden({
    ...userIntroducedNames,
    ...(internalGit === undefined ? {} : { [internalGit.gitName]: 'git' }),
  });

  const authority = /** @type {EndoGuestAuthority} */ (
    harden({
      ...(Object.keys(mount).length === 0 ? {} : { mount: harden(mount) }),
      ...(Object.keys(git).length === 0 ? {} : { git: harden(git) }),
      ...(Object.keys(gitRemote).length === 0
        ? {}
        : { gitRemote: harden(gitRemote) }),
    })
  );
  const canonicalWorkspace =
    spec.workspace === undefined
      ? undefined
      : harden({ ...spec.workspace, path: mount.workspace.path });
  const canonicalMounts =
    spec.mounts === undefined
      ? undefined
      : harden(
          Object.fromEntries(
            Object.entries(spec.mounts).map(([name, grant]) => [
              name,
              harden({ ...grant, path: mount[name].path }),
            ]),
          ),
        );
  const normalizedSpec = harden({
    ...spec,
    ...(canonicalWorkspace === undefined
      ? {}
      : { workspace: canonicalWorkspace }),
    ...(canonicalMounts === undefined ? {} : { mounts: canonicalMounts }),
    ...(spec.gits === undefined ? {} : { gits: harden({ ...spec.gits }) }),
    ...(spec.gitRemotes === undefined
      ? {}
      : { gitRemotes: harden({ ...spec.gitRemotes }) }),
    ...(Object.keys(userIntroducedNames).length === 0
      ? {}
      : { introducedNames: userIntroducedNames }),
  });
  return harden({
    version: /** @type {3} */ (3),
    guestName: `code-mode-${options.harness}-${sessionHash}`,
    authority,
    introducedNames,
    ...(internalGit === undefined ? {} : { internalGit }),
    spec: /** @type {EndoCodeModeProvisionSpec} */ (normalizedSpec),
  });
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
    [
      'version',
      'guestName',
      'authority',
      'introducedNames',
      'internalGit',
      'spec',
    ],
    'EndoCodeModeProvisionPersistence',
  );
  if (record.version !== 3 || !isPetName(record.guestName)) {
    throw makeError(X`EndoCodeModeProvisionPersistence is invalid`);
  }
  plainRecord(record.authority, 'persisted authority');
  const introducedNames = plainRecord(
    record.introducedNames,
    'introducedNames',
  );
  const spec = plainRecord(record.spec, 'spec');
  /** @type {EndoCodeModeProvisionPersistence['internalGit']} */
  let internalGit;
  if (record.internalGit !== undefined) {
    const internalGitRecord = plainRecord(record.internalGit, 'internalGit');
    assertFields(
      internalGitRecord,
      ['path', 'mountName', 'gitName'],
      'internalGit',
    );
    if (
      typeof internalGitRecord.path !== 'string' ||
      !isPetName(internalGitRecord.mountName) ||
      !isPetName(internalGitRecord.gitName)
    ) {
      throw makeError(X`internalGit is invalid`);
    }
    internalGit = harden({
      path: internalGitRecord.path,
      mountName: internalGitRecord.mountName,
      gitName: internalGitRecord.gitName,
    });
  }
  return harden({
    version: /** @type {3} */ (3),
    guestName: record.guestName,
    authority: record.authority,
    introducedNames: harden({ ...introducedNames }),
    ...(internalGit === undefined ? {} : { internalGit }),
    spec: harden({ ...spec }),
  });
};
harden(validateEndoCodeModeProvisionPersistence);

// Internal aliases for the Pi session adapter. The public package entry point
// exports only the EndoCodeMode-prefixed names.
export const normalizeEndoProvisionSpec = normalizeEndoCodeModeProvisionSpec;
harden(normalizeEndoProvisionSpec);
export const validateEndoProvisionPersistence =
  validateEndoCodeModeProvisionPersistence;
harden(validateEndoProvisionPersistence);
