// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
/** @import { LogPowers } from '../platform/logging.js' */
import harden from '@endo/harden';

/** @import { connectLocalControl } from '../control/local-control.js' */
/**
 * @param {TerminalSession} session
 * @param {LogPowers} logging
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showMailbox = async (session, logging, client) => {
  const close = () => {
    session.close();
    client.close();
  };
  session.onClose(close);
  void client.closed.then(() => session.close());
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
