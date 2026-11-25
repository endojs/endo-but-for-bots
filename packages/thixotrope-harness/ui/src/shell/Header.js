// @ts-check
/**
 * The header (R6-37, R6-61; m3-interfaces.md 9.3): ☰ (narrow screens), the
 * active session's title (a button: click, Enter or Space renames, Enter
 * saves, Esc cancels, and focus returns to the title), `header.chip`
 * features and the Settings control, which opens and closes the Settings
 * view (`Settings.js`: the `app.panel` features and the session's
 * `session.settings`) with or without a session open (not while a subagent
 * is inspected, which shows no features). The header keeps one line
 * (`flex-wrap: nowrap`); the title truncates.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import {
  uiTexts,
  uiTextOf,
} from '../../../resources/agent-host/impl/gateway/protocol.js';
import { settingsTexts, settingsToggleId } from './Settings.js';
import { Slot } from './Slot.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 *   narrow: boolean,
 *   sidebarOpen: boolean,
 *   toggleSidebar: () => void,
 *   inventoryOpen: boolean,
 *   toggleInventory?: () => void,
 * }} props
 */
export const Header = ({
  state,
  controller,
  features,
  context,
  narrow,
  sidebarOpen,
  toggleSidebar,
  inventoryOpen,
  toggleInventory,
}) => {
  const [editing, setEditing] = useState(/** @type {string | null} */ (null));
  // Set by Enter and Esc: put focus back on the title once it is a button.
  const refocus = useRef(false);
  const titleRef = useRef(/** @type {any} */ (null));
  useLayoutEffect(() => {
    if (!refocus.current || !titleRef.current) return;
    refocus.current = false;
    titleRef.current.focus();
  });
  // Opening the field moves focus into it: `autofocus` is ignored for an
  // element inserted while another one (the title button) has focus.
  const inputRef = useRef(/** @type {any} */ (null));
  const isEditing = editing !== null;
  useLayoutEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);
  const view = state.view;
  const title = view ? view.info.title : uiTexts.pageTitle;
  const commit = () => {
    if (editing === null) return;
    const next = editing.trim();
    setEditing(null);
    if (next !== '' && view && next !== view.info.title && state.activeKey) {
      controller.renameSession(state.activeKey, next);
    }
  };
  return h(
    'div',
    { class: 'floot-header' },
    narrow
      ? h(
          'button',
          {
            type: 'button',
            class: 'floot-menu-btn thix-menu-btn',
            'aria-label': uiTexts.sessions,
            'aria-controls': 'thix-session-sidebar',
            'aria-expanded': sidebarOpen,
            onClick: toggleSidebar,
          },
          '☰',
        )
      : null,
    toggleInventory
      ? h(
          'button',
          {
            type: 'button',
            class: 'floot-header-btn thix-inventory-toggle',
            'aria-label': 'Agent inventory',
            title: inventoryOpen
              ? 'Hide agent inventory'
              : 'Show agent inventory',
            'aria-expanded': inventoryOpen,
            'aria-controls': 'thix-agent-inventory-items',
            onClick: toggleInventory,
          },
          h('span', { 'aria-hidden': 'true' }, inventoryOpen ? '‹' : '›'),
          ' Inventory',
        )
      : null,
    state.sessionPath?.[1]
      ? h(
          'nav',
          { class: 'thix-session-path', 'aria-label': 'Session path' },
          state.sessionPath.map(
            (
              /** @type {{key:string,title:string,name?:string}} */ step,
              /** @type {number} */ index,
            ) =>
              index === state.sessionPath.length - 1
                ? h(
                    'span',
                    {
                      key: step.key,
                      'aria-current': 'page',
                      title: step.title,
                    },
                    step.name ?? step.title,
                  )
                : h(
                    'button',
                    {
                      key: step.key,
                      type: 'button',
                      title: step.title,
                      'aria-label': step.title,
                      onClick: () => controller.openAncestor(step.key),
                    },
                    step.name ?? step.title,
                  ),
          ),
        )
      : editing !== null
        ? h('input', {
            class: 'floot-header-title-input',
            ref: inputRef,
            value: editing,
            autofocus: true,
            /** @param {any} event */
            onInput: event => setEditing(event.target.value),
            'aria-label': uiTextOf.renameSession(title),
            /** @param {any} event */
            onKeyDown: event => {
              if (event.key === 'Enter') {
                refocus.current = true;
                commit();
              } else if (event.key === 'Escape') {
                refocus.current = true;
                setEditing(null);
              }
            },
            onBlur: commit,
          })
        : view
          ? h(
              'button',
              {
                type: 'button',
                class: 'floot-header-title',
                ref: titleRef,
                title,
                'aria-label': uiTextOf.renameSession(title),
                onClick: () => setEditing(view.info.title),
              },
              title,
            )
          : h('div', { class: 'floot-header-title' }, title),
    h(Slot, { slot: 'header.chip', features, context, class: 'thix-chips' }),
    state.sessionPath?.[1]
      ? null
      : h(
          'button',
          {
            type: 'button',
            id: settingsToggleId,
            class: `floot-header-btn thix-settings-toggle${state.settings ? ' on' : ''}`,
            'aria-label': settingsTexts.title,
            title: state.settings ? settingsTexts.close : settingsTexts.open,
            'aria-expanded': Boolean(state.settings),
            // The view exists only while open.
            'aria-controls': state.settings ? 'thix-settings' : undefined,
            onClick: () => controller.toggleSettings(),
          },
          h('span', { 'aria-hidden': 'true' }, '⚙'),
          h('span', { class: 'thix-settings-label' }, settingsTexts.title),
        ),
  );
};
