// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import {
  ProviderModelFields,
  automaticModels,
  firstModel,
  isFaeRoute,
} from './ProviderModelFields.js';
import { SessionSidebar } from './SessionSidebar.js';
import { MessageList } from './MessageList.js';
import { ComposeBar } from './ComposeBar.js';
import { SettingsPanel } from './SettingsPanel.js';
import { RecoveryPanel } from './RecoveryPanel.js';
import {
  accountBlocked,
  accountChip,
  accountsOfSession,
} from './account-label.js';
import { usageLabel } from './usage-label.js';

/** @import { VNode } from 'preact' */
/** @import { FlootController, FlootPreset, FlootModel, FlootCatalog, FlootSafeEvent } from './types.js' */

// Floot voice-assistant space as a PURE confined Preact component. The host
// (packages/chat/floot-component.js) owns the imperative engine — mic capture,
// Web Audio, the VAD loop, the background-turn registry, CapTP resolution — and
// passes it down as a `controller` (pure-data snapshots + callbacks). Nothing
// here touches the DOM or any audio/browser API; see DESIGN.md.

// Re-render whenever the host controller's state changes. The controller
// instance is stable for the mount, so the subscription is mount-once.
/** @param {FlootController} controller */
const useControllerState = controller => {
  const [, setTick] = useState(0);
  // Mount-once: the controller instance is stable for this mount.
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setTick(t => t + 1));
    // Initial CapTP reads can finish between render and effect installation.
    // Re-read after subscribing so that notification gap cannot strand loading.
    setTick(t => t + 1);
    return unsubscribe;
  }, []);
  return controller.getState();
};

/**
 * @param {{presets: FlootPreset[], models: FlootModel[], catalogs?: FlootCatalog[],
 * discoveryError?: string, onPick: FlootController['newSession'], onClose: () => void}} props
 */
const PresetModal = ({
  presets,
  models,
  catalogs,
  discoveryError,
  onPick,
  onClose,
}) => {
  const [presetId, setPresetId] = useState(presets[0]?.id || '');
  const [networkOverride, setNetworkOverride] = useState(
    /** @type {boolean | undefined} */ (undefined),
  );
  const [override, setOverride] = useState(
    /** @type {{backendId: string, modelId: string} | null} */ (null),
  );
  const preset = presets.find(p => p.id === presetId) || presets[0];
  const canEnableNetwork =
    preset?.supportedNetworkPolicies?.includes('public-internet') === true;
  const online =
    canEnableNetwork && (networkOverride ?? preset.networkPolicy !== 'off');
  const offered = automaticModels(models);
  const preferred = firstModel(offered);
  const backendId =
    override?.backendId ??
    (preset?.backendId ||
      preferred?.backendId ||
      catalogs?.find(c => isFaeRoute(c.backendId))?.backendId ||
      '');
  const modelId =
    override?.modelId ??
    (preset?.backendId
      ? preset.modelId ||
        offered.find(m => m.backendId === backendId && m.default)?.modelId ||
        ''
      : preferred?.modelId || '');
  const selected = offered.find(
    m => m.backendId === backendId && m.modelId === modelId,
  );
  const matchesPreset =
    backendId === preset?.backendId && modelId === preset.modelId;
  const effort = matchesPreset ? preset.reasoningEffort : undefined;
  const missingEffort =
    !!effort && !selected?.reasoningEfforts?.includes(effort);
  return h(
    'div',
    { class: 'floot-modal-backdrop', onClick: onClose },
    h(
      'div',
      {
        class: 'floot-modal',
        onClick: (/** @type {FlootSafeEvent} */ e) => e.stopPropagation(),
      },
      h('div', { class: 'floot-modal-title' }, 'Start a new session'),
      presets.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Preset'),
            h(
              'select',
              {
                class: 'floot-model-select',
                'aria-label': 'Preset',
                value: preset?.id,
                onChange: (/** @type {FlootSafeEvent} */ e) => {
                  setPresetId(e.target.value);
                  setOverride(null);
                  setNetworkOverride(undefined);
                },
              },
              presets.map(p =>
                h('option', { key: p.id, value: p.id }, p.title),
              ),
            ),
            preset?.description ? h('small', null, preset.description) : null,
          )
        : null,
      h(ProviderModelFields, {
        key: JSON.stringify([preset?.id, backendId]),
        models,
        catalogs,
        backendId,
        modelId,
        discoveryError,
        onChange: (route, id) => setOverride({ backendId: route, modelId: id }),
      }),
      h(
        'label',
        { class: 'floot-preset-object' },
        h('input', {
          type: 'checkbox',
          'aria-label': 'Internet access',
          checked: online,
          disabled: !canEnableNetwork,
          onChange: (/** @type {FlootSafeEvent} */ e) =>
            setNetworkOverride(e.target.checked),
        }),
        'Internet access',
      ),
      !override && preset?.backendId && !modelId
        ? h(
            'small',
            { role: 'status' },
            'The saved provider’s configured model is unavailable.',
          )
        : null,
      missingEffort
        ? h(
            'small',
            { role: 'status' },
            `Saved reasoning effort "${effort}" is unavailable for this model.`,
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'floot-start-session',
          disabled: !selected || missingEffort,
          onClick: () => {
            if (selected && !missingEffort)
              onPick({
                presetId: preset?.id,
                backendId,
                modelId,
                reasoningEffort: effort,
                ...(preset?.supportedNetworkPolicies
                  ? { networkPolicy: online ? 'public-internet' : 'off' }
                  : {}),
              });
          },
        },
        'Start session',
      ),
    ),
  );
};
harden(PresetModal);

