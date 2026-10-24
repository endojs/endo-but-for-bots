// @ts-check
/// <reference types="ses"/>

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

/** @import { ERef } from '@endo/eventual-send' */
/** @import { EndoClaudeGuestProvisionOptions, EndoClaudeProvisionHost } from './claude.types.js' */

const REQUIRED_GRANTS = harden(['workspace', 'git', 'remote', 'shell']);

/**
 * Provision the guest that an endo-claude session will drive, after checking
 * that its command capability is backed by the sandbox engine.
 *
 * The source names are host pet names. The guest receives them under the fixed
 * code-mode names `workspace`, `git`, `remote`, and `shell`. The engine check
 * happens before `provideGuest`, so a host-engine Shell neither creates a guest
 * nor enters one that already exists.
 *
 * @param {ERef<EndoClaudeProvisionHost>} host
 * @param {EndoClaudeGuestProvisionOptions} options
 */
export const provisionEndoClaudeGuest = async (host, options) => {
  const { handleName, agentName, grants } = options;
  if (!grants || typeof grants !== 'object') {
    throw makeError(X`provisionEndoClaudeGuest: grants must be an object`);
  }

  const sourceNames = REQUIRED_GRANTS.map(name => grants[name]);
  for (let index = 0; index < sourceNames.length; index += 1) {
    const sourceName = sourceNames[index];
    if (typeof sourceName !== 'string' || sourceName.length === 0) {
      throw makeError(
        X`provisionEndoClaudeGuest: grant ${q(REQUIRED_GRANTS[index])} must name a host pet name`,
      );
    }
  }
  if (new Set(sourceNames).size !== sourceNames.length) {
    throw makeError(
      X`provisionEndoClaudeGuest: every workspace grant must name a distinct host capability`,
    );
  }

  const present = await Promise.all(sourceNames.map(name => E(host).has(name)));
  const missing = REQUIRED_GRANTS.filter((_name, index) => !present[index]);
  if (missing.length > 0) {
    throw makeError(
      X`provisionEndoClaudeGuest: missing host grants ${q(missing.join(', '))}`,
    );
  }

  const shell = await E(host).lookup(grants.shell);
  const posture = await E(/** @type {any} */ (shell)).inspect();
  if (
    posture === null ||
    typeof posture !== 'object' ||
    /** @type {{ engine?: unknown }} */ (posture).engine !== 'sandbox'
  ) {
    throw makeError(
      X`provisionEndoClaudeGuest: Shell ${q(grants.shell)} is not sandbox-backed; refusing to provision an endo-claude guest`,
    );
  }

  const introducedNames = harden(
    Object.fromEntries(
      REQUIRED_GRANTS.map((guestName, index) => [
        /** @type {string} */ (sourceNames[index]),
        guestName,
      ]),
    ),
  );
  return E(host).provideGuest(handleName, {
    agentName,
    introducedNames,
  });
};
harden(provisionEndoClaudeGuest);
