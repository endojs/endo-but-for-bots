// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
/** @import { Logger } from '../platform/logging.js' */
import harden from '@endo/harden';

import { makeWorkspaceClient } from '../control/workspace-client.js';
import { printJson } from './terminal-text.js';
import { bindViewSession } from './view-session.js';

/** @import { connectLocalControl } from '../control/local-control.js' */

/**
 * A line-oriented view of the mailbox: list the inbox, then take a message's
 * capability into an inventory key or discard the message.
 * @param {TerminalSession} session
 * @param {Logger} logging
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showMailbox = async (session, logging, client) => {
  const { close } = bindViewSession(session, client);
  const mail = makeWorkspaceClient(client);
  const refresh = async () => {
    // Message text and contact labels are remote-controlled: every control
    // character is escaped before it reaches the terminal. The view renders
    // descriptions; a capability it takes passes through it on its way from
    // the address book into the inventory.
    printJson(logging, await mail.inbox());
  };
  try {
    await refresh();
    logging.log(
      'r: refresh; take <id> <inventory-key>; discard <id>; q: close',
    );
    for await (const line of session.lines()) {
      const [command, id, key] = line.trim().split(/\s+/);
      if (command === 'q') break;
      try {
        if (command === 'take') {
          await mail.take(id, key);
        } else if (command === 'discard') {
          await mail.discard(id);
        } else if (command !== 'r') {
          logging.log('Unknown command');
          // eslint-disable-next-line no-continue
          continue;
        }

        await refresh();
      } catch (error) {
        logging.error(/** @type {Error} */ (error).message);
      }
    }
  } finally {
    close();
  }
};
harden(showMailbox);
