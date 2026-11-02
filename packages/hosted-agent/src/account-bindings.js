// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { passStyleOf } from '@endo/pass-style';

import { assertAccountAuthority } from './account-authority.js';

/** @typedef {{backendId: string, subscriptionId?: string}} AccountUse */
/** @typedef {{accountId: string, providerId: string, title: string, label?: string, oracle: any, adminId?: string, admin?: any, uses: AccountUse[]}} AccountBinding */
/** @typedef {{version: 1, accounts: AccountBinding[], unavailable?: true}} AccountBindings */

/** @param {any} value @param {string[]} required @param {string[]} [optional] */
const record = (value, required, optional = []) => {
  (passStyleOf(value) === 'copyRecord' &&
    required.every(key => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      key =>
        typeof key === 'string' && [...required, ...optional].includes(key),
    )) ||
    Fail`Invalid account bindings record`;
};
/** @param {unknown} value */
const text = value => {
  (typeof value === 'string' && value.trim() !== '' && value.length <= 8192) ||
    Fail`Invalid account bindings text`;
};

/**
 * The operator's declared account authority, qualified by provider and optional
 * pool member. Observer formulas and runtime names are not account identities.
 * @param {{providerId: string, accountAuthority: string, subscriptionId?: string}} identity
 */
export const makeAccountId = ({
  providerId,
  accountAuthority,
  subscriptionId,
}) => {
  text(providerId);
  assertAccountAuthority(accountAuthority);
  if (subscriptionId !== undefined) text(subscriptionId);
  return JSON.stringify([providerId, accountAuthority, subscriptionId ?? null]);
};
harden(makeAccountId);

/**
 * Validate trusted profile publications, not proof that an ID authenticates a
 * capability. Account IDs are explicit provider/authority/member declarations;
 * admin IDs are the existing formula identities captured by setup.
 * Multiple uses share one account; distinct owners are never inferred
 * equal from labels or provider names.
 * @param {unknown} value
 * @returns {AccountBindings}
 */
export const assertAccountBindings = value => {
  const data = /** @type {any} */ (value);
  record(data, ['version', 'accounts'], ['unavailable']);
  (data.version === 1 && Array.isArray(data.accounts)) ||
    Fail`Invalid account bindings version or accounts`;
  !Object.hasOwn(data, 'unavailable') ||
    (data.unavailable === true && data.accounts.length === 0) ||
    Fail`Unavailable account bindings must have no accounts`;
  const ids = new Set();
  const oracles = new Set();
  for (const entry of Array.from(data.accounts)) {
    record(
      entry,
      ['accountId', 'providerId', 'title', 'oracle', 'uses'],
      ['label', 'adminId', 'admin'],
    );
    for (const key of ['accountId', 'providerId', 'title']) text(entry[key]);
    if (Object.hasOwn(entry, 'label')) text(entry.label);
    (!ids.has(entry.accountId) && !oracles.has(entry.oracle)) ||
      Fail`Duplicate account binding authority`;
    ids.add(entry.accountId);
    oracles.add(entry.oracle);
    passStyleOf(entry.oracle) === 'remotable' ||
      Fail`Invalid account oracle capability`;
    Object.hasOwn(entry, 'adminId') === Object.hasOwn(entry, 'admin') ||
      Fail`Account admin identity and capability must be paired`;
    if (Object.hasOwn(entry, 'admin')) {
      text(entry.adminId);
      passStyleOf(entry.admin) === 'remotable' ||
        Fail`Invalid account admin capability`;
    }
    (Array.isArray(entry.uses) && entry.uses.length !== 0) ||
      Fail`Account requires explicit uses`;
    const uses = new Set();
    for (const use of Array.from(entry.uses)) {
      record(use, ['backendId'], ['subscriptionId']);
      text(use.backendId);
      if (Object.hasOwn(use, 'subscriptionId')) text(use.subscriptionId);
      const key = JSON.stringify([use.backendId, use.subscriptionId ?? null]);
      !uses.has(key) || Fail`Duplicate account use`;
      uses.add(key);
    }
  }
  return harden(data);
};
harden(assertAccountBindings);

/**
 * Publish one complete source in the existing profile. Preparation must finish
 * before calling; failure, including a lost write acknowledgement, is never
 * rolled back. Setup writers must be serialized as for other profile bindings.
 * @param {any} profile
 * @param {{source: string, accounts: AccountBinding[]}} options
 */
export const publishAccountBindings = async (profile, { source, accounts }) => {
  await null;
  (typeof source === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(source)) ||
    Fail`Invalid account bindings source`;
  const value = assertAccountBindings(harden({ version: 1, accounts }));
  if (!(await E(profile).has('account-bindings')))
    await E(profile).makeDirectory(['account-bindings']);
  await E(profile).storeValue(value, ['account-bindings', source]);
};
harden(publishAccountBindings);

/**
 * Withdraw discovery authority before rebinding existing observation wrappers.
 * A failed setup leaves an explicit unknown reading, never stale reset powers.
 * @param {any} profile
 * @param {{source: string}} options
 */
export const invalidateAccountBindings = async (profile, { source }) => {
  await null;
  (typeof source === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(source)) ||
    Fail`Invalid account bindings source`;
  if (!(await E(profile).has('account-bindings')))
    await E(profile).makeDirectory(['account-bindings']);
  await E(profile).storeValue(
    harden({ version: 1, accounts: [], unavailable: true }),
    ['account-bindings', source],
  );
};
harden(invalidateAccountBindings);
