// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { h, render } from 'preact';
// eslint-disable-next-line import/no-relative-packages -- Exercise the confined view without adding a production export.
import { PresetSettings } from '../../../space-floot/src/PresetSettings.js';
import { createDOM, waitFor, tick } from '../helpers/dom-setup.js';

const dom = createDOM();

test.serial(
  'preset form edits voice choice, shell internet, models, and explicit objects',
  async t => {
    t.timeout(5000);
    const parent = dom.document.createElement('div');
    dom.document.body.append(parent);
    t.teardown(() => {
      render(null, parent);
      parent.remove();
    });
    const calls = [];
    const preset = {
      id: 'voice',
      title: 'Voice',
      description: '',
      templateId: 'general',
      instructions: '',
      objects: [],
      endowments: [],
      backendId: '',
      modelId: '',
      reasoningEffort: '',
      networkPolicy: '',
    };
    const state = /** @type {any} */ ({
      models: [
        {
          id: 'fae:sol',
          backendId: 'fae-codex',
          modelId: 'sol',
          title: 'Sol',
          reasoningEfforts: ['high'],
        },
      ],
      presetSettings: {
        busy: false,
        configuration: {
          revision: '0',
          voicePresetId: 'voice',
          builtinIds: ['voice'],
          templates: [{ id: 'general', title: 'General', objects: [] }],
          presets: [preset, { ...preset, id: 'custom', title: 'Custom' }],
        },
      },
    });
    const controller = /** @type {any} */ ({
      loadPresetSettings: () => calls.push(['load']),
      savePreset: draft => calls.push(['save', draft]),
      setVoicePreset: id => calls.push(['voice', id]),
    });
    render(h(PresetSettings, { state, controller }), parent);
    await waitFor(() => parent.querySelector('fieldset'));
    const change = async (selector, value, type = 'change') => {
      const element = parent.querySelector(selector);
      if (!element) throw Error(selector);
      element.value = value;
      element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
      await tick();
    };
    const click = async text => {
      const button = [...parent.querySelectorAll('button')].find(
        item => item.textContent === text,
      );
      if (!button) throw Error(text);
      button.click();
      await tick();
    };
    await change('[aria-label="Voice shortcut preset"]', 'custom');
    await change('[aria-label="Preset model"]', 'fae:sol');
    await change('[aria-label="Preset reasoning effort"]', 'high');
    await change('[aria-label="Preset internet access"]', 'public-internet');
    await click('Add object');
    await change('.floot-preset-endowment input', 'docs', 'input');
    await change(
      '.floot-preset-endowment input[placeholder]',
      'shared/docs',
      'input',
    );
    await click('Save preset');
    t.deepEqual(calls[0], ['voice', 'custom']);
    t.like(calls[1][1], {
      backendId: 'fae-codex',
      modelId: 'sol',
      reasoningEffort: 'high',
      networkPolicy: 'public-internet',
      endowments: [{ petName: 'docs', sourcePath: ['shared', 'docs'] }],
    });
    state.presetSettings.error = 'Save failed';
    render(h(PresetSettings, { state, controller }), parent);
    t.is(parent.querySelector('[role="alert"]')?.textContent, 'Save failed');
    await click('Discard edits');
    await click('Reload presets');
    t.deepEqual(calls.at(-1), ['load']);
  },
);

test.serial(
  'shell presets offer Fae models and expose hosted choices after shell removal',
  async t => {
    t.timeout(5000);
    const parent = dom.document.createElement('div');
    dom.document.body.append(parent);
    t.teardown(() => {
      render(null, parent);
      parent.remove();
    });
    const objects = [
      { kind: 'git-workspace', petName: 'workspace' },
      { kind: 'development-environment', petName: 'shell' },
    ];
    const state = /** @type {any} */ ({
      models: [
        { id: 'fae', backendId: 'fae-codex', modelId: 'sol', title: 'Sol' },
        { id: 'hosted', backendId: 'codex', modelId: 'sol', title: 'Hosted' },
      ],
      presetSettings: {
        busy: false,
        configuration: {
          revision: '0',
          voicePresetId: 'voice',
          builtinIds: ['voice'],
          templates: [{ id: 'general', title: 'General', objects }],
          presets: [
            {
              id: 'voice',
              title: 'Voice',
              templateId: 'general',
              objects,
              endowments: [],
              backendId: 'fae-codex',
              modelId: 'sol',
            },
          ],
        },
      },
    });
    render(
      h(PresetSettings, {
        state,
        controller: /** @type {any} */ ({ loadPresetSettings: () => {} }),
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('fieldset'));
    const choices = () =>
      [...parent.querySelectorAll('[aria-label="Preset model"] option')].map(
        option => option.getAttribute('value'),
      );
    t.deepEqual(choices(), ['', 'fae']);
    const shell = parent.querySelectorAll('.floot-preset-object input')[1];
    shell.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick();
    t.deepEqual(choices(), ['', 'fae', 'hosted']);
  },
);

test.serial(
  'unsaved preset edits cannot be erased by shortcut selection or reload',
  async t => {
    t.timeout(5000);
    const parent = dom.document.createElement('div');
    dom.document.body.append(parent);
    t.teardown(() => {
      render(null, parent);
      parent.remove();
    });
    const calls = [];
    const preset = {
      id: 'voice',
      title: 'Voice',
      templateId: 'general',
      objects: [],
      endowments: [],
    };
    const state = /** @type {any} */ ({
      models: [],
      presetSettings: {
        busy: false,
        configuration: {
          revision: '0',
          voicePresetId: 'voice',
          builtinIds: ['voice'],
          templates: [{ id: 'general', title: 'General', objects: [] }],
          presets: [preset, { ...preset, id: 'other' }],
        },
      },
    });
    render(
      h(PresetSettings, {
        state,
        controller: /** @type {any} */ ({
          loadPresetSettings: () => calls.push('reload'),
          setVoicePreset: id => calls.push(id),
        }),
      }),
      parent,
    );
    await waitFor(() => parent.querySelector('fieldset'));
    const name = parent.querySelector('fieldset input');
    if (!(name instanceof dom.window.HTMLInputElement))
      throw Error('Missing name input');
    name.value = 'Unsaved name';
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await tick();
    const voice = parent.querySelector('[aria-label="Voice shortcut preset"]');
    if (!(voice instanceof dom.window.HTMLSelectElement))
      throw Error('Missing voice selector');
    t.true(voice.disabled);
    voice.value = 'other';
    voice.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick();
    t.deepEqual(calls, []);
    t.is(name.value, 'Unsaved name');
    t.true(
      parent
        .querySelector('[aria-label="Edit preset"]')
        ?.hasAttribute('disabled'),
    );
    const reload = [...parent.querySelectorAll('button')].find(
      b => b.textContent === 'Reload presets',
    );
    if (!reload) throw Error('Missing reload button');
    t.true(reload.disabled);
    [...parent.querySelectorAll('button')]
      .find(b => b.textContent === 'Discard edits')
      ?.click();
    await tick();
    t.is(name.value, 'Voice');
    t.false(voice.disabled);
    voice.value = 'other';
    voice.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick();
    t.deepEqual(calls, ['other']);
  },
);
