// @ts-check
import { Far } from '@endo/far';

/** @param {any} _powers @param {any} _context @param {{env?: {ROLE?: string}}} [options] */
export const make = (_powers, _context, { env = {} } = {}) =>
  Far('AccountBindingTestCapability', { role: () => env.ROLE || 'account' });
harden(make);
