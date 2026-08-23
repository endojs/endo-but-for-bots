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
 *
 * The same rule governs the two temporal authorities, which is why they are
 * named here and nowhere else: a clock for the token bucket and a timer for
 * `follow()`'s polling.  Both default to the host's globals, because this is
 * the module already entitled to a live network client and so already the
 * unconfined one; a caller that has tamed or wants to fake either passes it in
 * (`{ now, setTimeout }`), and no module below can reach past what it is given.
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

/** @import { SheetsClient } from '@endo/google-sheets' */
/**
 * @typedef {object} ExoSheetsClient
 * @property {Pick<SheetsClient['values'], 'get' | 'batchGet' | 'update' | 'batchUpdate' | 'append' | 'clear'>} values
 * @property {Pick<SheetsClient['spreadsheets'], 'get'>} spreadsheets
 */

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
 * @param {ExoSheetsClient} client The used subset of an
 *   `@endo/google-sheets` client.
 * @param {object} [options]
 * @param {number} [options.maxRequestsPerMinute]
 * @param {number} [options.maxCellsPerRead]
 * @param {number} [options.maxCellsPerWrite]
 * @param {number} [options.pollIntervalMs]
 * @param {() => number} [options.now] Clock for the request throttle.
 * @param {((callback: () => void, ms: number) => unknown) | null} [options.setTimeout]
 *   Timer `follow()` polls on; `null` grants none, leaving reads working and
 *   polling unavailable.
 */
export const makeExoSpreadsheet = (client, options = {}) => {
  if (!client || !client.values || !client.spreadsheets)
    throw new TypeError('A Sheets client is required');

  const {
    now = () => Date.now(),
    setTimeout = globalThis.setTimeout,
    ...limitOptions
  } = options;
  const policy = makePolicy({ ...limitOptions, now });

  // The delay is minted here, from the timer, so `powers.js` and `facets.js`
  // receive the authority to wait rather than the means to schedule.  A host
  // whose platform has no timer still gets working reads; only `follow()`
  // fails, and it says why.
  const delay =
    typeof setTimeout === 'function'
      ? /** @param {number} ms */
        ms => new Promise(resolve => setTimeout(() => resolve(undefined), ms))
      : undefined;

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
    batchGetValues: ranges => client.values.batchGet(ranges),
    getSpreadsheet: fields => client.spreadsheets.get(fields),
    access: readAccess,
    limits: policy.limits,
    delay,
  });
  const append = makeAppendPowers({
    appendValues: (range, rows) => client.values.append(range, rows),
    access: mutateAccess,
    limits: policy.limits,
  });
  const write = makeWritePowers({
    updateValues: (range, values) => client.values.update(range, values),
    batchUpdateValues: updates => client.values.batchUpdate(updates),
    clearValues: range => client.values.clear(range),
    access: mutateAccess,
    limits: policy.limits,
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
