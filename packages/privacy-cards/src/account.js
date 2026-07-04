// @ts-check

// Portable core of the Privacy.com account capability.
//
// This module has no Node imports: the HTTP client, the ledger's
// persistence and clock, and the timer used by spend monitors are all
// injected. The unconfined caplet (`caplet.js`) is a thin Node shell
// around this core; the same core can run *confined* (a make-archive
// caplet) once a mediated fetch capability exists to construct the
// client from — see designs/privacy-card-issuer.md, Phase 4.

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { approvedSpendCents } from './client.js';
import { assertCents } from './ledger.js';

/** @import { makePrivacyClient } from './client.js' */
/** @import { makeBudgetLedger } from './ledger.js' */

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

// Sub-grants may narrow card types but NOT choose their memo prefix:
// repair() attributes stranded cards by prefix, so a delegatee who
// could pick one could shed budget accounting (empty prefix) or
// misattribute their stranded cards to a foreign grant.
const SubGrantOptionalsShape = harden({
  allowedTypes: M.arrayOf(CardTypeShape),
});

const GrantOptionalsShape = harden({
  ...SubGrantOptionalsShape,
  memoPrefix: M.string(),
  renewal: harden({ amountCents: M.number(), periodMs: M.number() }),
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
    M.splitRecord(GrantOptionsShape, SubGrantOptionalsShape),
  ).returns(IssuerKitShape),
  help: M.call().returns(M.string()),
});

const GrantAuditorInterface = M.interface('PrivacyGrantAuditor', {
  audit: M.call().returns(M.record()),
  reconcile: M.call().returns(M.promise()),
  help: M.call().returns(M.string()),
});

