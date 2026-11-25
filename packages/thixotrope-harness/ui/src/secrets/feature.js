// @ts-check
/**
 * M4's Secrets view (P-58; m4-interfaces.md 9.1 item 1, 12 W4.7): one
 * `app.panel` feature: a section of the Settings view, listed by its label.
 */
import { SecretsPanel } from './SecretsPanel.js';

/** @type {import('../../../resources/agent-host/impl/gateway/protocol.js').UiFeature} */
export const feature = harden({
  id: 'secrets',
  slot: 'app.panel',
  label: 'Secrets',
  component: SecretsPanel,
});
