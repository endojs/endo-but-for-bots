// @ts-check
import { limits } from '../lib/limits.js';
import { cutText } from '../lib/bounded.js';
/** @import { Binding, Labels } from './labels.js' */

/**
 * Read-only view of this session's petnames and its current child aliases.
 * Cursors identify an offset within a revision. A stale cursor restarts at
 * the new revision, which lets a reader discard the earlier pages.
 * @param {Labels} labels
 * @param {number} rev
 * @param {string} [cursor]
 */
export const inventoryPage = (labels, rev, cursor) => {
  const names = labels.list();
  let start = 0;
  if (cursor !== undefined) {
    const match = /^(\d+)\.(\d+)$/.exec(cursor);
    if (!match) throw Error('Invalid inventory cursor');
    if (Number(match[1]) === rev) {
      start = Number(match[2]);
      if (!Number.isSafeInteger(start) || start < 1 || start >= names.length)
        throw Error('Invalid inventory cursor');
    }
  }
  const end = start + limits.inventoryPageRows;
  const rows = names.slice(start, end).map(label => {
    const binding = /** @type {Binding} */ (labels.get(label));
    if (binding.kind === 'object' && binding.source === 'subagent')
      return { label, kind: 'subagent' };
    if (binding.kind !== 'json') return { label, kind: binding.kind };
    const preview = cutText(binding.text, limits.inventoryPreviewBytes);
    return {
      label,
      kind: 'value',
      preview,
      ...(preview.length < binding.text.length ? { truncated: true } : {}),
    };
  });
  return harden({
    rev,
    rows,
    ...(end < names.length ? { next: `${rev}.${end}` } : {}),
  });
};
harden(inventoryPage);
