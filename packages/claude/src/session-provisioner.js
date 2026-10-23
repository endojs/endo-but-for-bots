// @ts-check
/// <reference types="ses"/>

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';

/** @import { ClaudeSessionBindings, ClaudeSessionGrant } from './claude.types.js' */

const bindingEntries = harden([
  harden(['workspace', 'workspace']),
  harden(['git', 'git']),
  harden(['remote', 'origin']),
  harden(['shell', 'shell']),
]);

/**
 * Bind the fixed code-mode grant for one Claude guest.
 *
 * The shell posture is read from the held Shell capability itself before the
 * guest receives any grant. A caller cannot bless a host-engine shell with
 * metadata beside the capability, and a refused session is left unmodified.
 *
 * @param {unknown} guest Endo guest whose petstore receives the grant.
 * @param {ClaudeSessionBindings} bindings
 * @returns {Promise<ClaudeSessionGrant>}
 */
export const provisionClaudeSession = async (guest, bindings) => {
  const posture = await E(/** @type {any} */ (bindings.shell)).inspect();
  if (posture?.engine !== 'sandbox') {
    throw makeError(
      X`Claude session requires a sandbox-engine Shell; held Shell reports engine ${q(
        posture?.engine,
      )}`,
    );
  }

  for (const [bindingName, petName] of bindingEntries) {
    // eslint-disable-next-line no-await-in-loop
    await E(/** @type {any} */ (guest)).storeValue(
      bindings[/** @type {keyof ClaudeSessionBindings} */ (bindingName)],
      petName,
    );
  }

  return harden({
    codeNames: harden(bindingEntries.map(([, name]) => name)),
    petNamePaths: harden(bindingEntries.map(([, name]) => harden([name]))),
  });
};
harden(provisionClaudeSession);
