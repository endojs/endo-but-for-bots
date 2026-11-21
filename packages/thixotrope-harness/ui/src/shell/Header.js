// @ts-check
/**
 * The header (R6-37, R6-61; m3-interfaces.md 9.3): ☰ (narrow screens), the
 * active session's title (double-click to rename: Enter saves, Esc
 * cancels), `header.chip` features, a button per `app.panel` feature (its
 * `label`), and the session settings toggle.
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { Slot, visibleFeatures } from './Slot.js';

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
  const panels = visibleFeatures(features, 'app.panel', context);
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
            value: editing,
            autofocus: true,
            /** @param {any} event */
            onInput: event => setEditing(event.target.value),
            /** @param {any} event */
            onKeyDown: event => {
              if (event.key === 'Enter') commit();
              else if (event.key === 'Escape') setEditing(null);
            },
            onBlur: commit,
          })
        : h(
            'div',
            {
              class: 'floot-header-title',
              title: view ? 'Double-click to rename' : undefined,
              onDblClick: () => {
                if (view) setEditing(view.info.title);
              },
            },
            title,
          ),
    h(Slot, { slot: 'header.chip', features, context, class: 'thix-chips' }),
    panels.map(feature =>
      h(
        'button',
        {
          key: feature.id,
          type: 'button',
          class: `floot-header-btn chip${state.panel === feature.id ? ' on' : ''}`,
          'data-panel': feature.id,
          onClick: () =>
            state.panel === feature.id
              ? controller.closePanel()
              : controller.openPanel(feature.id),
        },
        feature.label ?? feature.id,
      ),
    ),
    view && !state.sessionPath?.[1]
      ? h(
          'button',
          {
            type: 'button',
            class: `floot-header-btn${state.settingsOpen ? ' on' : ''}`,
            'aria-label': 'Settings',
            onClick: () => controller.toggleSettings(),
          },
          '⚙',
        )
      : null,
  );
};
