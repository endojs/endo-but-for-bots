// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeGlobal, CodeModeGrant, CodeModePower } from '@endo/agent-tools/code-mode/types.js' */
/** @import { EndoGuest } from '@endo/daemon' */
/** @import { EndoProvisionPersistence } from './code-mode-provisioning-types.js' */

import { E } from '@endo/eventual-send';
import { makeGitGlobal } from '@endo/agent-tools/code-mode-globals/git.js';
import { normalizeGlobals } from '@endo/agent-tools/code-mode/declarations.js';

import {
  makeCodeModeGrantMinter,
  normalizeCodeModeGrants,
  provisionedGuestAuthorityOf,
} from './code-mode-grants.js';

/**
 * Select prompt descriptors from normalized policy. This helper is exported
 * from the source module for focused tests; the public subpath filters it out.
 * Caller-supplied descriptions are supplemental model context only. A future
 * trusted descriptor registry owns any TypeScript declaration and must not let
 * policy text supply, replace, or override that declaration.
 *
 * @param {EndoProvisionPersistence} persistence
 * @returns {CodeModeGlobal[]}
 */
export const makeEndoProvisionGlobals = persistence => {
  const { policy } = persistence;
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  for (const name of Object.keys(policy.mounts).sort()) {
    if (policy.mounts[name].guestBinding) {
      // EndoMount is a Directory-shaped capability, not the platform
      // Filesystem object described by makeWorkspaceGlobal.  Withhold an
      // interface declaration until a mount-specific recognizer exists.
      globals.push({ name });
    }
  }
  const gits = policy.gits ?? {};
  for (const name of Object.keys(gits).sort()) {
    const grant = gits[name];
    globals.push(
      makeGitGlobal({
        name,
        readOnly: grant.mode === 'readOnly',
        historyRewrite: grant.mode === 'historyRewrite',
      }),
    );
  }
  for (const name of Object.keys(policy.gitRemotes ?? {}).sort()) {
    // A remote is foreign to this vat and has no local posture recognizer.
    globals.push({ name });
  }
  for (const [name, grant] of Object.entries(policy.grants ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    globals.push(
      harden({
        name,
        ...(grant.description === undefined
          ? {}
          : { description: grant.description }),
      }),
    );
  }
  return normalizeGlobals(globals);
};
harden(makeEndoProvisionGlobals);

/**
 * Rebind every guest-facing capability and derive its declaration from the
 * same normalized policy that minted that capability.  This function is
 * intentionally asynchronous: a retained session must not manufacture a
 * prompt descriptor until the live guest has rebound the actual capability.
 *
 * @param {EndoGuest} guest
 * @param {EndoProvisionPersistence} persistence
 * @returns {Promise<CodeModeGrant[]>}
 */
export const makeEndoProvisionGrants = async (guest, persistence) => {
  await null;
  const minter = makeCodeModeGrantMinter();
  const authority = provisionedGuestAuthorityOf(guest);
  if (authority === undefined) {
    throw new Error(
      'code-mode provisioning grants require a guest returned by the trusted provisioning path',
    );
  }
  const { policy } = persistence;
  const gits = policy.gits ?? {};
  /** @type {CodeModeGrant[]} */
  const grants = [];
  for (const name of Object.keys(policy.mounts).sort()) {
    if (policy.mounts[name].guestBinding) {
      const capability = /** @type {CodeModePower} */ (
        // eslint-disable-next-line no-await-in-loop
        await E(guest).lookup(name)
      );
      grants.push(
        minter.provisionedFilesystem({
          name,
          capability,
          mode: policy.mounts[name].mode,
          authority,
        }),
      );
    }
  }
  for (const name of Object.keys(gits).sort()) {
    const grant = gits[name];
    const capability = /** @type {CodeModePower} */ (
      // eslint-disable-next-line no-await-in-loop
      await E(guest).lookup(name)
    );
    grants.push(
      minter.provisionedGit({
        name,
        capability,
        mode: grant.mode,
        authority,
      }),
    );
  }
  for (const name of Object.keys(policy.gitRemotes ?? {}).sort()) {
    const capability = /** @type {CodeModePower} */ (
      // eslint-disable-next-line no-await-in-loop
      await E(guest).lookup(name)
    );
    // A remote capability has no local interface recognizer in this package.
    // Keep the compatibility binding truthful by withholding an interface
    // declaration until a trusted remote minter is available.
    grants.push(minter.opaque({ name, capability }));
  }
  for (const [name, grant] of Object.entries(policy.grants ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const capability = /** @type {CodeModePower} */ (
      // eslint-disable-next-line no-await-in-loop
      await E(guest).lookup(name)
    );
    grants.push(
      minter.opaque({
        name,
        description: grant.description,
        capability,
      }),
    );
  }
  return normalizeCodeModeGrants(grants);
};
harden(makeEndoProvisionGrants);
