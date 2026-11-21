// @ts-check
import { h } from 'preact';

import { isStagedText } from '../conversation/text.js';
import { useVoiceState } from './VoiceControls.js';
import { voiceUiTexts } from './texts.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */
/** @import { ShownMessage } from '../conversation/ToolGroup.js' */

/** @param {{ context: FeatureContext, message: ShownMessage }} props */
export const ReplayButton = ({ context, message }) => {
  const voice = useVoiceState(context);
  const text = message.text;
  if (
    !voice.view().speechOut ||
    message.role !== 'assistant' ||
    !(typeof text === 'string'
      ? text.trim()
      : isStagedText(text) && text.bytes > 0)
  )
    return null;
  return h('button', {
    type: 'button',
    class: 'floot-replay thix-voice-replay',
    'aria-label': voiceUiTexts.playMessage,
    title: voiceUiTexts.playMessage,
    onClick: () => voice.replay(message),
  });
};
