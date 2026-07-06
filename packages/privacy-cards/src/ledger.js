// @ts-check

// Budget ledger for Privacy.com card grants.
//
// Pure accounting, no network: the caplet reserves a card's spend limit
// here *before* asking Privacy.com to create the card, so the sum of
// limits ever issued under a grant can never exceed the grant's budget
// (the reservation/escrow model — see designs/privacy-card-issuer.md).
//
// Grants form a tree. A sub-grant's whole budget counts as consumed by
// its parent, which is what makes attenuation recursive: parent and
// children together can never exceed the original grant. Revoking a
// grant shrinks its budget down to what it actually consumed, which
// returns the difference to the parent automatically.
//
// All amounts are integer cents.

import { makeError, q, X } from '@endo/errors';

/**
 * @typedef {object} CardEntry
 * @property {number} reservedCents
 * @property {boolean} closed
 * @property {number} refundedCents
 */

/**
 * @typedef {object} RenewalRecord
 * @property {number} amountCents accrues once per elapsed period
 * @property {number} periodMs
 * @property {number} anchorMs clock reading at grant creation
 * @property {number} accruedPeriods periods already credited
 */

/**
 * @typedef {object} GrantRecord
 * @property {string} name
 * @property {string | null} parentName
 * @property {number} budgetCents
 * @property {boolean} revoked
 * @property {string[]} allowedTypes
 * @property {string} memoPrefix
 * @property {Record<string, number>} pending pendingId -> reserved cents
 * @property {Record<string, CardEntry>} cards cardToken -> entry
 * @property {string[]} subGrantNames
 * @property {RenewalRecord} [renewal]
 */

/**
 * @typedef {object} LedgerState
 * @property {number} version
 * @property {number} nextPendingId
 * @property {Record<string, GrantRecord>} grants
 */

/**
 * @typedef {object} LedgerHooks
 * @property {() => LedgerState | undefined} [restore]
 * @property {(state: LedgerState) => void} [persist]
 * @property {() => number} [now] clock authority (ms), required only
 * for grants with a renewal schedule
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export const assertCents = (value, label) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw makeError(
      X`${q(label)} must be a non-negative safe integer of cents, got ${q(
        value,
      )}`,
    );
  }
  return value;
};
harden(assertCents);

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
const assertName = (value, label) => {
  if (typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) {
    throw makeError(X`${q(label)} must be a non-empty single-line string`);
  }
  return value;
};

/**
 * @param {LedgerHooks} [hooks]
 */
