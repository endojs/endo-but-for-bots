// @ts-check
import harden from '@endo/harden';
import { Fragment, h } from 'preact';
import { useState } from 'preact/hooks';
/** @import { FlootModel, FlootCatalog, FlootSafeEvent } from './types.js' */

// Retain the factory's route when sending a selection, including when two
// providers offer the same upstream model ID.
const directTitles = harden({
  'fae-codex': 'OpenAI',
  'fae-claude': 'Anthropic',
  provider: 'Configured provider',
  openrouter: 'OpenRouter',
});

/** @param {string | undefined} id */
export const isFaeRoute = id => !!id && Object.hasOwn(directTitles, id);
harden(isFaeRoute);

/** @param {FlootModel[]} models */
export const automaticModels = models =>
  models.filter(m => {
    if (!isFaeRoute(m.backendId) || !m.modelId) return false;
    const pinned = new Set(
      (m.subscriptions || []).filter(a => a.pinnedOnly).map(a => a.id),
    );
    return (
      !m.subscriptionIds?.length ||
      m.subscriptionIds.some(id => !pinned.has(id))
    );
  });
harden(automaticModels);

/** @param {FlootModel[]} models */
export const firstModel = models => models.find(m => m.default) || models[0];
harden(firstModel);

/**
 * @param {{models: FlootModel[], catalogs?: FlootCatalog[], backendId: string,
 * modelId: string, onChange: (backendId: string, modelId: string) => void,
 * allowDefault?: boolean, discoveryError?: string}} props
 */
export const ProviderModelFields = ({
  models,
  catalogs = [],
  backendId,
  modelId,
  onChange,
  allowDefault = false,
  discoveryError = '',
}) => {
  const [query, setQuery] = useState('');
  const choices = automaticModels(models);
  const providers = new Map();
  for (const row of [...models, ...catalogs]) {
    if (row.backendId && isFaeRoute(row.backendId)) {
      providers.set(
        row.backendId,
        row.providerTitle ||
          providers.get(row.backendId) ||
          directTitles[row.backendId],
      );
    }
  }
  const current = choices.filter(m => m.backendId === backendId);
  const available = current.some(m => m.modelId === modelId);
  /** @param {string} value */
  const matches = value => {
    const needle = value.trim().toLowerCase();
    return current.filter(m =>
      [m.title, m.modelId || ''].some(text =>
        text.toLowerCase().includes(needle),
      ),
    );
  };
  const visible = matches(query);
  const accounts =
    catalogs.find(c => c.backendId === backendId)?.accounts || [];
  const note =
    discoveryError ||
    (accounts.some(a => a.state === 'stale')
      ? 'Showing the last available model list.'
      : accounts.some(a => a.state === 'unavailable') && current.length
        ? 'Some accounts could not be reached.'
        : '');
  const field = (label, element) =>
    h(
      'label',
      { class: 'floot-modal-field' },
      h('span', { class: 'floot-modal-label' }, label),
      element,
    );
  return h(
    Fragment,
    null,
    field(
      'Provider',
      h(
        'select',
        {
          class: 'floot-model-select',
          'aria-label': 'Provider',
          value: backendId,
          onChange: (/** @type {FlootSafeEvent} */ e) => {
            const route = e.target.value;
            setQuery('');
            onChange(
              route,
              firstModel(choices.filter(m => m.backendId === route))?.modelId ||
                '',
            );
          },
        },
        allowDefault ? h('option', { value: '' }, 'Factory default') : null,
        backendId && !providers.has(backendId)
          ? h(
              'option',
              { value: backendId, disabled: true },
              `${directTitles[backendId] || backendId} (unavailable)`,
            )
          : null,
        [...providers].map(([id, title]) =>
          h('option', { key: id, value: id }, title),
        ),
      ),
    ),
    backendId && (current.length > 20 || query)
      ? field(
          'Search models',
          h('input', {
            class: 'floot-model-select',
            type: 'search',
            'aria-label': 'Search models',
            value: query,
            onInput: (/** @type {FlootSafeEvent} */ e) => {
              const value = e.target.value;
              setQuery(value);
              const found = matches(value);
              if (
                (!allowDefault || found.length) &&
                !found.some(m => m.modelId === modelId)
              )
                onChange(backendId, firstModel(found)?.modelId || '');
            },
          }),
        )
      : null,
    backendId || !allowDefault
      ? field(
          'Model',
          h(
            'select',
            {
              class: 'floot-model-select',
              'aria-label': 'Model',
              value: modelId,
              disabled: !visible.length,
              onChange: (/** @type {FlootSafeEvent} */ e) =>
                onChange(backendId, e.target.value),
            },
            allowDefault && backendId === 'provider'
              ? h('option', { value: '' }, 'Configured model')
              : !modelId && visible.length
                ? h('option', { value: '', disabled: true }, 'Choose a model')
                : null,
            modelId && !available
              ? h(
                  'option',
                  { value: modelId, disabled: true },
                  `${modelId} (unavailable)`,
                )
              : null,
            visible.map(m =>
              h(
                'option',
                { key: m.modelId, value: m.modelId },
                m.title === m.modelId ? m.title : `${m.title} — ${m.modelId}`,
              ),
            ),
          ),
        )
      : null,
    note
      ? h('small', { class: 'floot-discovery-note', role: 'status' }, note)
      : null,
    !providers.size && !discoveryError
      ? h('small', { role: 'status' }, 'No providers are available.')
      : null,
    backendId && !visible.length && (!modelId || query)
      ? h(
          'small',
          { role: 'status' },
          query
            ? 'No models match your search.'
            : 'No models are available for this provider.',
        )
      : null,
  );
};
harden(ProviderModelFields);
