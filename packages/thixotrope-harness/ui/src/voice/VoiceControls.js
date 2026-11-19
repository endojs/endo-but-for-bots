// @ts-check
/**
 * The compose bar's voice controls (`voice.controls` in `composer.addon`;
 * R5-56, R5-46, P-49): the mic toggle, the speaker toggle ("Mute replies" /
 * "Speak replies"), the level meter with its noise-floor and threshold
 * markers, Talk, and one line for "continuing in background…" or the last
 * warning.
 */
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

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
  useEffect(() => voice.subscribe(() => setTick(n => n + 1)), [voice]);
  return voice;
};

/** @param {number} fraction */
const percent = fraction => `${Math.round(fraction * 1000) / 10}%`;

/**
 * @param {{ context: FeatureContext }} props
 */
export const VoiceControls = ({ context }) => {
  const voice = useVoiceState(context);
  const view = voice.view();
  const speakerLabel = view.autoSpeak
    ? voiceUiTexts.muteReplies
    : voiceUiTexts.speakReplies;
  const micLabel = view.micOn ? voiceUiTexts.micOff : voiceUiTexts.micOn;
  return h(
    'div',
    { class: 'thix-voice-controls' },
    h(
      'div',
      { class: 'thix-voice-row' },
      h(
        'button',
        {
          type: 'button',
          class: `thix-voice-mic${view.micOn ? ' on' : ''}`,
          'aria-pressed': view.micOn ? 'true' : 'false',
          title: view.speechIn ? micLabel : voiceUiTexts.speechInOff,
          disabled: !view.speechIn && !view.micOn,
          onClick: () => voice.toggleMic(),
        },
        micLabel,
      ),
      h(
        'button',
        {
          type: 'button',
          class: `thix-voice-speaker${view.autoSpeak ? ' on' : ''}`,
          'aria-pressed': view.autoSpeak ? 'true' : 'false',
          title: view.speechOut ? speakerLabel : voiceUiTexts.speechOutOff,
          disabled: !view.speechOut,
          onClick: () => voice.toggleSpeaker(),
        },
        speakerLabel,
      ),
      h(
        'div',
        {
          class: 'thix-voice-meter',
          role: 'meter',
          'aria-valuenow': view.level,
        },
        h('div', {
          class: 'thix-voice-meter-fill',
          style: { width: percent(meterFraction(view.level)) },
        }),
        view.micOn
          ? h('div', {
              class: 'thix-voice-meter-floor',
              style: { left: percent(meterFraction(view.floor)) },
            })
          : null,
        view.micOn
          ? h('div', {
              class: 'thix-voice-meter-threshold',
              style: { left: percent(meterFraction(view.threshold)) },
            })
          : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'thix-voice-talk',
          disabled: view.talking || !view.speechIn,
          onClick: () => voice.talk(),
        },
        voiceUiTexts.talk,
      ),
    ),
    view.bargeIn || view.note
      ? h(
          'div',
          { class: 'thix-voice-note', role: 'status' },
          view.bargeIn ? voiceUiTexts.continuingInBackground : view.note,
        )
      : null,
  );
};
