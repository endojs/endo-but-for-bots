// @ts-check
/**
 * Replay of one turn's assistant text (`voice.replay` in
 * `message.renderer`; R5-45, decision D-M11-17, owner question O-3): one
 * `Speech.replay` of the turn's texts as the controller holds them, shown
 * once the turn has settled and when speech out is configured, whether
 * auto-speak is on or off.
 */
import { h } from 'preact';

import { isLive } from '../conversation/transcript.js';
import { useVoiceState } from './VoiceControls.js';
import { voiceUiTexts } from './texts.js';

/** @import { MessageRendererProps } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * @param {MessageRendererProps} props
 */
export const ReplayButton = ({ context, turn }) => {
  const voice = useVoiceState(context);
  const view = voice.view();
  const state = turn.status && turn.status.state;
  if (!view.speechOut || state === undefined || isLive(state)) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'thix-voice-replay',
      'data-turn': turn.turnId,
      onClick: () => voice.replay(turn.turnId),
    },
    voiceUiTexts.replay,
  );
};
