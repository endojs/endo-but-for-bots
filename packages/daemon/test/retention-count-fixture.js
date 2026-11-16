// @ts-check

import Database from 'better-sqlite3';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

/**
 * Read-only test probe; exposes counts, never identities or capabilities.
 * @param {unknown} _powers
 * @param {any} context
 * @param {{env: {DATABASE_PATH: string}}} options
 */
export const make = (_powers, context, { env }) => {
  const db = new Database(env.DATABASE_PATH, { readonly: true });
  E(context)
    .whenCancelled()
    .catch(() => db.close());
  const statement = db.prepare('SELECT COUNT(*) AS count FROM retention');
  return makeExo(
    'Retention Count Probe',
    M.interface('Retention Count Probe', {
      count: M.call().returns(M.number()),
    }),
    {
      count: () => /** @type {{count: number}} */ (statement.get()).count,
    },
  );
};
harden(make);