export const makeBudgetLedger = ({ restore, persist, now } = {}) => {
  /** @type {LedgerState} */
  const state = (restore && restore()) || {
    version: 1,
    nextPendingId: 1,
    grants: {},
  };

  const save = () => {
    if (persist) {
      persist(state);
    }
  };

  /**
   * Lazily credits any renewal periods that elapsed since the last
   * look. Carryover semantics: unspent allowance accumulates. Accrual
   * stops at revocation.
   *
   * @param {GrantRecord} grant
   */
  const accrue = grant => {
    const { renewal } = grant;
    if (!renewal || grant.revoked || !now) {
      return;
    }
    const periods = Math.floor((now() - renewal.anchorMs) / renewal.periodMs);
    if (periods > renewal.accruedPeriods) {
      // Clamped: an extreme owner-set schedule left idle for ages must
      // not push the budget past safe-integer arithmetic.
      grant.budgetCents = Math.min(
        Number.MAX_SAFE_INTEGER,
        grant.budgetCents +
          (periods - renewal.accruedPeriods) * renewal.amountCents,
      );
      renewal.accruedPeriods = periods;
      save();
    }
  };

  /**
   * @param {string} name
   * @returns {GrantRecord}
   */
  const getGrant = name => {
    const grant = state.grants[name];
    if (!grant) {
      throw makeError(X`No such grant ${q(name)}`);
    }
    accrue(grant);
    return grant;
  };

  /**
   * @param {GrantRecord} grant
   * @returns {number}
   */
  const consumedCents = grant => {
    let consumed = 0;
    for (const cents of Object.values(grant.pending)) {
      consumed += cents;
    }
    for (const card of Object.values(grant.cards)) {
      consumed += card.reservedCents - card.refundedCents;
    }
    for (const subName of grant.subGrantNames) {
      const sub = getGrant(subName);
      // Normally the escrowed budget bounds a sub-grant's exposure,
      // but adoption during repair records reality even past the
      // budget — so charge the parent whichever is larger, or an
      // overdrawn sub-grant would let the parent under-count real
      // exposure and issue against headroom that does not exist.
      consumed += Math.max(sub.budgetCents, consumedCents(sub));
    }
    return consumed;
  };

  /**
   * @param {string} name
   * @returns {number}
   */
  const remainingCents = name => {
    const grant = getGrant(name);
    return grant.budgetCents - consumedCents(grant);
  };

  /**
   * @param {string} name
   */
  const assertActive = name => {
    const grant = getGrant(name);
    if (grant.revoked) {
      throw makeError(X`Grant ${q(name)} has been revoked`);
    }
  };

  /**
   * @param {string} name
   * @param {number} cents
   * @param {string} label
   */
  const assertAvailable = (name, cents, label) => {
    const available = remainingCents(name);
    if (cents > available) {
      throw makeError(
        X`${q(label)} of ${q(cents)} cents exceeds the remaining budget of ${q(
          available,
        )} cents for grant ${q(name)}`,
      );
    }
  };

  const ledger = {
    /**
     * @param {string} name
     * @param {object} opts
     * @param {number} opts.budgetCents
     * @param {string | null} [opts.parentName]
     * @param {string[]} [opts.allowedTypes]
     * @param {string} [opts.memoPrefix] defaults to `[${name}]`; the
     * bracketed default cannot collide across grants, and any override
     * must be a non-empty single-line string — repair() attributes
     * stranded cards by this prefix, so an empty or forgeable prefix
     * would let cards escape or corrupt budget accounting.
     * @param {{ amountCents: number, periodMs: number }} [opts.renewal]
     */
    createGrant: (
      name,
      {
        budgetCents,
        parentName = null,
        allowedTypes = [],
        memoPrefix = undefined,
        renewal = undefined,
      },
    ) => {
      assertName(name, 'grant name');
      assertCents(budgetCents, 'budgetCents');
      if (memoPrefix === undefined) {
        memoPrefix = `[${name}]`;
      } else {
        assertName(memoPrefix, 'memo prefix');
      }
      if (state.grants[name]) {
        throw makeError(X`Grant ${q(name)} already exists`);
      }
      if (parentName !== null) {
        assertActive(parentName);
        // The child's whole budget is escrowed from the parent.
        assertAvailable(parentName, budgetCents, 'sub-grant budget');
      }
      /** @type {RenewalRecord | undefined} */
      let renewalRecord;
      if (renewal !== undefined) {
        if (parentName !== null) {
          // A renewing sub-grant would accrue against the parent's
          // escrow without a reservation-time budget check; only root
          // grants may renew until that interaction has a design.
          throw makeError(
            X`Renewal schedules are only supported on root grants, not sub-grant ${q(
              name,
            )}`,
          );
        }
        if (!now) {
          throw makeError(
            X`Renewal schedules require a clock authority (now hook)`,
          );
        }
        assertCents(renewal.amountCents, 'renewal.amountCents');
        if (
          renewal.amountCents === 0 ||
          !Number.isSafeInteger(renewal.periodMs) ||
          renewal.periodMs <= 0
        ) {
          throw makeError(
            X`Renewal requires positive amountCents and periodMs, got ${q(
              renewal,
            )}`,
          );
        }
        renewalRecord = {
          amountCents: renewal.amountCents,
          periodMs: renewal.periodMs,
          anchorMs: now(),
          accruedPeriods: 0,
        };
      }
      state.grants[name] = {
        name,
        parentName,
        budgetCents,
        revoked: false,
        allowedTypes: [...allowedTypes],
        memoPrefix,
        pending: {},
        cards: {},
        subGrantNames: [],
        ...(renewalRecord === undefined ? {} : { renewal: renewalRecord }),
      };
      if (parentName !== null) {
        getGrant(parentName).subGrantNames.push(name);
      }
      save();
    },

    /** @param {string} name */
    hasGrant: name => Object.hasOwn(state.grants, name),

    grantNames: () => harden(Object.keys(state.grants)),

    remainingCents,

    assertActive,

    /**
     * Reserves budget ahead of a card-creation API call.
     *
     * @param {string} name
     * @param {number} cents
     * @returns {string} pendingId to commit or roll back
     */
    reservePending: (name, cents) => {
      assertActive(name);
      assertCents(cents, 'spend limit');
      if (cents === 0) {
        throw makeError(X`spend limit must be positive`);
      }
      assertAvailable(name, cents, 'spend limit');
      const pendingId = `pending-${state.nextPendingId}`;
      state.nextPendingId += 1;
      getGrant(name).pending[pendingId] = cents;
      save();
      return pendingId;
    },

    /**
     * @param {string} name
     * @param {string} pendingId
     * @param {string} cardToken
     */
    commitPending: (name, pendingId, cardToken) => {
      const grant = getGrant(name);
      const cents = grant.pending[pendingId];
      if (cents === undefined) {
        throw makeError(X`No pending reservation ${q(pendingId)}`);
      }
      delete grant.pending[pendingId];
      grant.cards[cardToken] = {
        reservedCents: cents,
        closed: false,
        refundedCents: 0,
      };
      save();
    },

    /**
     * @param {string} name
     * @param {string} pendingId
     */
    rollbackPending: (name, pendingId) => {
      const grant = getGrant(name);
      delete grant.pending[pendingId];
      save();
    },

    /**
     * Reservations that were persisted but never committed or rolled
     * back — the residue of a crash between reserving and learning the
     * card token. Repair inspects these.
     *
     * @param {string} name
     */
    pendingIds: name => harden(Object.keys(getGrant(name).pending)),

    /**
     * Adopts a card discovered at the Privacy API (by memo prefix) that
     * the ledger has no entry for — a stranding repair, not a normal
     * issuance. Deliberately skips the budget check: the card already
     * exists, so the account's real exposure must be recorded even if
     * that drives the grant's remaining budget negative and blocks
     * further issuance. Adoption always records the card as open; a
     * card already closed at the API should be adopted and then closed
     * through `closeCard` with its reconciled spend, so its unspent
     * reservation is refunded rather than stranded forever.
     *
     * @param {string} name
     * @param {string} cardToken
     * @param {number} reservedCents the card's live spend limit
     */
    adoptCard: (name, cardToken, reservedCents) => {
      assertCents(reservedCents, 'adopted spend limit');
      const grant = getGrant(name);
      if (grant.cards[cardToken]) {
        throw makeError(X`Card ${q(cardToken)} is already recorded`);
      }
      grant.cards[cardToken] = {
        reservedCents,
        closed: false,
        refundedCents: 0,
      };
      save();
    },

    /**
     * Card operations only reach tokens the grant itself issued, so a
     * leaked or guessed foreign token is rejected before any API call.
     *
     * @param {string} name
     * @param {string} cardToken
     * @returns {CardEntry}
     */
    getOwnCard: (name, cardToken) => {
      const grant = getGrant(name);
      const card = grant.cards[cardToken];
      if (!card) {
        throw makeError(
          X`Grant ${q(name)} has no card with token ${q(cardToken)}`,
        );
      }
      return card;
    },

    /**
     * Records a card closure and returns the unspent reservation to the
     * budget.
     *
     * @param {string} name
     * @param {string} cardToken
     * @param {number} approvedCents conservative approved spend
     * @returns {number} refunded cents
     */
    closeCard: (name, cardToken, approvedCents) => {
      assertCents(approvedCents, 'approved spend');
      const card = ledger.getOwnCard(name, cardToken);
      if (card.closed) {
        throw makeError(X`Card ${q(cardToken)} is already closed`);
      }
      const refund = Math.max(0, card.reservedCents - approvedCents);
      card.closed = true;
      card.refundedCents = refund;
      save();
      return refund;
    },

    /**
     * Grows a budget. For a sub-grant the deposit is escrowed from the
     * parent; for a root grant it is new exposure the owner accepts.
     *
     * @param {string} name
     * @param {number} cents
     */
    deposit: (name, cents) => {
      assertActive(name);
      assertCents(cents, 'deposit');
      if (cents === 0) {
        throw makeError(X`deposit must be positive`);
      }
      const grant = getGrant(name);
      if (grant.parentName !== null) {
        assertActive(grant.parentName);
        assertAvailable(grant.parentName, cents, 'deposit');
      }
      grant.budgetCents += cents;
      save();
    },

    /**
     * Revokes a grant and all of its descendants, bottom-up. Each
     * revoked grant's budget shrinks to what it actually consumed, so
     * the unconsumed remainder returns to its parent automatically.
     *
     * @param {string} name
     * @returns {{ openCardTokens: string[] }} tokens the caller should
     * pause with the Privacy API (revocation pauses rather than closes,
     * so the owner can still salvage cards).
     */
    revokeGrant: name => {
      const grant = getGrant(name);
      /** @type {string[]} */
      const openCardTokens = [];
      for (const subName of grant.subGrantNames) {
        if (!getGrant(subName).revoked) {
          const { openCardTokens: subTokens } = ledger.revokeGrant(subName);
          openCardTokens.push(...subTokens);
        }
      }
      // Stranded pending reservations die with the grant.
      grant.pending = {};
      grant.budgetCents -= Math.max(0, remainingCents(name));
      grant.revoked = true;
      for (const [cardToken, card] of Object.entries(grant.cards)) {
        if (!card.closed) {
          openCardTokens.push(cardToken);
        }
      }
      save();
      return { openCardTokens };
    },

    /**
     * Read-only snapshot for audits.
     *
     * @param {string} name
     */
    grantInfo: name => {
      const grant = getGrant(name);
      return harden({
        name: grant.name,
        parentName: grant.parentName,
        budgetCents: grant.budgetCents,
        remainingCents: remainingCents(name),
        revoked: grant.revoked,
        allowedTypes: [...grant.allowedTypes],
        memoPrefix: grant.memoPrefix,
        subGrantNames: [...grant.subGrantNames],
        ...(grant.renewal === undefined
          ? {}
          : {
              renewal: {
                amountCents: grant.renewal.amountCents,
                periodMs: grant.renewal.periodMs,
              },
            }),
        cards: Object.entries(grant.cards).map(([cardToken, card]) => ({
          cardToken,
          reservedCents: card.reservedCents,
          closed: card.closed,
          refundedCents: card.refundedCents,
        })),
      });
    },
  };

  return harden(ledger);
};
harden(makeBudgetLedger);
