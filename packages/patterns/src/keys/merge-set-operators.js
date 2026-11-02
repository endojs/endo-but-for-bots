import harden from '@endo/harden';
import {
  assertRankSorted,
  compareAntiRank,
  makeFullOrderComparatorKit,
  sortByRank,
} from '@endo/marshal';
import { q, Fail } from '@endo/errors';
import { assertNoDuplicates, makeSetOfElements } from './copySet.js';

/**
 * @import {Passable} from '@endo/pass-style';
 * @import {FullCompare, RankCompare} from '@endo/marshal'
 * @import {KeyComparison} from '../types.js'
 */

// TODO share more code with keycollection-operators.js.

/**
 * Refine rank-sorted elements into this merge's full order.
 * Rank ties can overlap: [a] ties with [b], and [b] with [a, 0], while
 * [a] and [a, 0] compare by length. Partitioning by ties to one key can
 * therefore leave elements out of full order across adjacent windows.
 *
 * @template {Passable} T
 * @param {T[]} elements
 * @param {RankCompare} rankCompare
 * @param {FullCompare} fullCompare
 * @returns {T[]}
 */
const fullSort = (elements, rankCompare, fullCompare) => {
  assertRankSorted(elements, rankCompare);
  const sorted = sortByRank(elements, fullCompare);
  assertNoDuplicates(sorted, fullCompare);
  return sorted;
};

/**
 * Returns an iterable whose iteration results are [key, xCount, yCount] tuples
 * representing the next key in the local full order, as well as how many
 * times it occurred in the x input iterator and the y input iterator.
 *
 * For sets, these counts are always 0 or 1, but this representation
 * generalizes nicely for bags.
 *
 * @template {Passable} T
 * @param {T[]} xelements
 * @param {T[]} yelements
 * @returns {Iterable<[T,bigint,bigint]>}
 */
const merge = (xelements, yelements) => {
  // This fullOrder contains history dependent state. It is specific
  // to this one `merge` call and does not survive it.
  const fullCompare = makeFullOrderComparatorKit().antiComparator;

  const xs = fullSort(xelements, compareAntiRank, fullCompare);
  const ys = fullSort(yelements, compareAntiRank, fullCompare);
  return harden({
    [Symbol.iterator]: () => {
      // These four `let` variables are buffering one ahead from the underlying
      // iterators. Each iteration reports one or the other or both, and
      // then refills the buffers of those it advanced.
      /** @type {T} */
      let x;
      let xDone;
      /** @type {T} */
      let y;
      let yDone;

      const xi = xs[Symbol.iterator]();
      const nextX = () => {
        !xDone || Fail`Internal: nextX should not be called once done`;
        const result = xi.next();
        xDone = result.done;
        if (!result.done) x = result.value;
      };
      nextX();

      const yi = ys[Symbol.iterator]();
      const nextY = () => {
        !yDone || Fail`Internal: nextY should not be called once done`;
        const result = yi.next();
        yDone = result.done;
        if (!result.done) y = result.value;
      };
      nextY();

      return harden({
        next: () => {
          /** @type {boolean} */
          let done = false;
          /** @type {[T,bigint,bigint]} */
          let value;
          if (xDone && yDone) {
            done = true;
            // @ts-expect-error Because the terminating value does not matter
            value = [null, 0n, 0n];
          } else if (xDone) {
            // only ys are left
            value = [y, 0n, 1n];
            nextY();
          } else if (yDone) {
            // only xs are left
            value = [x, 1n, 0n];
            nextX();
          } else {
            const comp = fullCompare(x, y);
            if (comp === 0) {
              // x and y are equivalent, so report both
              value = [x, 1n, 1n];
              nextX();
              nextY();
            } else if (comp < 0) {
              // x is earlier, so report it
              value = [x, 1n, 0n];
              nextX();
            } else {
              // y is earlier, so report it
              comp > 0 || Fail`Internal: Unexpected comp ${q(comp)}`;
              value = [y, 0n, 1n];
              nextY();
            }
          }
          return harden({ done, value });
        },
      });
    },
  });
};
harden(merge);

