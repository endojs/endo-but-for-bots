// @ts-check

import { Fail, q } from '@endo/errors';
import { assertPattern, matches, mustMatch } from '@endo/patterns';

import {
  AdmissionRefusalShape,
  ClassifiedResultShape,
  RETRY_LATER_TYPES,
} from './guards.js';

/** @import { AdmissionRefusal, ClassifiedResult, InferResult, ShapeClassifier, ShapeTable, ShapeTableEntry } from './types.js' */

/**
 * Reads each field of a caller-supplied entry exactly once into a fresh
 * hardened data record, checks that copy, and returns it, so an accessor
 * cannot answer the check with one value and a later lookup with another.
 *
 * @param {string} version
 * @param {ShapeTableEntry} entry
 * @returns {ShapeTableEntry}
 */
const snapshotShapeTableEntry = (version, entry) => {
  const { pattern, result, retryAfterMs } = entry;
  const copy = harden(
    retryAfterMs === undefined
      ? { pattern, result }
      : { pattern, result, retryAfterMs },
  );
  assertPattern(pattern);
  mustMatch(result, ClassifiedResultShape, `table entry for ${version}`);
  if (retryAfterMs !== undefined) {
    typeof retryAfterMs === 'function' ||
      Fail`retryAfterMs for ${q(version)} must be a function`;
    /** @type {readonly string[]} */ (RETRY_LATER_TYPES).includes(
      result.type,
    ) || Fail`retryAfterMs is meaningless for a ${q(result.type)} entry`;
  }
  return copy;
};

/**
 * Makes the pinned-table classifier a provider plugin calls while the raw
 * provider response is still in hand. Each row was captured against one
 * exact provider version. A response classifies only through a row pinned to
 * the version the plugin is running; an unknown version or an unrecognized
 * response classifies as `undefined`, which the plugin reports as
 * `unavailable`, so a provider upgrade that changes its error wire can never
 * produce a false `needs-auth`.
 *
 * The classifier writes every tag except `ok` and `needs-containment`; the
 * table is checked for that at construction. The constructor iterates each
 * row once and keeps only the hardened data copies it checked, never the
 * caller's own row or entry objects.
 *
 * @param {ShapeTable} table
 * @returns {ShapeClassifier}
 */
export const makeShapeClassifier = table => {
  /** @type {Map<string, readonly ShapeTableEntry[]>} */
  const rows = new Map();
  for (const [version, entries] of Object.entries(table)) {
    rows.set(
      version,
      harden(
        Array.from(entries, entry => snapshotShapeTableEntry(version, entry)),
      ),
    );
  }
  const versions = harden([...rows.keys()]);

  /**
   * Hardens `response`, because matching a pattern requires a passable
   * specimen. A response that cannot be hardened or passed does not
   * classify. A refill reader that throws on a matched response leaves the
   * row's result without a refill time, as a reader returning a nonsensical
   * time does.
   *
   * @param {string | undefined} version
   * @param {unknown} response
   * @returns {ClassifiedResult | undefined}
   */
  const classify = (version, response) => {
    if (version === undefined) return undefined;
    const entries = rows.get(version);
    if (entries === undefined) return undefined;
    let row;
    try {
      harden(response);
      row = entries.find(({ pattern }) => matches(response, pattern));
    } catch {
      // A provider response is untrusted: whatever makes hardening or
      // matching it throw is an unrecognized response, never a classifier
      // failure.
      return undefined;
    }
    if (row === undefined) return undefined;
    const { result, retryAfterMs } = row;
    let delay;
    try {
      delay = retryAfterMs?.(response);
    } catch {
      return result;
    }
    if (
      typeof delay === 'number' &&
      delay >= 0 &&
      delay <= Number.MAX_SAFE_INTEGER
    ) {
      return /** @type {ClassifiedResult} */ (
        harden({ ...result, retryAfterMs: delay })
      );
    }
    return result;
  };

  return harden({ versions: () => versions, classify });
};
harden(makeShapeClassifier);

/**
 * Maps a credential source's admission refusal to the top-level tag of the
 * same name, carrying its `retryAfterMs`. The plugin calls this when
 * `acquire()` refuses, before any provider process starts.
 *
 * @param {AdmissionRefusal} refusal
 * @returns {InferResult}
 */
export const admissionRefusalResult = refusal => {
  mustMatch(harden(refusal), AdmissionRefusalShape, 'admission refusal');
  const { reason, retryAfterMs } = refusal;
  return harden(
    retryAfterMs === undefined
      ? { type: reason }
      : { type: reason, retryAfterMs },
  );
};
harden(admissionRefusalResult);
