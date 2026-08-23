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
 *
 * Like `facets.js`, this module reaches for no global.  The two temporal
 * authorities it needs — a clock to refill the token bucket, a timer to wait
 * out a poll interval — arrive as parameters, so `exo-google-sheets.js` is
 * the only module in the package that touches ambient authority at all.
 *
 * **Why this is a module of its own, rather than the top of `facets.js`.**  The
 * split is what makes `facets.js` cheap to audit: grep it for `client`,
 * `access`, `revoke`, or any allowlist and you find nothing but prose.  A facet
 * maker cannot reach the client, cannot charge the throttle, and cannot consult
 * or edit a policy, because none of those are in its scope — so "`makeReader`
 * cannot write" is settled by its parameter list, without reading a method
 * body.  Fold the two together and the claim weakens to "no method here happens
 * to call the client", which is a property of the current bodies and has to be
 * re-established on every edit.
 *
 * Two more things fall out of the split rather than being arranged:
 *
 * - `writer.readOnly()` hands back a reader over the *same* read power object
 *   the writer's own read methods use — subset by identity, not by rebuilding a
 *   reader from the raw operations and hoping the rebuild stayed narrower.
 * - The power objects carry `narrow`, `designate`, and `unscoped`, which the
 *   facets need but no guest may call.  Kept here they are ordinary locals;
 *   moved into the exos they would be methods, and every one would have to be
 *   deliberately withheld from the interface guard.
 */

import harden from '@endo/harden';

import { contains, parseA1, sheetPrefix } from './a1.js';

/**
 * @import { Scope } from './a1.js'
 */

const DEFAULT_MAX_CELLS_PER_READ = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;

const { apply } = Reflect;
const { filter, map, reduce } = Array.prototype;
/**
 * @template T
 * @param {T[]} array
 * @param {(value: T) => boolean} callback
 * @returns {T[]}
 */
const arrayFilter = (array, callback) => apply(filter, array, [callback]);
/**
 * @template T,U
 * @param {T[]} array
 * @param {(value: T) => U} callback
 * @returns {U[]}
 */
const arrayMap = (array, callback) => apply(map, array, [callback]);
/**
 * @template T,U
 * @param {T[]} array
 * @param {(total: U, value: T) => U} callback
 * @param {U} initial
 * @returns {U}
 */
const arrayReduce = (array, callback, initial) =>
  apply(reduce, array, [callback, initial]);

/**
 * Intersect a power's current designation with a further narrowing. A second
 * `part()`/`sheet()`/`range()` call may refine either axis, but must never
 * replace an axis with a wider or different designation.
 *
 * @param {Scope} scope
 * @param {Scope} patch
 * @returns {Scope}
 */
const narrowScope = (scope, patch) => {
  if (patch.sheet !== undefined && patch.sheet.length === 0)
    throw new Error('Sheet must be non-empty');
  const scopeRange = scope.range ? parseA1(scope.range) : undefined;
  const patchRange = patch.range ? parseA1(patch.range) : undefined;
  if (scope.range && !scopeRange) throw new Error('Invalid range scope');
  if (patch.range && !patchRange) throw new Error('Invalid narrower range');

  const scopeSheet = scope.sheet || (scopeRange && scopeRange.sheet);
  const patchSheet = patch.sheet || (patchRange && patchRange.sheet);
  if (patchRange && !scopeSheet && !patchSheet)
    throw new Error('A range scope requires a sheet');
  if (scopeSheet && patchSheet && scopeSheet !== patchSheet)
    throw new Error('Part escapes the sheet scope');
  if (
    scopeRange &&
    patchRange &&
    !contains(scopeRange, { ...patchRange, sheet: undefined })
  ) {
    throw new Error('Part escapes the range scope');
  }

  const sheet = scopeSheet || patchSheet;
  return harden({
    ...scope,
    ...patch,
    ...(sheet ? { sheet } : {}),
  });
};
harden(narrowScope);

/**
 * The host-retained policy: the allowlists and the caps, plus the token bucket
 * that bounds request rate.  It holds no spreadsheet authority itself — it can
 * only say yes or no to a designation and account for a request — so handing
 * `limits` to a reader is not a way to smuggle write authority back in, and
 * `controls` (which can *widen* the allowlists) is kept off that path.
 *
 * The token bucket needs to know how much time has passed, so the clock is a
 * required parameter rather than an ambient `Date.now`.  It stays inside the
 * closure — no power and no facet is handed the clock — and a host with a
 * taming, or a test with a fake clock, supplies its own.
 *
 * @param {object} options
 * @param {() => number} options.now A monotonic-enough clock in milliseconds.
 * @param {number} [options.maxRequestsPerMinute]
 * @param {number} [options.maxCellsPerRead]
 * @param {number} [options.pollIntervalMs]
 */
