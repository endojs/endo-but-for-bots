// @ts-check

import harden from '@endo/harden';
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';

/** @import { FlootController, FlootRecovery, FlootJournalTurn, FlootSafeEvent } from './types.js' */

// View-only limits: all evidence stays available through explicit paging.
const TEXT_PAGE = 8192;
const TURN_PAGE = 50;

/** @param {{ text: string }} props */
const EvidenceText = ({ text }) => {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(text.length / TEXT_PAGE));
  const current = Math.min(page, pages - 1);
  return h(
    'div',
    { class: 'floot-evidence-text' },
    h('pre', null, text.slice(current * TEXT_PAGE, (current + 1) * TEXT_PAGE)),
    pages > 1
      ? h(
          'div',
          null,
          h(
            'span',
            null,
            `Evidence chunk ${current + 1}/${pages}; remaining text is paged, not discarded. `,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: current === 0,
              onClick: () => setPage(current - 1),
            },
            'Previous chunk',
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: current === pages - 1,
              onClick: () => setPage(current + 1),
            },
            'Next chunk',
          ),
        )
      : null,
  );
};
harden(EvidenceText);

/** @param {{ items: unknown[] }} props */
const EvidenceItems = ({ items }) => {
  const [index, setIndex] = useState(0);
  const current = Math.min(index, Math.max(0, items.length - 1));
  return h(
    'div',
    null,
    items.length
      ? h(
          Fragment,
          null,
          h('p', null, `Evidence item ${current + 1}/${items.length}`),
          h(EvidenceText, {
            key: current,
            text: JSON.stringify(items[current], null, 2),
          }),
          items.length > 1
            ? h(
                'div',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: current === 0,
                    onClick: () => setIndex(current - 1),
                  },
                  'Previous item',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: current === items.length - 1,
                    onClick: () => setIndex(current + 1),
                  },
                  'Next item',
                ),
              )
            : null,
        )
      : h('p', null, 'No evidence recorded.'),
  );
};
harden(EvidenceItems);

/** @param {{ turn: FlootJournalTurn, recovery: FlootRecovery, controller: FlootController }} props */
const RecoveryTurn = ({ turn, recovery, controller }) => {
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const unknown = turn.state === 'outcome-unknown' && !turn.resolution;
  return h(
    'details',
    { class: 'floot-recovery-turn', open: expanded },
    h(
      'summary',
      {
        onClick: (/** @type {FlootSafeEvent} */ event) => {
          event.preventDefault();
          setExpanded(!expanded);
        },
      },
      `Turn ${turn.turnId}: ${turn.state}${turn.resolution ? ' (acknowledged)' : ''}`,
    ),
    expanded
      ? h(
          Fragment,
          null,
          turn.error ? h(EvidenceText, { text: turn.error }) : null,
          h(
            'p',
            null,
            'Endo tools below have write-ahead intent records. Native/backend activity is observed evidence, not proof of external effects.',
          ),
          h('h4', null, 'Endo tool evidence'),
          h(EvidenceItems, { items: turn.tools || [] }),
          h('h4', null, 'Observed native/backend activity'),
          h(EvidenceItems, { items: turn.activity || [] }),
          turn.resolution
            ? h('p', null, `Operator acknowledgment: ${turn.resolution}`)
            : null,
          unknown
            ? h(
                'div',
                null,
                h(
                  'p',
                  null,
                  'The outcome is unknown. Check external effects yourself before acknowledging. This does not undo effects, prove success, or replay the turn.',
                ),
                h(
                  'label',
                  null,
                  'Recovery note',
                  h('textarea', {
                    value: note,
                    disabled: recovery.resolving,
                    onInput: (/** @type {FlootSafeEvent} */ e) =>
                      setNote(e.target.value),
                  }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: recovery.resolving,
                    'aria-pressed': confirmed ? 'true' : 'false',
                    onClick: () => setConfirmed(!confirmed),
                  },
                  confirmed
                    ? '✓ External effects checked'
                    : 'Confirm: I checked external effects',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled:
                      !recovery.canResolve || !confirmed || !note.trim(),
                    onClick: () =>
                      controller.resolveTurn?.(turn.turnId, note, confirmed),
                  },
                  recovery.resolving
                    ? 'Acknowledging…'
                    : 'Acknowledge and allow a new turn',
                ),
              )
            : null,
        )
      : null,
  );
};
harden(RecoveryTurn);

/** @param {{ recovery: FlootRecovery, controller: FlootController }} props */
export const RecoveryPanel = ({ recovery, controller }) => {
  const [page, setPage] = useState(0);
  const count = recovery.turns.length;
  const pages = Math.max(1, Math.ceil(count / TURN_PAGE));
  const current = Math.min(page, pages - 1);
  // Newest first. Only one page of summaries and expanded details is mounted.
  const visible = recovery.turns
    .slice()
    .reverse()
    .slice(current * TURN_PAGE, (current + 1) * TURN_PAGE);
  const firstUnknown = recovery.turns.findLastIndex(
    turn => turn.state === 'outcome-unknown' && !turn.resolution,
  );
  return h(
    'section',
    { class: 'floot-recovery', 'aria-label': 'Turn journal and recovery' },
    h('h3', null, 'Turn journal and recovery'),
    h(
      'button',
      {
        type: 'button',
        disabled: recovery.resolving || recovery.status === 'loading',
        onClick: () => controller.refreshRecovery?.(),
      },
      'Refresh journal',
    ),
    recovery.message ? h('p', { role: 'status' }, recovery.message) : null,
    recovery.current
      ? h('p', null, 'A turn is active. Recovery is disabled until it settles.')
      : null,
    recovery.capacity
      ? h(
          'p',
          null,
          `Journal: ${recovery.capacity.usedEvents}/${recovery.capacity.eventLimit} events (${recovery.capacity.storage}). ${recovery.capacity.nearCapacity ? 'Near capacity: arrange a new session before the journal fills.' : ''}`,
        )
      : null,
    recovery.status === 'ready' && !recovery.turns.length
      ? h('p', null, 'No recorded turns.')
      : null,
    firstUnknown >= 0
      ? h(
          'button',
          {
            type: 'button',
            onClick: () =>
              setPage(Math.floor((count - 1 - firstUnknown) / TURN_PAGE)),
          },
          'Show unresolved turn',
        )
      : null,
    pages > 1
      ? h(
          'div',
          null,
          h('p', null, `Turn page ${current + 1}/${pages}, newest first`),
          h(
            'button',
            {
              type: 'button',
              disabled: current === 0,
              onClick: () => setPage(current - 1),
            },
            'Newer turns',
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: current === pages - 1,
              onClick: () => setPage(current + 1),
            },
            'Older turns',
          ),
        )
      : null,
    visible.map(turn =>
      h(RecoveryTurn, { key: turn.turnId, turn, recovery, controller }),
    ),
  );
};
harden(RecoveryPanel);
