// @ts-check

import { parseLocator } from '@endo/daemon/locator.js';

/**
 * Inbox package attachment IDs are exposed to agents as locators, while
 * lookupById() expects a raw formula identifier.
 *
 * @param {string} id
 */
export const formulaIdFromMessageId = id => {
  if (!id.startsWith('endo://')) {
    return id;
  }
  const { number, node } = parseLocator(id);
  return `${number}:${node}`;
};
harden(formulaIdFromMessageId);
