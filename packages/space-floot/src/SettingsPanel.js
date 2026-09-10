// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';
import { NetworkPolicyPanel } from './NetworkPolicyPanel.js';

/** @import { VNode } from 'preact' */
/** @import { FlootController, FlootSafeEvent, FlootState } from './types.js' */

// The folded-in Transcription/Voice surface, now a debug/settings panel inside
// Floot rather than a standalone space. Pure view over the controller snapshot:
// live transcript, mic/VAD state, the wired STT/TTS/controller objects, the
// voice controls the TTS object advertises, and per-session token totals.

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

  // The voice controls are built from what the TTS object advertises: its
  // voices and the ranges of its Piper knobs. Until that arrives (or when an
  // older object has no configuration) the sliders fall back to the ranges
  // the Piper caplet enforces, so a value chosen early is never one it would
  // refuse, and to the current values.
  const settings = v.ttsSettings || {
    voice: '',
    speed: 1,
    noiseScale: 0.667,
    noiseW: 0.8,
    sentenceSilence: 0.2,
  };
  const configuration = v.ttsConfiguration || { voices: [], ranges: {} };
  const ranges = configuration.ranges || {};
  const fallbackRanges = {
    speed: { min: 0.25, max: 4, step: 0.05 },
    noiseScale: { min: 0, max: 2, step: 0.05 },
    noiseW: { min: 0, max: 2, step: 0.05 },
    sentenceSilence: { min: 0, max: 5, step: 0.05 },
  };
  const rangeControl = (
    /** @type {'speed' | 'noiseScale' | 'noiseW' | 'sentenceSilence'} */ name,
    /** @type {string} */ label,
  ) => {
    const range = ranges[name] || fallbackRanges[name];
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
      state.network
        ? h(NetworkPolicyPanel, {
            key: state.activeSessionId || '',
            network: state.network,
            controller,
          })
        : null,
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