export const makePolicy = options => {
  const { now } = options;
  if (typeof now !== 'function')
    throw new TypeError('A clock is required to bound request rate');
  /** @type {Set<string> | null} */
  let allowedSheets = null;
  /** @type {string[] | null} */
  let allowedRanges = null;
  let maxCellsPerRead = options.maxCellsPerRead ?? DEFAULT_MAX_CELLS_PER_READ;
  let pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let maxRequestsPerMinute =
    options.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
  if (!Number.isSafeInteger(maxCellsPerRead) || maxCellsPerRead < 1)
    throw new TypeError('max cells must be positive');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0)
    throw new TypeError('poll interval must be non-negative');
  if (!Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1)
    throw new TypeError('request limit must be positive');
  let tokens = maxRequestsPerMinute;
  let lastRefill = now();

  const charge = () => {
    const instant = now();
    tokens = Math.min(
      maxRequestsPerMinute,
      tokens + ((instant - lastRefill) * maxRequestsPerMinute) / 60_000,
    );
    lastRefill = instant;
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
    if (scope.range && !scopeRange) throw new Error('Invalid range scope');
    if (scopeRange && !parsed)
      throw new Error('Range cannot be confined to the range scope');
    const scopeSheet = scope.sheet || (scopeRange && scopeRange.sheet);
    const sheet = parsed && parsed.sheet ? parsed.sheet : scopeSheet;
    if (scopeSheet && sheet && sheet !== scopeSheet)
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
        ? !parsed && selector === sheet
          ? selector
          : `${sheetPrefix(sheet)}!${selector}`
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
    /**
     * Reject a bounded read whose requested rectangle already exceeds the cap.
     * @param {string} selector
     */
    boundRange: selector => {
      const range = parseA1(selector);
      if (range) {
        const rows = range.bottom - range.top + 1;
        const columns = range.right - range.left + 1;
        if (rows > maxCellsPerRead / columns)
          throw new Error('Read exceeds maximum cell count');
      }
      return selector;
    },
    /** @param {any[][]} values */
    boundCells: values => {
      const count = arrayReduce(
        values,
        (total, row) => total + row.length,
        0,
      );
      if (count > maxCellsPerRead)
        throw new Error('Read exceeds maximum cell count');
      return harden(arrayMap(values, row => harden([...row])));
    },
    pollIntervalMs: () => pollIntervalMs,
    /**
     * Keep metadata within both the facet's sheet designation and the host's
     * current sheet allowlist.
     *
     * @param {any[]} sheets
     * @param {Scope} scope
     */
    boundSheets: (sheets, scope) => {
      const scopeRange = scope.range ? parseA1(scope.range) : undefined;
      const scopeSheet = scope.sheet || (scopeRange && scopeRange.sheet);
      return harden(
        arrayFilter(sheets, ({ properties }) => {
          const title = properties && properties.title;
          return (
            (!scopeSheet || title === scopeSheet) &&
            (!allowedSheets || allowedSheets.has(title))
          );
        }),
      );
    },
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
  const assertActive = () => {
    if (revoked) throw new Error('Spreadsheet capability has been revoked');
  };
  const enter = () => {
    assertActive();
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
      assertActive();
      const confined = policy.confine(selector, scope);
      policy.charge();
      return confined;
    },
    revoke: () => {
      revoked = true;
    },
  });
};
harden(makeCaretaker);

/**
 * Powers to read a designated part of a spreadsheet, and nothing else.  The
 * parameters are the whole authority: two getters, a caretaker, the caps, and
 * a timer.  No overwrite, append, or clear operation is in scope, so no reader
 * built over these powers can perform one.
 *
 * `delay` is the scheduling authority `follow()` polls on.  It is granted the
 * same way the getters are — a host that omits it hands out a reader that can
 * read but cannot wait, and so cannot poll.  How *long* each wait is stays
 * with the policy rather than the timer, so `control.setPollIntervalMs()`
 * still takes effect on the next poll of a follow already in flight.
 *
 * @param {object} authority
 * @param {(range: string) => Promise<any>} authority.getValues
 * @param {(options: object) => Promise<any>} authority.getSpreadsheet
 * @param {ReturnType<typeof makeCaretaker>} authority.access
 * @param {ReturnType<typeof makePolicy>['limits']} authority.limits
 * @param {(ms: number) => Promise<void>} [authority.delay]
 */
export const makeReadPowers = ({
  getValues,
  getSpreadsheet,
  access,
  limits,
  delay,
}) => {
  /** @param {Scope} scope */
  const at = scope =>
    harden({
      /** @param {Scope} patch */
      narrow: patch => at(narrowScope(scope, patch)),
      /** The powers as first minted, for a selector already fully qualified. */
      unscoped: () => root,
      /** @param {string} selector */
      designate: selector => access.admit(selector, scope),
      /** @param {object} fields */
      describe: async fields => {
        access.enter();
        const result = await getSpreadsheet(fields);
        return harden({
          ...result,
          sheets: result.sheets
            ? limits.boundSheets(result.sheets, scope)
            : result.sheets,
        });
      },
      /** @param {string} selector */
      read: async selector => {
        const target = limits.boundRange(access.admit(selector, scope));
        const result = await getValues(target);
        return limits.boundCells(result.values || []);
      },
      /** Wait one poll interval, as the host currently sets it. */
      pollDelay: () => {
        if (typeof delay !== 'function')
          throw new Error('Spreadsheet was granted no timer to poll on');
        return delay(limits.pollIntervalMs());
      },
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
      narrow: patch => at(narrowScope(scope, patch)),
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
      narrow: patch => at(narrowScope(scope, patch)),
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
