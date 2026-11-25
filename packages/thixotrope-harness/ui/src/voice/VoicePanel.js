// @ts-check
/**
 * The Voice panel (`voice.panel` in `app.panel`; R5-50, R5-53, R5-55,
 * R5-56; owner question O-9): Spoken replies (On — autoplay / Off), the
 * voice, the sliders Speed, Expression, Phoneme variation and Sentence
 * pause, the Voice shortcut's preset and Talk (a new spoken session from
 * that preset; m11-interfaces.md 9.1). Opening it reads the shared
 * preferences and the shortcut again; a change is used at once and written
 * after the debounce (`VoiceState.setPreference`).
 */
import { h } from 'preact';
import { useEffect } from 'preact/hooks';

import { useVoiceState } from './VoiceControls.js';
import { voiceUiTexts } from './texts.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** The sliders, in display order (R5-56). */
const sliders = harden([
  { field: 'speed', label: voiceUiTexts.speed },
  { field: 'noiseScale', label: voiceUiTexts.expression },
  { field: 'noiseW', label: voiceUiTexts.phonemeVariation },
  { field: 'sentenceSilence', label: voiceUiTexts.sentencePause },
]);

/**
 * @param {string} label
 * @param {any} control
 */
const row = (label, control) =>
  h('label', { class: 'thix-voice-setting' }, h('span', null, label), control);

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoicePanel = ({ context }) => {
  const voice = useVoiceState(context);
  useEffect(() => voice.panelOpened(), [voice]);
  const view = voice.view();
  const { settings, shortcut } = view;
  return h(
    'div',
    { class: 'thix-voice-panel' },
    h('h2', null, voiceUiTexts.panelLabel),
    view.speechOut
      ? null
      : h('p', { class: 'thix-voice-off' }, voiceUiTexts.speechOutOff),
    view.speechIn
      ? null
      : h('p', { class: 'thix-voice-off' }, voiceUiTexts.speechInOff),
    row(
      voiceUiTexts.spokenReplies,
      h(
        'select',
        {
          class: 'thix-voice-autospeak',
          disabled: !view.speechOut,
          value: view.autoSpeak ? 'on' : 'off',
          onChange: (/** @type {any} */ event) =>
            voice.setAutoSpeak(event.currentTarget.value === 'on'),
        },
        h('option', { value: 'on' }, voiceUiTexts.spokenRepliesOn),
        h('option', { value: 'off' }, voiceUiTexts.spokenRepliesOff),
      ),
    ),
    row(
      voiceUiTexts.voice,
      h(
        'select',
        {
          class: 'thix-voice-voice',
          value: settings.voice,
          disabled: view.voices.length === 0,
          onChange: (/** @type {any} */ event) =>
            voice.setPreference('voice', event.currentTarget.value),
        },
        view.voices.map(entry =>
          h('option', { key: entry.id, value: entry.id }, entry.name),
        ),
      ),
    ),
    sliders.map(({ field, label }) => {
      const range = view.ranges[field];
      return h(
        'label',
        { key: field, class: 'thix-voice-setting' },
        h('span', null, label),
        h('input', {
          type: 'range',
          class: `thix-voice-${field}`,
          min: range.min,
          max: range.max,
          step: range.step,
          value: settings[field],
          onInput: (/** @type {any} */ event) =>
            voice.setPreference(field, Number(event.currentTarget.value)),
        }),
        h('output', null, String(settings[field])),
      );
    }),
    row(
      voiceUiTexts.voiceShortcut,
      h(
        'select',
        {
          class: 'thix-voice-shortcut',
          value: String(shortcut.selected),
          disabled: shortcut.state !== 'ready',
          onChange: (/** @type {any} */ event) =>
            voice.chooseShortcut(Number(event.currentTarget.value)),
        },
        shortcut.selected < 0 ? h('option', { value: '-1' }, '') : null,
        shortcut.entries.map((entry, index) =>
          h(
            'option',
            {
              key: String(index),
              value: String(index),
              disabled: !entry.available,
              title: entry.unavailableReason,
            },
            entry.label,
          ),
        ),
      ),
    ),
    row(
      '',
      h(
        'button',
        {
          type: 'button',
          class: 'thix-voice-talk',
          title: voiceUiTexts.talkHint,
          // The same requirement as the mode switch (9.1); the panel shows
          // which half is missing above.
          disabled: view.talking || !view.speechIn || !view.speechOut,
          onClick: () => voice.talk(),
        },
        voiceUiTexts.talk,
      ),
    ),
    view.note
      ? h('div', { class: 'thix-voice-note', role: 'status' }, view.note)
      : null,
  );
};
