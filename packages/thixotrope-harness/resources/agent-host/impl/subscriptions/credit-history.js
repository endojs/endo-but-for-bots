// @ts-check
/* eslint-disable import/no-relative-packages -- shared bounded history contract */
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */

/**
 * A numeric wallet balance is distinct from quota percentages and reset
 * credits. Preserve the original provider decimal on disk and on the wire.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isCreditBalance = value =>
  typeof value === 'string' && /^-?\d{1,24}(?:\.\d{1,12})?$/.test(value);
harden(isCreditBalance);

/** @typedef {{ from: string, value: string, to?: string, count?: number }} CreditRecord */

/** @param {string} value */
const scaled = value => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(12, '0'));
};

/**
 * A missing balance on a full read, or an explicitly nonnumeric balance,
 * ends the observable series. A header about other fields leaves it alone.
 * @param {CreditRecord[]} records
 * @param {string | undefined} from
 * @param {string | undefined} value
 * @param {boolean} partial
 * @returns {CreditRecord[]}
 */
export const observeCredits = (records, from, value, partial) => {
  if (!from || (partial && value === undefined)) return records;
  const last = records.at(-1);
  if (last && from < (last.to ?? last.from)) return records;
  if (!isCreditBalance(value)) return [];
  if (last && from === (last.to ?? last.from)) return records;
  if (last && scaled(last.value) === scaled(value)) {
    return [
      ...records.slice(0, -1),
      {
        from: last.from,
        value,
        to: from,
        count: Math.min(Number.MAX_SAFE_INTEGER, (last.count ?? 1) + 1),
      },
    ];
  }
  return [...records, { from, value }].slice(
    -subscriptionLimits.historySamples,
  );
};
harden(observeCredits);

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isInstant = value => {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value
  );
};

/**
 * @param {unknown} candidate
 * @returns {CreditRecord[]}
 */
export const checkCredits = candidate => {
  /** @type {CreditRecord[]} */
  const records = [];
  if (!Array.isArray(candidate)) return records;
  for (const record of candidate.slice(-subscriptionLimits.historySamples)) {
    const { from, value, to, count } = record ?? {};
    const last = records.at(-1);
    if (
      isInstant(from) &&
      isCreditBalance(value) &&
      (!last || from > (last.to ?? last.from))
    ) {
      const repeated =
        isInstant(to) &&
        to > from &&
        typeof count === 'number' &&
        Number.isSafeInteger(count) &&
        count >= 2;
      records.push({ from, value, ...(repeated ? { to, count } : {}) });
    }
  }
  return records;
};
harden(checkCredits);
