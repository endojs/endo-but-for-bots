// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal, CodeModeGrant, CodeModePower, GlobalDeclaration } from '@endo/agent-tools/code-mode/types.js' */

import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';
import {
  makeFilesystemGlobal,
  makeWorkspaceGlobal,
} from '@endo/agent-tools/code-mode-globals/fs.js';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { makeHttpGlobal } from '@endo/agent-tools/code-mode-globals/http.js';
import { lineageOf } from '@endo/daemon/src/mount.js';
import { isGitHistoryRewrite, isGitReadOnly } from '@endo/exo-git';
import {
  isFilesystemReadOnly,
  isFilesystemReadWrite,
} from '@endo/platform/fs/extended';

/** @typedef {'readOnly' | 'readWrite' | 'historyRewrite'} GitMode */

/**
 * @typedef {object} CodeModeGrantMinter
 * @property {(options: { name: string, petName?: string | string[], description?: string, capability: CodeModePower }) => CodeModeGrant} opaque
 * @property {(options: { name: string, petName?: string | string[], capability: CodeModePower, requestedMode?: GitMode }) => CodeModeGrant} git
 * @property {(options: { name: string, petName?: string | string[], capability: CodeModePower, surface?: 'mount' | 'filesystem' }) => CodeModeGrant} filesystem
 * @property {(options: { name: string, petName?: string | string[], capability: CodeModePower, mode: 'readOnly' | 'readWrite', authority: object }) => CodeModeGrant} provisionedFilesystem
 * @property {(options: { name: string, petName?: string | string[], capability: CodeModePower, mode: GitMode, authority: object }) => CodeModeGrant} provisionedGit
 * @property {(options: { name: string, petName?: string | string[], capability: CodeModePower, authority: object }) => CodeModeGrant} provisionedHttp
 */

/** @type {WeakSet<object>} */
const trustedGrants = new WeakSet();
/** @type {WeakMap<object, object>} */
const provisionedGuestAuthorities = new WeakMap();
/** @type {WeakSet<object>} */
const trustedProvisionAuthorities = new WeakSet();

/**
 * @param {unknown} value
 * @returns {value is GlobalDeclaration}
 */
const isDeclaration = value => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = /** @type {{ body?: unknown, aux?: unknown }} */ (value);
  return (
    typeof record.body === 'string' &&
    record.body.length > 0 &&
    (record.aux === undefined || typeof record.aux === 'string')
  );
};

/**
 * @param {object} guest
 * @returns {object}
 */
export const registerProvisionedGuest = guest => {
  const authority = harden({});
  trustedProvisionAuthorities.add(authority);
  provisionedGuestAuthorities.set(guest, authority);
  return authority;
};
harden(registerProvisionedGuest);

/**
 * @param {unknown} guest
 * @returns {object | undefined}
 */
export const provisionedGuestAuthorityOf = guest =>
  typeof guest === 'object' && guest !== null
    ? provisionedGuestAuthorities.get(guest)
    : undefined;
harden(provisionedGuestAuthorityOf);

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string | string[]} [options.petName]
 * @param {string} [options.description]
 * @param {GlobalDeclaration} options.declaration
 * @param {CodeModePower} options.capability
 * @returns {CodeModeGrant}
 */
const mintGrant = ({
  name,
  petName = name,
  description,
  declaration,
  capability,
}) => {
  if (
    (typeof capability !== 'object' || capability === null) &&
    typeof capability !== 'function'
  ) {
    throw new Error(
      `code-mode grant "${name}" requires a live capability object`,
    );
  }
  if (!isDeclaration(declaration)) {
    throw new Error(`code-mode grant "${name}" requires a derived declaration`);
  }
  const grant = /** @type {CodeModeGrant} */ (
    harden({
      name,
      petName,
      ...(description === undefined ? {} : { description }),
      declaration,
      capability,
    })
  );
  trustedGrants.add(grant);
  return grant;
};

/**
 * @param {unknown} grant
 * @returns {grant is CodeModeGrant}
 */
const isTrustedGrant = grant =>
  typeof grant === 'object' && grant !== null && trustedGrants.has(grant);

/**
 * @param {unknown} authority
 * @returns {object}
 */
const assertProvisionAuthority = authority => {
  if (
    (typeof authority !== 'object' || authority === null) &&
    typeof authority !== 'function'
  ) {
    throw new Error('code-mode grant lacks trusted provisioning provenance');
  }
  if (!trustedProvisionAuthorities.has(authority)) {
    throw new Error('code-mode grant lacks trusted provisioning provenance');
  }
  return authority;
};

/**
 * The only grant minter used by code-mode construction and retained
 * provisioning.
 *
 * @returns {CodeModeGrantMinter}
 */
