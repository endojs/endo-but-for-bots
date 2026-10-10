// @ts-check

import harden from '@endo/harden';
import { h } from 'preact';

/**
 * Rendering for the `command` and `command-result` messages that the
 * daemon records in an agent's own inbox when the agent issues a host
 * command (dismiss, resolve, reject, adopt, send, request).
 */

export const COMMAND_PENDING_ICON = '◐'; // ◐
export const COMMAND_SUCCESS_ICON = '✓'; // ✓
export const COMMAND_FAILURE_ICON = '✗'; // ✗

/**
 * The text of a command card: the command name followed by its argument
 * values, in recording order.
 *
 * @param {string} commandName
 * @param {Record<string, unknown> | undefined} args
 * @returns {string}
 */
export const formatCommandText = (commandName, args) => {
  const argsStr = args
    ? Object.values(args)
        .map(value => `${value}`)
        .join(' ')
    : '';
  return `${commandName} ${argsStr}`.trim();
};
harden(formatCommandText);

/**
 * @typedef {object} CommandCardMessage
 * @property {'command'} type
 * @property {string} commandName
 * @property {Record<string, unknown>} [args]
 */

/**
 * @typedef {object} CommandResultCardMessage
 * @property {'command-result'} type
 * @property {boolean} success
 * @property {string} [summary]
 */

/**
 * The compact card for a command or command-result message: a `command`
 * shows a pending icon with the command name and its argument values; a
 * `command-result` shows a success or failure icon with its summary.
 *
 * @param {object} props
 * @param {CommandCardMessage | CommandResultCardMessage} props.message
 */
export const CommandCard = ({ message }) => {
  if (message.type === 'command') {
    return h(
      'div',
      { class: 'command-message' },
      h('span', { class: 'command-icon' }, COMMAND_PENDING_ICON),
      h(
        'span',
        { class: 'command-text' },
        formatCommandText(message.commandName, message.args),
      ),
    );
  }
  return h(
    'div',
    { class: `command-message ${message.success ? 'success' : 'error'}` },
    h(
      'span',
      { class: 'command-icon' },
      message.success ? COMMAND_SUCCESS_ICON : COMMAND_FAILURE_ICON,
    ),
    h('span', { class: 'command-text' }, message.summary || ''),
  );
};
harden(CommandCard);
