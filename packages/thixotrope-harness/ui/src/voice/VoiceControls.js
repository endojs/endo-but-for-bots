// @ts-check
/**
 * The compose bar's voice controls (m11-interfaces.md 9.1; R5-56, R5-46,
 * P-49):
 *
 * - `VoiceModeSwitch` (`voice.mode` in `composer.action`, inside the
 *   compose bar before Send): one icon button, text mode or spoken mode
 *   for the session in view (`aria-pressed` true in spoken mode).
 * - `VoiceControls` (`voice.controls` in `composer.addon`, above the
 *   bar): the level meter with its noise-floor and threshold markers,
 *   only while listening, and one line for "continuing in background…",
 *   the last warning or speech that is not configured.
 *
 * Talk (a new spoken session from the Voice shortcut) is in the Voice
 * panel (`VoicePanel.js`).
 */
import { h } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';

import { meterFraction } from './endpointing.js';
import { voiceStateOf } from './state.js';
import { voiceUiTexts } from './texts.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * The page's voice state for `context`, re-rendering the caller on every
 * change.
 *
 * @param {FeatureContext} context
 */
export const useVoiceState = context => {
  const voice = voiceStateOf(context);
  const [, setTick] = useState(0);
  useLayoutEffect(() => {
    const update = () => setTick(n => n + 1);
    const unsubscribe = voice.subscribe(update);
    // Configuration may have arrived between render and subscription.
    update();
    return unsubscribe;
  }, [voice]);
  return voice;
};

/** @param {number} fraction */
const percent = fraction => `${Math.round(fraction * 1000) / 10}%`;

/** A microphone, stroked in the text colour (Feather-style, 24 x 24). */
const micIcon = () =>
  h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 20,
      height: 20,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
    h('path', { d: 'M5 10a7 7 0 0 0 14 0' }),
    h('path', { d: 'M12 17v4' }),
  );

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoiceModeSwitch = ({ context }) => {
  const voice = useVoiceState(context);
  const view = voice.view();
  const available = view.speechIn && view.speechOut;
  const unavailable = !view.speechIn
    ? voiceUiTexts.speechInOff
    : voiceUiTexts.speechOutOff;
  const hint = view.spoken
    ? voiceUiTexts.toTextMode
    : voiceUiTexts.toSpokenMode;
  return h(
    'button',
    {
      type: 'button',
      class: `thix-voice-mode${view.spoken ? ' on' : ''}`,
      'aria-label': voiceUiTexts.spokenMode,
      'aria-pressed': view.spoken ? 'true' : 'false',
      title: available || view.spoken ? hint : unavailable,
      disabled: !available && !view.spoken,
      onClick: () => voice.toggleMode(),
    },
    micIcon(),
  );
};

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoiceControls = ({ context }) => {
  const voice = useVoiceState(context);
  const view = voice.view();
  const off =
    view.configured && (!view.speechIn || !view.speechOut)
      ? [
          !view.speechIn && voiceUiTexts.speechInOff,
          !view.speechOut && voiceUiTexts.speechOutOff,
        ]
          .filter(Boolean)
          .join('. ')
      : '';
  const status = view.bargeIn ? voiceUiTexts.continuingInBackground : view.note;
  if (!view.micOn && !off && !status) return null;
  return h(
    'div',
    { class: 'thix-voice-controls' },
    view.micOn
      ? h(
          'div',
          {
            class: 'thix-voice-meter',
            role: 'meter',
            'aria-label': voiceUiTexts.inputLevel,
            'aria-valuenow': view.level,
          },
          h('div', {
            class: 'thix-voice-meter-fill',
            style: { width: percent(meterFraction(view.level)) },
          }),
          h('div', {
            class: 'thix-voice-meter-floor',
            style: { left: percent(meterFraction(view.floor)) },
          }),
          h('div', {
            class: 'thix-voice-meter-threshold',
            style: { left: percent(meterFraction(view.threshold)) },
          }),
        )
      : null,
    off ? h('div', { class: 'thix-voice-note' }, off) : null,
    status
      ? h('div', { class: 'thix-voice-note', role: 'status' }, status)
      : null,
  );
};
