// @ts-check

/**
 * The per-credential caplet `provideManagedRenewableCredentials` mints for a
 * provider credential that must be *renewed*, not merely read.
 *
 * `managed-credentials-module.js` is the static case: a key that never expires,
 * delegated as a `SecretBlob` read facet and issued to sessions as single-shot
 * grants. It is the right shape for OpenRouter, and the wrong shape for a
 * subscription grant that is exchanged for short-lived access tokens and
 * written back under a generation check.
 *
 * ## Durable identity and administration authority
 *
 * A renewing holder needs two authorities over one record: read with the
 * generation it read at (`SecretBlob.readBase64WithGeneration`) and conditional
 * in-place replacement (`SecretAdmin.replaceBase64`). The daemon makes the
 * first delegable and the second not. `secrets/<name>` is a `lookup` formula,
 * so a read facet has a formula identifier and can be another formula's
 * `powersName`; a `SecretAdmin` is created inside the secret manager and vended
 * only by `@secrets/catalog`, so it has no identifier, cannot be stored in a
 * marshalled value, and cannot be named as powers. `@secrets` itself resolves
 * to the host formula, so "mint it with just the catalog" is not smaller than
 * `@agent` — it *is* `@agent`.
 *
 * Powers is a marshalled pair of the host and the exact SecretBlob capability.
 * Its formula retains both dependencies. The host's catalog derives the matching
 * administration facet from that exact read facet, never a mutable pet name or
 * public secret ID. Rebinding the operator's name therefore cannot retarget a
 * reconstructed wrapper or pair one record's reads with another record's writes.
 * Old path-only formulas fail before lookup; deliberate owner retirement and
 * reprovisioning are required. No credential bytes or renewal state are copied.
 *
 * @module
 */

import { Fail, b, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M, mustMatch } from '@endo/patterns';

import { ReplaceBase64MethodGuard } from './secret-rotator.js';

const PET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const RENEWABLE_CREDENTIAL_BINDING_VERSION = '2';
harden(RENEWABLE_CREDENTIAL_BINDING_VERSION);

export const RenewableCredentialInterface = M.interface(
  'ManagedRenewableCredential',
  {
    // The `SecretBlob` reads, both of them. The broker grant reads the current
    // bytes per request; the refreshing credential needs the generation those
    // bytes came from so its write-back can be pinned to it.
    readBase64: M.call().returns(M.promise()),
    readBase64WithGeneration: M.call().returns(M.promise()),
    // The rotator's own guard, not a transcription of it: the closed rest is
    // what stops a misspelled `{ ifGeneraton }` arriving as `undefined` and
    // turning a conditional write into a blind overwrite.
    replaceBase64: ReplaceBase64MethodGuard,
    describe: M.call().returns(M.promise()),
    help: M.call().returns(M.string()),
  },
);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export const readCredentialSecretPath = value => {
  let path = value;
  if (typeof path === 'string') {
    try {
      path = JSON.parse(path);
    } catch {
      throw Fail`${b('CREDENTIAL_SECRET_PATH')} must be a JSON array of pet names, got ${q(value)}`;
    }
  }
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.length > 8 ||
    !path.every(name => typeof name === 'string' && PET_NAME_PATTERN.test(name))
  ) {
    throw Fail`${b('CREDENTIAL_SECRET_PATH')} must be a JSON array of pet names, got ${q(value)}`;
  }
  return harden([...path]);
};
harden(readCredentialSecretPath);

/**
 * @param {any} powers The durably retained host and SecretBlob pair.
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env = {} } = {}) => {
  env.CREDENTIAL_BINDING_VERSION === RENEWABLE_CREDENTIAL_BINDING_VERSION ||
    Fail`Legacy renewable credential binding; retire its renewal owner before reprovisioning`;
  const pair = await powers;
  mustMatch(
    pair,
    M.splitRecord({ host: M.remotable(), secret: M.remotable() }, {}, {}),
  );
  const { host, secret } = pair;
  const label = env.CREDENTIAL_LABEL || 'Provider';
  const catalog = await E(host).lookup(['@secrets', 'catalog']);
  const admin = await E(catalog).adminFor(secret);
  return makeExo('ManagedRenewableCredential', RenewableCredentialInterface, {
    readBase64: () => E(secret).readBase64(),
    readBase64WithGeneration: () => E(secret).readBase64WithGeneration(),
    /**
     * @param {string} base64
     * @param {{ ifGeneration?: bigint }} [options]
     */
    replaceBase64: (base64, options) => E(admin).replaceBase64(base64, options),
    describe: () => E(admin).getSummary(),
    help: () =>
      `${label} credential backed by one pinned Secrets record: generation-carrying read and conditional in-place replacement, for a grant that is exchanged for short-lived tokens. No revoke, delete or setDescription; rotate or revoke the record in the Secrets manager.`,
  });
};
harden(make);
