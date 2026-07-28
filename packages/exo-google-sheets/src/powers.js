// @ts-check

/**
 * The attenuation boundary.
 *
 * A Sheets client is broad authority: a holder can read, overwrite, and erase
 * every cell of the spreadsheet.  This module is where that one authority is
 * split into the three narrower authority classes the facets are built from —
 * read, append, and overwrite — each reified as its own object over its own
 * subset of the client's operations.
 *
 * Two properties are load-bearing, and both are structural rather than
 * conditional:
 *
 * - Each maker below takes *only* the client operations its class needs, so a
 *   reader's scope contains no function that can change a cell.  There is no
 *   flag to consult and none to get wrong; code that cannot write is code that
 *   was never handed a writer.
 * - Narrowing (`narrow`) returns a *new* power object bound to a smaller
 *   designation, in the shape of `pathlib`'s `/` or pola-io's `join`.  A
 *   narrowed power is not a wider one wearing a smaller label.
 *
 * The host's policy — allowed tabs and ranges, the size and rate caps — is
 * enforced here, at the single place authority crosses out to a facet, so no
 * facet method can reach the client without passing it.
 */

import harden from '@endo/harden';

import { contains, parseA1, sheetPrefix } from './a1.js';

/**
 * @typedef {object} Scope
 * @property {string} [sheet] Tab this power is confined to, if any.
 * @property {string} [range] A1 rectangle this power is confined to, if any.
 */

/**
 * Read one part designation as the scope narrowing it names.  This is the
 * mereological verb: a tab is a part of the spreadsheet, a rectangle is a part
 * of a tab, and `'Tasks!A1:C10'` names both in one step.  Which axis a
 * designation narrows is decided by whether it parses as A1 — so the parse,
 * not a second method name, carries the distinction.
 *
 * The one designation this cannot read is a tab whose *title* is A1-shaped (a
 * tab literally named `A1`); `sheet(title)` remains for that case, and no
 * corresponding hazard runs the other way, since a string that parses as A1
 * always denotes cells.
 *
 * @param {string} designation
 * @returns {Scope}
 */
export const partScope = designation => {
  if (typeof designation !== 'string' || designation.length === 0)
    throw new TypeError('part must be a non-empty tab name or A1 range');
  const parsed = parseA1(designation);
  if (!parsed) return harden({ sheet: designation });
  return parsed.sheet
    ? harden({ sheet: parsed.sheet, range: designation })
    : harden({ range: designation });
};
harden(partScope);

const DEFAULT_MAX_CELLS_PER_READ = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

/**
 * The host-retained policy: the allowlists and the caps, plus the token bucket
 * that bounds request rate.  It holds no spreadsheet authority itself — it can
 * only say yes or no to a designation and account for a request — so handing
 * `limits` to a reader is not a way to smuggle write authority back in, and
 * `controls` (which can *widen* the allowlists) is kept off that path.
 *
 * @param {{ maxRequestsPerMinute?: number, maxCellsPerRead?: number, pollIntervalMs?: number }} [options]
 */
export const makePolicy = (options = {}) => {
  /** @type {Set<string> | null} */
  let allowedSheets = null;
  /** @type {string[] | null} */
  let allowedRanges = null;
  let maxCellsPerRead = options.maxCellsPerRead || DEFAULT_MAX_CELLS_PER_READ;
  let pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  let maxRequestsPerMinute =
    options.maxRequestsPerMinute || DEFAULT_MAX_REQUESTS_PER_MINUTE;
  let tokens = maxRequestsPerMinute;
  let lastRefill = Date.now();

  const charge = () => {
    const now = Date.now();
    tokens = Math.min(
      maxRequestsPerMinute,
      tokens + ((now - lastRefill) * maxRequestsPerMinute) / 60_000,
    );
    lastRefill = now;
    if (tokens < 1) throw new Error('Spreadsheet request throttle exceeded');
    tokens -= 1;
  };

  /**
   * Resolve a caller's selector against the power's designation and the host
   * allowlists, yielding the fully qualified range to hand the client.
   *
   * @param {string} selector
   * @param {Scope} scope
   * @returns {string}
   */
  const confine = (selector, scope) => {
    if (typeof selector !== 'string' || selector.length === 0)
      throw new TypeError('range must be a non-empty A1 string');
    const parsed = parseA1(selector);
    const scopeRange = scope.range ? parseA1(scope.range) : undefined;
    const sheet =
      parsed && parsed.sheet
        ? parsed.sheet
        : scope.sheet || (scopeRange && scopeRange.sheet);
    if (scope.sheet && sheet && sheet !== scope.sheet)
      throw new Error('Range escapes the sheet scope');
    if (allowedSheets && (!sheet || !allowedSheets.has(sheet)))
      throw new Error('Sheet is not allowed');
    if (
      scopeRange &&
      parsed &&
      !contains(scopeRange, { ...parsed, sheet: undefined })
    )
      throw new Error('Range escapes the range scope');
    const full =
      sheet && !(parsed && parsed.sheet)
        ? `${sheetPrefix(sheet)}!${selector}`
        : selector;
    if (
      allowedRanges &&
      !allowedRanges.some(range => {
        const allowed = parseA1(range);
        const candidate = parseA1(full);
        return (
          allowed &&
          candidate &&
          allowed.sheet === candidate.sheet &&
          contains(allowed, candidate)
        );
      })
    )
      throw new Error('Range is not allowed');
    return full;
  };

  /** The read-side view: caps a reader must respect, nothing it can relax. */
  const limits = harden({
    /** @param {any[][]} values */
    boundCells: values => {
      const count = values.reduce((total, row) => total + row.length, 0);
      if (count > maxCellsPerRead)
        throw new Error('Read exceeds maximum cell count');
      return harden(values.map(row => harden([...row])));
    },
    pollIntervalMs: () => pollIntervalMs,
  });

  /** The host-side view: the knobs `SpreadsheetControl` turns. */
  const controls = harden({
    /** @param {string[] | null} titles */
    setAllowedSheets: titles => {
      allowedSheets = titles === null ? null : new Set(titles);
    },
    /** @param {string[] | null} ranges */
    setAllowedRanges: ranges => {
      allowedRanges = ranges === null ? null : [...ranges];
    },
    /** @param {number} value */
    setMaxCellsPerRead: value => {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError('max cells must be positive');
      maxCellsPerRead = value;
    },
    /** @param {number} value */
    setPollIntervalMs: value => {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('poll interval must be non-negative');
      pollIntervalMs = value;
    },
    /** @param {number} value */
    setMaxRequestsPerMinute: value => {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError('request limit must be positive');
      maxRequestsPerMinute = value;
      tokens = Math.min(tokens, value);
    },
  });

  return harden({ charge, confine, limits, controls });
};
harden(makePolicy);

