// @ts-check

import { Fail, q } from '@endo/errors';
import { assertPattern, matches, mustMatch } from '@endo/patterns';

import { AdmissionRefusalShape, ClassifiedResultShape } from './guards.js';

/** @import { AdmissionRefusal, ClassifiedResult, InferResult, ShapeClassifier, ShapeTable, ShapeTableEntry } from './types.js' */

const RETRY_LATER_TYPES = harden([
  'rate-limited',
  'usage-exhausted',
  'budget-exhausted',
]);

/**
 * @param {string} version
 * @param {ShapeTableEntry} entry
 */
const assertShapeTableEntry = (version, entry) => {
  const { pattern, result, retryAfterMs } = entry;
  assertPattern(pattern);
  mustMatch(result, ClassifiedResultShape, `table entry for ${version}`);
  if (retryAfterMs !== undefined) {
    typeof retryAfterMs === 'function' ||
      Fail`retryAfterMs for ${q(version)} must be a function`;
    RETRY_LATER_TYPES.includes(result.type) ||
      Fail`retryAfterMs is meaningless for a ${q(result.type)} entry`;
  }
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
 * table is checked for that at construction.
 *
 * @param {ShapeTable} table
 * @returns {ShapeClassifier}
 */
export const makeShapeClassifier = table => {
  /** @type {Map<string, readonly ShapeTableEntry[]>} */
  const rows = new Map();
  for (const [version, entries] of Object.entries(table)) {
    for (const entry of entries) {
      assertShapeTableEntry(version, entry);
    }
    rows.set(version, harden([...entries]));
  }
  const versions = harden([...rows.keys()]);

  /**
   * Hardens `response`, because matching a pattern requires a passable
   * specimen. A response that cannot be passed does not classify.
   *
   * @param {string | undefined} version
   * @param {unknown} response
   * @returns {ClassifiedResult | undefined}
   */
  const classify = (version, response) => {
    if (version === undefined) return undefined;
    const entries = rows.get(version);
    if (entries === undefined) return undefined;
    harden(response);
    for (const { pattern, result, retryAfterMs } of entries) {
      let matched;
      try {
        matched = matches(response, pattern);
      } catch {
        return undefined;
      }
      if (matched) {
        const delay = retryAfterMs?.(response);
        if (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
          return /** @type {ClassifiedResult} */ (
            harden({ ...result, retryAfterMs: delay })
          );
        }
        return result;
      }
    }
    return undefined;
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
