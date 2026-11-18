// @ts-check
/**
 * The full-screen connection overlay (R6-13, D-17; m3-interfaces.md 9.2):
 * "Reconnecting…" while a lost connection is retried, "Server starting..."
 * while nothing listens, the refusal text after a rejected sign-in, and
 * "Gateway not configured" (or the query refusal) without a fragment.
 */
import { h } from 'preact';

import { uiTexts } from '../../../resources/agent-host/impl/gateway/protocol.js';

/**
 * The overlay text of a connection state, or undefined when the page is
 * usable.
 *
 * @param {string} connection
 * @param {string} [message]
 * @returns {string | undefined}
 */
export const overlayText = (connection, message) => {
  switch (connection) {
    case 'open':
      return undefined;
    case 'connecting':
    case 'reconnecting':
      return uiTexts.reconnecting;
    case 'starting':
      return uiTexts.serverStarting;
    case 'refused':
      return message || uiTexts.signInRefused;
    case 'unconfigured':
      return message || uiTexts.gatewayNotConfigured;
    default:
      return uiTexts.reconnecting;
  }
};

/**
 * @param {{ connection: string, message?: string }} props
 */
export const Overlay = ({ connection, message }) => {
  const text = overlayText(connection, message);
  if (text === undefined) return null;
  const final = connection === 'refused' || connection === 'unconfigured';
  return h(
    'div',
    {
      class: `thix-overlay${final ? ' final' : ''}`,
      role: final ? 'alert' : 'status',
      'aria-live': 'polite',
      'data-connection': connection,
    },
    h('div', { class: 'thix-overlay-box' }, text),
  );
};