/**
 * A caretaker — Stiegler's revocable forwarder — over one authority class.
 * Every path from a facet to the client runs through `enter` or `admit`, so
 * revocation is one assignment in one place rather than a condition each
 * method has to remember, and it is one-way: nothing here can un-revoke.
 *
 * @param {ReturnType<typeof makePolicy>} policy
 */
export const makeCaretaker = policy => {
  let revoked = false;
  const enter = () => {
    if (revoked) throw new Error('Spreadsheet capability has been revoked');
    policy.charge();
  };
  return harden({
    /** Admit a request that names no range, such as reading the title. */
    enter,
    /**
     * Admit a request for `selector` from a power designated by `scope`.
     *
     * @param {string} selector
     * @param {Scope} scope
     */
    admit: (selector, scope) => {
      enter();
      return policy.confine(selector, scope);
    },
    revoke: () => {
      revoked = true;
    },
  });
};
harden(makeCaretaker);

/**
 * Powers to read a designated part of a spreadsheet, and nothing else.  The
 * parameters are the whole authority: two getters, a caretaker, and the caps.
 * No overwrite, append, or clear operation is in scope, so no reader built
 * over these powers can perform one.
 *
 * @param {object} authority
 * @param {(range: string) => Promise<any>} authority.getValues
 * @param {(options: object) => Promise<any>} authority.getSpreadsheet
 * @param {ReturnType<typeof makeCaretaker>} authority.access
 * @param {ReturnType<typeof makePolicy>['limits']} authority.limits
 */
export const makeReadPowers = ({
  getValues,
  getSpreadsheet,
  access,
  limits,
}) => {
  /** @param {Scope} scope */
  const at = scope =>
    harden({
      /** @param {Scope} patch */
      narrow: patch => at({ ...scope, ...patch }),
      /** The powers as first minted, for a selector already fully qualified. */
      unscoped: () => root,
      /** @param {string} selector */
      designate: selector => access.admit(selector, scope),
      /** @param {object} fields */
      describe: fields => {
        access.enter();
        return getSpreadsheet(fields);
      },
      /** @param {string} selector */
      read: async selector => {
        const result = await getValues(access.admit(selector, scope));
        return limits.boundCells(result.values || []);
      },
      pollIntervalMs: () => limits.pollIntervalMs(),
    });
  const root = at({});
  return root;
};
harden(makeReadPowers);

/**
 * Powers to append rows to a designated part of a spreadsheet.  Append is its
 * own class because it can add without disclosing or destroying what is
 * already there — a log a guest may write to but not audit or erase.
 *
 * @param {object} authority
 * @param {(range: string, rows: any[][]) => Promise<any>} authority.appendValues
 * @param {ReturnType<typeof makeCaretaker>} authority.access
 */
export const makeAppendPowers = ({ appendValues, access }) => {
  /** @param {Scope} scope */
  const at = scope =>
    harden({
      /** @param {Scope} patch */
      narrow: patch => at({ ...scope, ...patch }),
      /**
       * @param {string} selector
       * @param {any[][]} rows
       */
      append: async (selector, rows) => {
        const result = await appendValues(access.admit(selector, scope), rows);
        return harden({
          updatedRange: result.updates.updatedRange,
          appendedRows: result.updates.updatedRows,
        });
      },
    });
  return at({});
};
harden(makeAppendPowers);

/**
 * Powers to overwrite and erase a designated part of a spreadsheet.  There is
 * no getter in scope, so a facet built over these powers alone cannot read
 * back what it wrote or learn what it erased.
 *
 * @param {object} authority
 * @param {(range: string, values: any[][]) => Promise<any>} authority.updateValues
 * @param {(range: string) => Promise<any>} authority.clearValues
 * @param {ReturnType<typeof makeCaretaker>} authority.access
 */
export const makeWritePowers = ({ updateValues, clearValues, access }) => {
  /** @param {Scope} scope */
  const at = scope =>
    harden({
      /** @param {Scope} patch */
      narrow: patch => at({ ...scope, ...patch }),
      /**
       * @param {string} selector
       * @param {any[][]} values
       */
      update: async (selector, values) => {
        const result = await updateValues(
          access.admit(selector, scope),
          values,
        );
        return harden({
          updatedRange: result.updatedRange,
          updatedCells: result.updatedCells,
        });
      },
      /** @param {string} selector */
      clear: async selector => {
        await clearValues(access.admit(selector, scope));
      },
    });
  return at({});
};
harden(makeWritePowers);
