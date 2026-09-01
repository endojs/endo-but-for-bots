// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { SessionSidebar } from './SessionSidebar.js';
import { MessageList } from './MessageList.js';
import { ComposeBar } from './ComposeBar.js';
import { SettingsPanel } from './SettingsPanel.js';

/** @import { VNode } from 'preact' */
/** @import { FlootController, FlootPreset, FlootModel, FlootRuntime, FlootThinkingOption, FlootSafeEvent } from './types.js' */

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
    // A notify that fired between the render's getState() snapshot and this
    // subscription is otherwise lost, leaving the view stale until the NEXT
    // event — e.g. a fast initial session-list load, or a turn that finished
    // during mount. Re-render once now to pick up anything missed.
    setTick(t => t + 1);
    return unsubscribe;
  }, []);
  return controller.getState();
};

const formatTokens = (/** @type {number} */ n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
};

const supportsRuntime = (
  /** @type {{ runtimes?: string[] }} */ option,
  /** @type {string} */ runtime,
) => !option.runtimes?.length || option.runtimes.includes(runtime);

const defaultModel = (
  /** @type {FlootModel[]} */ models,
  /** @type {string} */ runtime,
) =>
  models.find(model => model.defaultFor?.includes(runtime)) ||
  models.find(model => model.default) ||
  models[0];

const defaultThinking = (/** @type {FlootThinkingOption[]} */ options) =>
  options.find(option => option.default) || options[0];

/**
 * @param {{
 *   presets: FlootPreset[],
 *   models: FlootModel[],
 *   runtimes: FlootRuntime[],
 *   thinkingOptions: FlootThinkingOption[],
 *   onPick: (id: string, model: string, runtime: string, thinking: string) => void,
 *   onClose: () => void,
 * }} props
 * @returns {VNode}
 */
