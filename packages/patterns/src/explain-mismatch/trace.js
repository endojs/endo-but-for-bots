// @ts-check
/* eslint-disable no-use-before-define */

import harden from '@endo/harden';
import { passStyleOf, getTag } from '@endo/pass-style';
import { passableAsJustin } from '@endo/marshal';

import {
  matches,
  confirmMatches,
  kindOf,
} from '../patterns/patternMatchers.js';

/**
 * @import {Passable, CopyArray, CopyRecord, CopyTagged} from '@endo/pass-style';
 * @import {Pattern} from '../types.js';
 */

/**
 * @typedef {{kind: 'property', name: string}
 *         | {kind: 'index', index: number}
 *         | {kind: 'orBranch', branchIndex: number, branchPattern: Pattern}
 *         | {kind: 'andBranch', branchIndex: number, branchPattern: Pattern}
 *         | {kind: 'arrayOfElement', index: number}
 *         | {kind: 'recordOfKey', key: string}
 *         | {kind: 'recordOfValue', key: string}
 *         | {kind: 'optional', name: string}
 *         | {kind: 'rest'}} TraceStep
 */

/**
 * @typedef {object} LeafFailure
 * @property {string} reason
 * @property {Passable} specimenFragment
 * @property {Pattern} expectedFragment
 */

/**
 * @typedef {object} Trace
 * @property {TraceStep[]} path
 * @property {Passable} specimen
 * @property {Pattern} pattern
 * @property {'match' | 'mismatch'} outcome
 * @property {LeafFailure} [leaf]
 * @property {Trace[]} [children]
 * @property {string} [combinator]  Name of the combinator that produced children, e.g. 'or', 'and', 'arrayOf'.
 * @property {number} [branchCount] For 'or', the total number of alternatives.
 */

/**
 * Render a value compactly for a single-line context.
 *
 * @param {Passable} value
 * @returns {string}
 */
const render = value => {
  try {
    return passableAsJustin(harden(value), false);
  } catch (_err) {
    return String(value);
  }
};
harden(render);

/**
 * Capture the rejection message produced by the production matcher when the
 * given specimen does not match the given pattern. Returns `undefined` when
 * the specimen matches.
 *
 * Cost note: this implementation drives `confirmMatches` with a rejector that
 * throws and immediately catches, paying one thrown `Error` (and stack-trace
 * capture) per leaf-failure to recover the message text. A follow-up to expose
 * a non-throwing accessor (a "render the rejection template without throwing"
 * entrypoint) on the production matcher would let this function format the
 * message directly and erase the throw-and-catch overhead.
 *
 * @param {Passable} specimen
 * @param {Pattern} pattern
 * @returns {string | undefined}
 */
