// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';

/** @import { VNode } from 'preact' */
/** @import { FlootController, FlootSafeEvent, FlootState } from './types.js' */

// The folded-in Transcription/Voice surface, now a debug/settings panel inside
// Floot rather than a standalone space. Pure view over the controller snapshot:
// live transcript, mic/VAD state, the wired STT/TTS/controller objects, and
// per-session token totals.

const Row = (/** @type {string} */ label, /** @type {string} */ value) =>
  h(
    'div',
    { class: 'floot-settings-row' },
    h('div', { class: 'floot-settings-label' }, label),
    h('div', null, value),
  );

const Control = (/** @type {string} */ label, /** @type {VNode} */ control) =>
  h(
    'label',
    { class: 'floot-settings-row' },
    h('span', { class: 'floot-settings-label' }, label),
    control,
  );

/**
 * @param {{ state: FlootState, controller: FlootController }} props
 * @returns {VNode}
 */
export const SettingsPanel = ({ state, controller }) => {
  const { voice, usage, objects } = state;
  const v = voice || {};
  const obj = objects || {};

  const transcription = v.hasMic
    ? [
        Row(
          'Mic',
          v.micError
            ? v.micError
            : v.micActive
              ? v.speaking
                ? 'listening (speaking)'
                : 'listening'
              : 'off',
        ),
        Row('Live transcript', v.transcript || '—'),
        Row(
          'VAD',
          `level ${Math.round(v.meterPct || 0)}% · threshold ${Math.round(
            v.thresholdPct || 0,
          )}%`,
        ),
      ]
    : [Row('Mic', 'no STT object wired')];

  const settings = v.ttsSettings || {
    voice: '',
    speed: 1,
    noiseScale: 0.667,
    noiseW: 0.8,
    sentenceSilence: 0.2,
  };
  const configuration = v.ttsConfiguration || { voices: [], ranges: {} };
  const ranges = configuration.ranges || {};
  const rangeControl = (
    /** @type {'speed' | 'noiseScale' | 'noiseW' | 'sentenceSilence'} */ name,
    /** @type {string} */ label,
  ) => {
    const range = ranges[name] || { min: 0, max: 2, step: 0.05 };
    const value = Number(settings[name] ?? 0);
    return Control(
      label,
      h(
        'div',
        { class: 'floot-tts-range' },
        h('input', {
          type: 'range',
          min: range.min,
          max: range.max,
          step: range.step,
          value,
          onInput: (/** @type {FlootSafeEvent} */ event) =>
            controller.setTtsSetting(name, event.target.value),
        }),
        h('output', null, String(value)),
      ),
    );
  };
  const speech = v.hasTts
    ? [
        Control(
          'Spoken replies',
          h(
            'button',
            {
              type: 'button',
              class: `floot-settings-toggle${v.ttsEnabled ? ' on' : ''}`,
              onClick: () => controller.toggleTts(),
            },
            v.ttsEnabled ? 'On — autoplay' : 'Off',
          ),
        ),
        Control(
          'Voice',
          h(
            'select',
            {
              class: 'floot-settings-select',
              value: settings.voice || '',
              onChange: (/** @type {FlootSafeEvent} */ event) =>
                controller.setTtsSetting('voice', event.target.value),
            },
            configuration.voices.map(voiceOption =>
              h(
                'option',
                { key: voiceOption.id, value: voiceOption.id },
                voiceOption.name || voiceOption.id,
              ),
            ),
          ),
        ),
        rangeControl('speed', 'Speed'),
        rangeControl('noiseScale', 'Expression'),
        rangeControl('noiseW', 'Phoneme variation'),
        rangeControl('sentenceSilence', 'Sentence pause (seconds)'),
      ]
    : [Row('Spoken replies', 'no TTS object wired')];

  const tokens = usage
    ? Row('Tokens', `↑${usage.inputTokens} ↓${usage.outputTokens}`)
    : Row('Tokens', '—');

  return h(
    'div',
    { class: 'floot-messages' },
    h(
      'div',
      { class: 'floot-settings' },
      h('div', { class: 'floot-modal-title' }, 'Transcription & settings'),
      ...transcription,
      ...speech,
      tokens,
      Row('Controller', obj.controller || '—'),
      Row('STT', obj.stt || '—'),
      Row('TTS', obj.tts || '—'),
    ),
  );
};
harden(SettingsPanel);
