// @ts-check
/**
 * M4's account features (P-45; R6-52, R6-54; m4-interfaces.md 9.1 item 1,
 * 12 W4.7): the Subscriptions panel (`app.panel`) and the account chips of
 * the status bar (`statusbar.chip`). One file, an array (M3 6.2); the
 * chip's id is `accounts.chip` because the collector takes `<dir>` or
 * `<dir>.<part>` only.
 */
import { AccountChip, chipWhen } from './AccountChip.js';
import { SubscriptionsPanel } from './SubscriptionsPanel.js';

/** @type {import('../../../resources/agent-host/impl/gateway/protocol.js').UiFeature[]} */
export const feature = harden([
  {
    id: 'accounts',
    slot: 'app.panel',
    label: 'Subscriptions',
    component: SubscriptionsPanel,
  },
  {
    id: 'accounts.chip',
    slot: 'statusbar.chip',
    when: chipWhen,
    component: AccountChip,
  },
]);
