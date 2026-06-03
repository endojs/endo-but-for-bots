// @ts-check

/**
 * @file `ResourceLedger` exo for the gateway's resource-accounting
 *   surface (design Feature 1, Phase 8).
 *
 * Per `designs/gateway-package.md` § Feature 1, the gateway *owns*
 * the resource-accounting surface: per-account counters for
 * compute, storage, and network tokens, plus the
 * `purchaseTokens(tokens, proof)` entry point a Chat-weblet UI
 * calls after a payment processor confirms a purchase. The
 * payment processor itself is **out of scope for `@endo/gateway`**;
 * the `proof` field is opaque to the gateway, validated by an
 * embedder-supplied `verifyPaymentProof` power.
 *
 * The exo carries the four methods the design names under
 * § Capability Surface: `getBalance`, `chargeBalance`,
 * `purchaseTokens`, `setQuota`. The admin facet (Phase 3) consumes
 * a `ResourceLedger`-shaped power through its `getResourceBalances`
 * surface, which iterates `listBalances()` (the admin-side bulk
 * read). Phase 8 keeps Phase 3's behavior on a no-ledger gateway
 * (returns `[]`); when the embedder supplies the concrete ledger,
 * the admin reads through it.
 *
 * ### Account identification
 *
 * An account is identified by an Ed25519 public key (32 bytes),
 * the same byte shape the bootstrap registrar uses for
 * registrations. Per the kriskowal directive on PR #393, byte
 * fields use `Uint8Array` as the sole unit of transmission; the
 * exo's interface guard uses `M.raw()` so the validation runs in
 * the method body rather than at the patterns layer. The ledger
 * keys its internal map by lowercase hex so two byte-equal inputs
 * (one from the wire, one we kept) resolve to the same account.
 *
 * ### Counter shape
 *
 * Each account carries three independent counter classes: compute
 * (suggested unit: seconds), storage (suggested unit: bytes), and
 * network (suggested unit: bytes). The names match the
 * `ResourceBalance` typedef from `admin.js` § Phase 3 so the admin
 * facet's snapshot shape carries forward unchanged.
 *
 * Counters are non-negative integers. Fractional or negative
 * inputs are rejected. The `chargeBalance` debit underflows
 * fail-closed: a charge for more tokens than the account holds
 * throws, leaving the account state unchanged. This matches the
 * design's framing: *"gate resource-intensive operations on a
 * positive balance"*; silently going negative would be the
 * wrong-shape failure for a metering surface.
 *
 * ### Quota
 *
 * Per design § Capability Surface, the `setQuota` method caps the
 * *maximum* balance for each class. A `purchaseTokens` call whose
 * effect would push any class above the quota throws (the full
 * purchase fails); this is the fail-closed posture for a paid
 * surface. An account with no quota set is unbounded. Setting a
 * quota lower than the current balance does not retroactively
 * reduce the balance; it only bounds future credits.
 *
 * ### Payment-proof verification
 *
 * The ledger does **not** implement payment-proof validation. The
 * embedder injects a `verifyPaymentProof` power. The proof is
 * opaque to the gateway (per design: "the `proof` is opaque to
 * the gateway, validated by an external `PaymentProcessor` exo").
 * A `verifyPaymentProof` that returns a falsy value (or throws)
 * causes the `purchaseTokens` call to throw without touching any
 * counter. The verifier may return a structured `tokens` record
 * (so a payment processor can settle the *actual* token grant
 * itself rather than relying on the caller's stated `tokens`),
 * but the simplest verifier just returns `true` and the ledger
 * credits the caller's stated `tokens`.
 *
 * ### Failure modes
 *
 * - Unknown account on `getBalance` returns the all-zeros record
 *   rather than throwing. This matches the admin facet's
 *   "empty-snapshot" posture: a query against a brand-new account
 *   is benign.
 * - `chargeBalance` against an unknown account creates the
 *   account at zero before the underflow check, so the call
 *   throws (you cannot debit what was never credited).
 * - `purchaseTokens` against an unknown account creates the
 *   account on first credit. A failed proof-verify or a
 *   quota-overflow before any debit leaves the account state
 *   untouched.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeError, q, X } from '@endo/errors';

import { ED25519_PUBLIC_KEY_LENGTH } from './bootstrap.js';

const ResourceLedgerInterface = M.interface('ResourceLedger', {
  getBalance: M.call(M.raw()).returns(M.promise()),
  chargeBalance: M.call(M.raw(), M.raw()).returns(M.promise()),
  purchaseTokens: M.call(M.raw(), M.raw(), M.raw()).returns(M.promise()),
  setQuota: M.call(M.raw(), M.raw()).returns(M.promise()),
  listBalances: M.call().returns(M.promise()),
});
harden(ResourceLedgerInterface);

/**
 * The three counter classes the ledger maintains per account.
 * Order is fixed (compute, storage, network) so iteration order
 * is deterministic across snapshots; downstream consumers (the
 * admin facet, a hypothetical export-to-CSV tool) can rely on it.
 */
