// @ts-check
/**
 * Queued messages (R6-44; m3-interfaces.md 9.3; W3.6): the session's
 * `PendingRow`s after the live turn, each with Edit and Delete; the head
 * also has "Send now" while a turn runs or the queue is held ("Send again"
 * when the hold says the head was interrupted); a held queue shows its hold
 * line. Adapted from Floot's `PendingBubble` at `1315bef86`: rows are
 * addressed by the `PendingRow.key` the controller maps back to its
 * `QueueEntry` (F.2 d).
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { labels } from './labels.js';
import { linkify } from './text.js';

/**
 * @param {{
 *   row: Record<string, any>,
 *   controller: any,
 *   sendNow?: string,
 * }} props `sendNow` is the label of the row's Send-now button, if it has one
 */
const QueueRow = ({ row, controller, sendNow }) => {
  const [draft, setDraft] = useState(/** @type {string | null} */ (null));
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    // An emptied box is no delete: Delete has its own button.
    if (next && next !== row.preview) controller.editPending(row.key, next);
  };
  if (draft !== null) {
    return h(
      'div',
      { class: 'floot-msg-row user pending', 'data-entry': row.key },
      h('textarea', {
        class: 'floot-pending-input',
        'aria-label': labels.editQueued,
        value: draft,
        /** @param {any} event */
        onInput: event => setDraft(event.target.value),
        /** @param {any} event */
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            save();
          } else if (event.key === 'Escape') {
            setDraft(null);
          }
        },
      }),
      h(
        'div',
        { class: 'floot-pending-actions' },
        h(
          'button',
          { type: 'button', class: 'floot-pending-action', onClick: save },
          labels.save,
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'floot-pending-action',
            onClick: () => setDraft(null),
          },
          labels.cancel,
        ),
      ),
    );
  }
  return h(
    'div',
    { class: 'floot-msg-row user pending', 'data-entry': row.key },
    h('div', { class: 'floot-msg' }, ...linkify(row.preview)),
    h(
      'div',
      { class: 'floot-pending-actions' },
      sendNow
        ? h(
            'button',
            {
              type: 'button',
              class: 'floot-pending-action',
              'data-action': 'send-now',
              onClick: () => controller.sendPendingNow(row.key),
            },
            sendNow,
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'floot-pending-action',
          'data-action': 'edit',
          onClick: () => setDraft(row.preview),
        },
        uiTexts.edit,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'floot-pending-action floot-pending-delete',
          'data-action': 'delete',
          onClick: () => controller.cancelPending(row.key),
        },
        uiTexts.delete,
      ),
    ),
  );
};

/**
 * @param {{ state: any, controller: any }} props
 */
export const Queue = ({ state, controller }) => {
  const view = state.view;
  if (!view || view.pending.length === 0) return null;
  const hold = view.hold;
  const held = Boolean(hold);
  const headLabel =
    hold && hold.reason === 'interrupted' ? uiTexts.sendAgain : uiTexts.sendNow;
  return h(
    'div',
    { class: 'thix-queue' },
    held
      ? h(
          'div',
          {
            class: 'floot-pending-hold',
            role: 'status',
            'data-hold': hold.reason,
          },
          hold.message,
        )
      : null,
    view.pending.map((/** @type {Record<string, any>} */ row, index) =>
      state.sessionPath?.[1]
        ? h(
            'div',
            {
              key: row.key,
              class: 'floot-msg-row user pending',
              'data-entry': row.key,
            },
            h('div', { class: 'floot-msg' }, ...linkify(row.preview)),
          )
        : h(QueueRow, {
            key: row.key,
            row,
            controller,
            sendNow: index === 0 && (view.busy || held) ? headLabel : undefined,
          }),
    ),
  );
};