const captureRejectMessage = (specimen, pattern) => {
  if (matches(specimen, pattern)) {
    return undefined;
  }
  try {
    confirmMatches(specimen, pattern, /** @type {any} */ (rejectorThrow));
    // Fallthrough means the matcher considered it a match while `matches`
    // disagreed; treat as an opaque mismatch.
    return 'mismatch';
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
};
harden(captureRejectMessage);

/**
 * A `Rejector`-compatible function that throws an `Error` whose `message` is
 * the rendered template, mirroring the shape of `Fail` from `@endo/errors`
 * but built without SES details so the rendered values appear inline.
 *
 * @param {TemplateStringsArray} template
 * @param {...Passable} subs
 * @returns {never}
 */
const rejectorThrow = (template, ...subs) => {
  let message = '';
  for (let i = 0; i < template.length; i += 1) {
    message += template[i];
    if (i < subs.length) {
      message += render(subs[i]);
    }
  }
  throw Error(message);
};

/**
 * @param {TraceStep[]} path
 * @param {TraceStep} step
 * @returns {TraceStep[]}
 */
const extend = (path, step) => {
  const next = path.slice();
  next.push(step);
  return next;
};
harden(extend);

/**
 * Build a leaf trace by asking the production matcher for the rejection
 * message.
 *
 * @param {TraceStep[]} path
 * @param {Passable} specimen
 * @param {Pattern} pattern
 * @returns {Trace}
 */
const traceLeaf = (path, specimen, pattern) => {
  const reason = captureRejectMessage(specimen, pattern);
  if (reason === undefined) {
    return harden({
      path,
      specimen,
      pattern,
      outcome: 'match',
    });
  }
  return harden({
    path,
    specimen,
    pattern,
    outcome: 'mismatch',
    leaf: harden({
      reason,
      specimenFragment: specimen,
      expectedFragment: pattern,
    }),
  });
};

/**
 * Walk a specimen-pattern pair and produce a trace tree.
 *
 * The walk mirrors `confirmMatchesInternal` from
 * `../patterns/patternMatchers.js`, but instead of throwing on mismatch it
 * records every step structurally. Non-combinator patterns delegate to the
 * production matcher to recover the rejection text; combinator patterns are
 * unrolled so each branch or element is attributed to its own path.
 *
 * @param {Passable} specimen
 * @param {Pattern} pattern
 * @param {TraceStep[]} path
 * @returns {Trace}
 */
export const traceWalk = (specimen, pattern, path = []) => {
  if (matches(specimen, pattern)) {
    return harden({ path, specimen, pattern, outcome: 'match' });
  }

  const patternStyle = passStyleOf(/** @type {Passable} */ (pattern));

  if (patternStyle === 'copyArray') {
    const specimenStyle = passStyleOf(/** @type {Passable} */ (specimen));
    if (specimenStyle !== 'copyArray') {
      return traceLeaf(path, specimen, pattern);
    }
    const pattArr = /** @type {CopyArray<Pattern>} */ (pattern);
    const specArr = /** @type {CopyArray<Passable>} */ (specimen);
    if (pattArr.length !== specArr.length) {
      return traceLeaf(path, specimen, pattern);
    }
    const children = [];
    for (let i = 0; i < pattArr.length; i += 1) {
      const child = traceWalk(
        specArr[i],
        pattArr[i],
        extend(path, harden({ kind: 'index', index: i })),
      );
      if (child.outcome === 'mismatch') {
        children.push(child);
      }
    }
    if (children.length === 0) {
      return traceLeaf(path, specimen, pattern);
    }
    return harden({
      path,
      specimen,
      pattern,
      outcome: 'mismatch',
      combinator: 'array',
      children: harden(children),
    });
  }

  if (patternStyle === 'copyRecord') {
    const specimenStyle = passStyleOf(/** @type {Passable} */ (specimen));
    if (specimenStyle !== 'copyRecord') {
      return traceLeaf(path, specimen, pattern);
    }
    const pattRec = /** @type {CopyRecord<Pattern>} */ (pattern);
    const specRec = /** @type {CopyRecord<Passable>} */ (specimen);
    const pattKeys = Object.keys(pattRec).sort();
    const specKeys = Object.keys(specRec).sort();
    if (
      pattKeys.length !== specKeys.length ||
      pattKeys.some((k, i) => k !== specKeys[i])
    ) {
      return traceLeaf(path, specimen, pattern);
    }
    const children = [];
    for (const name of pattKeys) {
      const child = traceWalk(
        specRec[name],
        pattRec[name],
        extend(path, harden({ kind: 'property', name })),
      );
      if (child.outcome === 'mismatch') {
        children.push(child);
      }
    }
    if (children.length === 0) {
      return traceLeaf(path, specimen, pattern);
    }
    return harden({
      path,
      specimen,
      pattern,
      outcome: 'mismatch',
      combinator: 'record',
      children: harden(children),
    });
  }

  if (patternStyle === 'tagged') {
    const tag = getTag(/** @type {CopyTagged} */ (pattern));
    const payload = /** @type {CopyTagged<string, Passable>} */ (pattern)
      .payload;
    if (tag === 'match:or') {
      const patts = /** @type {CopyArray<Pattern>} */ (payload);
      const children = [];
      for (let i = 0; i < patts.length; i += 1) {
        const branchPattern = patts[i];
        const child = traceWalk(
          specimen,
          branchPattern,
          extend(
            path,
            harden({ kind: 'orBranch', branchIndex: i, branchPattern }),
          ),
        );
        children.push(child);
      }
      // If any branch matched, this disjunction matched; the production
      // `matches` would have agreed. We only get here when none matched.
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'or',
        branchCount: patts.length,
        children: harden(children),
      });
    }
    if (tag === 'match:and') {
      const patts = /** @type {CopyArray<Pattern>} */ (payload);
      const children = [];
      for (let i = 0; i < patts.length; i += 1) {
        const branchPattern = patts[i];
        const child = traceWalk(
          specimen,
          branchPattern,
          extend(
            path,
            harden({ kind: 'andBranch', branchIndex: i, branchPattern }),
          ),
        );
        if (child.outcome === 'mismatch') {
          children.push(child);
        }
      }
      if (children.length === 0) {
        return traceLeaf(path, specimen, pattern);
      }
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'and',
        children: harden(children),
      });
    }
    if (tag === 'match:arrayOf') {
      const specimenKind = kindOf(specimen);
      if (specimenKind !== 'copyArray') {
        return traceLeaf(path, specimen, pattern);
      }
      const arr = /** @type {CopyArray<Passable>} */ (specimen);
      const [subPatt] = /** @type {[Pattern, ...any[]]} */ (payload);
      const children = [];
      for (let i = 0; i < arr.length; i += 1) {
        const child = traceWalk(
          arr[i],
          subPatt,
          extend(path, harden({ kind: 'arrayOfElement', index: i })),
        );
        if (child.outcome === 'mismatch') {
          children.push(child);
        }
      }
      if (children.length === 0) {
        return traceLeaf(path, specimen, pattern);
      }
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'arrayOf',
        children: harden(children),
      });
    }
    if (tag === 'match:recordOf') {
      const specimenKind = kindOf(specimen);
      if (specimenKind !== 'copyRecord') {
        return traceLeaf(path, specimen, pattern);
      }
      const rec = /** @type {CopyRecord<Passable>} */ (specimen);
      const [keyPatt, valuePatt] = /** @type {[Pattern, Pattern, ...any[]]} */ (
        payload
      );
      const children = [];
      for (const key of Object.keys(rec).sort()) {
        if (!matches(key, keyPatt)) {
          children.push(
            traceLeaf(
              extend(path, harden({ kind: 'recordOfKey', key })),
              key,
              keyPatt,
            ),
          );
        }
        const valueChild = traceWalk(
          rec[key],
          valuePatt,
          extend(path, harden({ kind: 'recordOfValue', key })),
        );
        if (valueChild.outcome === 'mismatch') {
          children.push(valueChild);
        }
      }
      if (children.length === 0) {
        return traceLeaf(path, specimen, pattern);
      }
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'recordOf',
        children: harden(children),
      });
    }
    if (tag === 'match:splitRecord') {
      const specimenKind = kindOf(specimen);
      if (specimenKind !== 'copyRecord') {
        return traceLeaf(path, specimen, pattern);
      }
      const [requiredPatt, optionalPatt = {}, restPatt = undefined] =
        /** @type {[CopyRecord<Pattern>, CopyRecord<Pattern>?, Pattern?]} */ (
          payload
        );
      const rec = /** @type {CopyRecord<Passable>} */ (specimen);
      const children = [];
      // Required keys.
      for (const name of Object.keys(requiredPatt).sort()) {
        if (!Object.prototype.hasOwnProperty.call(rec, name)) {
          children.push(
            harden({
              path: extend(path, harden({ kind: 'property', name })),
              specimen: undefined,
              pattern: requiredPatt[name],
              outcome: /** @type {'mismatch'} */ ('mismatch'),
              leaf: harden({
                reason: `missing required property "${name}"`,
                specimenFragment: undefined,
                expectedFragment: requiredPatt[name],
              }),
            }),
          );
        } else {
          const child = traceWalk(
            rec[name],
            requiredPatt[name],
            extend(path, harden({ kind: 'property', name })),
          );
          if (child.outcome === 'mismatch') {
            children.push(child);
          }
        }
      }
      // Optional keys: only walked if present.
      for (const name of Object.keys(optionalPatt).sort()) {
        if (Object.prototype.hasOwnProperty.call(rec, name)) {
          const value = rec[name];
          if (value !== undefined) {
            const child = traceWalk(
              value,
              optionalPatt[name],
              extend(path, harden({ kind: 'optional', name })),
            );
            if (child.outcome === 'mismatch') {
              children.push(child);
            }
          }
        }
      }
      // Rest properties: any key not in required or optional.
      if (restPatt !== undefined) {
        /** @type {Record<string, Passable>} */
        const restEntries = {};
        for (const name of Object.keys(rec)) {
          if (
            !Object.prototype.hasOwnProperty.call(requiredPatt, name) &&
            !Object.prototype.hasOwnProperty.call(optionalPatt, name)
          ) {
            restEntries[name] = rec[name];
          }
        }
        const restSpec = harden(restEntries);
        if (!matches(restSpec, restPatt)) {
          children.push(
            traceLeaf(
              extend(path, harden({ kind: 'rest' })),
              restSpec,
              restPatt,
            ),
          );
        }
      }
      if (children.length === 0) {
        return traceLeaf(path, specimen, pattern);
      }
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'splitRecord',
        children: harden(children),
      });
    }
    if (tag === 'match:splitArray') {
      const specimenKind = kindOf(specimen);
      if (specimenKind !== 'copyArray') {
        return traceLeaf(path, specimen, pattern);
      }
      const [requiredPatt, optionalPatt = [], restPatt = undefined] =
        /** @type {[Pattern[], Pattern[]?, Pattern?]} */ (payload);
      const arr = /** @type {Passable[]} */ (specimen);
      const children = [];
      const numRequired = requiredPatt.length;
      const numOptional = optionalPatt.length;
      if (arr.length < numRequired) {
        return traceLeaf(path, specimen, pattern);
      }
      for (let i = 0; i < numRequired; i += 1) {
        const child = traceWalk(
          arr[i],
          requiredPatt[i],
          extend(path, harden({ kind: 'index', index: i })),
        );
        if (child.outcome === 'mismatch') {
          children.push(child);
        }
      }
      for (let i = 0; i < numOptional; i += 1) {
        const idx = numRequired + i;
        if (idx >= arr.length) break;
        if (arr[idx] !== undefined) {
          const child = traceWalk(
            arr[idx],
            optionalPatt[i],
            extend(path, harden({ kind: 'index', index: idx })),
          );
          if (child.outcome === 'mismatch') {
            children.push(child);
          }
        }
      }
      if (restPatt !== undefined) {
        const restSpec = harden(arr.slice(numRequired + numOptional));
        if (!matches(restSpec, restPatt)) {
          children.push(
            traceLeaf(
              extend(path, harden({ kind: 'rest' })),
              restSpec,
              restPatt,
            ),
          );
        }
      }
      if (children.length === 0) {
        return traceLeaf(path, specimen, pattern);
      }
      return harden({
        path,
        specimen,
        pattern,
        outcome: 'mismatch',
        combinator: 'splitArray',
        children: harden(children),
      });
    }
    // Other tagged patterns: not specially unrolled; surface as a leaf.
    return traceLeaf(path, specimen, pattern);
  }

  // Non-pattern-style cases: delegate to the production matcher's verdict.
  return traceLeaf(path, specimen, pattern);
};
harden(traceWalk);

/**
 * Count the leaf failures in a trace (used by the renderer for the header).
 *
 * @param {Trace} trace
 * @returns {number}
 */
export const countLeaves = trace => {
  if (trace.outcome === 'match') return 0;
  if (trace.leaf !== undefined) return 1;
  if (trace.children === undefined || trace.children.length === 0) return 1;
  if (trace.combinator === 'or') {
    // One disjunction failure, regardless of how many alternatives were tried.
    return 1;
  }
  let n = 0;
  for (const child of trace.children) {
    n += countLeaves(child);
  }
  return n || 1;
};
harden(countLeaves);
