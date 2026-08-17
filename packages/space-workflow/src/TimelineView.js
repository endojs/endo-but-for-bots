// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useState } from 'preact/hooks';

/** @import { VNode } from 'preact' */

/**
 * Serialize a journal record for display. A record can carry any
 * passable value folded from participant replies — including a bigint,
 * which `JSON.stringify` throws on — so coerce bigints to a tagged
 * string rather than crash the expanded view.
 *
 * @param {any} record
 * @returns {string}
 */
const stringifyRecord = record => {
  try {
    return JSON.stringify(
      record,
      (_key, value) => (typeof value === 'bigint' ? `${value}n` : value),
      2,
    );
  } catch (error) {
    return `<unrenderable record: ${/** @type {Error} */ (error).message}>`;
  }
};

const EVENT_ICONS = harden({
  'run.started': '▶',
  'effect.issued': '↗',
  'effect.settled': '✓',
  'effect.rejected': '✗',
  'fanout.result': '·',
  'fanout.joined': '⋈',
  'form.value': '☑',
  'transition.fired': '→',
  'event.unauthorized': '⚠',
  'signal.injected': '📣',
  'admin.forced': '⚙',
  'recovery.completed': '♻',
  'child.finished': '⤶',
  'run.finished': '■',
  emit: '∙',
});

/**
 * The journal as a virtualized-enough event list, newest last, each
 * entry expandable to its full record; clicking an entry scrubs the
 * statechart to that seq.
 *
 * @param {{
 *   records: any[],
 *   scrubSeq: number | undefined,
 *   onScrub: (seq: number | undefined) => void,
 *   filter: string,
 * }} props
 * @returns {VNode}
 */
export const TimelineView = ({ records, scrubSeq, onScrub, filter }) => {
  const [expandedSeq, setExpandedSeq] = useState(
    /** @type {number | undefined} */ (undefined),
  );
  const shown = filter
    ? records.filter(
        record =>
          typeof record.type === 'string' && record.type.includes(filter),
      )
    : records;
  return h(
    'ol',
    { class: 'wf-timeline' },
    shown.map(record =>
      h(
        'li',
        {
          key: record.seq,
          class:
            record.seq === scrubSeq
              ? 'wf-timeline-entry wf-timeline-entry-scrubbed'
              : 'wf-timeline-entry',
        },
        [
          h(
            'button',
            {
              class: 'wf-timeline-head',
              onClick: () => {
                onScrub(record.seq === scrubSeq ? undefined : record.seq);
                setExpandedSeq(
                  record.seq === expandedSeq ? undefined : record.seq,
                );
              },
            },
            [
              h('span', { class: 'wf-timeline-seq' }, `#${record.seq}`),
              h(
                'span',
                { class: 'wf-timeline-icon' },
                EVENT_ICONS[record.type] ?? '•',
              ),
              h('span', { class: 'wf-timeline-type' }, record.type),
              h(
                'span',
                { class: 'wf-timeline-summary' },
                record.as ?? record.to ?? record.final ?? '',
              ),
            ],
          ),
          record.seq === expandedSeq
            ? h('pre', { class: 'wf-timeline-record' }, stringifyRecord(record))
            : null,
        ],
      ),
    ),
  );
};
harden(TimelineView);
