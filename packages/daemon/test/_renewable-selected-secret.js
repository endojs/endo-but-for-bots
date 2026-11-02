// @ts-check
import { E } from '@endo/eventual-send';

/** Test-only dynamic recipe; deliberately does not retain the selected grant.
 * @param {any} host
 */
export const make = async host => {
  const grant = await E(host).lookup('selected-secret-grant');
  return E(host).lookup(['@secrets', 'use', grant]);
};
harden(make);
