// @ts-check

import harden from '@endo/harden';
import { q } from '@endo/errors';

import { idFromLocator } from './locator.js';

/** @import { FormulaIdentifier, GuestMessage, GuestNameChange, Name, PetStoreNameChange } from './types.js' */

/**
 * A guest holds no formula identifiers or locators (distributed confinement):
 * a designation carried as data must not become authority, and authority the
 * guest holds must not leave as data. These message fields carry one or the
 * other and are withheld from every message a guest reads.
 */
export const designationMessageFields = harden([
  'from',
  'to',
  'ids',
  'promiseId',
  'resolverId',
  'valueId',
]);

/**
 * Make the redaction a guest applies to every message it reads.
 *
 * @param {(id: FormulaIdentifier) => Name[]} reverseIdentify The guest's own
 *   pet names for a formula.
 * @param {object} [options]
 * @param {(...args: unknown[]) => void} [options.reportError]
 */
export const makeMessageRedactor = (
  reverseIdentify,
  { reportError = (...args) => console.error(...args) } = {},
) => {
  /**
   * The guest's own pet names for a correspondent, in place of the
   * correspondent's locator.
   * @param {unknown} locator
   * @returns {Name[]}
   */
  const namesForLocator = locator => {
    if (typeof locator !== 'string') {
      return harden([]);
    }
    /** @type {FormulaIdentifier} */
    let id;
    try {
      id = /** @type {FormulaIdentifier} */ (idFromLocator(locator));
    } catch (error) {
      // The daemon writes every envelope's `from` and `to`, so a locator that
      // does not parse is a daemon defect. Withholding names fails safe (it
      // discloses nothing), but the defect must not pass silently.
      reportError(
        `Guest message correspondent is not a valid locator: ${q(locator)}`,
        error,
      );
      return harden([]);
    }
    return harden([...reverseIdentify(id)]);
  };

  /**
   * @param {Record<string, any>} message
   * @returns {GuestMessage}
   */
  const redactMessage = message => {
    /** @type {Record<string, any>} */
    const redacted = {
      ...message,
      fromNames: namesForLocator(message.from),
      toNames: namesForLocator(message.to),
    };
    for (const field of designationMessageFields) {
      delete redacted[field];
    }
    return /** @type {GuestMessage} */ (harden(redacted));
  };

  return harden({ namesForLocator, redactMessage });
};
harden(makeMessageRedactor);

/**
 * A name change as a guest reads it: an addition's `value` carries the named
 * formula's identifier and is withheld.
 *
 * @param {PetStoreNameChange} change
 * @returns {GuestNameChange}
 */
export const redactNameChange = change => {
  if (!('add' in change)) {
    return harden({ ...change });
  }
  const { value: _value, ...rest } = change;
  return harden(rest);
};
harden(redactNameChange);
