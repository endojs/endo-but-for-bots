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
    await click('Reload presets');
    t.deepEqual(calls.at(-1), ['load']);
  },
);