export const RESOURCE_CLASSES = harden(
  /** @type {const} */ (['compute', 'storage', 'network']),
);

/**
 * The all-zeros balance record. Used as the default for new
 * accounts and as the response shape for an unknown-account
 * `getBalance` query.
 */
const ZERO_COUNTERS = harden({ compute: 0, storage: 0, network: 0 });

/** @import {
 *   ResourceTokens,
 *   ResourceQuota,
 *   VerifyPaymentProofResult,
 *   VerifyPaymentProof,
 *   ResourceLedger,
 *   ResourceBalance,
 * } from './types.d.ts' */

/**
 * @typedef {object} ResourceLedgerDeps Args to `makeResourceLedger`.
 * @property {VerifyPaymentProof} verifyPaymentProof The
 *   embedder-supplied payment-proof verifier. The package itself
 *   does not implement payment verification; the verifier is the
 *   contract boundary between the gateway and the operator's
 *   payment processor.
 */

/**
 * Validate a byte-shaped public-key input.
 *
 * @param {unknown} candidate
 * @returns {Uint8Array}
 */
const checkAgentPublicKey = candidate => {
  if (!(candidate instanceof Uint8Array)) {
    throw makeError(X`agentPublicKey must be a Uint8Array`);
  }
  if (candidate.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw makeError(
      X`agentPublicKey must be ${q(ED25519_PUBLIC_KEY_LENGTH)} bytes, got ${q(candidate.length)}`,
    );
  }
  return candidate;
};

/**
 * Hex-render a byte view. The ledger keys its internal map by hex
 * so two byte-equal inputs hit the same Map entry.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const publicKeyToHex = bytes => {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/**
 * Validate one counter-class input. Non-negative integers only;
 * `NaN`, fractional, negative, and `Infinity` inputs all throw.
 *
 * @param {unknown} candidate
 * @param {string} fieldName
 * @returns {number}
 */
const checkNonNegativeInteger = (candidate, fieldName) => {
  if (typeof candidate !== 'number') {
    throw makeError(X`${q(fieldName)} must be a number, got ${q(candidate)}`);
  }
  if (!Number.isFinite(candidate)) {
    throw makeError(
      X`${q(fieldName)} must be a finite number, got ${q(candidate)}`,
    );
  }
  if (!Number.isInteger(candidate)) {
    throw makeError(X`${q(fieldName)} must be an integer, got ${q(candidate)}`);
  }
  if (candidate < 0) {
    throw makeError(
      X`${q(fieldName)} must be non-negative, got ${q(candidate)}`,
    );
  }
  return candidate;
};

/**
 * Validate one quota-class input. Non-negative integers or
 * `Infinity` (the unbounded sentinel).
 *
 * @param {unknown} candidate
 * @param {string} fieldName
 * @returns {number}
 */
const checkQuotaValue = (candidate, fieldName) => {
  if (typeof candidate !== 'number') {
    throw makeError(X`${q(fieldName)} must be a number, got ${q(candidate)}`);
  }
  if (Number.isNaN(candidate)) {
    throw makeError(X`${q(fieldName)} must not be NaN`);
  }
  if (candidate < 0) {
    throw makeError(
      X`${q(fieldName)} must be non-negative, got ${q(candidate)}`,
    );
  }
  if (candidate !== Infinity && !Number.isInteger(candidate)) {
    throw makeError(
      X`${q(fieldName)} must be an integer or Infinity, got ${q(candidate)}`,
    );
  }
  return candidate;
};

