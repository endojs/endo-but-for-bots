// @ts-check
/**
 * M5's preset editor (W5.8; `designs/m5-interfaces.md` 4.1 item 1, 10;
 * R6-55, P-49): an `app.panel`, the Settings view's "Presets" section.
 */
import { PresetEditor } from './PresetEditor.js';

/** @import { UiFeature } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/** @type {UiFeature} */
export const feature = harden({
  id: 'presets',
  slot: 'app.panel',
  label: 'Presets',
  component: PresetEditor,
});
