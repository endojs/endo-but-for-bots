// @ts-check
/**
 * "Start a new session" (R6-38, R6-39; m3-interfaces.md 9.1, 9.3; W3.5),
 * adapted from the preset modal of `space-floot` `FlootApp.js` and its
 * provider and model fields, with objects in place of string ids: a preset
 * is the controller's row `index` (its `Preset` presence stays in the
 * controller), a backend its row `index`, a model a row of the loaded
 * catalogue page.
 *
 * - Backend: `state.backends`; choosing one loads its catalogue
 *   (`refreshModels`), also when the dialog opens.
 * - Model: "Factory default" (nothing pinned: the factory resolves the
 *   backend and model) or a catalogue row, filtered by the search field over
 *   the loaded rows (A-9), further pages with "More models"; a failed
 *   discovery shows R6-38's note and the catalogue's text.
 * - Slot `newSession.field` (M7's internet toggle) under the fields.
 * - Presets: one card per `state.presets` row with its description when the
 *   row carries one; an unavailable preset is disabled with its reason
 *   (M5's `Preset.describe()` `available` / `unavailableReason`; a
 *   `describe()` that failed carries the error text). Choosing a card
 *   starts the session (as Floot): `controller.newSession({ presetIndex,
 *   backendIndex?, modelSelection? })`.
 * - R6-39: effort comes only from the preset; the dialog refuses to start
 *   when the chosen model does not offer the preset's saved effort.
 */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';
import { discoveryNotes, effortRefusal, matchesModel } from './rows.js';
import { SessionsSlot } from './slot.js';

/** The model select's value for "Factory default". */
const FACTORY_DEFAULT = '';

/**
 * @param {{
 *   state: any,
 *   controller: any,
 *   features: readonly any[],
 *   context: any,
 * }} props
 */
