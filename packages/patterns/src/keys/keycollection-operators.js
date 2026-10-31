// @ts-check
import harden from '@endo/harden';
import {
  assertRankSorted,
  compareAntiRank,
  makeFullOrderComparatorKit,
} from '@endo/marshal';
import { makeIterator } from '@endo/common/make-iterator.js';
import { makeArrayIterator } from '@endo/common/make-array-iterator.js';

/**
 * @import {FullCompare, PartialCompare, RankCompare} from '@endo/marshal'
 * @import {Key, KeyCompare, KeyComparison, KeyCollection} from '../types.js'
 */

import { q, Fail } from '@endo/errors';

/**
 * Refines a sequence of entries that is already sorted over its keys by the
 * `rankCompare` preorder, where there may be internal runs tied for the same
 * rank, into an iterable that resolves those ties using `fullCompare`.
 *
 * @template [V=unknown]
 * @param {Array<[Key, V]>} entries
 * @param {RankCompare} rankCompare
 * @param {FullCompare} fullCompare
 * @returns {IterableIterator<[Key, V]>}
 */
const generateFullSortedEntries = (entries, rankCompare, fullCompare) => {
  assertRankSorted(harden(entries.map(([key]) => key)), rankCompare);
  // Rank ties are not transitive around nested remotables. Fully order the
  // keys together instead of refining independent windows of tied entries.
  const sorted = harden(
    [...entries].sort(([left], [right]) => fullCompare(left, right)),
  );
  for (let i = 1; i < sorted.length; i += 1) {
    const [previous] = sorted[i - 1];
    const [key] = sorted[i];
    Math.sign(fullCompare(previous, key)) ||
      Fail`Duplicate entry key: ${previous}`;
  }
  return makeArrayIterator(sorted);
};
harden(generateFullSortedEntries);

/**
 * Returns an iterator that merges reverse-rank-sorted [key, value] entries of
 * two KeyCollections into a reverse-full-sorted [key, value1, value2] entries
 * by the key they have in common, representing the value for an absent entry in
 * either collection as `absentValue`.
 *
 * @template [C=KeyCollection]
 * @template [V=unknown]
 * @param {C} c1
 * @param {C} c2
 * @param {(collection: C) => Array<[Key, V]>} getEntries
 * @param {any} absentValue
 * @returns {IterableIterator<[Key, V | absentValue, V | absentValue]>}
 */
export const generateCollectionPairEntries = (
  c1,
  c2,
  getEntries,
  absentValue,
) => {
  const e1 = getEntries(c1);
  const e2 = getEntries(c2);

  // Establish a history-dependent comparison scoped to the active invocation
  // and use it to map reverse-preordered entries into an iterator with a
  // narrower total order.
  const fullCompare = makeFullOrderComparatorKit().antiComparator;
  const x = generateFullSortedEntries(e1, compareAntiRank, fullCompare);
  const y = generateFullSortedEntries(e2, compareAntiRank, fullCompare);

  // Maintain a single-result { done, key, value } buffer for each iterator
  // so they can be merged.
  let xDone;
  let xKey;
  let xValue;
  let yDone;
  let yKey;
  let yValue;
  const nonEntry = [undefined, undefined];
  const nextX = () => {
    !xDone || Fail`Internal: nextX must not be called once done`;
    const result = xValue;
    ({ done: xDone, value: [xKey, xValue] = nonEntry } = x.next());
    return result;
  };
  nextX();
  const nextY = () => {
    !yDone || Fail`Internal: nextY must not be called once done`;
    const result = yValue;
    ({ done: yDone, value: [yKey, yValue] = nonEntry } = y.next());
    return result;
  };
  nextY();
  return makeIterator(() => {
    let done = false;
    /** @type {[Key, V | absentValue, V | absentValue]} */
    let value;
    if (xDone && yDone) {
      done = true;
      value = [undefined, absentValue, absentValue];
    } else if (xDone) {
      value = [yKey, absentValue, nextY()];
    } else if (yDone) {
      value = [xKey, nextX(), absentValue];
    } else {
      // Compare the keys to determine if we should return a merged result
      // or a one-sided result.
      const comp = fullCompare(xKey, yKey);
      if (comp === 0) {
        value = [xKey, nextX(), nextY()];
      } else if (comp < 0) {
        value = [xKey, nextX(), absentValue];
      } else if (comp > 0) {
        value = [yKey, absentValue, nextY()];
      } else {
        throw Fail`Unexpected key comparison ${q(comp)} for ${xKey} vs ${yKey}`;
      }
    }
    return harden({ done, value });
  });
};
harden(generateCollectionPairEntries);

/**
 * Returns a function for comparing two KeyCollections of the same type using
 * the provided entries factory and same-key entry value comparator (where the
 * value for an absent entry in one collection is `absentValue`).
 *
 * If the corresponding entries for any single key are incomparable or the
 * comparison result has the opposite sign of the result for a different key,
 * then the KeyCollections are incomparable. Otherwise, the collections compare
 * by the result of any non-equal entry comparison, or compare equal if there is
 * no non-equal entry comparison result.
 * For example, given CopyBags X and Y and a value comparator that goes by count
 * (defaulting absent keys to a count of 0), X is smaller than Y (`result < 0`)
 * iff there are no keys in X that are either absent from Y
 * (`compareValues(xCount, absentValue) > 0`) or present in Y with a lower count
 * (`compareValues(xCount, yCount) > 0`) AND there is at least one key in Y that
 * is either absent from X (`compareValues(absentValue, yCount) < 0`) or present
 * with a lower count (`compareValues(xCount, yCount) < 0`).
 *
 * This can be generalized to virtual collections in the future by replacing
 * `getEntries => Array` with `generateEntries => IterableIterator`.
 *
 * @template [C=KeyCollection]
 * @template [V=unknown]
 * @param {(collection: C) => Array<[Key, V]>} getEntries
 * @param {V} absentValue
 * @param {PartialCompare<V>} compareValues
 * @returns {(left: C, right: C) => KeyComparison}
 */
export const makeCompareCollection = (getEntries, absentValue, compareValues) =>
  harden((left, right) => {
    const merged = generateCollectionPairEntries(
      left,
      right,
      getEntries,
      absentValue,
    );
    let leftIsBigger = false;
    let rightIsBigger = false;
    for (const [_key, leftValue, rightValue] of merged) {
      const comp = compareValues(leftValue, rightValue);
      if (comp === 0) {
        // eslint-disable-next-line no-continue
        continue;
      } else if (comp < 0) {
        // Based on this key, left < right.
        rightIsBigger = true;
      } else if (comp > 0) {
        // Based on this key, left > right.
        leftIsBigger = true;
      } else {
        Number.isNaN(comp) ||
          // prettier-ignore
          Fail`Unexpected value comparison ${q(comp)} for ${leftValue} vs ${rightValue}`;
        return NaN;
      }
      if (leftIsBigger && rightIsBigger) {
        return NaN;
      }
    }
    // eslint-disable-next-line no-nested-ternary
    return leftIsBigger ? 1 : rightIsBigger ? -1 : 0;
  });
harden(makeCompareCollection);
