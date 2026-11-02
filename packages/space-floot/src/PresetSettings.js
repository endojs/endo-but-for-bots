// @ts-check
import harden from '@endo/harden';
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
/** @import { FlootController, FlootState, FlootSafeEvent } from './types.js' */

const objectLabel = object =>
  ({
    'git-workspace': 'Git workspace',
    'development-environment': 'Isolated shell',
    'host-powers': 'Full Endo control',
    'code-mount': 'Read-only Endo source',
    'nixos-admin': 'Machine administration',
    'workflow-factory': 'Deployment workflow',
  })[object.kind] || object.kind;

/** @param {{state: FlootState, controller: FlootController}} props */
export const PresetSettings = ({ state, controller }) => {
  const settings = state.presetSettings;
  const config = settings?.configuration;
  const [selected, setSelected] = useState('voice');
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState(/** @type {any} */ (null));
  useEffect(() => {
    if (!config) return;
    const preset =
      config.presets.find(item => item.id === selected) || config.presets[0];
    if (preset) {
      setSelected(preset.id);
      setDraft({ ...preset });
      setDirty(false);
    }
  }, [config?.revision, selected]);
  if (!controller.loadPresetSettings || !settings) return null;
  const change = patch => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const field = (label, control) =>
    h(
      'label',
      { class: 'floot-preset-field' },
      h('span', null, label),
      control,
    );
  const input = (key, label, maxLength = 120) =>
    field(
      label,
      h('input', {
        value: draft[key] || '',
        maxLength,
        onInput: (/** @type {FlootSafeEvent} */ event) =>
          change({ [key]: event.target.value }),
      }),
    );
  const hasShell = draft?.objects.some(
    object => object.kind === 'development-environment',
  );
  const availableModels = state.models.filter(
    model =>
      !hasShell ||
      model.backendId === 'provider' ||
      model.backendId === 'fae-codex',
  );
  const currentModel = availableModels.find(
    model =>
      model.backendId === draft?.backendId && model.modelId === draft?.modelId,
  );
  const template = config?.templates.find(
    item => item.id === draft?.templateId,
  );
  return h(
    'section',
    { class: 'floot-presets floot-operator-panel' },
    h('h3', null, 'Assistant presets'),
    h(
      'p',
      null,
      'Defaults for new sessions, shared across devices. Existing sessions keep their instructions and objects.',
    ),
    h(
      'button',
      {
        type: 'button',
        disabled: settings.busy || dirty,
        onClick: () => {
          if (!dirty) controller.loadPresetSettings?.();
        },
      },
      config ? 'Reload presets' : 'Manage presets',
    ),
    dirty
      ? h(
          'p',
          { role: 'status' },
          'Unsaved edits. Save or discard them before changing the voice shortcut or loading another preset.',
        )
      : null,
    dirty
      ? h(
          'button',
          {
            type: 'button',
            disabled: settings.busy,
            onClick: () => {
              const saved = config.presets.find(item => item.id === selected);
              if (saved) {
                setDraft({ ...saved });
                setDirty(false);
              }
            },
          },
          'Discard edits',
        )
      : null,
    settings.error ? h('p', { role: 'alert' }, settings.error) : null,
    settings.message ? h('p', { role: 'status' }, settings.message) : null,
    config
      ? field(
          'Voice shortcut',
          h(
            'select',
            {
              'aria-label': 'Voice shortcut preset',
              value: config.voicePresetId,
              disabled: settings.busy || dirty,
              onChange: (/** @type {FlootSafeEvent} */ event) => {
                if (!dirty) controller.setVoicePreset?.(event.target.value);
              },
            },
            config.presets.map(preset =>
              h('option', { value: preset.id }, preset.title),
            ),
          ),
        )
      : null,
    config && draft
      ? h(
          'fieldset',
          { disabled: settings.busy },
          field(
            'Edit preset',
            h(
              'select',
              {
                value: selected,
                'aria-label': 'Edit preset',
                disabled: dirty,
                onChange: (/** @type {FlootSafeEvent} */ event) => {
                  if (!dirty) setSelected(event.target.value);
                },
              },
              config.presets.map(preset =>
                h('option', { value: preset.id }, preset.title),
              ),
            ),
          ),
          input('title', 'Name'),
          input('description', 'Description', 1000),
          field(
            'Template',
            h(
              'select',
              {
                value: draft.templateId,
                'aria-label': 'Preset template',
                onChange: (/** @type {FlootSafeEvent} */ event) => {
                  const next = config.templates.find(
                    item => item.id === event.target.value,
                  );
                  if (next)
                    change({ templateId: next.id, objects: next.objects });
                },
              },
              config.templates.map(item =>
                h('option', { value: item.id }, item.title),
              ),
            ),
          ),
          field(
            'Additional instructions',
            h('textarea', {
              rows: 4,
              maxLength: 32_768,
              value: draft.instructions,
              onInput: (/** @type {FlootSafeEvent} */ event) =>
                change({ instructions: event.target.value }),
            }),
          ),
          field(
            'Default model',
            h(
              'select',
              {
                'aria-label': 'Preset model',
                value:
                  currentModel?.id || (draft.backendId ? '__retained' : ''),
                onChange: (/** @type {FlootSafeEvent} */ event) => {
                  const model = state.models.find(
                    item => item.id === event.target.value,
                  );
                  change({
                    backendId: model?.backendId || '',
                    modelId: model?.modelId || '',
                    reasoningEffort: '',
                  });
                },
              },
              h('option', { value: '' }, 'Factory default'),
              draft.backendId && !currentModel
                ? h(
                    'option',
                    { value: '__retained' },
                    `${draft.backendId} · ${draft.modelId || 'configured model'} (not currently listed)`,
                  )
                : null,
              availableModels
                .filter(model => model.backendId && model.modelId)
                .map(model =>
                  h(
                    'option',
                    { value: model.id },
                    `${model.backendTitle || model.backendId} · ${model.title}`,
                  ),
                ),
            ),
          ),
          hasShell
            ? h(
                'p',
                null,
                'The isolated shell works with Fae models. Hosted backends provide their own environment.',
              )
            : null,
          field(
            'Reasoning effort',
            h(
              'select',
              {
                'aria-label': 'Preset reasoning effort',
                value: draft.reasoningEffort,
                onChange: (/** @type {FlootSafeEvent} */ event) =>
                  change({ reasoningEffort: event.target.value }),
              },
              h('option', { value: '' }, 'Model default'),
              [
                ...new Set([
                  ...(currentModel?.reasoningEfforts || []),
                  ...(draft.reasoningEffort ? [draft.reasoningEffort] : []),
                ]),
              ].map(effort => h('option', { value: effort }, effort)),
            ),
          ),
          field(
            'Shell internet access',
            h(
              'select',
              {
                'aria-label': 'Preset internet access',
                value: draft.networkPolicy || '',
                onChange: (/** @type {FlootSafeEvent} */ event) =>
                  change({ networkPolicy: event.target.value }),
              },
              h('option', { value: '' }, 'Default (off)'),
              h('option', { value: 'off' }, 'Off'),
              h('option', { value: 'public-internet' }, 'Public internet'),
            ),
          ),
          h(
            'p',
            null,
            'Internet policy is enforced by the attached isolated shell, or by a hosted backend that supports it. For Fae, enable both workspace and shell below.',
          ),
          h('h4', null, 'Default objects'),
          (template?.objects || []).map(object =>
            h(
              'label',
              { class: 'floot-preset-object' },
              h('input', {
                type: 'checkbox',
                checked: draft.objects.some(
                  item => item.petName === object.petName,
                ),
                disabled: draft.templateId === 'development',
                onChange: () =>
                  change({
                    objects: draft.objects.some(
                      item => item.petName === object.petName,
                    )
                      ? draft.objects.filter(
                          item => item.petName !== object.petName,
                        )
                      : [...draft.objects, object],
                  }),
              }),
              `${object.petName} — ${objectLabel(object)}`,
            ),
          ),
          h(
            'p',
            null,
            'Add an object from your Endo inventory by path. Each new session gets that capability under the name you choose.',
          ),
          draft.endowments.map((item, index) =>
            h(
              'div',
              { class: 'floot-preset-endowment' },
              field(
                'Session name',
                h('input', {
                  value: item.petName,
                  maxLength: 80,
                  onInput: (/** @type {FlootSafeEvent} */ event) =>
                    change({
                      endowments: draft.endowments.map((old, i) =>
                        i === index
                          ? { ...old, petName: event.target.value }
                          : old,
                      ),
                    }),
                }),
              ),
              field(
                'Object path',
                h('input', {
                  value: item.sourcePath.join('/'),
                  placeholder: 'projects/example',
                  onInput: (/** @type {FlootSafeEvent} */ event) =>
                    change({
                      endowments: draft.endowments.map((old, i) =>
                        i === index
                          ? {
                              ...old,
                              retainedId: undefined,
                              sourcePath: event.target.value.split('/'),
                            }
                          : old,
                      ),
                    }),
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () =>
                    change({
                      endowments: draft.endowments.filter(
                        (_, i) => i !== index,
                      ),
                    }),
                },
                'Remove object',
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: Number(draft.endowments.length) >= 32,
              onClick: () =>
                change({
                  endowments: [
                    ...draft.endowments,
                    { petName: '', sourcePath: [] },
                  ],
                }),
            },
            'Add object',
          ),
          h(
            'div',
            { class: 'floot-preset-actions' },
            h(
              'button',
              { type: 'button', onClick: () => controller.savePreset?.(draft) },
              'Save preset',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () =>
                  controller.savePreset?.({
                    ...draft,
                    id: `custom-${Date.now().toString(36)}`,
                    title: `${draft.title} copy`,
                  }),
              },
              'Save as new preset',
            ),
            config.builtinIds.includes(draft.id)
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => controller.resetPreset?.(draft.id),
                  },
                  'Reset to built-in defaults',
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    disabled: config.voicePresetId === draft.id,
                    onClick: () => controller.deletePreset?.(draft.id),
                  },
                  'Delete preset',
                ),
          ),
        )
      : null,
  );
};
harden(PresetSettings);
