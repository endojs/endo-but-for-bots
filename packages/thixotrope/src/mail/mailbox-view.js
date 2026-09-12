// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import harden from '@endo/harden';

/** @import { connectLocalControl } from '../control/local-control.js' */
/**
 * @param {NodePowers} powers
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showMailbox = async (powers, client) => {
  const {
    console,
    process,
    readline: { createInterface },
  } = powers;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  // Register consumption before the first remote await so piped commands and
  // early EOF are buffered while the initial mailbox snapshot is in flight.
  const lines = terminal[Symbol.asyncIterator]();
  const close = () => {
    terminal.close();
    client.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  terminal.once('SIGINT', close);
  void client.closed.then(() => terminal.close());
  const refresh = async () => {
    const offers = await client.call('inbox');
    // JSON quoting keeps untrusted messages and contact labels from becoming
    // terminal controls. The view receives descriptions, never capabilities.
    console.log(JSON.stringify(offers, null, 2));
  };
  try {
    await refresh();
    console.log(
      'r: refresh; take <id> <inventory-key>; discard <id>; q: close',
    );
    for await (const line of lines) {
      const [command, id, key] = line.trim().split(/\s+/);
      if (command === 'q') break;
      try {
        if (command === 'take') {
          await client.call('takeOffer', id, key);
        } else if (command === 'discard') {
          await client.call('discardOffer', id);
        } else if (command !== 'r') {
          console.log('Unknown command');
          // eslint-disable-next-line no-continue
          continue;
        }

        await refresh();
      } catch (error) {
        console.error(/** @type {Error} */ (error).message);
      }
    }
  } finally {
    close();
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  }
};
harden(showMailbox);
