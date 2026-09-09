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
  // The `{ ifGeneration }` precondition travels with the write, because a
  // rotation that cannot be made conditional cannot avoid overwriting a
  // replacement it never read.
  //
  // The closed rest is load-bearing, exactly as it is on the secret manager's
  // own guard: two-argument `M.splitRecord` leaves unlisted properties
  // unconstrained, so a misspelled `{ ifGeneraton }` would pass here, arrive as
  // `undefined`, and turn a conditional write into a blind overwrite of the
  // operator's credential.
  replaceBase64: M.call(SecretBase64Shape)
    .optional(M.splitRecord({}, { ifGeneration: M.bigint() }, harden({})))
    .returns(M.promise()),
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
 * @param {{ replaceBase64(base64: string, options?: {ifGeneration?: bigint}): Promise<unknown> }} admin
 */
export const makeSecretRotator = admin => {
  // Only that it could be a facet at all. Checking for `replaceBase64` here
  // would reject a CapTP presence, whose methods are not properties to
  // inspect, and the secret manager is exactly the sort of facet that arrives
  // that way; the guard on the method below is what refuses a bad payload.
  (admin && (typeof admin === 'object' || typeof admin === 'function')) ||
    Fail`Secret rotator requires an administration facet`;
  return makeExo('SecretRotator', SecretRotatorInterface, {
    /**
     * @param {string} base64
     * @param {{ ifGeneration?: bigint }} [options]
     */
    async replaceBase64(base64, options) {
      return E(admin).replaceBase64(base64, options);
    },
  });
};
harden(makeSecretRotator);
