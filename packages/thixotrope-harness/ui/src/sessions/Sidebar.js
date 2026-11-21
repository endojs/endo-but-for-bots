// @ts-check
/**
 * The session sidebar (R6-36, R6-37; m3-interfaces.md 9.3; W3.5), adapted
 * from `space-floot` `SessionSidebar.js`: "Sessions" with New session (+),
 * "No sessions yet" when empty, one row per session with its status circle,
 * title, `backend · model · effort` line and `N messages · N queued` line.
 * The rows are the controller's `state.sessions`, kept live by its list
 * feed; a row is named by the `key` the controller gave it.
 *
 * ✎ or a double-click on the title renames inline (Enter saves, Esc
 * cancels, leaving the field saves); 🗑 asks `Delete "<title>"?` with the
 * browser's `confirm` and deletes through the controller. Selecting a row
 * never waits for or stops a turn (R6-49).
 */
import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';

import {
  uiTexts,
  uiTextOf,
} from '../../../resources/agent-host/impl/gateway/protocol.js';
import {
  countsLabel,
  lifecycleNote,
  runtimeLabel,
  sessionStatusOf,
  statusLabels,
} from './rows.js';

/**
 * The browser's `confirm`; absent (no window): nothing is deleted.
 *
 * @param {string} text
 */
const confirmed = text => {
  const ask = /** @type {any} */ (globalThis).confirm;
  return typeof ask === 'function' ? Boolean(ask(text)) : false;
};

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   open: boolean,
 * }} props
 */
export const Sidebar = ({ state, controller, open }) => {
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  const [draft, setDraft] = useState('');
  // The key being renamed, read by handlers of an older render (a blur
  // after Escape must not save).
  const editingRef = useRef(/** @type {string | null} */ (null));

  /** @param {any} row */
  const beginRename = row => {
    editingRef.current = row.key;
    setEditing(row.key);
    setDraft(row.title);
  };
  const cancelRename = () => {
    editingRef.current = null;
    setEditing(null);
  };
  /**
   * @param {any} row
   * @param {string} value
   */
  const commitRename = (row, value) => {
    if (editingRef.current !== row.key) return;
    editingRef.current = null;
    setEditing(null);
    const title = value.trim();
    if (title !== '' && title !== row.title) {
      controller.renameSession(row.key, title);
    }
  };
  /** @param {any} row */
  const remove = row => {
    if (confirmed(uiTextOf.confirmDelete(row.title))) {
      controller.deleteSession(row.key);
    }
  };

  /** @param {any} row */
  const item = row => {
    const status = sessionStatusOf(row);
    const note = lifecycleNote(row.state);
    const runtime = runtimeLabel(row);
    const isEditing = editing === row.key;
    return h(
      'div',
      {
        key: row.key,
        class: `floot-session-item${row.key === state.activeKey ? ' active' : ''}`,
        'data-key': row.key,
        onClick: () => {
          if (!isEditing) controller.selectSession(row.key);
        },
      },
      h('span', {
        class: `floot-status-dot floot-status-dot-${status}`,
        role: 'img',
        'aria-label': statusLabels[status],
        title: statusLabels[status],
      }),
      h(
        'div',
        { class: 'floot-session-meta' },
        note ? h('div', { class: 'thix-session-note' }, note) : null,
        isEditing
          ? h('input', {
              class: 'floot-session-title-input',
              value: draft,
              autofocus: true,
              /** @param {any} event */
              onClick: event => event.stopPropagation(),
              /** @param {any} event */
              onInput: event => setDraft(event.target.value),
              /** @param {any} event */
              onKeyDown: event => {
                if (event.key === 'Enter')
                  commitRename(row, event.target.value);
                else if (event.key === 'Escape') cancelRename();
              },
              /** @param {any} event */
              onBlur: event => commitRename(row, event.target.value),
            })
          : h(
              'div',
              {
                class: 'floot-session-name',
                /** @param {any} event */
                onDblClick: event => {
                  event.stopPropagation();
                  beginRename(row);
                },
              },
              row.title,
            ),
        runtime
          ? h(
              'div',
              { class: 'floot-session-runtime', title: runtime },
              runtime,
            )
          : null,
        h('div', { class: 'floot-session-sub' }, countsLabel(row)),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'floot-row-btn',
          'aria-label': 'Rename',
          /** @param {any} event */
          onClick: event => {
            event.stopPropagation();
            beginRename(row);
          },
        },
        '✎',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'floot-row-btn',
          'aria-label': 'Delete',
          /** @param {any} event */
          onClick: event => {
            event.stopPropagation();
            remove(row);
          },
        },
        '🗑',
      ),
    );
  };

  const rows = /** @type {any[]} */ (state.sessions);
  return h(
    'aside',
    {
      id: 'thix-session-sidebar',
      class: `floot-sidebar${open ? ' open' : ''}`,
    },
    h(
      'div',
      { class: 'floot-sidebar-head' },
      h('span', { class: 'floot-sidebar-title' }, uiTexts.sessions),
      h(
        'button',
        {
          type: 'button',
          class: 'floot-new-btn',
          'aria-label': uiTexts.newSession,
          onClick: () => controller.openNewSession(),
        },
        '+',
      ),
    ),
    h(
      'div',
      { class: 'floot-session-list' },
      rows.length > 0
        ? rows.slice().reverse().map(item)
        : h('div', { class: 'floot-session-empty' }, uiTexts.noSessions),
    ),
  );
};
