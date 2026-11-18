// @ts-check
/**
 * The preset editor's size check (W5.8; `designs/m5-interfaces.md` 1.3,
 * 4.1 item 7): a record over `presetRecordBytes` is refused before sending
 * with `presetTooLarge`, by the rule of `fitsFrame` (`guest/lib/bounded.js`):
 * the string content bytes of the record (UTF-8, record keys included;
 * contract rule 4), estimated as UTF-16 units x 3 first and counted exactly
 * only when the estimate is over. Remotables (the backend, endowment
 * values) carry no string content.
 *
 * A browser copy of that rule: `bounded.js` needs the vat prelude. The
 * value and the rule are checked equal to the guest's by
 * `test/unit/m5-w58-copies.test.js`.
 */
import { passStyleOf } from '@endo/far';

/**
 * `limits.presetRecordBytes` (`frameBytes` 24,576 - 2,048): the string
 * content bytes one `PresetRecord` may carry.
 */
export const presetRecordBytes = 22_528;

/**
 * Visit every string a message would carry: record keys and values, array
 * items, an error's name and message; remotables, promises and scalars
 * carry none. Iterative.
 *
 * @param {unknown} value
 * @param {(text: string) => void} visit
 */
const eachString = (value, visit) => {
  /** @type {unknown[]} */
  const stack = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      visit(item);
    } else if (typeof item === 'object' && item !== null) {
      /** @type {string} */
      let style;
      if (Object.isFrozen(item)) {
        try {
          style = passStyleOf(item);
        } catch {
          style = 'other';
        }
      } else if (Array.isArray(item)) {
        style = 'copyArray';
      } else if (item instanceof Error) {
        style = 'error';
      } else {
        const proto = Object.getPrototypeOf(item);
        style =
          proto === Object.prototype || proto === null ? 'copyRecord' : 'other';
      }
      if (style === 'copyArray') {
        for (const element of /** @type {unknown[]} */ (item)) {
          stack.push(element);
        }
      } else if (style === 'copyRecord') {
        for (const key of Object.keys(item)) {
          visit(key);
          stack.push(/** @type {Record<string, unknown>} */ (item)[key]);
        }
      } else if (style === 'tagged') {
        visit(/** @type {any} */ (item)[Symbol.toStringTag]);
        stack.push(/** @type {any} */ (item).payload);
      } else if (style === 'error') {
        visit(/** @type {Error} */ (item).name);
        visit(/** @type {Error} */ (item).message);
      }
    }
  }
};

/** @type {TextEncoder | undefined} */
let encoder;

/**
 * The exact UTF-8 bytes of every string in a record.
 *
 * @param {unknown} record
 * @returns {number}
 */
export const presetRecordSize = record => {
  if (encoder === undefined) encoder = new TextEncoder();
  const measure = encoder;
  let total = 0;
  eachString(record, text => {
    total += measure.encode(text).length;
  });
  return total;
};
harden(presetRecordSize);

/**
 * Whether a `PresetRecord` fits `budget` (default `presetRecordBytes`):
 * the estimate first, the exact count only when the estimate is over.
 *
 * @param {unknown} record
 * @param {number} [budget]
 * @returns {boolean}
 */
export const fitsPresetRecord = (record, budget = presetRecordBytes) => {
  let units = 0;
  eachString(record, text => {
    units += text.length;
  });
  if (units * 3 <= budget) return true;
  // Each string has at least one byte per unit.
  if (units > budget) return false;
  return presetRecordSize(record) <= budget;
};
harden(fitsPresetRecord);
