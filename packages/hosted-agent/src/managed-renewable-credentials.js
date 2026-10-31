// @ts-check

/**
 * Mint (or adopt) the caplet that holds one renewable provider credential.
 *
 * Claude and Codex use this for credentials exchanged for short-lived tokens.
 * Powers retains an exact host/SecretBlob pair, so reconstruction is independent
 * of later pet-name rebinding. Setup compares the requested capability with the
 * stored pair before adopting an existing wrapper; legacy path-only wrappers
 * require deliberate retirement rather than silent migration.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { M, mustMatch } from '@endo/patterns';
import { randomUUID } from 'node:crypto';

import {
  assertCurrentSpecifier,
  toCurrentSpecifier,
} from './current-specifier.js';
import { readProvisionedEnvironment } from './hosted-setup.js';
import {
  readCredentialSecretPath,
  RENEWABLE_CREDENTIAL_BINDING_VERSION,
} from './managed-renewable-credentials-module.js';

export const renewableCredentialsSpecifier = assertCurrentSpecifier(
  toCurrentSpecifier(
    new URL('./managed-renewable-credentials-module.js', import.meta.url).href,
  ),
  'managed-renewable-credentials',
);

/**
 * A marshal only fixes its slot recipes, not the values those recipes return.
 * Refuse dynamic recipes before evaluation: a cold incarnation may otherwise
 * register a caplet's returned blob under that caplet instead of its grant.
 *
 * @param {any} host
 * @param {string} identifier
 */
const assertStablePowers = async (host, identifier) => {
  const diagnostics = await E(host).diagnostics();
  const formula = await E(diagnostics).getFormula(identifier);
  formula.type === 'marshal' ||
    Fail`Renewable credential powers must be a marshalled dependency pair`;
  const slots = formula.properties?.slots;
  slots?.kind === 'reference-list' ||
    Fail`Renewable credential powers must retain static Secret grant recipes`;
  const identifiers = Object.values(slots.entries);
  const hostId = await E(host).identify('@agent');
  (identifiers.length === 2 &&
    new Set(identifiers).size === 2 &&
    identifiers.includes(hostId)) ||
    Fail`Renewable credential powers must retain static Secret grant recipes`;
  const hostFormula = await E(diagnostics).getFormula(hostId);
  hostFormula.type === 'host' ||
    Fail`Renewable credential host recipe is invalid`;
  const secretId = identifiers.find(id => id !== hostId);
  const secretFormula = await E(diagnostics).getFormula(secretId);
  const hub = secretFormula.properties?.hub;
  const path = secretFormula.properties?.path;
  (secretFormula.type === 'lookup' &&
    hub?.kind === 'reference' &&
    hub.identifier === hostId &&
    path?.kind === 'literal' &&
    Array.isArray(path.value) &&
    path.value.length === 3 &&
    path.value[0] === '@secrets' &&
    path.value[1] === 'use' &&
    typeof path.value[2] === 'string' &&
    path.value[2].length > 0) ||
    Fail`Renewable credential powers must retain static Secret grant recipes`;
};

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
  env.CREDENTIAL_BINDING_VERSION === RENEWABLE_CREDENTIAL_BINDING_VERSION ||
    Fail`${b(label)} credential has a legacy path-only binding; retire its renewal owner before reprovisioning`;
  const formula = await E(E(host).diagnostics()).getFormula(identifier);
  const powers = formula.properties.powers;
  powers?.kind === 'reference' ||
    Fail`Renewable credential powers must be retained`;
  await assertStablePowers(host, powers.identifier);
  const pair = await E(host).lookupById(powers.identifier);
  mustMatch(
    pair,
    M.splitRecord({ host: M.remotable(), secret: M.remotable() }, {}, {}),
  );
  pair.host === host || Fail`Renewable credential captures another host`;
  return harden({
    identifier,
    secretPath: readCredentialSecretPath(env.CREDENTIAL_SECRET_PATH),
    secret: pair.secret,
  });
};
harden(readManagedRenewableCredentials);

/**
 * @param {any} host
 * @param {object} options
 * @param {string[]} options.namePath Where the credential caplet is bound.
 * @param {string[]} options.secretPath The one Secrets record it may read and
 *   replace. The path is metadata; the capability is a formula dependency.
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
    existing.secret === (await E(host).lookup(secretPath)) ||
      Fail`${b(label)} credential secret identity changed; retire its renewal owner before reprovisioning`;
    return harden({ minted: false });
  }
  // Capture the read facet first and validate its matching admin by identity.
  // A rebind during these awaits cannot pair a read of A with a write to B.
  const secret = await E(host).lookup(secretPath);
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  await E(catalog).adminFor(secret);
  const temporary = `renewable-credential-powers.${randomUUID()}`;
  let failed = false;
  /** @type {unknown} */
  let failure;
  try {
    await E(host).storeValue(harden({ host, secret }), temporary);
    await assertStablePowers(host, await E(host).identify(temporary));
    await E(host).makeUnconfined('@main', renewableCredentialsSpecifier, {
      powersName: temporary,
      resultName: namePath,
      env: harden({
        CREDENTIAL_BINDING_VERSION: RENEWABLE_CREDENTIAL_BINDING_VERSION,
        CREDENTIAL_SECRET_PATH: JSON.stringify(secretPath),
        CREDENTIAL_LABEL: label,
      }),
    });
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    // Removing the alias leaves the marshalled powers formula retained by the
    // wrapper. A failed mint must not leave a hidden setup-only retention root.
    if (await E(host).has(temporary)) await E(host).remove(temporary);
  } catch (cleanupError) {
    if (failed) {
      // Preserve the original reason (including its CapTP correlation) rather
      // than replacing it with the cleanup failure or a stringified summary.
      throw AggregateError(
        [failure, cleanupError],
        'Renewable credential provisioning and temporary-name cleanup failed',
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (failed) throw failure;
  return harden({ minted: true });
};
harden(provideManagedRenewableCredentials);
