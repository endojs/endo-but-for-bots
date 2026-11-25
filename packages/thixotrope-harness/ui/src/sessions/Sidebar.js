// @ts-check
/**
 * The session sidebar (R6-36, R6-37; m3-interfaces.md 9.3; W3.5), adapted
 * from `space-floot` `SessionSidebar.js`: "Sessions" with New session (+),
 * "No sessions yet" when empty, one row per session with its status circle,
 * title, `backend · model · effort` line and `N messages · N queued` line.
 * The rows are the controller's `state.sessions`, kept live by its list
 * feed; a row is named by the `key` the controller gave it.
 *
 * Each row is a button that opens the session (`aria-current` on the open
 * one), followed by Rename and Delete buttons; all three are in the tab
 * order, and the two actions show while the row is hovered or holds focus.
 * Rename or a double-click on the title renames inline (Enter saves, Esc
 * cancels, leaving the field saves). Delete asks `Delete "<title>"?` in an
 * inline row (Delete / Cancel; Esc cancels) and deletes through the
 * controller. Focus returns to the row after a rename or a cancelled delete.
 * Selecting a row never waits for or stops a turn (R6-49).
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import {
  uiTexts,
  uiTextOf,
} from '../../../resources/agent-host/impl/gateway/protocol.js';
import { icon } from '../shell/icons.js';
import {
  countsLabel,
  lifecycleNote,
  runtimeLabel,
  sessionStatusOf,
  statusLabels,
} from './rows.js';

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
  const [confirming, setConfirming] = useState(
    /** @type {string | null} */ (null),
  );
  // The key being renamed, read by handlers of an older render (a blur
  // after Escape must not save).
  const editingRef = useRef(/** @type {string | null} */ (null));
  const asideRef = useRef(/** @type {any} */ (null));
  // A selector, inside the sidebar, to focus after the next render.
  const focusNext = useRef(/** @type {string | null} */ (null));
  useLayoutEffect(() => {
    const selector = focusNext.current;
    if (selector === null || !asideRef.current) return;
    focusNext.current = null;
    asideRef.current.querySelector(selector)?.focus();
  });
  /**
   * @param {string} key
   * @param {string} action
   */
  const refocus = (key, action) => {
    focusNext.current = `[data-key="${key}"] [data-action="${action}"]`;
  };

  /** @param {any} row */
  const beginRename = row => {
    editingRef.current = row.key;
    setConfirming(null);
    setEditing(row.key);
    setDraft(row.title);
  };
  /** @param {any} row */
  const cancelRename = row => {
    editingRef.current = null;
    refocus(row.key, 'open');
    setEditing(null);
  };
  /**
   * @param {any} row
   * @param {string} value
   * @param {boolean} [keyboard] keep focus on the row (Enter, not blur)
   */
  const commitRename = (row, value, keyboard = false) => {
    if (editingRef.current !== row.key) return;
    editingRef.current = null;
    if (keyboard) refocus(row.key, 'open');
    setEditing(null);
    const title = value.trim();
    if (title !== '' && title !== row.title) {
      controller.renameSession(row.key, title);
    }
  };
  /** @param {any} row */
  const askDelete = row => {
    refocus(row.key, 'cancel-delete');
    setConfirming(row.key);
  };
  /** @param {any} row */
  const cancelDelete = row => {
    refocus(row.key, 'delete');
    setConfirming(null);
  };
  /** @param {any} row */
  const remove = row => {
    setConfirming(null);
    controller.deleteSession(row.key);
  };

  /** @param {any} event */
  const stop = event => event.stopPropagation();

  /** @param {any} row */
  const item = row => {
    const status = sessionStatusOf(row);
    const note = lifecycleNote(row.state);
    const runtime = runtimeLabel(row);
    const isEditing = editing === row.key;
    const isConfirming = confirming === row.key;
    const active = row.key === (state.sessionPath?.[0]?.key ?? state.activeKey);
    const body = [
      h('span', {
        class: `floot-status-dot floot-status-dot-${status}`,
        role: 'img',
        'aria-label': statusLabels[status],
        title: statusLabels[status],
      }),
      h(
        'span',
        { class: 'floot-session-meta' },
        note ? h('span', { class: 'thix-session-note' }, note) : null,
        isEditing
          ? h('input', {
              class: 'floot-session-title-input',
              value: draft,
              autofocus: true,
              'aria-label': uiTextOf.renameSession(row.title),
              onClick: stop,
              /** @param {any} event */
              onInput: event => setDraft(event.target.value),
              /** @param {any} event */
              onKeyDown: event => {
                if (event.key === 'Enter') {
                  commitRename(row, event.target.value, true);
                } else if (event.key === 'Escape') cancelRename(row);
              },
              /** @param {any} event */
              onBlur: event => commitRename(row, event.target.value),
            })
          : h(
              'span',
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
              'span',
              { class: 'floot-session-runtime', title: runtime },
              runtime,
            )
          : null,
        h('span', { class: 'floot-session-sub' }, countsLabel(row)),
      ),
    ];
    /**
     * @param {string} name the button's data-action
     * @param {string} label
     * @param {string} iconName
     * @param {() => void} onClick
     */
    const rowButton = (name, label, iconName, onClick) =>
      h(
        'button',
        {
          type: 'button',
          class: 'floot-row-btn',
          'data-action': name,
          'aria-label': label,
          title: label,
          /** @param {any} event */
          onClick: event => {
            event.stopPropagation();
            onClick();
          },
        },
        icon(iconName, 14),
      );
    return h(
      'div',
      {
        key: row.key,
        class: `floot-session-item${active ? ' active' : ''}`,
        'data-key': row.key,
        // The whole row is the pointer target; the open button inside is
        // the keyboard's, and its click arrives here too.
        onClick: () => {
          if (!isEditing) controller.selectSession(row.key);
        },
      },
      isEditing
        ? h('span', { class: 'floot-session-open' }, ...body)
        : h(
            'button',
            {
              type: 'button',
              class: 'floot-session-open',
              'data-action': 'open',
              'aria-current': active ? 'true' : undefined,
            },
            ...body,
          ),
      rowButton('rename', uiTextOf.renameSession(row.title), 'pencil', () =>
        beginRename(row),
      ),
      rowButton('delete', uiTextOf.deleteSession(row.title), 'trash', () =>
        askDelete(row),
      ),
      isConfirming
        ? h(
            'div',
            {
              class: 'thix-row-confirm',
              'data-form': 'delete',
              role: 'group',
              'aria-label': uiTextOf.confirmDelete(row.title),
              onClick: stop,
              /** @param {any} event */
              onKeyDown: event => {
                if (event.key === 'Escape') cancelDelete(row);
              },
            },
            h(
              'span',
              { class: 'thix-row-confirm-text' },
              uiTextOf.confirmDelete(row.title),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'thix-row-confirm-btn danger',
                'data-action': 'confirm-delete',
                onClick: () => remove(row),
              },
              uiTexts.delete,
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'thix-row-confirm-btn',
                'data-action': 'cancel-delete',
                onClick: () => cancelDelete(row),
              },
              uiTexts.cancel,
            ),
          )
        : null,
    );
  };

  const rows = /** @type {any[]} */ (state.sessions);
  return h(
    'aside',
    {
      id: 'thix-session-sidebar',
      class: `floot-sidebar${open ? ' open' : ''}`,
      ref: asideRef,
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
          title: uiTexts.newSession,
          onClick: () => controller.openNewSession(),
        },
        icon('plus', 18),
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
