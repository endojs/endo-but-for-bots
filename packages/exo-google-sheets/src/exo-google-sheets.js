// @ts-check

/**
 * `makeExoSpreadsheet` is the boundary: the one place that holds a whole
 * Sheets client, and the only place that does.  It takes the client apart into
 * the individual operations, hands each power maker exactly the operations its
 * authority class needs, and keeps nothing but the host's `control`.
 *
 * Everything downstream — `powers.js`, `facets.js` — receives narrowed objects.
 * That is the whole design: attenuate once, near the entry point, and pass the
 * smaller thing along, rather than passing the client around with rules about
 * how to use it.
 */

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';

import { SpreadsheetControlInterface } from './interfaces.js';
import { makeReader, makeWriter } from './facets.js';
import {
  makeAppendPowers,
  makeCaretaker,
  makePolicy,
  makeReadPowers,
  makeWritePowers,
} from './powers.js';

export {
  SpreadsheetAppenderInterface,
  SpreadsheetControlInterface,
  SpreadsheetInterface,
  SpreadsheetWriteOnlyInterface,
  SpreadsheetWriterInterface,
} from './interfaces.js';

/**
 * Make attenuated spreadsheet facets around a portable Sheets client.
 *
 * Returns the reader (`spreadsheet`), the read-write facet (`writer`), and the
 * host's `control`.  Which of those a guest receives *is* the grant: a guest
 * given only `spreadsheet` holds no object that can change a cell, so there is
 * no read-only mode to set and none to forget to check.  A grant already
 * handed out is withdrawn through `control` — `revokeWrites()` for the
 * mutating classes, `revoke()` for all of them — which severs the caretakers
 * the facets reach the client through, and cannot be undone.
 *
 * @param {any} client A `@endo/google-sheets` client.
 * @param {{ maxRequestsPerMinute?: number, maxCellsPerRead?: number, pollIntervalMs?: number }} [options]
 */
export const makeExoSpreadsheet = (client, options = {}) => {
  if (!client || !client.values || !client.spreadsheets)
    throw new TypeError('A Sheets client is required');

  const policy = makePolicy(options);

  // Two caretakers, so read authority and mutating authority can be revoked
  // independently.  They share the policy — one allowlist, one token bucket —
  // but not a revocation, which is what lets `revokeWrites()` leave an
  // outstanding reader working.
  const readAccess = makeCaretaker(policy);
  const mutateAccess = makeCaretaker(policy);

  // The client comes apart here.  Each maker's arguments are the complete
  // statement of what facets built over it can reach.
  const read = makeReadPowers({
    getValues: range => client.values.get(range),
    getSpreadsheet: fields => client.spreadsheets.get(fields),
    access: readAccess,
    limits: policy.limits,
  });
  const append = makeAppendPowers({
    appendValues: (range, rows) => client.values.append(range, rows),
    access: mutateAccess,
  });
  const write = makeWritePowers({
    updateValues: (range, values) => client.values.update(range, values),
    clearValues: range => client.values.clear(range),
    access: mutateAccess,
  });

  // The default facet is built from the read powers alone, not attenuated down
  // from the writer, so the grant a guest most often receives is the one whose
  // authority is easiest to check.
  const spreadsheet = makeReader(read);
  const writer = makeWriter(harden({ read, append, write }));

  const control = makeExo(
    'SpreadsheetControl',
    SpreadsheetControlInterface,
    /** @type {any} */ ({
      ...policy.controls,
      revokeWrites: () => {
        mutateAccess.revoke();
      },
      revoke: () => {
        mutateAccess.revoke();
        readAccess.revoke();
      },
      help: () =>
        'SpreadsheetControl: host-only policy and revocation controls.',
    }),
  );

  return /** @type {any} */ (harden({ spreadsheet, writer, control }));
};
harden(makeExoSpreadsheet);
