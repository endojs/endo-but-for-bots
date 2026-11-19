// @ts-check
/**
 * The environment feature (spec R6-50, R6-57; `designs/m6-interfaces.md`
 * seam U-1): the "Sandbox execution" section of the session Settings panel.
 * It shows only for a session with a shell environment (the component
 * answers nothing otherwise).
 */
import { ExecutionPanel } from './ExecutionPanel.js';
import { executionTexts } from './texts.js';

/** @type {import('../../../resources/agent-host/impl/gateway/protocol.js').UiFeature} */
export const feature = harden({
  id: 'environment',
  slot: 'session.settings',
  label: executionTexts.heading,
  component: ExecutionPanel,
});
