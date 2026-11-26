// @ts-check

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { passableAsJustin } from '@endo/marshal';

import { countLeaves } from './trace.js';

/**
 * @import {Passable} from '@endo/pass-style';
 * @import {Pattern} from '../types.js';
 * @import {Trace, TraceStep} from './trace.js';
 */

/**
 * Render a single passable value on one line (no newlines).
 *
 * @param {Passable} value
 * @returns {string}
 */
const oneLine = value => {
  let s;
  try {
    s = passableAsJustin(harden(value), false);
  } catch (_err) {
    s = String(value);
  }
  return s.replace(/\s+/g, ' ').trim();
};
harden(oneLine);

/**
 * Render the same value across multiple lines (used by `expanded`).
 *
 * @param {Passable} value
 * @returns {string}
 */
const multiLine = value => {
  try {
    return passableAsJustin(harden(value), true);
  } catch (_err) {
    return String(value);
  }
};
harden(multiLine);

/**
 * Add a type tag to a value for the `found` column when the type is not
 * unambiguous from the literal alone (e.g., `2` could be a number or a
 * bigint).
 *
 * @param {Passable} value
 * @returns {string}
 */
const renderFound = value => {
  let style;
  try {
    style = passStyleOf(value);
  } catch (_err) {
    return oneLine(value);
  }
  const text = oneLine(value);
  if (style === 'number') return `${text} (number)`;
  if (style === 'string') return text;
  if (style === 'bigint') return text;
  if (style === 'boolean') return text;
  if (style === 'undefined') return 'undefined';
  if (style === 'null') return 'null';
  if (style === 'symbol') return `${text} (symbol)`;
  return `${text} (${style})`;
};
harden(renderFound);

/**
 * Convert a path of `TraceStep`s into a human-readable accessor (e.g.
 * `.user.age`, `[2]`, `[map: "k"]`).
 *
 * @param {TraceStep[]} path
 * @returns {string}
 */
export const renderPath = path => {
  if (path.length === 0) return '.';
  const parts = [];
  for (const step of path) {
    switch (step.kind) {
      case 'property':
      case 'optional': {
        parts.push(`.${step.name}`);
        break;
      }
      case 'index':
      case 'arrayOfElement': {
        parts.push(`[${step.index}]`);
        break;
      }
      case 'recordOfKey': {
        parts.push(`{key ${oneLine(step.key)}}`);
        break;
      }
      case 'recordOfValue': {
        parts.push(`.${step.key}`);
        break;
      }
      case 'orBranch': {
        parts.push(`(or alt ${step.branchIndex})`);
        break;
      }
      case 'andBranch': {
        parts.push(`(and branch ${step.branchIndex})`);
        break;
      }
      case 'rest': {
        parts.push(`...rest`);
        break;
      }
      default: {
        parts.push('?');
      }
    }
  }
  return parts.join('') || '.';
};
harden(renderPath);

/**
 * Escape a literal `|` so the `compact` row separator stays unambiguous.
 *
 * @param {string} s
 * @returns {string}
 */
const escapeBar = s => s.replace(/\|/g, '\\|');
harden(escapeBar);

/**
 * Yield the leaf trace nodes of a tree (skipping interior nodes that just
 * collect children).
 *
 * @param {Trace} trace
 * @returns {Trace[]}
 */
const collectLeaves = trace => {
  if (trace.outcome === 'match') return [];
  if (trace.leaf !== undefined) return [trace];
  const acc = [];
  if (trace.children !== undefined) {
    for (const child of trace.children) {
      for (const leaf of collectLeaves(child)) {
        acc.push(leaf);
      }
    }
  }
  return acc;
};
harden(collectLeaves);

/**
 * Render one leaf trace as a single compact line.
 *
 * @param {Trace} leaf
 * @returns {string}
 */
const compactLeafLine = leaf => {
  const path = renderPath(leaf.path);
  const found = leaf.leaf
    ? renderFound(leaf.leaf.specimenFragment)
    : renderFound(leaf.specimen);
  const expected = leaf.leaf
    ? oneLine(leaf.leaf.expectedFragment)
    : oneLine(leaf.pattern);
  const reason = leaf.leaf ? ` (${leaf.leaf.reason})` : '';
  return `${escapeBar(path)} | found ${escapeBar(found)} | expected ${escapeBar(
    expected,
  )}${escapeBar(reason)}`;
};
harden(compactLeafLine);

/**
 * Render a trace in `compact` format.
 *
 * @param {Trace} trace
 * @param {string} [context]
 * @returns {string}
 */
