// @ts-check
/**
 * The app shell (m3-interfaces.md 9, 17; W3.4): overlay, sidebar (a drawer
 * at `drawerMaxWidthPx` or less, R6-61), header, the main region (an open
 * `app.panel`, the settings panel, the recovery panel or the conversation),
 * the status bar and the composer. It renders the controller's state as it
 * is; it calls no daemon method itself.
 *
 * Region views come from the directories that own them (`views`):
 * `sessions` (W3.5: `Sidebar`, `NewSession`) and `conversation` (W3.6:
 * `Conversation`, `Composer`, `Recovery`). Each receives
 * `{ state, controller, features, context, narrow }`; `Sidebar` also gets
 * `open`. A missing view leaves its region with the shell's bare frame.
 */
import { h } from 'preact';
import { useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { Header } from './Header.js';
import { Overlay } from './Overlay.js';
import { FeatureHost, Slot } from './Slot.js';
import { StatusBar } from './StatusBar.js';

/** @import { UiFeature } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * @typedef {object} ShellViews
 * @property {Record<string, any>} [sessions] `ui/src/sessions/index.js`
 * @property {Record<string, any>} [conversation] `ui/src/conversation/index.js`
 */

/**
 * The sidebar frame while `ui/src/sessions/` has no view.
 *
 * @param {{ open: boolean, controller: any }} props
 */
const BareSidebar = ({ open, controller }) =>
  h(
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
  );

/**
 * @param {{
 *   controller: any,
 *   features: readonly UiFeature[],
 *   views?: ShellViews,
 *   narrow?: boolean,
 * }} props
 */
export const App = ({ controller, features, views = {}, narrow = false }) => {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const state = controller.getState();
  const context = controller.featureContext();
  const sessions = views.sessions ?? {};
  const conversation = views.conversation ?? {};
  const inspecting = Boolean(state.sessionPath?.[1]);
  const shared = {
    state,
    controller,
    features: inspecting ? [] : features,
    context,
    narrow,
  };
  const drawerOpen = narrow && state.drawerOpen;
  const sidebarOpen = !narrow || drawerOpen;

  const panel =
    state.panel === undefined
      ? undefined
      : features.find(
          feature => feature.slot === 'app.panel' && feature.id === state.panel,
        );

  const inventory =
    state.activeKey && !panel && sessions.SessionInventory
      ? h(sessions.SessionInventory, {
          state,
          controller,
          expanded: inventoryOpen,
        })
      : null;

  /** @returns {any} */
  const body = () => {
    if (panel) {
      return h(
        'div',
        { class: 'thix-panel', 'data-panel': panel.id },
        h(FeatureHost, { key: panel.id, feature: panel, props: { context } }),
      );
    }
    if (!state.view) {
      return h(
        'div',
        { class: 'thix-empty' },
        h(
          'button',
          {
            type: 'button',
            class: 'thix-start-btn',
            onClick: () => controller.openNewSession(),
          },
          uiTexts.startNewSession,
        ),
      );
    }
    if (state.settingsOpen) {
      return h(
        'div',
        { class: 'thix-settings' },
        h(Slot, { slot: 'session.settings', features, context }),
      );
    }
    if (state.recovery && conversation.Recovery) {
      return h(conversation.Recovery, shared);
    }
    return conversation.Conversation
      ? h(conversation.Conversation, shared)
      : h('div', { class: 'floot-messages' });
  };

  return h(
    'div',
    {
      class: `floot-app thix-app${narrow ? ' narrow' : ''}`,
      'data-sidebar': sidebarOpen ? 'open' : 'closed',
      'data-drawer': narrow ? (drawerOpen ? 'open' : 'closed') : 'none',
    },
    h(Overlay, {
      connection: state.connection,
      message: state.connectionMessage,
    }),
    sessions.Sidebar
      ? h(sessions.Sidebar, { ...shared, open: sidebarOpen })
      : h(BareSidebar, { open: sidebarOpen, controller }),
    drawerOpen
      ? h('div', {
          class: 'floot-backdrop open',
          onClick: () => controller.toggleDrawer(),
        })
      : null,
    h(
      'div',
      { class: 'floot-main' },
      h(Header, {
        ...shared,
        sidebarOpen,
        toggleSidebar: () => controller.toggleDrawer(),
        inventoryOpen,
        toggleInventory:
          state.activeKey && !panel && sessions.SessionInventory
            ? () => setInventoryOpen(open => !open)
            : undefined,
      }),
      h(
        'div',
        { class: 'thix-session-body' },
        inventory,
        h(
          'div',
          { class: 'thix-session-content' },
          body(),
          h(StatusBar, shared),
          state.view && !inspecting && !panel && conversation.Composer
            ? h(conversation.Composer, shared)
            : null,
        ),
      ),
    ),
    state.newSessionOpen && sessions.NewSession
      ? h(sessions.NewSession, shared)
      : null,
  );
};
