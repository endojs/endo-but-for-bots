// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// A pattern mismatch reports the offending specimen verbatim, so the default
// `M.string()` length limit would interpolate an oversize secret into an error
// that crosses CapTP and lands in logs. The limit is disabled here for the same
// reason the daemon's own `SecretBase64Shape` disables it: the secret manager
// behind this facet is the sole rejecter of secret payloads.
const SecretBase64Shape = M.string({
  stringLengthLimit: Number.MAX_SAFE_INTEGER,
});

export const SecretRotatorInterface = M.interface('SecretRotator', {
  replaceBase64: M.call(SecretBase64Shape).returns(M.promise()),
});

/**
 * Attenuate a secret administration facet down to in-place replacement.
 *
 * A refreshing broker needs exactly one write: put the new OAuth state where
 * the old one was, so the next request — and every other lease reading the same
 * record — picks it up without re-delegation. It does not need, and must not
 * hold, the rest of `SecretAdmin`: `revoke` and `delete` would let a broker
 * destroy the operator's credential, and `setDescription` would let it rewrite
 * the record's audit-visible identity.
 *
 * This is a structural attenuation, not a daemon dependency: anything with a
 * `replaceBase64` method can back it, which is what lets a test drive rotation
 * without a secret manager.
 *
 * @param {{ replaceBase64(base64: string): Promise<unknown> }} admin
 */
export const makeSecretRotator = admin => {
  admin || Fail`Secret rotator requires an administration facet`;
  return makeExo('SecretRotator', SecretRotatorInterface, {
    /** @param {string} base64 */
    async replaceBase64(base64) {
      return E(admin).replaceBase64(base64);
    },
  });
};
harden(makeSecretRotator);