const iterIsSuperset = xyi => {
  for (const [_m, xc, _yc] of xyi) {
    if (xc === 0n) {
      // something in y is not in x, so x is not a superset of y
      return false;
    }
  }
  return true;
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {boolean}
 */
const iterIsDisjoint = xyi => {
  for (const [_m, xc, yc] of xyi) {
    if (xc >= 1n && yc >= 1n) {
      // Something in both, so not disjoint
      return false;
    }
  }
  return true;
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {KeyComparison}
 */
const iterCompare = xyi => {
  let loneY = false;
  let loneX = false;
  for (const [_m, xc, yc] of xyi) {
    if (xc === 0n) {
      // something in y is not in x, so x is not a superset of y
      loneY = true;
    }
    if (yc === 0n) {
      // something in x is not in y, so y is not a superset of x
      loneX = true;
    }
    if (loneX && loneY) {
      return NaN;
    }
  }
  if (loneX) {
    return 1;
  } else if (loneY) {
    return -1;
  } else {
    (!loneX && !loneY) ||
      Fail`Internal: Unexpected lone pair ${q([loneX, loneY])}`;
    return 0;
  }
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {T[]}
 */
const iterUnion = xyi => {
  const result = [];
  for (const [m, xc, yc] of xyi) {
    if (xc >= 0n) {
      result.push(m);
    } else {
      yc >= 0n || Fail`Internal: Unexpected count ${q(yc)}`;
      // if x and y were both ready, then they were equivalent and
      // above clause already took care of it. Otherwise push here.
      result.push(m);
    }
  }
  return result;
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {T[]}
 */
const iterDisjointUnion = xyi => {
  const result = [];
  for (const [m, xc, yc] of xyi) {
    xc === 0n || yc === 0n || Fail`Sets must not have common elements: ${m}`;
    if (xc >= 1n) {
      result.push(m);
    } else {
      yc >= 1n || Fail`Internal: Unexpected count ${q(yc)}`;
      result.push(m);
    }
  }
  return result;
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {T[]}
 */
const iterIntersection = xyi => {
  const result = [];
  for (const [m, xc, yc] of xyi) {
    if (xc >= 1n && yc >= 1n) {
      // If they are both present, then they were equivalent
      result.push(m);
    }
  }
  return result;
};

/**
 * @template T
 * @param {Iterable<[T,bigint,bigint]>} xyi
 * @returns {T[]}
 */
const iterDisjointSubtract = xyi => {
  const result = [];
  for (const [m, xc, yc] of xyi) {
    xc >= 1n || Fail`right element ${m} was not in left`;
    if (yc === 0n) {
      // the x was not in y
      result.push(m);
    }
  }
  return result;
};

const mergeify = iterOp => (xelements, yelements) =>
  iterOp(merge(xelements, yelements));

export const elementsIsSuperset = mergeify(iterIsSuperset);
export const elementsIsDisjoint = mergeify(iterIsDisjoint);
export const elementsCompare = mergeify(iterCompare);
export const elementsUnion = mergeify(iterUnion);
export const elementsDisjointUnion = mergeify(iterDisjointUnion);
export const elementsIntersection = mergeify(iterIntersection);
export const elementsDisjointSubtract = mergeify(iterDisjointSubtract);

const rawSetify = elementsOp => (xset, yset) =>
  elementsOp(xset.payload, yset.payload);

const setify = elementsOp => (xset, yset) =>
  makeSetOfElements(elementsOp(xset.payload, yset.payload));

export const setIsSuperset = rawSetify(elementsIsSuperset);
export const setIsDisjoint = rawSetify(elementsIsDisjoint);
export const setUnion = setify(elementsUnion);
export const setDisjointUnion = setify(elementsDisjointUnion);
export const setIntersection = setify(elementsIntersection);
export const setDisjointSubtract = setify(elementsDisjointSubtract);
