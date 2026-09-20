// @ts-check

import { Fail, q } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Redeeming a banked rate-limit reset, as an operator action with a stored
 * intent.
 *
 * A reset credit is scarce, expires, and is spent by one provider call whose
 * answer can be lost. So the call carries an idempotency key, and the key is
 * **stored before the call is made**: a daemon that dies between the call and
 * its answer comes back knowing that a redeem is unconfirmed, and with the key
 * that makes asking again safe.
 *
 * What is never done with that stored intent:
 *
 * - it is not replayed when the formula revives, and not by `refresh()`. A
 *   replay is a provider call and may be the call that redeems, so it takes a
 *   person asking again;
 * - a refresh resolves it only by reading the credit's own `status` from the
 *   account reading (`redeemed`), which spends nothing.
 *
 * The caller says which of the two it means. A redeem (`consumeResetCredit()`)
 * is refused while another is unconfirmed; asking again
 * (`consumeResetCredit({ replay: true })`) sends the stored key and credit and
 * never starts a redeem of its own: if the unconfirmed one has been settled
 * meanwhile it answers with how, and calls nobody. So a press that meant "ask
 * again" can never spend a second credit, whatever happened between the view
 * drawing the button and the person pressing it.
 *
 * An intent ends by an answer to its first ask, by an accepted answer to a
 * later one, by the credit reading `redeemed`, or by the operator giving it
 * up (`abandonResetIntent()`). A refusal of a *later* ask does not end it: the
 * first may have been accepted and its answer lost.
 *
 * This holds no credential. `redeem` is the broker's facet for the one call.
 *
 * Who can reach it: the operator's Floot, which setup binds it into, and so
 * also a Floot session the operator opened with the host itself (the
 * `full-control` and `machine-admin` presets, which are root-equivalent by
 * design). No other session, no slice, no grant and no share.
 */

export const RESET_OUTCOMES = harden([
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed',
]);

// The same shape `codex-account-read.js` admits into a reading.
const CREDIT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const KEY = /^[A-Za-z0-9-]{16,64}$/;

/**
 * @typedef {object} ResetIntent
 * @property {string} idempotencyKey
 * @property {string | null} creditId null when the provider was left to choose
 * @property {string} startedAt ISO instant of the first attempt
 * @property {string} lastAttemptAt
 * @property {number} attempts
 * @property {string} lastAnswer What the last ask came to: `unknown` (no
 *   answer) or `refused` (a later ask was refused; the first may still have
 *   been accepted)
 */

/**
 * @typedef {object} ResetSettled
 * @property {string} outcome one of RESET_OUTCOMES, `refused` (the provider
 *   answered the only ask with a client error, so nothing was spent),
 *   `redeemed` (learnt from the credit's status, not from the call) or
 *   `abandoned` (the operator gave an unconfirmed redeem up)
 * @property {string | null} creditId
 * @property {string} at
 */

/**
 * @typedef {object} ResetRecord
 * @property {ResetIntent | null} intent
 * @property {ResetSettled | null} last
 */

