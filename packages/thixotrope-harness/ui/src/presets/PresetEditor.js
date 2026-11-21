// @ts-check
/**
 * The preset editor panel (W5.8; R6-55, P-49): the list of presets, and
 * the selected one's name, description, template, provider and model,
 * reasoning effort, internet, instructions and default objects from the
 * inventory, with Save, Save as new, Delete, Reset to built-in defaults,
 * Discard edits and Reload. State and actions are `editor.js`'s.
 */
import { h } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { makePresetEditor } from './editor.js';
import { presetTemplateNames, presetTexts } from './texts.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */
/** @import { EditorState } from './editor.js' */

/** UTF-16 bounds of the fields (`limits`), as input `maxLength`. */
const MAX = harden({
  label: 120,
  description: 500,
  instructions: 4096,
  model: 256,
  effort: 32,
  endowmentLabel: 80,
});

/**
 * @param {string} label
 * @param {any} control
 */
const field = (label, control) =>
  h('label', { class: 'thix-preset-field' }, h('span', null, label), control);

/**
 * @param {{ context: FeatureContext }} props
 */
export const PresetEditor = ({ context }) => {
  const powers = context.powers;
  const holder = useRef(
    /** @type {{ powers: any, editor: ReturnType<typeof makePresetEditor> } | undefined} */ (
      undefined
    ),
  );
  if (!holder.current || holder.current.powers !== powers) {
    holder.current = { powers, editor: makePresetEditor({ powers }) };
  }
  const { editor } = holder.current;
  const [, setTick] = useState(0);
  useLayoutEffect(() => {
    const unsubscribe = editor.subscribe(() => setTick(tick => tick + 1));
    editor.start();
    return unsubscribe;
  }, [editor]);

  /** @type {EditorState} */
  const state = editor.getState();
  const entry = state.selected >= 0 ? state.entries[state.selected] : undefined;
  const view = entry ? entry.view : undefined;
  const form = state.form;
  const builtIn = Boolean(view && view.builtIn);

  /** @returns {any} */
  const messageLine = () => {
    if (state.error !== undefined) {
      return h(
        'div',
        { class: 'thix-preset-error', role: 'alert' },
        state.error,
      );
    }
    if (state.notice !== undefined) {
      return h(
        'div',
        { class: 'thix-preset-notice', role: 'status' },
        state.notice,
      );
    }
    return null;
  };

  const list = h(
    'ul',
    { class: 'thix-preset-list' },
    state.entries.map((item, index) =>
      h(
        'li',
        { key: `${index}` },
        h(
          'button',
          {
            type: 'button',
            class: `thix-preset-item${index === state.selected ? ' on' : ''}`,
            'data-index': `${index}`,
            disabled: state.busy,
            onClick: () => editor.select(index),
          },
          h(
            'span',
            { class: 'thix-preset-item-label' },
            item.view ? item.view.label : item.error,
          ),
          item.view && item.view.builtIn
            ? h('span', { class: 'thix-preset-tag' }, presetTexts.builtIn)
            : null,
          item.view && item.view.available === false
            ? h(
                'span',
                {
                  class: 'thix-preset-tag unavailable',
                  title: item.view.unavailableReason,
                },
                presetTexts.unavailable,
              )
            : null,
        ),
      ),
    ),
  );

  /** @returns {any} */
  const formView = () => {
    if (!form) return null;
    const backendIndex = state.backends.findIndex(
      row => row.backend === form.backend,
    );
    const model = state.models.find(row => row.modelId === form.modelId);
    const chosen = new Set(form.endowments.map(endowment => endowment.value));
    const offered = state.inventory
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => !chosen.has(row.value));
    return h(
      'form',
      {
        class: 'thix-preset-form',
        /** @param {any} event */
        onSubmit: event => {
          event.preventDefault();
          editor.save();
        },
      },
      field(
        presetTexts.label,
        h('input', {
          name: 'label',
          value: form.label,
          maxLength: MAX.label,
          /** @param {any} event */
          onInput: event => editor.setField('label', event.target.value),
        }),
      ),
      field(
        presetTexts.description,
        h('textarea', {
          name: 'description',
          rows: 2,
          value: form.description,
          maxLength: MAX.description,
          /** @param {any} event */
          onInput: event => editor.setField('description', event.target.value),
        }),
      ),
      field(
        presetTexts.template,
        h(
          'select',
          {
            name: 'template',
            value: form.template,
            disabled: builtIn,
            /** @param {any} event */
            onChange: event => editor.setField('template', event.target.value),
          },
          presetTemplateNames.map(name =>
            h('option', { key: name, value: name }, name),
          ),
        ),
      ),
      form.template === 'development' && form.workspaceSeed
        ? field('Project revision', h('code', {}, form.workspaceSeed.commit))
        : form.template === 'development' && form.projectSource
          ? field(
              'Project source',
              h('span', {}, 'Thixotrope · operator-selected revision'),
            )
          : null,
      field(
        presetTexts.backend,
        h(
          'select',
          {
            name: 'backend',
            value: `${backendIndex}`,
            /** @param {any} event */
            onChange: event => editor.setBackend(Number(event.target.value)),
          },
          h('option', { value: '-1' }, presetTexts.factoryDefault),
          state.backends.map((row, index) =>
            h('option', { key: `${index}`, value: `${index}` }, row.label),
          ),
        ),
      ),
      field(
        presetTexts.model,
        h('input', {
          name: 'modelId',
          value: form.modelId,
          maxLength: MAX.model,
          list: 'thix-preset-models',
          disabled: form.backend === undefined,
          /** @param {any} event */
          onInput: event => editor.setField('modelId', event.target.value),
        }),
      ),
      h(
        'datalist',
        { id: 'thix-preset-models' },
        state.models.map(row =>
          h('option', { key: row.modelId, value: row.modelId }),
        ),
      ),
      field(
        presetTexts.effort,
        h('input', {
          name: 'reasoningEffort',
          value: form.reasoningEffort,
          maxLength: MAX.effort,
          list: 'thix-preset-efforts',
          disabled: form.backend === undefined,
          /** @param {any} event */
          onInput: event =>
            editor.setField('reasoningEffort', event.target.value),
        }),
      ),
      h(
        'datalist',
        { id: 'thix-preset-efforts' },
        (model ? model.reasoningEfforts : []).map(effort =>
          h('option', { key: effort, value: effort }),
        ),
      ),
      h(
        'label',
        { class: 'thix-preset-check' },
        h('input', {
          type: 'checkbox',
          name: 'internet',
          checked: form.networkPolicy === 'public-internet',
          /** @param {any} event */
          onChange: event =>
            editor.setField(
              'networkPolicy',
              event.target.checked ? 'public-internet' : 'off',
            ),
        }),
        h('span', null, presetTexts.internet),
      ),
      field(
        presetTexts.instructions,
        h('textarea', {
          name: 'instructions',
          rows: 6,
          value: form.instructions,
          maxLength: MAX.instructions,
          /** @param {any} event */
          onInput: event => editor.setField('instructions', event.target.value),
        }),
      ),
      form.objects.length === 0
        ? null
        : h(
            'div',
            { class: 'thix-preset-objects' },
            h('span', null, presetTexts.templateObjects),
            h(
              'ul',
              null,
              form.objects.map(object =>
                h(
                  'li',
                  { key: object.label },
                  `${object.label} (${object.kind})`,
                ),
              ),
            ),
          ),
      h(
        'div',
        { class: 'thix-preset-objects' },
        h('span', null, presetTexts.objects),
        form.endowments.length === 0
          ? h('div', { class: 'thix-preset-muted' }, presetTexts.noObjects)
          : h(
              'ul',
              { class: 'thix-preset-endowments' },
              form.endowments.map((endowment, index) =>
                h(
                  'li',
                  { key: `${index}` },
                  h('input', {
                    name: `endowment-${index}`,
                    value: endowment.label,
                    maxLength: MAX.endowmentLabel,
                    /** @param {any} event */
                    onInput: event =>
                      editor.relabelEndowment(index, event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'thix-preset-remove',
                      onClick: () => editor.removeEndowment(index),
                    },
                    presetTexts.removeObject,
                  ),
                ),
              ),
            ),
        offered.length === 0
          ? null
          : h(
              'select',
              {
                name: 'addObject',
                value: '',
                /** @param {any} event */
                onChange: event => {
                  const picked = event.target.value;
                  event.target.value = '';
                  if (picked !== '') editor.addEndowment(Number(picked));
                },
              },
              h('option', { value: '' }, presetTexts.addObject),
              offered.map(({ row, index }) =>
                h('option', { key: `${index}`, value: `${index}` }, row.label),
              ),
            ),
      ),
      h(
        'div',
        { class: 'thix-preset-actions' },
        h(
          'button',
          {
            type: 'button',
            name: 'save',
            disabled: state.busy || !state.dirty,
            onClick: () => editor.save(),
          },
          presetTexts.save,
        ),
        h(
          'button',
          {
            type: 'button',
            name: 'saveAsNew',
            disabled: state.busy,
            onClick: () => editor.saveAsNew(),
          },
          presetTexts.saveAsNew,
        ),
        builtIn
          ? h(
              'button',
              {
                type: 'button',
                name: 'reset',
                disabled: state.busy,
                onClick: () => editor.reset(),
              },
              presetTexts.reset,
            )
          : h(
              'button',
              {
                type: 'button',
                name: 'delete',
                class: 'danger',
                disabled: state.busy,
                onClick: () => editor.remove(),
              },
              state.confirmDelete
                ? presetTexts.confirmDelete
                : presetTexts.delete,
            ),
        h(
          'button',
          {
            type: 'button',
            name: 'discard',
            disabled: state.busy || !state.dirty,
            onClick: () => editor.discard(),
          },
          presetTexts.discard,
        ),
      ),
    );
  };

  return h(
    'section',
    { class: 'thix-presets', 'aria-label': presetTexts.title },
    h(
      'div',
      { class: 'thix-presets-head' },
      h('h2', null, presetTexts.title),
      h(
        'button',
        {
          type: 'button',
          name: 'reload',
          disabled: state.busy,
          onClick: () => editor.reload(),
        },
        presetTexts.reload,
      ),
    ),
    state.phase === 'loading'
      ? h('div', { class: 'thix-preset-muted' }, presetTexts.loading)
      : null,
    messageLine(),
    state.phase === 'ready'
      ? h('div', { class: 'thix-presets-body' }, list, formView())
      : null,
  );
};
