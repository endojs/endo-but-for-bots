// @ts-check
/**
 * The voice features (`designs/m11-interfaces.md` section 9; P-33..P-35,
 * P-49, P-66, R6-60): the mode switch in the compose bar (`voice.mode`,
 * 9.1), the level meter and voice notes above it (`voice.controls`), the
 * Voice panel with Talk (`voice.panel`) and the per-message Play button
 * (`voice.replay`). Each is shown only on a connection
 * whose gateway serves the `speech` extras service.
 *
 * State: one `VoiceState` per page, reached from the `FeatureContext`
 * (`voiceStateOf(context)`): found by the context's controller (the page),
 * and bound to the context itself, which the controller makes anew at
 * every attach, so the connection's parts (port, socket, `Voice`,
 * submission listener) follow the context and the page's parts (mic,
 * player, wake lock, auto-speak) stay. Nothing is keyed by `powers`.
 * When the `FeatureContext` gains a per-feature cache (step 5 (a) of the
 * harness review, fold item F-5) the lookup below becomes that cache.
 */
import { voiceUiTexts } from './texts.js';
import { VoiceControls, VoiceModeSwitch } from './VoiceControls.js';
import { VoicePanel } from './VoicePanel.js';
import { ReplayButton } from './ReplayButton.js';
import { browserVoiceIo, voiceStateOf } from './state.js';

/** @import { FeatureContext, UiFeature } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * Whether the connection serves speech; binds the page's voice state to
 * this context so a launch link and auto-speak work before any voice
 * control is rendered.
 *
 * @param {FeatureContext} context
 */
const speechServed = context => {
  if (!context || !context.powers) return false;
  try {
    if (!context.extra('speech')) return false;
  } catch {
    return false;
  }
  voiceStateOf(context, browserVoiceIo);
  return true;
};

/** @type {UiFeature[]} */
export const feature = harden([
  {
    id: 'voice.controls',
    slot: 'composer.addon',
    when: speechServed,
    component: VoiceControls,
  },
  {
    id: 'voice.mode',
    slot: 'composer.action',
    when: speechServed,
    component: VoiceModeSwitch,
  },
  {
    id: 'voice.panel',
    slot: 'app.panel',
    label: voiceUiTexts.panelLabel,
    when: speechServed,
    component: VoicePanel,
  },
  {
    id: 'voice.replay',
    slot: 'message.action',
    when: speechServed,
    component: ReplayButton,
  },
]);
