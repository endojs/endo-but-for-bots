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
 *   the last warning or why spoken mode cannot run (visible text, which
 *   the disabled switch names with `aria-describedby`).
 * - While no switch is on screen (another panel or view hides the compose
 *   bar) spoken mode pauses: each mounted switch is counted
 *   (`VoiceState.switchShown`).
 *
 * Talk (a new spoken session from the Voice shortcut) is in the Voice
 * panel (`VoicePanel.js`).
 */
import { h } from 'preact';
import { useLayoutEffect, useState } from 'preact/hooks';

import { icon } from '../shell/icons.js';
import { meterFraction } from './endpointing.js';
import { endpointingDefaults } from './endpointing-defaults.js';
import { unavailableReason, voiceStateOf } from './state.js';
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

/** The id of the visible line that says why spoken mode cannot run. */
const REASON_ID = 'thix-voice-reason';

/**
 * Why the view's spoken mode cannot run, or ''.
 * @param {import('./state.js').VoiceView} view
 */
const reasonOf = view =>
  view.speechIn && view.speechOut
    ? ''
    : unavailableReason(
        view.configured
          ? { speechIn: view.speechIn, speechOut: view.speechOut }
          : undefined,
      );

/** @param {number} fraction */
const percent = fraction => `${Math.round(fraction * 1000) / 10}%`;

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoiceModeSwitch = ({ context }) => {
  const voice = useVoiceState(context);
  useLayoutEffect(() => voice.switchShown(), [voice]);
  const view = voice.view();
  const available = view.speechIn && view.speechOut;
  const unavailable = reasonOf(view);
  const disabled = !available && !view.spoken;
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
      title: disabled ? unavailable : hint,
      ...(disabled ? { 'aria-describedby': REASON_ID } : {}),
      disabled,
      onClick: () => voice.toggleMode(),
    },
    icon('microphone', 20),
  );
};

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoiceControls = ({ context }) => {
  const voice = useVoiceState(context);
  const view = voice.view();
  const off = view.spoken ? '' : reasonOf(view);
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
            'aria-valuemin': 0,
            'aria-valuemax': endpointingDefaults.meterFullScale,
            'aria-valuenow': Math.min(
              view.level,
              endpointingDefaults.meterFullScale,
            ),
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
    off ? h('div', { class: 'thix-voice-note', id: REASON_ID }, off) : null,
    status
      ? h('div', { class: 'thix-voice-note', role: 'status' }, status)
      : null,
  );
};