export const makeCodeModeGrantMinter = () => {
  /** @type {CodeModeGrantMinter} */
  const minter = {
    opaque: ({ name, petName = name, description, capability }) =>
      mintGrant({
        name,
        petName,
        description,
        declaration: { body: 'unknown' },
        capability,
      }),
    git: ({ name, petName = name, capability, requestedMode }) => {
      const readOnly = isGitReadOnly(capability);
      const historyRewrite = isGitHistoryRewrite(capability);
      if (readOnly === undefined || historyRewrite === undefined) {
        throw new Error(
          'code-mode Git grants require a recognized same-vat Git capability; foreign or unknown Git objects are rejected',
        );
      }
      const actualMode = historyRewrite
        ? 'historyRewrite'
        : readOnly
          ? 'readOnly'
          : 'readWrite';
      if (requestedMode !== undefined && requestedMode !== actualMode) {
        if (requestedMode === 'readOnly') {
          throw new Error(
            'code-mode gitMode readOnly requires an already read-only Git capability',
          );
        }
        if (requestedMode === 'historyRewrite') {
          throw new Error(
            'code-mode gitMode historyRewrite requires a Git capability with history-rewrite authority',
          );
        }
        throw new Error(
          `code-mode gitMode ${requestedMode} does not match the recognized Git capability posture (${actualMode})`,
        );
      }
      const global = makeGitGlobal({
        name,
        petName,
        readOnly: actualMode === 'readOnly',
        historyRewrite: actualMode === 'historyRewrite',
      });
      if (global.declaration === undefined) {
        throw new Error('Git global is missing its generated declaration');
      }
      return mintGrant({
        name,
        petName,
        description: global.description,
        declaration: global.declaration,
        capability,
      });
    },
    filesystem: ({ name, petName = name, capability, surface }) => {
      const posture = isFilesystemReadOnly(capability)
        ? 'readOnly'
        : isFilesystemReadWrite(capability)
          ? 'readWrite'
          : undefined;
      const isMount = lineageOf(capability) !== undefined;
      if (
        (surface === 'filesystem' && posture === undefined) ||
        (surface === 'mount' && !isMount) ||
        (surface === undefined && posture === undefined && !isMount)
      ) {
        throw new Error(
          `code-mode filesystem grant "${name}" requires a locally recognized exact reader or writer posture; foreign filesystem capabilities are rejected`,
        );
      }
      const makeFilesystemDescriptor =
        surface === 'filesystem' ||
        (surface === undefined && posture !== undefined)
          ? makeFilesystemGlobal
          : makeWorkspaceGlobal;
      const global = makeFilesystemDescriptor({
        name,
        petName,
        readOnly: posture === 'readOnly',
      });
      if (global.declaration === undefined) {
        throw new Error(
          'workspace global is missing its generated declaration',
        );
      }
      return mintGrant({
        name,
        petName,
        description: global.description,
        declaration: global.declaration,
        capability,
      });
    },
    provisionedFilesystem: ({
      name,
      petName = name,
      capability,
      mode,
      authority,
    }) => {
      assertProvisionAuthority(authority);
      if (mode !== 'readOnly' && mode !== 'readWrite') {
        throw new Error(
          `code-mode filesystem grant "${name}" has an invalid posture`,
        );
      }
      return mintGrant({
        name,
        petName,
        capability,
        declaration: { body: 'unknown' },
      });
    },
    provisionedGit: ({ name, petName = name, capability, mode, authority }) => {
      assertProvisionAuthority(authority);
      const global = makeGitGlobal({
        name,
        petName,
        readOnly: mode === 'readOnly',
        historyRewrite: mode === 'historyRewrite',
      });
      if (global.declaration === undefined) {
        throw new Error('Git global is missing its generated declaration');
      }
      return mintGrant({
        name,
        petName,
        description: global.description,
        declaration: global.declaration,
        capability,
      });
    },
    provisionedHttp: ({ name, petName = name, capability, authority }) => {
      assertProvisionAuthority(authority);
      // An HttpClient is a foreign-to-this-vat capability with no local
      // posture recognizer, but it does have a generated declaration, so the
      // binding can be a described global rather than an opaque one. The
      // policy it enforces is the host's, not this record's.
      const global = makeHttpGlobal({ name, petName });
      if (global.declaration === undefined) {
        throw new Error(
          'HttpClient global is missing its generated declaration',
        );
      }
      return mintGrant({
        name,
        petName,
        description: global.description,
        declaration: global.declaration,
        capability,
      });
    },
  };
  return /** @type {CodeModeGrantMinter} */ (harden(minter));
};
harden(makeCodeModeGrantMinter);

/**
 * @param {CodeModeGrant[]} grants
 * @returns {CodeModeGrant[]}
 */
export const normalizeCodeModeGrants = grants => {
  if (!Array.isArray(grants) || !grants.every(isTrustedGrant)) {
    throw new Error(
      'code-mode grants must be minted by a trusted code-mode grant minter',
    );
  }
  normalizeGlobals(
    grants.map(({ capability: _capability, ...global }) => global),
  );
  return harden([...grants]);
};
harden(normalizeCodeModeGrants);

/**
 * @param {CodeModeGrant[]} grants
 * @returns {CodeModeGlobal[]}
 */
export const codeModeGrantGlobals = grants =>
  normalizeGlobals(
    normalizeCodeModeGrants(grants).map(
      ({ capability: _capability, ...global }) => global,
    ),
  );
harden(codeModeGrantGlobals);
