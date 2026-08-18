// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useState } from 'preact/hooks';

/** @import { VNode } from 'preact' */

/**
 * Serialize a journal entry for display. An entry can carry any
 * passable data folded from participant replies — including a bigint,
 * which `JSON.stringify` throws on — so coerce bigints to a tagged
 * string rather than crash the expanded view.
 *
 * @param {any} entry
 * @returns {string}
 */
const stringifyEntry = entry => {
  try {
    return JSON.stringify(
      entry,
      (_key, value) => (typeof value === 'bigint' ? `${value}n` : value),
      2,
    );
  } catch (error) {
    return `<unrenderable entry: ${/** @type {Error} */ (error).message}>`;
  }
};

const ENTRY_ICONS = harden({
  started: '▶',
  event: '→',
  'effect-dispatched': '↗',
  'effect-settled': '✓',
  spawned: '⤷',
  paused: '⏸',
  resumed: '⏵',
  cancelled: '■',
  completed: '■',
  failed: '✗',
  snapshot: '⟲',
  admin: '⚙',
});

/**
 * One line of summary for a journal entry beyond its kind.
 *
 * @param {any} entry
 * @returns {string}
 */
const summarize = entry => {
  if (entry.kind === 'event') {
    const type = entry.event?.type ?? '';
    const settled =
      entry.settles === undefined ? '' : ` ⇐ ${entry.settles.effectId}`;
    const terminal =
      entry.terminal === undefined ? '' : ` ■ ${entry.terminal.outcome}`;
    // An unfired entry may have been queued while paused (replayed
    // later) or fallen through guards; either way, no transition here.
    const fired =
      entry.fired === undefined && entry.terminal === undefined
        ? ' (no transition)'
        : '';
    return `${type}${settled}${terminal}${fired}`;
  }
  if (entry.kind === 'effect-dispatched' || entry.kind === 'effect-settled') {
    return `${entry.effectId}${entry.status !== undefined ? ` ${entry.status}` : ''}`;
  }
  if (entry.kind === 'spawned') {
    return entry.childRunId ?? '';
  }
  if (entry.kind === 'started') {
    return `${entry.chartName} v${entry.chartVersion}`;
  }
  if (entry.kind === 'failed' || entry.kind === 'cancelled') {
    return typeof entry.reason === 'string' ? entry.reason : '';
  }
  if (entry.kind === 'admin') {
    return `${entry.action} ${entry.detail ?? ''}`;
  }
  return '';
};

/**
 * The journal as an event list, oldest first, each entry expandable to
 * its full record; clicking an entry scrubs the statechart to the state
 * just after it applied.
 *
 * @param {{
 *   entries: any[],
 *   scrubSeq: number | undefined,
 *   onScrub: (seq: number | undefined) => void,
 *   filter: string,
 * }} props
 * @returns {VNode}
 */
export const TimelineView = ({ entries, scrubSeq, onScrub, filter }) => {
  const [expandedSeq, setExpandedSeq] = useState(
    /** @type {number | undefined} */ (undefined),
  );
  const shown = filter
    ? entries.filter(
        entry =>
          entry.kind.includes(filter) ||
          (typeof entry.event?.type === 'string' &&
            entry.event.type.includes(filter)) ||
          (typeof entry.by === 'string' && entry.by.includes(filter)),
      )
    : entries;
  return h(
    'ol',
    { class: 'wf-timeline' },
    shown.map(entry => {
      const seq = Number(entry.seq);
      return h(
        'li',
        {
          key: seq,
          class:
            seq === scrubSeq
              ? 'wf-timeline-entry wf-timeline-entry-scrubbed'
              : 'wf-timeline-entry',
        },
        [
          h(
            'button',
            {
              class: 'wf-timeline-head',
              onClick: () => {
                onScrub(seq === scrubSeq ? undefined : seq);
                setExpandedSeq(seq === expandedSeq ? undefined : seq);
              },
            },
            [
              h('span', { class: 'wf-timeline-seq' }, `#${seq}`),
              h(
                'span',
                { class: 'wf-timeline-icon' },
                ENTRY_ICONS[entry.kind] ?? '•',
              ),
              h('span', { class: 'wf-timeline-type' }, entry.kind),
              h('span', { class: 'wf-timeline-summary' }, summarize(entry)),
            ],
          ),
          seq === expandedSeq
            ? h('pre', { class: 'wf-timeline-record' }, stringifyEntry(entry))
            : null,
        ],
      );
    }),
  );
};
harden(TimelineView);