const PresetModal = ({
  presets,
  models,
  runtimes,
  thinkingOptions,
  onPick,
  onClose,
}) => {
  // Pick the runtime first, then choose defaults compatible with that backend.
  const preferredRuntime = runtimes.find(r => r.default) || runtimes[0];
  const [runtime, setRuntime] = useState(
    preferredRuntime ? preferredRuntime.id : '',
  );
  const initialModels = models.filter(option =>
    supportsRuntime(option, preferredRuntime?.id || ''),
  );
  const initialThinking = thinkingOptions.filter(option =>
    supportsRuntime(option, preferredRuntime?.id || ''),
  );
  const [model, setModel] = useState(
    defaultModel(initialModels, preferredRuntime?.id || '')?.id || '',
  );
  const [thinking, setThinking] = useState(
    defaultThinking(initialThinking)?.id || '',
  );
  const compatibleModels = models.filter(option =>
    supportsRuntime(option, runtime),
  );
  const compatibleThinking = thinkingOptions.filter(option =>
    supportsRuntime(option, runtime),
  );
  const chooseRuntime = (/** @type {string} */ nextRuntime) => {
    setRuntime(nextRuntime);
    const nextModels = models.filter(option =>
      supportsRuntime(option, nextRuntime),
    );
    if (!nextModels.some(option => option.id === model)) {
      setModel(defaultModel(nextModels, nextRuntime)?.id || '');
    }
    const nextThinking = thinkingOptions.filter(option =>
      supportsRuntime(option, nextRuntime),
    );
    if (!nextThinking.some(option => option.id === thinking)) {
      setThinking(defaultThinking(nextThinking)?.id || '');
    }
  };
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
      // Runtime toggle (CLI vs API) — a segmented control, CLI preselected.
      runtimes.length
        ? h(
            'div',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Runtime'),
            h(
              'div',
              { class: 'floot-runtime-toggle' },
              runtimes.map(r =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: r.id,
                    class: `floot-runtime-option${
                      r.id === runtime ? ' selected' : ''
                    }`,
                    'aria-pressed': r.id === runtime ? 'true' : 'false',
                    title: r.description || '',
                    onClick: () => chooseRuntime(r.id),
                  },
                  r.title,
                ),
              ),
            ),
          )
        : null,
      compatibleModels.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Model'),
            h(
              'select',
              {
                class: 'floot-model-select',
                value: model,
                onInput: (/** @type {FlootSafeEvent} */ e) =>
                  setModel(e.target.value),
              },
              compatibleModels.map(m =>
                h(
                  'option',
                  { key: m.id, value: m.id },
                  `${m.title}${
                    m.defaultFor?.includes(runtime) ||
                    (!m.defaultFor?.length && m.default)
                      ? ' (default)'
                      : ''
                  }`,
                ),
              ),
            ),
          )
        : null,
      compatibleThinking.length
        ? h(
            'label',
            { class: 'floot-modal-field' },
            h('span', { class: 'floot-modal-label' }, 'Thinking effort'),
            h(
              'select',
              {
                class: 'floot-model-select',
                value: thinking,
                onInput: (/** @type {FlootSafeEvent} */ e) =>
                  setThinking(e.target.value),
              },
              compatibleThinking.map(option =>
                h(
                  'option',
                  { key: option.id, value: option.id },
                  `${option.title}${option.default ? ' (default)' : ''}`,
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'floot-preset-list' },
        presets.map(p =>
          h(
            'button',
            {
              type: 'button',
              key: p.id,
              class: 'floot-preset-card',
              onClick: () => onPick(p.id, model, runtime, thinking),
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

  const {
    sessions,
    activeSessionId,
    presets,
    models,
    runtimes,
    thinkingOptions,
    usage,
    status,
  } = state;
  const active = sessions.find(s => s.id === activeSessionId);

  const onNew = () => {
    // Skip the modal only when there is nothing to choose — a single preset,
    // no model alternatives, and no runtime choice. Multiple models or runtimes
    // alone still warrant the picker.
    if (
      presets.length <= 1 &&
      models.length <= 1 &&
      runtimes.length <= 1 &&
      thinkingOptions.length <= 1
    ) {
      const defaultRuntime = runtimes.find(r => r.default) || runtimes[0];
      const runtime = defaultRuntime?.id || '';
      const compatibleModels = models.filter(option =>
        supportsRuntime(option, runtime),
      );
      const compatibleThinking = thinkingOptions.filter(option =>
        supportsRuntime(option, runtime),
      );
      controller.newSession(
        presets[0] ? presets[0].id : undefined,
        defaultModel(compatibleModels, runtime)?.id,
        runtime || undefined,
        defaultThinking(compatibleThinking)?.id,
      );
      setDrawerOpen(false);
    } else {
      setModalOpen(true);
    }
  };
  const pickPreset = (
    /** @type {string} */ id,
    /** @type {string} */ model,
    /** @type {string} */ runtime,
    /** @type {string} */ thinking,
  ) => {
    setModalOpen(false);
    setDrawerOpen(false);
    controller.newSession(id, model, runtime, thinking);
  };

  const commitTitle = () => {
    const title = titleDraft.trim();
    setTitleEditing(false);
    if (title && active) controller.renameSession(active.id, title);
  };

  const tokenLabel =
    usage && (usage.inputTokens || usage.outputTokens)
      ? `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`
      : '';

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
    h(
      'button',
      {
        type: 'button',
        class: `floot-header-btn${debug ? ' on' : ''}`,
        'aria-label': 'Toggle raw debug view',
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
        onClick: () => controller.toggleSettings(),
      },
      '⚙',
    ),
  );

  const statusBar = h(
    'div',
    { class: 'floot-status-bar' },
    h('span', null, status || ''),
    h('span', { class: 'floot-tokens' }, tokenLabel),
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
      state.settingsOpen
        ? h(SettingsPanel, { state, controller })
        : h(MessageList, { state, controller, debug }),
      statusBar,
      h(ComposeBar, { state, controller }),
    ),
    modalOpen
      ? h(PresetModal, {
          presets,
          models,
          runtimes,
          thinkingOptions,
          onPick: pickPreset,
          onClose: () => setModalOpen(false),
        })
      : null,
  );
};
harden(FlootApp);
