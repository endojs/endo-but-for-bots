// @ts-check
/**
 * M4's Secrets view (P-58; m4-interfaces.md 9.1 item 1, 12 W4.7): one
 * `app.panel` feature, opened from the header menu by its label.
 */
import { SecretsPanel } from './SecretsPanel.js';

/** @type {import('../../../resources/agent-host/impl/gateway/contract-m3.js').UiFeature} */
export const feature = harden({
  id: 'secrets',
  slot: 'app.panel',
  label: 'Secrets',
  component: SecretsPanel,
});