export const ResetCreditAdminInterface = M.interface('SubscriptionAdmin', {
  consumeResetCredit: M.callWhen()
    .optional(M.splitRecord({}, { creditId: M.string(), replay: M.boolean() }))
    .returns(M.record()),
  abandonResetIntent: M.callWhen().returns(M.record()),
  getResetState: M.callWhen().returns(M.record()),
  refresh: M.callWhen().returns(M.undefined()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(ResetCreditAdminInterface);

/** @param {any} value */
const intentFrom = value => {
  if (value === null || typeof value !== 'object') return null;
  const {
    idempotencyKey,
    creditId,
    startedAt,
    lastAttemptAt,
    attempts,
    lastAnswer,
  } = value;
  if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) {
    return null;
  }
  return {
    idempotencyKey,
    creditId:
      typeof creditId === 'string' && CREDIT_ID.test(creditId)
        ? creditId
        : null,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    lastAttemptAt: typeof lastAttemptAt === 'string' ? lastAttemptAt : '',
    attempts:
      typeof attempts === 'number' && Number.isSafeInteger(attempts)
        ? attempts
        : 1,
    lastAnswer: lastAnswer === 'refused' ? 'refused' : 'unknown',
  };
};

/** @param {any} value */
const settledFrom = value => {
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.outcome !== 'string') return null;
  return {
    outcome: value.outcome,
    creditId:
      typeof value.creditId === 'string' && CREDIT_ID.test(value.creditId)
        ? value.creditId
        : null,
    at: typeof value.at === 'string' ? value.at : '',
  };
};

/**
 * The banked resets of a raw account reading, or undefined when the reading
 * does not say.
 *
 * @param {any} reading
 */
const resetCreditsOf = reading => {
  const section = reading?.rateLimits?.resetCredits;
  return section !== null && typeof section === 'object' ? section : undefined;
};

/**
 * Which credit to spend when the operator named none: the one that expires
 * soonest, since an unused credit is lost too. Null leaves the choice to the
 * provider, which is all that can be done when the reading lists no credits.
 *
 * @param {any} section
 * @param {string} nowIso
 */
export const chooseResetCredit = (section, nowIso) => {
  const rows = Array.isArray(section?.credits) ? section.credits : [];
  const nowMs = Date.parse(nowIso);
  /** @type {Array<{ id: string, expiresMs: number }>} */
  const available = [];
  for (const row of rows) {
    if (
      row?.status === 'available' &&
      typeof row.id === 'string' &&
      CREDIT_ID.test(row.id)
    ) {
      // Compared as instants, not as text: a reading's spelling of a time is
      // not this module's to rely on. No date sorts last.
      const parsed = Date.parse(`${row.expiresAt || ''}`);
      const expiresMs = Number.isFinite(parsed) ? parsed : Infinity;
      if (expiresMs > nowMs) available.push({ id: row.id, expiresMs });
    }
  }
  if (available.length === 0) return null;
  // Stable: credits that expire together, or never say, keep listed order.
  available.sort((a, b) => Math.sign(a.expiresMs - b.expiresMs) || 0);
  return available[0].id;
};
harden(chooseResetCredit);

/**
 * @param {object} powers
 * @param {() => Promise<(request: { idempotencyKey: string, creditId?: string }) => Promise<{ outcome: string }>>} powers.provideRedeem
 *   Reach the one provider call, without making it. Asked before an intent is
 *   stored: a redeemer that is not there fails the redeem outright, with
 *   nothing pending, since nothing could have been sent. The call it answers
 *   with gives one of RESET_OUTCOMES; `refused` (a client error: this ask
 *   spent nothing); or `notSent` (it failed before the provider could have
 *   heard of it). It throws when the answer is not known (no response, a
 *   server error, a body that could not be read).
 * @param {() => Promise<any>} powers.observe The account's last raw reading,
 *   from memory.
 * @param {() => Promise<void>} powers.refreshReading One active read of the
 *   account; it redeems nothing.
 * @param {{ read(): Promise<any>, write(record: any): Promise<void> }} powers.journal
 *   The formula's own store. Single writer.
 * @param {() => string} powers.makeKey A fresh unguessable idempotency key.
 * @param {() => string} [powers.now] ISO 8601 clock.
 * @param {(message: string) => void} [powers.log]
 */
export const makeResetCreditAdmin = ({
  provideRedeem,
  observe,
  refreshReading,
  journal,
  makeKey,
  now = () => new Date().toISOString(),
  log = message => console.error(message),
}) => {
  /** @type {ResetRecord | undefined} */
  let record;
  /** @type {Promise<ResetRecord> | undefined} */
  let loading;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  // A provider call is in flight. Whoever asks for the state meanwhile is
  // answered from memory, which already says pending, instead of waiting out
  // the call behind it.
  let asking = false;

  /**
   * One operation at a time: the record has a single writer, and two redeems
   * racing must not each find no intent.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const inOrder = operation => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };

  const load = async () => {
    if (record !== undefined) return record;
    loading ??= (async () => {
      const kept = await journal.read();
      // A write may have landed while the store was being read.
      record ??= {
        intent: intentFrom(kept?.intent),
        last: settledFrom(kept?.last),
      };
      return record;
    })();
    try {
      return await loading;
    } finally {
      loading = undefined;
    }
  };

  /** @param {ResetRecord} next */
  const keep = async next => {
    await journal.write(harden({ intent: next.intent, last: next.last }));
    record = next;
  };

  /**
   * Settle an unresolved intent from the credit's own status, where the
   * reading has it. Only `redeemed` settles: a credit still `available` may
   * have a call on its way, and one missing from the list may have expired.
   */
  const reconcile = async () => {
    const current = await load();
    const { intent } = current;
    if (intent === null || intent.creditId === null) return current;
    const section = resetCreditsOf(await observe().catch(() => undefined));
    const rows = Array.isArray(section?.credits) ? section.credits : [];
    const row = rows.find(
      (/** @type {any} */ entry) => entry?.id === intent.creditId,
    );
    if (row?.status !== 'redeemed') return current;
    const next = {
      intent: null,
      last: { outcome: 'redeemed', creditId: intent.creditId, at: now() },
    };
    await keep(next);
    return next;
  };

  /** @param {ResetRecord} current */
  const stateOf = current =>
    harden({
      // The key stays here: it is of no use without the credential, and of no
      // use to a view either.
      pending:
        current.intent === null
          ? null
          : {
              creditId: current.intent.creditId,
              startedAt: current.intent.startedAt,
              lastAttemptAt: current.intent.lastAttemptAt,
              attempts: current.intent.attempts,
              lastAnswer: current.intent.lastAnswer,
            },
      last: current.last,
    });

  /** @param {{ creditId?: string, replay?: boolean }} [options] */
  const consumeResetCredit = ({ creditId, replay = false } = {}) =>
    inOrder(async () => {
      creditId === undefined ||
        CREDIT_ID.test(creditId) ||
        Fail`Invalid reset credit id`;
      // Before anything is stored: with no redeemer there is no call, and so
      // nothing to be unsure of.
      const redeem = await provideRedeem();
      const before = await load();
      let current = await reconcile();
      if (replay) {
        if (current.intent === null) {
          // Asking again about a redeem that has been settled meanwhile (the
          // credit read `redeemed` between the button and the press) answers
          // with how. It never becomes a redeem of another credit.
          before.intent !== null || Fail`No redeem is unconfirmed`;
          return harden({
            outcome: /** @type {ResetSettled} */ (current.last).outcome,
            creditId: /** @type {ResetSettled} */ (current.last).creditId,
            replayed: true,
            pending: false,
          });
        }
        creditId === undefined ||
          creditId === current.intent.creditId ||
          Fail`The unconfirmed redeem is of another reset credit`;
        current = {
          ...current,
          intent: {
            ...current.intent,
            lastAttemptAt: now(),
            attempts: current.intent.attempts + 1,
          },
        };
      } else {
        // Never a second redeem beside an unconfirmed one: that is how one
        // intention would spend two credits.
        current.intent === null ||
          Fail`A redeem is unconfirmed; ask again about it, or give it up, first`;
        let section = resetCreditsOf(await observe().catch(() => undefined));
        if (section === undefined) {
          // Nothing is known of this account's credits yet (nothing was read
          // since the daemon started). Ask once; this redeems nothing.
          await refreshReading().catch(() => {});
          section = resetCreditsOf(await observe().catch(() => undefined));
        }
        if (creditId === undefined && section !== undefined) {
          section.availableCount !== 0 || Fail`No reset credit is available`;
        }
        const chosen = creditId ?? chooseResetCredit(section, now());
        const at = now();
        const idempotencyKey = makeKey();
        KEY.test(idempotencyKey) || Fail`Invalid idempotency key`;
        current = {
          ...current,
          intent: {
            idempotencyKey,
            creditId: chosen,
            startedAt: at,
            lastAttemptAt: at,
            attempts: 1,
            lastAnswer: 'unknown',
          },
        };
      }
      // Durable before the provider hears of it. If this write fails there is
      // no call.
      await keep(current);
      const intent = /** @type {ResetIntent} */ (current.intent);
      const first = intent.attempts === 1;
      /** @type {{ outcome: string }} */
      let answer;
      asking = true;
      try {
        answer = await redeem(
          harden({
            idempotencyKey: intent.idempotencyKey,
            ...(intent.creditId === null ? {} : { creditId: intent.creditId }),
          }),
        );
      } catch (error) {
        // Not known. The intent stands, and says so to whoever looks.
        throw Error(
          `Reset credit redeem is unconfirmed (${
            error instanceof Error ? error.message : 'no answer'
          }); ask again to send the same key`,
        );
      } finally {
        asking = false;
      }
      const outcome = `${answer?.outcome}`;
      if (outcome === 'notSent') {
        // The provider never heard this ask. If it was the only one, there is
        // nothing to be unsure of; after an earlier one, there still is.
        if (first) {
          await keep({ intent: null, last: current.last });
        }
        throw Error(
          first
            ? 'Reset credit redeem could not be sent; nothing was spent'
            : 'Reset credit redeem could not be sent; the earlier ask is still unconfirmed',
        );
      }
      outcome === 'refused' ||
        RESET_OUTCOMES.includes(outcome) ||
        Fail`Reset credit redeem answered ${q(outcome)}`;
      if (outcome === 'refused' && !first) {
        // This ask was refused. An earlier one may have been accepted and its
        // answer lost, so nothing here can say that no credit was spent.
        await keep({
          ...current,
          intent: { ...intent, lastAnswer: 'refused' },
        }).catch(() => {});
        return harden({
          outcome,
          creditId: intent.creditId,
          replayed: true,
          pending: true,
        });
      }
      // The answer is in hand, so it is returned even if it cannot be kept:
      // the stored intent then still reads as unconfirmed, and asking again
      // with its key is safe.
      await keep({
        intent: null,
        last: { outcome, creditId: intent.creditId, at: now() },
      }).catch(() =>
        log('Reset credit redeem was answered but the answer was not kept'),
      );
      if (outcome !== 'refused') {
        // Show the emptied windows, or that the credit is gone.
        await refreshReading().catch(() => {});
      }
      return harden({
        outcome,
        creditId: intent.creditId,
        replayed: !first,
        pending: false,
      });
    });

  /**
   * Give an unconfirmed redeem up. The way out when the provider will never
   * say (an answer in words this does not know, a credit the reading does not
   * list). What it costs is the protection: a redeem made afterwards is a new
   * one, and spends another credit if the abandoned one was in fact accepted.
   */
  const abandonResetIntent = () =>
    inOrder(async () => {
      const current = await reconcile();
      if (current.intent !== null) {
        await keep({
          intent: null,
          last: {
            outcome: 'abandoned',
            creditId: current.intent.creditId,
            at: now(),
          },
        });
      }
      return stateOf(/** @type {ResetRecord} */ (record));
    });

  return makeExo('SubscriptionAdmin', ResetCreditAdminInterface, {
    consumeResetCredit,
    abandonResetIntent,
    getResetState: async () =>
      asking
        ? stateOf(await load())
        : inOrder(async () => stateOf(await reconcile())),
    refresh: () =>
      inOrder(async () => {
        await refreshReading();
        await reconcile();
      }),
    /** @param {string} [methodName] */
    help(methodName) {
      const docs = {
        consumeResetCredit:
          'consumeResetCredit({ creditId?, replay? }) — Spend one banked rate-limit reset of this subscription: the named credit, or the one that expires soonest. An operator action; nothing calls it on its own. Answers { outcome: reset | nothingToReset | noCredit | alreadyRedeemed | refused | redeemed, creditId, replayed, pending }. The idempotency key is stored before the provider is called; if the answer is lost the redeem shows as pending and a new redeem is refused. { replay: true } asks again about the pending one with the same key, which cannot spend a second credit, and never starts a redeem of its own. A later ask that is refused leaves it pending: the first may have been accepted.',
        abandonResetIntent:
          'abandonResetIntent() — Give a pending redeem up, when the provider will never say. A redeem made afterwards is a new one and spends another credit if the abandoned one had been accepted. Answers getResetState().',
        getResetState:
          'getResetState() — { pending: { creditId, startedAt, lastAttemptAt, attempts, lastAnswer } | null, last: { outcome, creditId, at } | null }. pending is a redeem whose answer is not known. Calls no provider.',
        refresh:
          'refresh() — One active read of the account. Redeems nothing; a pending redeem is settled by it only if the credit now reads as redeemed.',
      };
      if (methodName === undefined) {
        return 'Subscription admin: consumeResetCredit({ creditId?, replay? }), abandonResetIntent(), getResetState(), refresh(). The operator’s; held by Floot’s profile, and so also by a session opened with the host itself (full-control, machine-admin). Never given to another session, a slice, a grant or a share.';
      }
      return (
        docs[/** @type {keyof typeof docs} */ (methodName)] ||
        `No documentation for method "${methodName}".`
      );
    },
  });
};
harden(makeResetCreditAdmin);
