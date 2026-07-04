// @ts-check

// Privacy.com account caplet — an Endo daemon *unconfined* formula.
//
// Provision with the API key in the formula's env, e.g.:
//
//   endo make --UNCONFINED packages/privacy-cards/src/caplet.js \
//     --name privacy-account --powers @none
//
// with env: PRIVACY_API_KEY (required), PRIVACY_API_BASE_URL (optional;
// defaults to production, point at https://sandbox.privacy.com/v1 for
// the sandbox), PRIVACY_STATE_FILE (optional; JSON ledger persistence
// across daemon restarts — without it the ledger is in-memory only).
//
// The returned PrivacyAccount facet is for the account owner alone: it
// mints { issuer, control } pairs per grant. The issuer facet is the
// thing to send to a guest or agent — it can create cards only up to
// the grant's budget, across any number of cards, and has no method
// that returns the API key, raises its own budget, or reaches cards of
// other grants. See designs/privacy-card-issuer.md.

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCTION_BASE_URL,
  approvedSpendCents,
  makePrivacyClient,
} from './client.js';
import { assertCents, makeBudgetLedger } from './ledger.js';

const CARD_TYPES = harden([
  'SINGLE_USE',
  'MERCHANT_LOCKED',
  'UNLOCKED',
  'DIGITAL_WALLET',
]);

// UNLOCKED (any-merchant) and DIGITAL_WALLET require both an explicit
// opt-in on the grant and extra privileges on the Privacy.com account.
const DEFAULT_ALLOWED_TYPES = harden(['SINGLE_USE', 'MERCHANT_LOCKED']);

const CardTypeShape = M.or(...CARD_TYPES);

const IssuerKitShape = harden({
  issuer: M.remotable('PrivacyCardIssuer'),
  control: M.remotable('PrivacyIssuerControl'),
});

const GrantOptionsShape = harden({
  budgetCents: M.number(),
});

const GrantOptionalsShape = harden({
  allowedTypes: M.arrayOf(CardTypeShape),
  memoPrefix: M.string(),
});

const CardIssuerInterface = M.interface('PrivacyCardIssuer', {
  createCard: M.call(
    M.splitRecord(
      harden({ spendLimitCents: M.number() }),
      harden({ type: CardTypeShape, memo: M.string() }),
    ),
  ).returns(M.promise()),
  listCards: M.call().returns(M.arrayOf(M.record())),
  pauseCard: M.call(M.string()).returns(M.promise()),
  resumeCard: M.call(M.string()).returns(M.promise()),
  closeCard: M.call(M.string()).returns(M.promise()),
  remainingCents: M.call().returns(M.number()),
  budgetCents: M.call().returns(M.number()),
  makeSubIssuer: M.call(
    M.string(),
    M.splitRecord(GrantOptionsShape, GrantOptionalsShape),
  ).returns(IssuerKitShape),
  help: M.call().returns(M.string()),
});

const IssuerControlInterface = M.interface('PrivacyIssuerControl', {
  audit: M.call().returns(M.record()),
  reconcile: M.call().returns(M.promise()),
  deposit: M.call(M.number()).returns(),
  revoke: M.call().returns(M.promise()),
  help: M.call().returns(M.string()),
});

const PrivacyAccountInterface = M.interface('PrivacyAccount', {
  makeIssuer: M.call(
    M.string(),
    M.splitRecord(GrantOptionsShape, GrantOptionalsShape),
  ).returns(IssuerKitShape),
  provideIssuer: M.call(M.string()).returns(IssuerKitShape),
  listGrants: M.call().returns(M.arrayOf(M.record())),
  listFundingSources: M.call().returns(M.promise()),
  status: M.call().returns(M.promise()),
  help: M.call().returns(M.string()),
});

// Serializes ledger-plus-API mutations so concurrent createCard calls
// cannot double-reserve against the same budget.
const makeMutex = () => {
  let tail = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T> | T} job
   * @returns {Promise<T>}
   */
  const enqueue = job => {
    const run = tail.then(job);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
  return enqueue;
};

/**
 * Atomic-ish JSON persistence: write to a temp file, then rename.
 *
 * @param {string} stateFile
 */
const makeFileHooks = stateFile => {
  return harden({
    restore: () => {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (cause) {
        if (/** @type {NodeJS.ErrnoException} */ (cause).code === 'ENOENT') {
          return undefined;
        }
        throw cause;
      }
    },
    /** @param {object} state */
    persist: state => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state));
      fs.renameSync(temporary, stateFile);
    },
  });
};

