// @ts-check
/**
 * The header (R6-37, R6-61; m3-interfaces.md 9.3): ☰ (narrow screens), the
 * active session's title (double-click to rename: Enter saves, Esc
 * cancels), `header.chip` features, a button per `app.panel` feature (its
 * `label`), and the session settings toggle.
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/contract-m3.js';
import { Slot, visibleFeatures } from './Slot.js';

/** @import { UiFeature, FeatureContext } from '../../../resources/agent-host/impl/gateway/contract-m3.js' */

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly UiFeature[],
 *   context: FeatureContext,
 *   narrow: boolean,
 * }} props
 */
export const Header = ({ state, controller, features, context, narrow }) => {
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
            'aria-expanded': state.drawerOpen ? 'true' : 'false',
            onClick: () => controller.toggleDrawer(),
          },
          '☰',
        )
      : null,
    editing !== null
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
    view
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