export const NewSession = ({ state, controller, features, context }) => {
  const backends = /** @type {any[]} */ (state.backends);
  const presets = /** @type {any[]} */ (state.presets);
  const models = state.models;
  const [chosenBackend, setChosenBackend] = useState(
    /** @type {number | undefined} */ (undefined),
  );
  const [query, setQuery] = useState('');
  // A catalogue row index as text, or FACTORY_DEFAULT.
  const [pick, setPick] = useState(FACTORY_DEFAULT);
  const [refusal, setRefusal] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const [busy, setBusy] = useState(false);

  const backendIndex =
    chosenBackend ?? (backends.length > 0 ? backends[0].index : undefined);

  // The catalogue is read again whenever the dialog opens or the backend
  // changes (discovery may have moved on since).
  // The call waits for the effect pass to end: the controller's notification
  // may draw at once (a synchronous `schedule`), and a draw from inside
  // Preact's effect pass runs this effect again, without end.
  useEffect(() => {
    if (backendIndex === undefined) return undefined;
    let live = true;
    Promise.resolve().then(() => {
      if (live) controller.refreshModels(backendIndex);
    });
    return () => {
      live = false;
    };
  }, [backendIndex]);

  const loaded = models.backendIndex === backendIndex ? models : undefined;
  /** @type {Array<{ row: any, index: number }>} */
  const visible = loaded
    ? loaded.rows
        .map((/** @type {any} */ row, /** @type {number} */ index) => ({
          row,
          index,
        }))
        .filter(({ row }) => matchesModel(row, query))
    : [];
  const selection = visible.some(({ index }) => String(index) === pick)
    ? pick
    : FACTORY_DEFAULT;
  const model =
    selection === FACTORY_DEFAULT || !loaded
      ? undefined
      : loaded.rows[Number(selection)];
  const notes = loaded ? discoveryNotes(loaded) : [];

  const close = () => controller.closeNewSession();

  /** @param {any} preset a `state.presets` row, or undefined (no presets) */
  const start = async preset => {
    if (busy || (preset && !preset.available)) return;
    const refused = effortRefusal(preset, model);
    setRefusal(refused);
    if (refused) return;
    setBusy(true);
    const key = await controller.newSession({
      ...(preset ? { presetIndex: preset.index } : {}),
      ...(model
        ? { backendIndex: loaded.backendIndex, modelSelection: model.modelId }
        : {}),
    });
    if (key === undefined) {
      // Still open: the controller reported why (`guarded`).
      setBusy(false);
      setRefusal(controller.getState().status || undefined);
    }
  };

  /** @param {any} preset */
  const card = preset =>
    h(
      'button',
      {
        type: 'button',
        key: preset.index,
        class: `floot-preset-card${preset.available ? '' : ' thix-unavailable'}`,
        'data-preset': preset.index,
        disabled: busy || !preset.available,
        'aria-disabled': preset.available ? undefined : 'true',
        onClick: () => start(preset),
      },
      h('div', { class: 'floot-preset-name' }, preset.label),
      preset.description
        ? h('div', { class: 'floot-preset-desc' }, preset.description)
        : null,
      preset.available
        ? null
        : h(
            'div',
            { class: 'floot-preset-desc thix-preset-reason' },
            preset.unavailableReason ?? '',
          ),
    );

  const backendField =
    backends.length > 0
      ? h(
          'label',
          { class: 'floot-modal-field' },
          h('span', { class: 'floot-modal-label' }, 'Backend'),
          h(
            'select',
            {
              class: 'floot-model-select',
              'aria-label': 'Backend',
              value: String(backendIndex),
              /** @param {any} event */
              onChange: event => {
                setChosenBackend(Number(event.target.value));
                setQuery('');
                setPick(FACTORY_DEFAULT);
                setRefusal(undefined);
              },
            },
            backends.map(backend =>
              h(
                'option',
                { key: backend.index, value: String(backend.index) },
                backend.label,
              ),
            ),
          ),
        )
      : null;

  const searchField = h(
    'label',
    { class: 'floot-modal-field' },
    h('span', { class: 'floot-modal-label' }, 'Search models'),
    h('input', {
      class: 'floot-model-select',
      type: 'search',
      'aria-label': 'Search models',
      placeholder: 'Search by name or model ID',
      value: query,
      /** @param {any} event */
      onInput: event => {
        setQuery(event.target.value);
        setRefusal(undefined);
      },
    }),
  );

  const modelField = h(
    'label',
    { class: 'floot-modal-field' },
    h('span', { class: 'floot-modal-label' }, 'Model'),
    h(
      'select',
      {
        class: 'floot-model-select',
        'aria-label': 'Model',
        value: selection,
        /** @param {any} event */
        onChange: event => {
          setPick(event.target.value);
          setRefusal(undefined);
        },
      },
      h(
        'option',
        { key: 'default', value: FACTORY_DEFAULT },
        uiTexts.factoryDefault,
      ),
      visible.map(({ row, index }) =>
        h(
          'option',
          { key: index, value: String(index) },
          `${row.title} — ${row.modelId}${row.default ? ' (default)' : ''}`,
        ),
      ),
    ),
    h(
      'small',
      { class: 'thix-model-status', role: 'status', 'aria-live': 'polite' },
      !loaded || loaded.state === 'loading'
        ? 'Loading models…'
        : visible.length > 0
          ? `${visible.length} models available`
          : /** @type {any[]} */ (loaded.rows).length > 0
            ? 'No models match your search. Try a different name or model ID.'
            : 'No models are listed for this backend right now.',
    ),
    loaded && loaded.next !== undefined
      ? h(
          'button',
          {
            type: 'button',
            class: 'floot-header-btn thix-more-models',
            onClick: () => controller.moreModels(),
          },
          'More models',
        )
      : null,
  );

  return h(
    'div',
    {
      class: 'floot-modal-backdrop',
      onClick: close,
      /** @param {any} event */
      onKeyDown: event => {
        if (event.key === 'Escape') close();
      },
    },
    h(
      'div',
      {
        class: 'floot-modal thix-new-session',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': uiTexts.startNewSession,
        // Clicks on the card must not reach the backdrop's dismiss.
        /** @param {any} event */
        onClick: event => event.stopPropagation(),
      },
      h('div', { class: 'floot-modal-title' }, uiTexts.startNewSession),
      backendField,
      notes.length > 0
        ? h(
            'small',
            { class: 'floot-discovery-note', role: 'status' },
            notes.map(line => h('div', { key: line }, line)),
          )
        : null,
      searchField,
      modelField,
      h(SessionsSlot, { slot: 'newSession.field', features, context }),
      refusal
        ? h('div', { class: 'thix-new-session-error', role: 'alert' }, refusal)
        : null,
      h(
        'div',
        { class: 'floot-preset-list' },
        presets.length > 0
          ? presets.map(card)
          : h(
              'button',
              {
                type: 'button',
                class: 'floot-preset-card',
                disabled: busy,
                onClick: () => start(undefined),
              },
              h('div', { class: 'floot-preset-name' }, 'Start session'),
            ),
      ),
    ),
  );
};
