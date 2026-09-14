// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
/** @import { Logger } from '../platform/logging.js' */
import harden from '@endo/harden';

import { bindViewSession } from './view-session.js';

/** @import { connectLocalControl } from '../control/local-control.js' */

/**
 * A line-oriented view of the mailbox: list the inbox, then take an offer
 * into an inventory key or discard it.
 * @param {TerminalSession} session
 * @param {Logger} logging
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showMailbox = async (session, logging, client) => {
  const { close } = bindViewSession(session, client);
  const refresh = async () => {
    const offers = await client.call('inbox');
    // JSON quoting keeps untrusted messages and contact labels from becoming
    // terminal controls. The view receives descriptions, never capabilities.
    logging.log(JSON.stringify(offers, null, 2));
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
          await client.call('takeOffer', id, key);
        } else if (command === 'discard') {
          await client.call('discardOffer', id);
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
