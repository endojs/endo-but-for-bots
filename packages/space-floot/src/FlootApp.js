// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

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

/** @param {FlootModel | undefined} model */
const maximumEffort = model => {
  const supported = model?.reasoningEfforts || [];
  return (
    ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'].find(
      effort => supported.includes(effort),
    ) ||
    supported.at(-1) ||
    ''
  );
};

/**
 * One line on how a backend's discovery stands, for a picker with nothing
 * (or not everything) to show: which accounts could not be read, and when
 * the rest were.
 *
 * @param {FlootCatalog | undefined} catalog
 */
const discoveryNote = catalog => {
  if (!catalog) return '';
  const accounts = catalog.accounts || [];
  const troubled = accounts.filter(account => account.state !== 'current');
  if (troubled.length === 0) return '';
  const when = (/** @type {number | null} */ at) =>
    typeof at === 'number'
      ? ` (last read ${new Date(at).toLocaleTimeString()})`
      : '';
  const said = troubled.map(account => {
    const who = account.label || account.subscriptionId;
    if (account.state === 'stale')
      return `${who}: provider unreachable, showing an earlier catalog${when(account.observedAt)}`;
    if (account.state === 'unsupported') return `${who}: no model discovery`;
    return `${who}: model discovery unavailable`;
  });
  return `Discovery for ${catalog.backendTitle || catalog.backendId} — ${said.join('; ')}.`;
};

/**
 * @param {{
 *   presets: FlootPreset[],
 *   models: FlootModel[],
 *   catalogs?: FlootCatalog[],
 *   discoveryError?: string,
 *   onPick: (id: string, model: string, reasoningEffort?: string, subscription?: string, networkPolicy?: string) => void,
 *   onClose: () => void,
 * }} props
 * @returns {VNode}
 */