/**
 * Unconfined caplet entry point.
 *
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 */
export const make = (_powers, _context, { env = {} } = {}) => {
  const apiKey = env.PRIVACY_API_KEY;
  if (!apiKey) {
    throw makeError(X`PRIVACY_API_KEY is required in the caplet env`);
  }
  const baseUrl = env.PRIVACY_API_BASE_URL || PRODUCTION_BASE_URL;
  const stateFile = env.PRIVACY_STATE_FILE;

  const client = makePrivacyClient({ apiKey, baseUrl });
  const ledger = makeBudgetLedger(stateFile ? makeFileHooks(stateFile) : {});
  const mutate = makeMutex();

  /** @type {Map<string, { issuer: unknown, control: unknown }>} */
  const issuerKits = new Map();

  /**
   * @param {string} grantName
   */
  const makeIssuerKit = grantName => {
    const info = () => ledger.grantInfo(grantName);

    /**
     * @param {string} cardToken
     * @param {'OPEN' | 'PAUSED'} state
     */
    const setOwnCardState = async (cardToken, state) => {
      ledger.assertActive(grantName);
      const card = ledger.getOwnCard(grantName, cardToken);
      if (card.closed) {
        throw makeError(X`Card ${q(cardToken)} is closed`);
      }
      await client.updateCard(cardToken, { state });
    };

    const issuer = makeExo('PrivacyCardIssuer', CardIssuerInterface, {
      createCard: async ({ spendLimitCents, type = 'SINGLE_USE', memo = '' }) =>
        mutate(async () => {
          await null; // first substantive await is inside the try below
          ledger.assertActive(grantName);
          assertCents(spendLimitCents, 'spendLimitCents');
          const { allowedTypes, memoPrefix } = info();
          if (!allowedTypes.includes(type)) {
            throw makeError(
              X`Card type ${q(type)} is not allowed for grant ${q(
                grantName,
              )}; allowed types are ${q(allowedTypes)}`,
            );
          }
          const pendingId = ledger.reservePending(grantName, spendLimitCents);
          let card;
          try {
            card = await client.createCard({
              type,
              // FOREVER is the only duration that bounds a card's
              // lifetime total, which the reservation model requires.
              spend_limit: spendLimitCents,
              spend_limit_duration: 'FOREVER',
              memo: memo === '' ? memoPrefix : `${memoPrefix} ${memo}`,
              state: 'OPEN',
            });
            ledger.commitPending(grantName, pendingId, card.token);
          } catch (cause) {
            ledger.rollbackPending(grantName, pendingId);
            throw cause;
          }
          // Card details are data, not capability: the PAN must cross
          // the wire to be usable at a checkout anyway.
          return harden({
            cardToken: card.token,
            pan: card.pan,
            cvv: card.cvv,
            expMonth: card.exp_month,
            expYear: card.exp_year,
            lastFour: card.last_four,
            memo: card.memo,
            spendLimitCents,
            type,
            state: card.state,
          });
        }),

      listCards: () => info().cards,

      pauseCard: async cardToken => {
        await setOwnCardState(cardToken, 'PAUSED');
      },

      resumeCard: async cardToken => {
        await setOwnCardState(cardToken, 'OPEN');
      },

      closeCard: async cardToken =>
        mutate(async () => {
          ledger.assertActive(grantName);
          const card = ledger.getOwnCard(grantName, cardToken);
          if (card.closed) {
            throw makeError(X`Card ${q(cardToken)} is already closed`);
          }
          await client.updateCard(cardToken, { state: 'CLOSED' });
          const transactions = await client.listCardTransactions(cardToken);
          const approved = approvedSpendCents(transactions);
          return ledger.closeCard(grantName, cardToken, approved);
        }),

      remainingCents: () => ledger.remainingCents(grantName),

      budgetCents: () => info().budgetCents,

      makeSubIssuer: (subName, options) => {
        ledger.assertActive(grantName);
        const { allowedTypes: parentTypes } = info();
        const { budgetCents, allowedTypes = parentTypes, memoPrefix } = options;
        for (const type of allowedTypes) {
          if (!parentTypes.includes(type)) {
            throw makeError(
              X`Sub-grant card type ${q(type)} exceeds parent grant ${q(
                grantName,
              )}; allowed types are ${q(parentTypes)}`,
            );
          }
        }
        const fullName = `${grantName}/${subName}`;
        ledger.createGrant(fullName, {
          budgetCents,
          parentName: grantName,
          allowedTypes,
          memoPrefix: memoPrefix === undefined ? `[${fullName}]` : memoPrefix,
        });
        // eslint-disable-next-line no-use-before-define
        return provideIssuerKit(fullName);
      },

      help: () =>
        `PrivacyCardIssuer for grant ${JSON.stringify(grantName)}: ` +
        'createCard({ spendLimitCents, type?, memo? }) -> card details; ' +
        'each card reserves its spend limit from a fixed budget, so all ' +
        'cards ever issued here total at most budgetCents(). ' +
        'listCards(), pauseCard(t), resumeCard(t), closeCard(t) -> ' +
        'refunded cents, remainingCents(), budgetCents(), ' +
        'makeSubIssuer(name, { budgetCents }) -> nested issuer escrowed ' +
        'from this budget.',
    });

    const control = makeExo('PrivacyIssuerControl', IssuerControlInterface, {
      audit: () => info(),

      reconcile: async () => {
        const snapshot = info();
        const cards = await Promise.all(
          snapshot.cards.map(async card => {
            const transactions = await client.listCardTransactions(
              card.cardToken,
            );
            return harden({
              ...card,
              approvedCents: approvedSpendCents(transactions),
            });
          }),
        );
        return harden({ ...snapshot, cards });
      },

      deposit: amountCents => {
        ledger.deposit(grantName, amountCents);
      },

      revoke: async () =>
        mutate(async () => {
          await null; // first substantive await is inside the loop below
          if (info().revoked) {
            return harden({ pausedCardTokens: [], failedCardTokens: [] });
          }
          // The ledger marks the whole grant subtree revoked first, so
          // issuer facets brick even if some API pauses fail below.
          const { openCardTokens } = ledger.revokeGrant(grantName);
          /** @type {string[]} */
          const pausedCardTokens = [];
          /** @type {string[]} */
          const failedCardTokens = [];
          for (const cardToken of openCardTokens) {
            try {
              // Sequential on purpose: cheap, and avoids rate limits.
              // eslint-disable-next-line no-await-in-loop
              await client.updateCard(cardToken, { state: 'PAUSED' });
              pausedCardTokens.push(cardToken);
            } catch {
              failedCardTokens.push(cardToken);
            }
          }
          return harden({ pausedCardTokens, failedCardTokens });
        }),

      help: () =>
        `PrivacyIssuerControl for grant ${JSON.stringify(grantName)} ` +
        '(caretaker facet — keep it, grant only the issuer): audit(), ' +
        'reconcile() -> audit with live approved spend, ' +
        'deposit(amountCents) grows the budget (escrowed from the ' +
        'parent grant if any), revoke() bricks the issuer and its ' +
        'sub-issuers and pauses all their open cards.',
    });

    return harden({ issuer, control });
  };

  /**
   * @param {string} grantName
   */
  const provideIssuerKit = grantName => {
    const existing = issuerKits.get(grantName);
    if (existing) {
      return existing;
    }
    if (!ledger.hasGrant(grantName)) {
      throw makeError(X`No such grant ${q(grantName)}`);
    }
    const kit = makeIssuerKit(grantName);
    issuerKits.set(grantName, kit);
    return kit;
  };

  return makeExo('PrivacyAccount', PrivacyAccountInterface, {
    makeIssuer: (grantName, options) => {
      const {
        budgetCents,
        allowedTypes = DEFAULT_ALLOWED_TYPES,
        memoPrefix,
      } = options;
      ledger.createGrant(grantName, {
        budgetCents,
        parentName: null,
        allowedTypes,
        memoPrefix: memoPrefix === undefined ? `[${grantName}]` : memoPrefix,
      });
      return provideIssuerKit(grantName);
    },

    // Idempotent facet recovery, e.g. after a daemon restart reloads
    // the ledger from PRIVACY_STATE_FILE.
    provideIssuer: grantName => provideIssuerKit(grantName),

    listGrants: () => harden(ledger.grantNames().map(ledger.grantInfo)),

    listFundingSources: async () => client.listFundingSources(),

    status: async () => client.status(),

    help: () =>
      'PrivacyAccount (owner-only facet — never grant this; it mints ' +
      'authority over the whole Privacy.com account): ' +
      'makeIssuer(grantName, { budgetCents, allowedTypes?, memoPrefix? }) ' +
      '-> { issuer, control }; grant the issuer to a guest or agent and ' +
      'keep the control. provideIssuer(grantName) re-yields a kit after ' +
      'restart. listGrants(), listFundingSources(), status().',
  });
};
harden(make);
