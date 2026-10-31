// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

/**
 * Deliberately effectful revival: this must run only during explicit activation.
 * @param {any} audit
 * @param {unknown} _context
 * @param {{env?: Record<string, string>}} [options]
 */
export const make = async (audit, _context, { env = {} } = {}) => {
  const name = `revivals-${env.LABEL}`;
  const before = await E(audit).maybeReadText(name);
  await E(audit).writeText(name, `${BigInt(before || '0') + 1n}`);
  return Far('NativeSessionDependencyFixture', { ping: () => env.LABEL });
};
harden(make);