const PresetModal = ({
  presets,
  models,
  catalogs = [],
  discoveryError = '',
  onPick,
  onClose,
}) => {
  /** @param {string} id */
  const modelsOf = id => models.filter(m => (m.backendId || 'provider') === id);
  /**
   * What a backend offers a session on a subscription: the models an account
   * the session may be served from lists — the chosen one's, or, under
   * `auto`, any not set aside. A model with no account information (a
   * factory from before discovery) is offered.
   *
   * @param {string} id
   * @param {string} chosen
   */
  const offeredOf = (id, chosen) => {
    const candidates = modelsOf(id);
    const lanes = new Set(
      (candidates[0]?.subscriptions || [])
        .filter(entry => entry.pinnedOnly === true)
        .map(entry => entry.id),
    );
    return candidates.filter(candidate => {
      const ids = candidate.subscriptionIds;
      if (!Array.isArray(ids) || ids.length === 0) return true;
      return chosen === 'auto'
        ? ids.some(account => !lanes.has(account))
        : ids.includes(chosen);
    });
  };
  /** @param {FlootModel[]} candidates */
  const firstChoice = candidates =>
    candidates.find(m => m.default) || candidates[0];
  // Pre-select the default model's backend and, on it, the first model an
  // `auto` session may be offered, so picking a preset alone still creates a
  // session with a model its account lists.
  const preferredBackend =
    (models.find(m => m.default) || models[0])?.backendId || 'provider';
  const preferred = firstChoice(offeredOf(preferredBackend, 'auto'));
  const [backend, setBackend] = useState(preferredBackend);
  // Backends are those with models and those whose discovery said something,
  // so a backend with nothing to offer is still shown, with why.
  const backends = [
    ...new Set([
      ...models.map(m => m.backendId || 'provider'),
      ...catalogs.map(c => c.backendId),
    ]),
  ];
  const backendCatalog = catalogs.find(c => c.backendId === backend);
  const backendModels = modelsOf(backend);
  // Which of the backend's subscriptions the session uses. `auto` lets the
  // backend drain the one that resets soonest and move a turn when one runs
  // out; a choice here pins the session. Offered only when there is a choice.
  const [subscription, setSubscription] = useState('auto');
  const declared = backendModels[0]?.subscriptions || [];
  // A lane set aside for somebody else's sessions is not offered.
  const subscriptions = declared.filter(entry => entry.pinnedOnly !== true);
  const chosenSubscription = subscriptions.some(
    entry => entry.id === subscription,
  )
    ? subscription
    : 'auto';
  const offeredModels = offeredOf(backend, chosenSubscription);
  // The direct provider runs its configured model, unpinned, when its account
  // lists nothing to choose from: no discovery for that provider kind, or
  // none right now. A hosted backend needs a listed model.
  const unpinnedOffered = backend === 'provider' && offeredModels.length === 0;
  const providerState = backendCatalog?.accounts?.[0]?.state;
  const [modelQuery, setModelQuery] = useState('');
  /**
   * @param {FlootModel} candidate
   * @param {string} query
   */
  const matchesModel = (candidate, query) => {
    const needle = query.trim().toLowerCase();
    return [candidate.title, candidate.id, candidate.modelId || ''].some(
      value => value.toLowerCase().includes(needle),
    );
  };
  const visibleModels = offeredModels.filter(candidate =>
    matchesModel(candidate, modelQuery),
  );
  const [model, setModel] = useState(preferred ? preferred.id : '');
  const [reasoningEffort, setReasoningEffort] = useState(
    maximumEffort(preferred),
  );
  // The list can change under an open picker: discovery is read again when
  // it opens. What is selected is the chosen model while the select still
  // shows it, else the first it shows; the state follows, so a pick never
  // sends a model the select does not show, nor a thinking level the model
  // no longer offers.
  const selectedModel =
    visibleModels.find(candidate => candidate.id === model) ||
    (unpinnedOffered ? undefined : firstChoice(visibleModels));
  const selection = selectedModel?.id || '';
  const reasoningEfforts = selectedModel?.reasoningEfforts || [];
  const effortListed = reasoningEfforts.length
    ? reasoningEfforts.includes(reasoningEffort)
    : reasoningEffort === '';
  useEffect(() => {
    if (selection !== model) {
      setModel(selection);
      setReasoningEffort(maximumEffort(selectedModel));
    } else if (!effortListed) {
      setReasoningEffort(maximumEffort(selectedModel));
    }
  }, [selection, model, effortListed]);
  const [internet, setInternet] = useState(true);
  const networkPolicies = selectedModel?.supportedNetworkPolicies || [];
  const supportsInternet = networkPolicies.includes('public-internet');
  const note =
    discoveryNote(backendCatalog) ||
    (discoveryError ? `Model discovery could not be read: ${discoveryError}` : '');
  return h(
    'div',
    { class: 'floot-modal-backdrop', onClick: onClose },
    h(
      'div',
      // Clicks on the card surface must not reach the dismiss-on-backdrop click.
      {
        class: 'floot-modal',
        onClick: (/** @type {FlootSafeEvent} */ e) => e.stopPropagation(),
      },
      h('div', { class: 'floot-modal-title' }, 'Start a new session'),
      models.length || catalogs.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Backend'),
            h(
              'select',
              {
                class: 'floot-model-select',
                'aria-label': 'Backend',
                value: backend,
                onChange: (/** @type {FlootSafeEvent} */ e) => {
                  // From what an `auto` session may be offered there, not
                  // from a lane's list.
                  const next = firstChoice(offeredOf(e.target.value, 'auto'));
                  setBackend(e.target.value);
                  setModelQuery('');
                  setSubscription('auto');
                  setModel(next?.id || '');
                  setReasoningEffort(maximumEffort(next));
                },
              },
              backends.map(id =>
                h(
                  'option',
                  { key: id, value: id },
                  models.find(m => (m.backendId || 'provider') === id)
                    ?.backendTitle ||
                    catalogs.find(c => c.backendId === id)?.backendTitle ||
                    (id === 'provider' ? 'Fae' : id),
                ),
              ),
            ),
          )
        : null,
      note
        ? h('small', { class: 'floot-discovery-note', role: 'status' }, note)
        : null,
      models.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Search models'),
            h('input', {
              class: 'floot-model-select',
              type: 'search',
              'aria-label': 'Search models',
              placeholder: 'Search by name or model ID',
              value: modelQuery,
              onInput: (/** @type {FlootSafeEvent} */ e) => {
                const query = e.target.value;
                setModelQuery(query);
                const matches = offeredModels.filter(candidate =>
                  matchesModel(candidate, query),
                );
                const next =
                  matches.find(candidate => candidate.id === model) ||
                  matches[0];
                setModel(next?.id || '');
                if (next?.id !== model) {
                  setReasoningEffort(maximumEffort(next));
                }
              },
            }),
          )
        : null,
      models.length || catalogs.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Model'),
            h(
              'select',
              {
                class: 'floot-model-select',
                'aria-label': 'Model',
                value: selection,
                disabled: visibleModels.length === 0 && !unpinnedOffered,
                onChange: (/** @type {FlootSafeEvent} */ e) => {
                  const next = models.find(
                    candidate => candidate.id === e.target.value,
                  );
                  setModel(e.target.value);
                  setReasoningEffort(maximumEffort(next));
                },
              },
              unpinnedOffered
                ? h(
                    'option',
                    { key: '', value: '' },
                    `Configured model — ${
                      providerState === 'unsupported'
                        ? 'no discovery'
                        : providerState === 'current' ||
                            providerState === 'stale'
                          ? 'none listed'
                          : 'discovery unavailable'
                    }`,
                  )
                : visibleModels.map(m =>
                    h(
                      'option',
                      { key: m.id, value: m.id },
                      `${m.title} — ${m.modelId || m.id}${m.default ? ' (default)' : ''}`,
                    ),
                  ),
            ),
            h(
              'small',
              { role: 'status', 'aria-live': 'polite' },
              unpinnedOffered
                ? providerState === 'unsupported'
                  ? 'No model discovery for this provider kind; the configured model runs unpinned.'
                  : providerState === 'current' || providerState === 'stale'
                    ? 'The account lists no models; the configured model runs unpinned.'
                    : 'Model discovery is unavailable; the configured model runs unpinned.'
                : visibleModels.length
                  ? `${visibleModels.length} models available`
                  : offeredModels.length
                    ? 'No models match your search. Try a different name or model ID.'
                    : backendModels.length
                      ? 'No models are listed for the chosen subscription.'
                      : 'No models are listed for this backend right now.',
            ),
          )
        : null,
      reasoningEfforts.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Thinking level'),
            h(
              'select',
              {
                class: 'floot-model-select',
                'aria-label': 'Thinking level',
                value: reasoningEffort,
                onChange: (/** @type {FlootSafeEvent} */ e) =>
                  setReasoningEffort(e.target.value),
              },
              reasoningEfforts.map(effort =>
                h('option', { key: effort, value: effort }, effort),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'floot-modal-field' },
        h('span', { class: 'floot-modal-label' }, 'Internet access'),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-label': 'Internet access',
            'aria-checked': supportsInternet && internet,
            disabled: !supportsInternet,
            onClick: () => setInternet(value => !value),
          },
          supportsInternet && internet
            ? 'On — public internet only'
            : networkPolicies.length
              ? 'Off'
              : 'Not available',
        ),
        h(
          'small',
          null,
          supportsInternet
            ? 'Allows public HTTP/HTTPS uploads and downloads. Private networks remain blocked.'
            : 'This backend does not offer configurable public-internet access.',
        ),
      ),
      subscriptions.length > 1
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Subscription'),
            h(
              'select',
              {
                class: 'floot-model-select floot-subscription-select',
                'aria-label': 'Subscription',
                value: chosenSubscription,
                onChange: (/** @type {FlootSafeEvent} */ e) => {
                  const chosen = e.target.value;
                  setSubscription(chosen);
                  // The model must be one the chosen account lists, and
                  // one the search still shows.
                  const listed = offeredOf(backend, chosen).filter(
                    candidate => matchesModel(candidate, modelQuery),
                  );
                  if (!listed.some(candidate => candidate.id === model)) {
                    const next = firstChoice(listed);
                    setModel(next?.id || '');
                    setReasoningEffort(maximumEffort(next));
                  }
                },
              },
              h(
                'option',
                { key: 'auto', value: 'auto' },
                'Automatic — soonest to reset first',
              ),
              subscriptions.map(entry =>
                h('option', { key: entry.id, value: entry.id }, entry.label),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'floot-preset-list' },
        (presets.length
          ? presets
          : [{ id: '', title: 'Start session', description: '' }]
        ).map(p =>
          h(
            'button',
            {
              type: 'button',
              key: p.id,
              class: 'floot-preset-card',
              disabled: visibleModels.length === 0 && !unpinnedOffered,
              onClick: () =>
                onPick(
                  p.id,
                  selection,
                  reasoningEffort || undefined,
                  chosenSubscription === 'auto'
                    ? undefined
                    : chosenSubscription,
                  networkPolicies.length
                    ? supportsInternet && internet
                      ? 'public-internet'
                      : 'off'
                    : undefined,
                ),
            },
            h('div', { class: 'floot-preset-name' }, p.title),
            h('div', { class: 'floot-preset-desc' }, p.description || ''),
          ),
        ),
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
  const needsRecovery = state.recovery?.turns.some(
    turn => turn.state === 'outcome-unknown' && !turn.resolution,
  );

  const onNew = () => {
    // What the backends list now, not what they listed at load.
    controller.refreshDiscovery?.();
    // Always expose the network choice, even with one model and preset.
    setModalOpen(true);
  };
  const pickPreset = (
    /** @type {string} */ id,
    /** @type {string} */ model,
    /** @type {string | undefined} */ reasoningEffort,
    /** @type {string | undefined} */ subscription,
    /** @type {string | undefined} */ networkPolicy,
  ) => {
    setModalOpen(false);
    setDrawerOpen(false);
    controller.newSession(
      id,
      model,
      reasoningEffort,
      subscription,
      networkPolicy,
    );
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
            return chip
              ? `${entry.label || entry.subscriptionId}: ${chip}`
              : '';
          })
          .filter(Boolean)
          .join(' | ')
      : accountChip(account, accountNow);

  // The journal and a pending network request are labels, not glyphs, so they
  // render as chips beside the icon buttons. A badge carries the part that
  // needs the operator (an unknown outcome, an approval to decide) and
  // collapses to a dot where the header is too narrow for the words.
  const journalButton = state.recovery
    ? h(
        'button',
        {
          type: 'button',
          class: `floot-header-btn chip${recoveryOpen ? ' on' : ''}${
            needsRecovery ? ' attention' : ''
          }`,
          'aria-label': needsRecovery
            ? 'Turn journal and recovery: recovery needed'
            : 'Turn journal and recovery',
          'aria-pressed': recoveryOpen ? 'true' : 'false',
          title: needsRecovery
            ? 'A turn has an unknown outcome; inspect the journal before repeating its effects'
            : 'Turn journal and recovery',
          onClick: () => {
            setRecoveryOpen(!recoveryOpen);
            controller.refreshRecovery?.();
          },
        },
        'Journal',
        needsRecovery
          ? h('span', { class: 'floot-header-badge' }, 'recovery needed')
          : null,
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
