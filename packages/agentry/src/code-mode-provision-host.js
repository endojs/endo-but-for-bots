// @ts-check

/** @import { CodeModeGlobal } from '@endo/agent-tools/code-mode/types.js' */
/** @import { EndoGuest, EndoHost } from '@endo/daemon' */
/** @import { EndoGuestAuthority } from '@endo/daemon/provision.js' */
/** @import { EndoCodeModeProvisionForkOptions, EndoCodeModeProvisionPersistence, EndoCodeModeProvisionRequest } from './code-mode-provisioning-types.js' */
/** @typedef {{ version: 1, authority: EndoGuestAuthority, introducedNames: Record<string, string> }} EndoCodeModeHostState */

import { E } from '@endo/eventual-send';
import { makeError, X } from '@endo/errors';
import { keyEQ } from '@endo/patterns';

import { makeEndoProvisionGlobals } from './code-mode-provision-globals.js';
import { validateEndoCodeModeProvisionPersistence } from './code-mode-provision-policy.js';

/** @param {string} guestName */
const statePathFor = guestName =>
  harden(['provisioned-guests', guestName, 'code-mode-state']);

/**
 * @param {unknown} value
 * @returns {EndoCodeModeHostState}
 */
const validateHostState = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw makeError(X`Retained Endo code-mode state is invalid`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  if (
    Object.keys(record).some(
      key => !['version', 'authority', 'introducedNames'].includes(key),
    ) ||
    record.version !== 1 ||
    typeof record.authority !== 'object' ||
    record.authority === null ||
    Array.isArray(record.authority) ||
    typeof record.introducedNames !== 'object' ||
    record.introducedNames === null ||
    Array.isArray(record.introducedNames)
  ) {
    throw makeError(X`Retained Endo code-mode state is invalid`);
  }
  return /** @type {EndoCodeModeHostState} */ (value);
};

/**
 * @param {EndoHost} host
 * @param {EndoCodeModeProvisionPersistence} persistence
 */
const loadHostState = async (host, persistence) => {
  await null;
  const path = statePathFor(persistence.guestName);
  if (!(await E(host).has(...path))) {
    throw makeError(X`Retained Endo code-mode state is unavailable`);
  }
  return validateHostState(await E(host).lookup(path));
};

/**
 * @param {EndoGuest} guest
 * @param {EndoCodeModeProvisionRequest} request
 */
const projectGlobals = async (guest, request) => {
  await null;
  const introducedBindings = new Set(Object.values(request.introducedNames));
  /** @type {CodeModeGlobal[]} */
  const globals = [];
  for (const global of makeEndoProvisionGlobals(request)) {
    const petNamePath = Array.isArray(global.petName)
      ? global.petName
      : [global.petName ?? global.name];
    if (
      !introducedBindings.has(global.name) ||
      // Missing introductions follow provideGuest's established ignore rule.
      // eslint-disable-next-line no-await-in-loop
      (await E(guest).has(...petNamePath))
    ) {
      globals.push(global);
    }
  }
  return harden(globals);
};

/**
 * Project a retained code-mode guest and its daemon-owned lexical state onto
 * an existing Endo host. Connection ownership stays with the caller.
 *
 * @param {EndoHost} host
 * @param {EndoCodeModeProvisionPersistence} persistence
 * @param {EndoCodeModeProvisionForkOptions & { request?: EndoCodeModeProvisionRequest }} [options]
 * @returns {Promise<{ guest: EndoGuest, globals: CodeModeGlobal[] }>}
 */
export const provideEndoCodeModeGuest = async (
  host,
  persistence,
  options = {},
) => {
  const identity = await validateEndoCodeModeProvisionPersistence(persistence);
  let request = options.request;
  if (request !== undefined) {
    const requestedIdentity = await validateEndoCodeModeProvisionPersistence(
      request.persistence,
    );
    if (!keyEQ(requestedIdentity, identity)) {
      throw makeError(X`Code-mode request identity does not match its guest`);
    }
  }
  if (options.forkFrom !== undefined) {
    if (request !== undefined) {
      throw makeError(X`A code-mode fork cannot carry a new authority request`);
    }
    const parent = await validateEndoCodeModeProvisionPersistence(
      options.forkFrom,
    );
    if (parent.guestName === identity.guestName) {
      throw makeError(
        X`A code-mode fork requires a distinct retained guest name`,
      );
    }
    const parentState = await loadHostState(host, parent);
    request = harden({
      persistence: identity,
      authority: parentState.authority,
      introducedNames: parentState.introducedNames,
    });
  }

  try {
    if (request === undefined) {
      const guest = await E(host).provideGuest(identity.guestName);
      const state = await loadHostState(host, identity);
      const globals = await projectGlobals(
        guest,
        harden({ persistence: identity, ...state }),
      );
      return harden({ guest, globals });
    }

    const guest = await E(host).provideGuest(identity.guestName, {
      authority: request.authority,
      ...(Object.keys(request.introducedNames).length === 0
        ? {}
        : { introducedNames: request.introducedNames }),
    });
    const proposed = harden({
      version: /** @type {1} */ (1),
      authority: request.authority,
      introducedNames: request.introducedNames,
    });
    const globals = await projectGlobals(guest, request);
    const statePath = statePathFor(identity.guestName);
    if (await E(host).has(...statePath)) {
      const retained = validateHostState(await E(host).lookup(statePath));
      if (!keyEQ(retained, proposed)) {
        throw makeError(X`Code-mode projection does not match retained state`);
      }
      return harden({ guest, globals });
    }
    await E(host).storeValue(/** @type {any} */ (proposed), statePath);
    return harden({ guest, globals });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('ENDO_CREDENTIAL_UNAVAILABLE:')
    ) {
      throw makeError(X`The configured Git credential is unavailable`, Error, {
        cause: error,
        code: 'ENDO_CREDENTIAL_UNAVAILABLE',
      });
    }
    throw error;
  }
};
harden(provideEndoCodeModeGuest);
