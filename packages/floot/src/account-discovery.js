// @ts-check
import { E } from '@endo/eventual-send';
import { assertAccountBindings } from '@endo/hosted-agent/account-bindings.js';

/** A UI action names both the account and the exact reset administrator.
 * @param {string} accountId
 * @param {string | undefined} adminId
 */
export const accountResetKey = (accountId, adminId) =>
  JSON.stringify([accountId, adminId]);
harden(accountResetKey);

/**
 * Read only explicitly published profile bindings. Unreadable sources preserve
 * their previous display through provenance, never their reset authority.
 * Conflicting assertions refuse the discovery instead of choosing a winner.
 * @param {any} profile
 */
export const discoverAccounts = async profile => {
  if (!(await E(profile).has('account-bindings'))) {
    return harden({ entries: [], unknown: [] });
  }
  const directory = await E(profile).lookup('account-bindings');
  const names = await E(directory).list();
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
    throw Error('Invalid account binding source inventory');
  }
  const accounts = new Map();
  const oracleIds = new Map();
  const unknown = [];
  for (const source of [...new Set(names)].sort()) {
    let record;
    try {
      // eslint-disable-next-line no-await-in-loop
      record = assertAccountBindings(await E(directory).lookup(source));
    } catch {
      unknown.push(source);
    }
    if (record?.unavailable === true) {
      unknown.push(source);
    }
    for (const entry of record?.accounts ?? []) {
      const previousId = oracleIds.get(entry.oracle);
      if (previousId !== undefined && previousId !== entry.accountId) {
        throw Error('One account oracle has conflicting account identities');
      }
      oracleIds.set(entry.oracle, entry.accountId);
      const previous = accounts.get(entry.accountId);
      if (previous) {
        if (
          previous.providerId !== entry.providerId ||
          (previous.admin !== undefined &&
            entry.admin !== undefined &&
            (previous.admin !== entry.admin ||
              previous.adminId !== entry.adminId))
        ) {
          throw Error('Conflicting published account bindings');
        }
        previous.sources.push(source);
        // A logical account can have several read-only observers. Sorted
        // source order chooses one; only an unambiguous admin grants resets.
        if (previous.admin === undefined && entry.admin !== undefined) {
          previous.admin = entry.admin;
          previous.adminId = entry.adminId;
        }
        for (const use of entry.uses) {
          if (
            !previous.uses.some(
              existing =>
                existing.backendId === use.backendId &&
                existing.subscriptionId === use.subscriptionId,
            )
          ) {
            previous.uses.push(use);
          }
        }
      } else {
        accounts.set(entry.accountId, {
          ...entry,
          sources: [source],
          uses: [...entry.uses],
        });
      }
    }
  }
  return harden({ entries: [...accounts.values()], unknown });
};
harden(discoverAccounts);