/**
 * Validate a `ResourceTokens` input and return a normalized
 * record with all three classes populated (missing classes
 * default to zero). Rejects unrecognized keys so a typo
 * (`computes: 5`) surfaces loudly rather than silently dropping.
 *
 * @param {unknown} candidate
 * @returns {{ compute: number, storage: number, network: number }}
 */
const checkResourceTokens = candidate => {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    throw makeError(
      X`tokens must be an object with compute / storage / network fields, got ${q(candidate)}`,
    );
  }
  const record = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of Object.keys(record)) {
    if (key !== 'compute' && key !== 'storage' && key !== 'network') {
      throw makeError(X`tokens has unrecognized field ${q(key)}`);
    }
  }
  const compute =
    record.compute === undefined
      ? 0
      : checkNonNegativeInteger(record.compute, 'tokens.compute');
  const storage =
    record.storage === undefined
      ? 0
      : checkNonNegativeInteger(record.storage, 'tokens.storage');
  const network =
    record.network === undefined
      ? 0
      : checkNonNegativeInteger(record.network, 'tokens.network');
  return { compute, storage, network };
};

/**
 * Validate a `ResourceQuota` input and return a normalized
 * record with all three classes populated (missing classes
 * default to `Infinity` / unbounded). Rejects unrecognized keys.
 *
 * @param {unknown} candidate
 * @returns {{ compute: number, storage: number, network: number }}
 */
const checkResourceQuota = candidate => {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    throw makeError(
      X`quota must be an object with compute / storage / network fields, got ${q(candidate)}`,
    );
  }
  const record = /** @type {Record<string, unknown>} */ (candidate);
  for (const key of Object.keys(record)) {
    if (key !== 'compute' && key !== 'storage' && key !== 'network') {
      throw makeError(X`quota has unrecognized field ${q(key)}`);
    }
  }
  const compute =
    record.compute === undefined
      ? Infinity
      : checkQuotaValue(record.compute, 'quota.compute');
  const storage =
    record.storage === undefined
      ? Infinity
      : checkQuotaValue(record.storage, 'quota.storage');
  const network =
    record.network === undefined
      ? Infinity
      : checkQuotaValue(record.network, 'quota.network');
  return { compute, storage, network };
};

/**
 * Create the `ResourceLedger` exo. The ledger is total: it
 * returns the exo unconditionally and the caller (the gateway
 * proper, `index.js`) decides whether to wire it in based on
 * whether the embedder supplied `powers.verifyPaymentProof`.
 *
 * The ledger holds account state in plain JS Maps; there is no
 * persistence surface. A future phase may layer a formula-backed
 * store on top (mirroring Phase 7's `AppsFormulaStore` shape),
 * but Phase 8 keeps the surface in-memory: the design's
 * "Gateway OWNS the surface" framing is about which exo holds the
 * counters, not about where they survive a restart.
 *
 * @param {ResourceLedgerDeps} deps
 * @returns {ResourceLedger}
 */
