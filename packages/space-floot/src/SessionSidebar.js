// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useState } from 'preact/hooks';

/** @import { VNode } from 'preact' */
/** @import { FlootState, FlootController, FlootSessionMeta, FlootSafeEvent } from './types.js' */

// Short noun shown on the per-session pill: the preset title reads as an action
// ("New project"); the pill wants the capability noun.
const PILL_LABELS = harden({
  'new-project': 'project',
  'full-control': 'endo',
});

const DEFAULT_PRESET_ID = 'general';

// What the status circle says, for a reader who cannot see its colour.
const STATUS_LABELS = harden({
  passive: 'Passive',
  working: 'Working',
  error: 'Error',
});

/**
 * The one of three states a session's status circle shows. Every session has
 * a circle: a session that is doing nothing is `passive`, not blank.
 *
 * A session the factory could not make ready is an error whatever else is
 * known about it, and an unrecognised status reads as passive rather than
 * leaking an arbitrary class name into the view.
 *
 * @param {Pick<FlootSessionMeta, 'status' | 'lifecycle'>} session
 * @returns {'passive' | 'working' | 'error'}
 */
export const sessionStatusOf = session => {
  if (session.lifecycle && session.lifecycle !== 'ready') return 'error';
  if (session.status === 'working' || session.status === 'streaming')
    return 'working';
  if (session.status === 'error') return 'error';
  return 'passive';
};
harden(sessionStatusOf);

/**
 * What a session runs on, for its row: "Backend · Model", with the reasoning
 * effort when the session pins one. Empty when the host reported neither, so
 * an older host draws the row as before.
 *
 * @param {Pick<FlootSessionMeta, 'backendLabel' | 'modelLabel' | 'reasoningEffort'>} session
 * @returns {string}
 */
export const sessionRuntimeLabel = session => {
  const model = [session.modelLabel, session.reasoningEffort]
    .filter(Boolean)
    .join(' ');
  return [session.backendLabel, model].filter(Boolean).join(' · ');
};
harden(sessionRuntimeLabel);

/**
 * @param {{
 *   state: FlootState,
 *   controller: FlootController,
 *   open: boolean,
 *   onNew: () => void,
 *   onAfterSelect: () => void,
 * }} props
 * @returns {VNode}
 */
export const SessionSidebar = ({
  state,
  controller,
  open,
  onNew,
  onAfterSelect,
}) => {
  const { sessions, activeSessionId, presets } = state;
  const [editingId, setEditingId] = useState(
    /** @type {string | null} */ (null),
  );
  const [draft, setDraft] = useState('');

  const pillLabel = (/** @type {string} */ id) => {
    if (PILL_LABELS[id]) return PILL_LABELS[id];
    const preset = presets.find(p => p.id === id);
    return preset ? preset.title : id;
  };

  const beginRename = (/** @type {FlootSessionMeta} */ session) => {
    setEditingId(session.id);
    setDraft(session.title);
  };
  const commitRename = (/** @type {string} */ id) => {
    const title = draft.trim();
    setEditingId(null);
    if (title) controller.renameSession(id, title);
  };

  const select = (/** @type {string} */ id) => {
    if (state.busy) return; // don't switch context mid-turn
    controller.selectSession(id);
    onAfterSelect();
  };

  const items = sessions.length
    ? sessions.map(session => {
        const unavailable = session.lifecycle && session.lifecycle !== 'ready';
        const status = sessionStatusOf(session);
        const editing = editingId === session.id;
        const runtime = sessionRuntimeLabel(session);
        return h(
          'div',
          {
            key: session.id,
            class: `floot-session-item${session.id === activeSessionId ? ' active' : ''}`,
            onClick: () => !editing && select(session.id),
          },
          // The modifier is namespaced on purpose. The space renders inside
          // chat's page, whose stylesheet has a global `.error` rule (padding
          // and a border, for error values in messages); a bare `error` class
          // here picked that up and stretched the circle into an ellipse.
          h('span', {
            class: `floot-status-dot floot-status-dot-${status}`,
            role: 'img',
            'aria-label': STATUS_LABELS[status],
            title: STATUS_LABELS[status],
          }),
          h(
            'div',
            { class: 'floot-session-meta' },
            unavailable
              ? h('div', null, `Unavailable: ${session.lifecycle}`)
              : null,
            editing
              ? h('input', {
                  class: 'floot-session-title-input',
                  value: draft,
                  autofocus: true,
                  onClick: (/** @type {FlootSafeEvent} */ e) =>
                    e.stopPropagation(),
                  onInput: (/** @type {FlootSafeEvent} */ e) =>
                    setDraft(e.target.value),
                  onKeyDown: (/** @type {FlootSafeEvent} */ e) => {
                    if (e.key === 'Enter') commitRename(session.id);
                    else if (e.key === 'Escape') setEditingId(null);
                  },
                  onBlur: () => commitRename(session.id),
                })
              : h(
                  'div',
                  {
                    class: 'floot-session-name',
                    onDblClick: (/** @type {FlootSafeEvent} */ e) => {
                      e.stopPropagation();
                      beginRename(session);
                    },
                  },
                  session.title,
                ),
            runtime
              ? h(
                  'div',
                  { class: 'floot-session-runtime', title: runtime },
                  runtime,
                )
              : null,
            h(
              'div',
              { class: 'floot-session-sub' },
              session.messageCount
                ? `${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`
                : session.loaded
                  ? 'empty'
                  : '',
            ),
            session.presetId && session.presetId !== DEFAULT_PRESET_ID
              ? h(
                  'span',
                  { class: 'floot-session-pill' },
                  pillLabel(session.presetId),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'floot-row-btn',
              'aria-label': 'Rename',
              onClick: (/** @type {FlootSafeEvent} */ e) => {
                e.stopPropagation();
                beginRename(session);
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
              onClick: (/** @type {FlootSafeEvent} */ e) => {
                e.stopPropagation();
                controller.deleteSession(session.id);
              },
            },
            '🗑',
          ),
        );
      })
    : [h('div', { class: 'floot-session-empty' }, 'No sessions yet')];

  return h(
    'div',
    { class: `floot-sidebar${open ? ' open' : ''}` },
    h(
      'div',
      { class: 'floot-sidebar-head' },
      h('div', { class: 'floot-sidebar-title' }, 'Sessions'),
      h(
        'button',
        {
          type: 'button',
          class: 'floot-new-btn',
          'aria-label': 'New session',
          onClick: onNew,
        },
        '+',
      ),
    ),
    h('div', { class: 'floot-session-list' }, items),
  );
};
harden(SessionSidebar);