/**
 * @param {{ controller: FlootController }} props
 * @returns {VNode}
 */
export const FlootApp = ({ controller }) => {
  const state = useControllerState(controller);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Debug view: reveal each turn's raw structured output (assistant content,
  // tool calls and results) as JSON. Local to this mount — a pure view toggle
  // over the same snapshot, so it needs no controller/host plumbing.
  const [debug, setDebug] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  const {
    sessions,
    activeSessionId,
    presets,
    models,
    catalogs = [],
    discoveryError = '',
    usage,
    status,
  } = state;
  const active = sessions.find(s => s.id === activeSessionId);

  const onNew = () => {
    // What the backends list now, not what they listed at load.
    controller.refreshDiscovery?.();
    setModalOpen(true);
  };
  /** @type {FlootController['newSession']} */
  const pickPreset = selection => {
    setModalOpen(false);
    setDrawerOpen(false);
    controller.newSession(selection);
  };

  const commitTitle = () => {
    const title = titleDraft.trim();
    setTitleEditing(false);
    if (title && active) controller.renameSession(active.id, title);
  };

  const tokenLabel = usageLabel(usage);
  // What the account behind this session's backend has left. Worded from the
  // last reading at render time, so a window past its reset reads as empty.
  const accountNow = Date.now();
  const sessionAccounts = accountsOfSession(state.accounts, active);
  // A session pinned to one subscription, or on a backend that has one, shows
  // that account. An automatic session on a backend with several may be served
  // by any of them, so each is shown under its label.
  const account = sessionAccounts.length === 1 ? sessionAccounts[0] : undefined;
  const accountLabel =
    sessionAccounts.length > 1
      ? sessionAccounts
          .map(entry => {
            const chip = accountChip(entry, accountNow);
            return chip ? `${entry.label || entry.title}: ${chip}` : '';
          })
          .filter(Boolean)
          .join(' | ')
      : accountChip(account, accountNow);

  // Historical interruption evidence belongs in details. Current execution
  // failures and approvals have their own actionable controls.
  const journalButton = state.recovery
    ? h(
        'button',
        {
          type: 'button',
          class: `floot-header-btn chip${recoveryOpen ? ' on' : ''}`,
          'aria-label': 'Turn journal and recovery',
          'aria-pressed': recoveryOpen ? 'true' : 'false',
          title: 'Session details',
          onClick: () => {
            setRecoveryOpen(!recoveryOpen);
            controller.refreshRecovery?.();
          },
        },
        'Details',
      )
    : null;
  const networkButton = state.network?.request
    ? h(
        'button',
        {
          type: 'button',
          class: 'floot-header-btn chip attention',
          'aria-label': 'Network approval requested',
          title:
            'The agent asked for sandbox network access; decide in settings',
          onClick: () => {
            setRecoveryOpen(false);
            if (!state.settingsOpen) controller.toggleSettings();
            controller.refreshNetworkPolicy?.();
          },
        },
        'Network',
        h('span', { class: 'floot-header-badge' }, 'approval requested'),
      )
    : null;

  const header = h(
    'div',
    { class: 'floot-header' },
    h(
      'button',
      {
        type: 'button',
        class: 'floot-menu-btn',
        'aria-label': 'Sessions',
        onClick: () => setDrawerOpen(o => !o),
      },
      '☰',
    ),
    titleEditing
      ? h('input', {
          class: 'floot-header-title-input',
          value: titleDraft,
          autofocus: true,
          onInput: (/** @type {FlootSafeEvent} */ e) =>
            setTitleDraft(e.target.value),
          onKeyDown: (/** @type {FlootSafeEvent} */ e) => {
            if (e.key === 'Enter') commitTitle();
            else if (e.key === 'Escape') setTitleEditing(false);
          },
          onBlur: commitTitle,
        })
      : h(
          'div',
          {
            class: 'floot-header-title',
            title: 'Double-click to rename',
            onDblClick: () => {
              if (!active) return;
              setTitleDraft(active.title);
              setTitleEditing(true);
            },
          },
          active ? active.title : 'Floot',
        ),
    networkButton,
    journalButton,
    h(
      'button',
      {
        type: 'button',
        class: `floot-header-btn${debug ? ' on' : ''}`,
        'aria-label': 'Toggle raw debug view',
        'aria-pressed': debug ? 'true' : 'false',
        title: 'Raw model output (debug)',
        onClick: () => setDebug(d => !d),
      },
      '</>',
    ),
    h(
      'button',
      {
        type: 'button',
        class: `floot-header-btn${state.settingsOpen ? ' on' : ''}`,
        'aria-label': 'Settings & transcription',
        onClick: () => {
          setRecoveryOpen(false);
          controller.toggleSettings();
        },
      },
      '⚙',
    ),
  );

  const statusBar = h(
    'div',
    { class: 'floot-status-bar' },
    h('span', null, status || ''),
    h(
      'span',
      { class: 'floot-tokens' },
      accountLabel
        ? h(
            'span',
            {
              class: `floot-account${
                sessionAccounts.length > 0 &&
                sessionAccounts.every(entry =>
                  accountBlocked(entry, accountNow),
                )
                  ? ' blocked'
                  : ''
              }`,
              title: `${sessionAccounts[0]?.title || ''} subscription`,
            },
            accountLabel,
          )
        : null,
      accountLabel && tokenLabel ? ' · ' : '',
      tokenLabel,
    ),
  );

  return h(
    'div',
    { class: 'floot-app' },
    h(SessionSidebar, {
      state,
      controller,
      open: drawerOpen,
      onNew,
      onAfterSelect: () => setDrawerOpen(false),
    }),
    h('div', {
      class: `floot-backdrop${drawerOpen ? ' open' : ''}`,
      onClick: () => setDrawerOpen(false),
    }),
    h(
      'div',
      { class: 'floot-main' },
      header,
      recoveryOpen && state.recovery
        ? h(RecoveryPanel, {
            key: activeSessionId || '',
            recovery: state.recovery,
            controller,
          })
        : state.settingsOpen
          ? h(SettingsPanel, { state, controller })
          : h(MessageList, { state, controller, debug }),
      statusBar,
      h(ComposeBar, { state, controller }),
    ),
    modalOpen
      ? h(PresetModal, {
          presets,
          models,
          catalogs,
          discoveryError,
          onPick: pickPreset,
          onClose: () => setModalOpen(false),
        })
      : null,
  );
};
harden(FlootApp);
