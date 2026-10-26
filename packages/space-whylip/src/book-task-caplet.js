// @ts-check

import { makeError, X } from '@endo/errors';
import { E } from '@endo/eventual-send';

/**
 * Formula-backed attenuator: the helper receives only a single draft task.
 * @param {any} powers
 * @param {unknown} _context
 * @param {{env?: {taskId?: string}}} [options]
 */
export const make = async (powers, _context, options = {}) => {
  const id = options.env?.taskId;
  if (!id || !/^\d+$/.test(id)) throw makeError(X`A valid taskId is required`);
  const book = await E(powers).lookup('book');
  return E(book).getTask(id);
};
harden(make);
