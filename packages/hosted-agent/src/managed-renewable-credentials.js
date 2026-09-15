// @ts-check

/**
 * Mint (or adopt) the caplet that holds one renewable provider credential.
 *
 * The sibling of `provideManagedCredentials`, for a grant that is exchanged for
 * short-lived access tokens rather than sent as-is. Two of the three CLI
 * adapters need this shape — Codex has it today, inside a backend that holds
 * `@agent` for the sake of it; Claude has no exchange step at all, which is the
 * leading explanation for its uniform broker 502s and the reason this is shared
 * rather than Codex-local. Adopting it for Claude also needs that stored
 * credential re-minted into a state record first, so this lands with one
 * consumer.
 *
 * Idempotent, because Phase 5 re-runs setup on every daemon start. What it is
 * not is *silently* idempotent: an existing credential whose pinned secret path
 * differs from the requested one fails closed rather than being re-pointed.
 * That is the guard `HOSTED-SUBSCRIPTION.md` calls "setup refuses an existing
 * backend before reading or changing its credential", kept when the one-shot
 * refusal around it goes away.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import { readProvisionedEnvironment } from './hosted-setup.js';
import { readCredentialSecretPath } from './managed-renewable-credentials-module.js';

export const renewableCredentialsSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./managed-renewable-credentials-module.js', import.meta.url).href,
  ),
  'managed-renewable-credentials',
);

/**
 * Read an existing renewable credential by its verified entrypoint and report
 * the secret path it was pinned to. A name bound to something else — or to a
 * caplet with a different entrypoint — is refused rather than adopted, because
 * removing a name alone never proves what still holds the capability.
 *
 * @param {any} host
 * @param {{ label: string, namePath: string[] }} options
 */
export const readManagedRenewableCredentials = async (
  host,
  { label, namePath },
) => {
  const { identifier, env } = await readProvisionedEnvironment(host, {
    label,
    namePath,
    expectedSpecifier: renewableCredentialsSpecifier,
  });
  return harden({
    identifier,
    secretPath: readCredentialSecretPath(env.CREDENTIAL_SECRET_PATH),
  });
};
harden(readManagedRenewableCredentials);

/**
 * @param {any} host
 * @param {object} options
 * @param {string[]} options.namePath Where the credential caplet is bound.
 * @param {string[]} options.secretPath The one Secrets record it may read and
 *   replace. Pinned into the formula environment; a change fails closed.
 * @param {string} [options.label] Names the provider in messages.
 * @returns {Promise<{ minted: boolean }>}
 */
export const provideManagedRenewableCredentials = async (
  host,
  { namePath, secretPath, label = 'Provider' },
) => {
  readCredentialSecretPath(secretPath);
  const wanted = JSON.stringify(secretPath);
  if (await E(host).has(...namePath)) {
    const existing = await readManagedRenewableCredentials(host, {
      label,
      namePath,
    });
    JSON.stringify(existing.secretPath) === wanted ||
      Fail`${b(label)} credential is pinned to ${q(existing.secretPath)}, not ${q(secretPath)}. Changing the record a live credential renews is a migration, not a reconfiguration: retire the backend and its credential deliberately.`;
    return harden({ minted: false });
  }
  // Refuse a secret that is not in the catalog before minting a formula that
  // would be bound and unconstructable.
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  const entries = await E(catalog).list();
  entries.some((/** @type {any} */ item) =>
    item.petNamePaths.some(
      (/** @type {string[]} */ path) => JSON.stringify(path) === wanted,
    ),
  ) ||
    Fail`${b(label)} credential secret ${q(secretPath)} is not in the secrets catalog; import it before setup`;
  await E(host).makeUnconfined('@main', renewableCredentialsSpecifier, {
    powersName: '@agent',
    resultName: namePath,
    env: harden({
      CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath),
      CREDENTIAL_LABEL: label,
    }),
  });
  return harden({ minted: true });
};
harden(provideManagedRenewableCredentials);