export const makeResourceLedger = ({ verifyPaymentProof }) => {
  if (typeof verifyPaymentProof !== 'function') {
    throw makeError(
      X`makeResourceLedger requires a verifyPaymentProof function`,
    );
  }

  /**
   * Per-account state. Keyed by lowercase-hex public key so two
   * byte-equal inputs resolve to the same account.
   *
   * @type {Map<string, {
   *   balance: { compute: number, storage: number, network: number },
   *   quota: { compute: number, storage: number, network: number },
   * }>}
   */
  const accounts = new Map();

  /**
   * Look up (or lazily create) the account record for the
   * supplied public key. Returns the mutable state slot.
   *
   * @param {Uint8Array} agentPublicKey
   */
  const accountFor = agentPublicKey => {
    const hex = publicKeyToHex(agentPublicKey);
    let entry = accounts.get(hex);
    if (entry === undefined) {
      entry = {
        balance: { ...ZERO_COUNTERS },
        quota: {
          compute: Infinity,
          storage: Infinity,
          network: Infinity,
        },
      };
      accounts.set(hex, entry);
    }
    return { hex, entry };
  };

  const exo = makeExo(
    'ResourceLedger',
    ResourceLedgerInterface,
    /** @type {any} */ ({
      /** @param {Uint8Array} agentPublicKey */
      async getBalance(agentPublicKey) {
        const key = checkAgentPublicKey(agentPublicKey);
        const hex = publicKeyToHex(key);
        const entry = accounts.get(hex);
        if (entry === undefined) {
          // Fail-closed default: a brand-new account has zero
          // balance until first credit. The query itself is
          // benign and does not allocate an account record.
          return harden({ account: hex, ...ZERO_COUNTERS });
        }
        return harden({ account: hex, ...entry.balance });
      },
      /**
       * @param {Uint8Array} agentPublicKey
       * @param {ResourceTokens} tokens
       */
      async chargeBalance(agentPublicKey, tokens) {
        const key = checkAgentPublicKey(agentPublicKey);
        const debit = checkResourceTokens(tokens);
        const { hex, entry } = accountFor(key);
        // Underflow check across all three classes before mutating
        // any one. Partial debits would leave the account in a
        // half-charged state and contradict the design's
        // "atomic charge or fail" framing.
        for (const cls of RESOURCE_CLASSES) {
          if (entry.balance[cls] < debit[cls]) {
            throw makeError(
              X`chargeBalance: insufficient ${q(cls)} tokens (held ${q(entry.balance[cls])}, requested ${q(debit[cls])})`,
            );
          }
        }
        for (const cls of RESOURCE_CLASSES) {
          entry.balance[cls] -= debit[cls];
        }
        return harden({ account: hex, ...entry.balance });
      },
      /**
       * @param {Uint8Array} agentPublicKey
       * @param {ResourceTokens} tokens
       * @param {unknown} proof
       */
      async purchaseTokens(agentPublicKey, tokens, proof) {
        const key = checkAgentPublicKey(agentPublicKey);
        const requested = checkResourceTokens(tokens);
        // Verify the payment proof *before* mutating any state.
        // The verifier may throw (we let the error propagate so a
        // descriptive message reaches the caller) or return a
        // falsy value (we throw a generic "invalid proof" error).
        // A `ResourceTokens`-shaped result lets the verifier
        // settle the actual grant; a `true` literal credits the
        // caller's stated amount.
        const verdict = await verifyPaymentProof({
          agentPublicKey: key,
          tokens: harden({ ...requested }),
          proof,
        });
        if (!verdict) {
          throw makeError(X`purchaseTokens: payment proof failed verification`);
        }
        const credit =
          verdict === true ? requested : checkResourceTokens(verdict);
        const { hex, entry } = accountFor(key);
        // Quota check across all three classes before mutating
        // any one. Same atomic-or-fail posture as chargeBalance.
        for (const cls of RESOURCE_CLASSES) {
          const next = entry.balance[cls] + credit[cls];
          if (next > entry.quota[cls]) {
            throw makeError(
              X`purchaseTokens: ${q(cls)} credit would exceed quota (balance ${q(entry.balance[cls])} + credit ${q(credit[cls])} > quota ${q(entry.quota[cls])})`,
            );
          }
        }
        for (const cls of RESOURCE_CLASSES) {
          entry.balance[cls] += credit[cls];
        }
        return harden({ account: hex, ...entry.balance });
      },
      /**
       * @param {Uint8Array} agentPublicKey
       * @param {ResourceQuota} quota
       */
      async setQuota(agentPublicKey, quota) {
        const key = checkAgentPublicKey(agentPublicKey);
        const next = checkResourceQuota(quota);
        const { entry } = accountFor(key);
        for (const cls of RESOURCE_CLASSES) {
          entry.quota[cls] = next[cls];
        }
      },
      async listBalances() {
        // Stable iteration order: hex-sorted accounts. Map
        // iteration is insertion-order in JS, which would leak
        // the order accounts were touched; sorting gives a
        // deterministic snapshot the admin facet can rely on.
        const hexes = [...accounts.keys()].sort();
        return harden(
          hexes.map(hex => {
            const entry =
              /** @type {NonNullable<ReturnType<typeof accounts.get>>} */ (
                accounts.get(hex)
              );
            return harden({ account: hex, ...entry.balance });
          }),
        );
      },
    }),
  );

  return /** @type {ResourceLedger} */ (/** @type {unknown} */ (exo));
};
harden(makeResourceLedger);