const renderCompact = (trace, context) => {
  const prefix = context ? `${context}: ` : '';
  if (trace.combinator === 'or' && trace.children) {
    const lines = [];
    lines.push(
      `${prefix}mismatch (or, ${trace.branchCount} alternatives, none matched): ${oneLine(trace.specimen)}`,
    );
    trace.children.forEach((branch, i) => {
      const leaves = collectLeaves(branch);
      if (leaves.length === 0) {
        lines.push(
          `  alt ${i} | (no specific leaf surfaced) | expected ${escapeBar(
            oneLine(branch.pattern),
          )}`,
        );
      } else {
        for (const leaf of leaves) {
          // Strip the leading "(or alt N)" prefix from the branch path so the
          // alt index lives in its own column.
          const trimmedLeaf = harden({
            ...leaf,
            path: leaf.path.slice(1),
          });
          lines.push(`  alt ${i} | ${compactLeafLine(trimmedLeaf)}`);
        }
      }
    });
    return lines.join('\n');
  }
  if (trace.combinator === 'arrayOf' && trace.children) {
    const total =
      passStyleOf(trace.specimen) === 'copyArray'
        ? /** @type {any[]} */ (trace.specimen).length
        : 0;
    const failed = trace.children.length;
    const lines = [
      `${prefix}mismatch (arrayOf, ${failed} of ${total} elements failed):`,
    ];
    for (const child of trace.children) {
      const leaves = collectLeaves(child);
      if (leaves.length === 0) {
        lines.push(`  ${compactLeafLine(child)}`);
      } else {
        for (const leaf of leaves) {
          lines.push(`  ${compactLeafLine(leaf)}`);
        }
      }
    }
    return lines.join('\n');
  }
  const leaves = collectLeaves(trace);
  if (leaves.length === 0) {
    return `${prefix}mismatch: ${oneLine(trace.specimen)} | expected ${escapeBar(
      oneLine(trace.pattern),
    )}`;
  }
  const count = countLeaves(trace);
  const head = `${prefix}mismatch (${count} ${count === 1 ? 'leaf' : 'leaves'}):`;
  if (count === 1) {
    return `${head} ${compactLeafLine(leaves[0])}`;
  }
  return [head, ...leaves.map(leaf => `  ${compactLeafLine(leaf)}`)].join('\n');
};
harden(renderCompact);

/**
 * Render a trace in `expanded` format (indented, Rust-compiler-style).
 *
 * @param {Trace} trace
 * @param {string} [context]
 * @returns {string}
 */
const renderExpanded = (trace, context) => {
  const lines = [];
  if (context) {
    lines.push(`in ${context}`);
  }
  if (trace.combinator === 'or' && trace.children) {
    lines.push(
      `mismatch on or-disjunction, ${trace.branchCount} alternatives, none matched`,
    );
    lines.push(`  specimen: ${oneLine(trace.specimen)}`);
    trace.children.forEach((branch, i) => {
      lines.push(`  alt ${i}: ${oneLine(branch.pattern)}`);
      const leaves = collectLeaves(branch);
      for (const leaf of leaves) {
        const trimmedPath = leaf.path.slice(1);
        lines.push(`    at ${renderPath(trimmedPath) || '.'}`);
        lines.push(
          `      found:    ${renderFound(leaf.leaf?.specimenFragment ?? leaf.specimen)}`,
        );
        lines.push(
          `      expected: ${oneLine(leaf.leaf?.expectedFragment ?? leaf.pattern)}`,
        );
        if (leaf.leaf?.reason) {
          lines.push(`      reason:   ${leaf.leaf.reason}`);
        }
      }
    });
    return lines.join('\n');
  }
  if (trace.combinator === 'arrayOf' && trace.children) {
    const total =
      passStyleOf(trace.specimen) === 'copyArray'
        ? /** @type {any[]} */ (trace.specimen).length
        : 0;
    const failed = trace.children.length;
    lines.push(`mismatch in arrayOf over ${total} elements; ${failed} failed`);
    for (const child of trace.children) {
      const leaves = collectLeaves(child);
      for (const leaf of leaves) {
        lines.push(`  at ${renderPath(leaf.path)}`);
        lines.push(
          `    found:    ${renderFound(leaf.leaf?.specimenFragment ?? leaf.specimen)}`,
        );
        lines.push(
          `    expected: ${oneLine(leaf.leaf?.expectedFragment ?? leaf.pattern)}`,
        );
        if (leaf.leaf?.reason) {
          lines.push(`    reason:   ${leaf.leaf.reason}`);
        }
      }
    }
    return lines.join('\n');
  }
  const leaves = collectLeaves(trace);
  if (leaves.length === 0) {
    lines.push(`mismatch at ${renderPath(trace.path)}`);
    lines.push(`  found:    ${renderFound(trace.specimen)}`);
    lines.push(`  expected: ${oneLine(trace.pattern)}`);
    return lines.join('\n');
  }
  for (const leaf of leaves) {
    lines.push(`mismatch at ${renderPath(leaf.path)}`);
    lines.push(
      `  found:    ${renderFound(leaf.leaf?.specimenFragment ?? leaf.specimen)}`,
    );
    lines.push(
      `  expected: ${oneLine(leaf.leaf?.expectedFragment ?? leaf.pattern)}`,
    );
    if (leaf.leaf?.reason) {
      lines.push(`  reason:   ${leaf.leaf.reason}`);
    }
  }
  return lines.join('\n');
};
harden(renderExpanded);

/**
 * @param {Trace} trace
 * @param {{format?: 'compact' | 'expanded', context?: string}} [options]
 * @returns {string}
 */
export const renderTrace = (trace, options = {}) => {
  const { format = 'compact', context } = options;
  if (format === 'expanded') {
    return renderExpanded(trace, context);
  }
  return renderCompact(trace, context);
};
harden(renderTrace);