const IssuerControlInterface = M.interface('PrivacyIssuerControl', {
  audit: M.call().returns(M.record()),
  reconcile: M.call().returns(M.promise()),
  makeAuditor: M.call().returns(M.remotable('PrivacyGrantAuditor')),
  deposit: M.call(M.number()).returns(),
  startSpendMonitor: M.call(
    M.splitRecord(harden({ intervalMs: M.number() })),
  ).returns(),
  readSpendMonitor: M.call().returns(M.record()),
  stopSpendMonitor: M.call().returns(),
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
  repair: M.call().returns(M.promise()),
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
 * @param {string} memo
 * @param {string} memoPrefix
 */
const memoMatchesPrefix = (memo, memoPrefix) =>
  memoPrefix !== '' &&
  (memo === memoPrefix || memo.startsWith(`${memoPrefix} `));

/**
 * @typedef {object} SpendMonitorState
 * @property {boolean} active
 * @property {number} intervalMs
 * @property {number} polls completed polling rounds
 * @property {string} [lastError]
 * @property {{ cardToken: string, reservedCents: number,
 *   approvedCents: number }[]} cards latest per-card approved spend
 */

/**
 * @param {object} powers
 * @param {ReturnType<typeof makePrivacyClient>} powers.client
 * @param {ReturnType<typeof makeBudgetLedger>} powers.ledger
 * @param {(ms: number) => Promise<void>} [powers.delay] timer authority;
 * without it, spend monitors are unavailable but everything else works
 * @returns {{ account: object, dispose: () => void }} the account facet
 * and a teardown hook that stops all spend monitors
 */
export const makeAccount = ({ client, ledger, delay }) => {
  const mutate = makeMutex();

  /** @type {Map<string, { issuer: object, control: object }>} */
  const issuerKits = new Map();

  /** @type {Map<string, SpendMonitorState>} */
  const monitors = new Map();

  /** @param {string} grantName */
  const stopMonitor = grantName => {
    const monitor = monitors.get(grantName);
    if (monitor) {
      monitor.active = false;
    }
  };

  const dispose = () => {
    for (const grantName of monitors.keys()) {
      stopMonitor(grantName);
    }
  };

  /**
   * Live approved spend per open card of a grant, straight from the
   * transactions API.
   *
   * @param {string} grantName
   */
  const pollSpend = async grantName => {
    await null; // first substantive await is inside the loop below
    const snapshot = ledger.grantInfo(grantName);
    const cards = [];
    for (const card of snapshot.cards) {
      if (!card.closed) {
        // Sequential on purpose: cheap, and avoids API rate limits.
        // eslint-disable-next-line no-await-in-loop
        const transactions = await client.listCardTransactions(card.cardToken);
        cards.push(
          harden({
            cardToken: card.cardToken,
            reservedCents: card.reservedCents,
            approvedCents: approvedSpendCents(transactions),
          }),
        );
      }
    }
    return harden(cards);
  };

  /**
   * @param {string} grantName
   */
  const makeIssuerKit = grantName => {
    const info = () => ledger.grantInfo(grantName);

    /**
     * Serialized through the mutex so a pause or resume cannot
     * interleave with revoke() or closeCard(): an unserialized resume
     * checked before a revocation could land its OPEN after the
     * revocation's PAUSED, quietly undoing it.
     *
     * @param {string} cardToken
     * @param {'OPEN' | 'PAUSED'} state
     */
    const setOwnCardState = (cardToken, state) =>
      mutate(async () => {
        ledger.assertActive(grantName);
        const card = ledger.getOwnCard(grantName, cardToken);
        if (card.closed) {
          throw makeError(X`Card ${q(cardToken)} is closed`);
        }
        await client.updateCard(cardToken, { state });
      });

    const audit = () => info();

    const reconcile = async () => {
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
        if ('renewal' in options) {
          // Explicit rejection beats silent ignore: a renewing
          // sub-grant would accrue against the parent's escrow without
          // a reservation-time budget check.
          throw makeError(
            X`Renewal schedules are only supported on root grants`,
          );
        }
        if ('memoPrefix' in options) {
          // The prefix is how repair() attributes stranded cards; a
          // delegatee who could choose it could shed their cards from
          // budget accounting or pin them on a foreign grant.
          throw makeError(
            X`A sub-grant's memo prefix is fixed to its grant name and cannot be overridden`,
          );
        }
        const { allowedTypes: parentTypes } = info();
        const { budgetCents, allowedTypes = parentTypes } = options;
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

    const auditor = makeExo('PrivacyGrantAuditor', GrantAuditorInterface, {
      audit,
      reconcile,
      help: () =>
        `PrivacyGrantAuditor for grant ${JSON.stringify(grantName)} ` +
        '(read-only): audit() -> ledger snapshot, reconcile() -> audit ' +
        'with live approved spend per card. No mutation authority.',
    });

    const control = makeExo('PrivacyIssuerControl', IssuerControlInterface, {
      audit,

      reconcile,

      // Attenuation for an accountant: observation without mutation.
      makeAuditor: () => auditor,

      deposit: amountCents => {
        ledger.deposit(grantName, amountCents);
      },

      startSpendMonitor: ({ intervalMs }) => {
        if (!delay) {
          throw makeError(
            X`Spend monitoring requires a timer authority; none was granted to this account`,
          );
        }
        if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
          throw makeError(
            X`intervalMs must be a positive safe integer of milliseconds, got ${q(
              intervalMs,
            )}`,
          );
        }
        ledger.assertActive(grantName);
        stopMonitor(grantName);
        /** @type {SpendMonitorState} */
        const monitor = {
          active: true,
          intervalMs,
          polls: 0,
          cards: [],
        };
        monitors.set(grantName, monitor);
        const loop = async () => {
          while (monitor.active) {
            // eslint-disable-next-line no-await-in-loop
            await delay(monitor.intervalMs);
            if (!monitor.active) {
              break;
            }
            try {
              // eslint-disable-next-line no-await-in-loop
              monitor.cards = [...(await pollSpend(grantName))];
              monitor.polls += 1;
              monitor.lastError = undefined;
            } catch (cause) {
              monitor.lastError = /** @type {Error} */ (cause).message;
            }
          }
        };
        loop().catch(() => {});
      },

      readSpendMonitor: () => {
        const monitor = monitors.get(grantName);
        if (!monitor) {
          return harden({ active: false, polls: 0, cards: [] });
        }
        return harden({
          active: monitor.active,
          intervalMs: monitor.intervalMs,
          polls: monitor.polls,
          ...(monitor.lastError === undefined
            ? {}
            : { lastError: monitor.lastError }),
          cards: [...monitor.cards],
        });
      },

      stopSpendMonitor: () => stopMonitor(grantName),

      revoke: async () =>
        mutate(async () => {
          await null; // first substantive await is inside the loop below
          if (info().revoked) {
            return harden({ pausedCardTokens: [], failedCardTokens: [] });
          }
          // The ledger marks the whole grant subtree revoked first, so
          // issuer facets brick even if some API pauses fail below.
          const { openCardTokens } = ledger.revokeGrant(grantName);
          // Revoked grants have nothing left to watch.
          for (const monitored of monitors.keys()) {
            if (
              monitored === grantName ||
              monitored.startsWith(`${grantName}/`)
            ) {
              stopMonitor(monitored);
            }
          }
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
        'reconcile() -> audit with live approved spend, makeAuditor() ' +
        '-> read-only observation facet, deposit(amountCents) grows ' +
        'the budget (escrowed from the parent grant if any), ' +
        'startSpendMonitor({ intervalMs }) / readSpendMonitor() / ' +
        'stopSpendMonitor() poll live spend, revoke() bricks the ' +
        'issuer and its sub-issuers and pauses all their open cards.',
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

  const account = makeExo('PrivacyAccount', PrivacyAccountInterface, {
    makeIssuer: (grantName, options) => {
      const {
        budgetCents,
        allowedTypes = DEFAULT_ALLOWED_TYPES,
        memoPrefix,
        renewal,
      } = options;
      ledger.createGrant(grantName, {
        budgetCents,
        parentName: null,
        allowedTypes,
        memoPrefix: memoPrefix === undefined ? `[${grantName}]` : memoPrefix,
        renewal,
      });
      return provideIssuerKit(grantName);
    },

    // Idempotent facet recovery, e.g. after a daemon restart reloads
    // the ledger from its state file.
    provideIssuer: grantName => provideIssuerKit(grantName),

    listGrants: () => harden(ledger.grantNames().map(ledger.grantInfo)),

    // Stranding repair: a crash between reserving and recording a card
    // token leaves a pending reservation and possibly a live card the
    // ledger does not know. Adopt unknown cards by their grant memo
    // prefix (recording real exposure, even past the budget), then
    // roll back whatever pendings remain.
    repair: async () =>
      mutate(async () => {
        const apiCards = await client.listCards();
        /** @type {{ grantName: string, cardToken: string }[]} */
        const adoptedCards = [];
        /** @type {{ grantName: string, pendingId: string }[]} */
        const rolledBackPendings = [];
        /** @type {Set<string>} */
        const claimed = new Set();
        for (const grantName of ledger.grantNames()) {
          const snapshot = ledger.grantInfo(grantName);
          for (const card of snapshot.cards) {
            claimed.add(card.cardToken);
          }
        }
        for (const grantName of ledger.grantNames()) {
          const snapshot = ledger.grantInfo(grantName);
          // Cards of revoked grants were already paused at revocation;
          // adopting them would only grow a dead ledger entry.
          if (!snapshot.revoked) {
            for (const apiCard of apiCards) {
              if (
                !claimed.has(apiCard.token) &&
                memoMatchesPrefix(apiCard.memo || '', snapshot.memoPrefix)
              ) {
                ledger.adoptCard(
                  grantName,
                  apiCard.token,
                  apiCard.spend_limit,
                  { closed: apiCard.state === 'CLOSED' },
                );
                claimed.add(apiCard.token);
                adoptedCards.push(
                  harden({ grantName, cardToken: apiCard.token }),
                );
              }
            }
            for (const pendingId of ledger.pendingIds(grantName)) {
              ledger.rollbackPending(grantName, pendingId);
              rolledBackPendings.push(harden({ grantName, pendingId }));
            }
          }
        }
        return harden({ adoptedCards, rolledBackPendings });
      }),

    listFundingSources: async () => client.listFundingSources(),

    status: async () => client.status(),

    help: () =>
      'PrivacyAccount (owner-only facet — never grant this; it mints ' +
      'authority over the whole Privacy.com account): ' +
      'makeIssuer(grantName, { budgetCents, allowedTypes?, memoPrefix?, ' +
      'renewal? }) -> { issuer, control }; grant the issuer to a guest ' +
      'or agent and keep the control. provideIssuer(grantName) ' +
      're-yields a kit after restart. repair() adopts stranded cards ' +
      'by memo prefix and clears stale reservations. listGrants(), ' +
      'listFundingSources(), status().',
  });

  return harden({ account, dispose });
};
harden(makeAccount);
