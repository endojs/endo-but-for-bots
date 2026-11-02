// @ts-check

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * A broker's facet for the one provider call that spends a banked rate-limit
 * reset. It is host-only and an operator's: the broker service offers it
 * beside the account source, a session scope never does, and a grant, a
 * slice and a share have no path to it.
 *
 * It keeps nothing. The caller (`reset-credit-admin.js`) owns the idempotency
 * key and stores it before calling; this only carries the call to the adapter,
 * which presents the credential.
 */
export const ResetRedeemerInterface = M.interface('ProviderResetRedeemer', {
  redeem: M.callWhen(
    M.splitRecord({ idempotencyKey: M.string() }, { creditId: M.string() }),
  ).returns(M.record()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ResetRedeemerInterface);

const OUTCOMES = harden([
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed',
  'refused',
  'notSent',
]);

/**
 * @param {(request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>} redeem
 *   The adapter's call. It answers an outcome, or throws when none is known.
 */
export const makeResetRedeemer = redeem =>
  makeExo('ProviderResetRedeemer', ResetRedeemerInterface, {
    /** @param {{ idempotencyKey: string, creditId?: string }} request */
    async redeem({ idempotencyKey, creditId }) {
      /^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey) ||
        Fail`Invalid idempotency key`;
      creditId === undefined ||
        /^[A-Za-z0-9_.:-]{1,128}$/.test(creditId) ||
        Fail`Invalid reset credit id`;
      const answer = await redeem(
        harden({
          idempotencyKey,
          ...(creditId === undefined ? {} : { creditId }),
        }),
      );
      const outcome = `${answer?.outcome}`;
      // Nothing of the provider's wording leaves: one word of a fixed set.
      OUTCOMES.includes(outcome) ||
        Fail`Reset credit redeem was not understood`;
      return harden({ outcome });
    },
    /** @param {string} [methodName] */
    help(methodName) {
      if (methodName === 'redeem') {
        return 'redeem({ idempotencyKey, creditId? }) — Ask the provider once to spend a banked rate-limit reset. Answers { outcome: reset | nothingToReset | noCredit | alreadyRedeemed | refused | notSent }; refused is a client error (this ask spent nothing), notSent a failure before the provider could have heard; throws when the answer is not known. The same key may be sent again.';
      }
      return methodName === undefined
        ? 'Provider reset redeemer: redeem({ idempotencyKey, creditId? }). Operator-only; it keeps no key and stores nothing.'
        : `No documentation for method "${methodName}".`;
    },
  });
harden(makeResetRedeemer);
