// @ts-check
import { Far } from '@endo/far';
import { makePoolIdentityJournal } from '../src/pool-identity-journal.js';

/** @param {any} namespace */
export const make = namespace => {
  const journal = makePoolIdentityJournal({
    namespace,
    providerId: 'test',
    origin: 'https://provider.test',
    accountRef: 'account',
  });
  return Far('PoolIdentityProbe', { bind: members => journal.bind(members) });
};
harden(make);
