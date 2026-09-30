// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
import { Far } from '@endo/far';
import harden from '@endo/harden';

import { terminalText } from './terminal-text.js';
import { bindViewSession } from './view-session.js';

/** @import { connectLocalControl } from '../control/local-control.js' */

/** @param {any} snapshot */
export const renderInventory = snapshot => {
  const rows = snapshot.entries.map(
    ([key, value]) => `${terminalText(key)}  ${terminalText(value)}`,
  );
  return `Inventory — revision ${terminalText(String(snapshot.revision))}\n${rows.length ? rows.join('\n') : '(empty)'}\n\nq / Ctrl-D / Ctrl-C: close view\n`;
};
harden(renderInventory);

/**
 * A full-screen view that redraws on every inventory revision. The server
 * explicitly removes the guest subscription before dropping its bridge, so
 * every exit path here must release the connection.
 * @param {TerminalSession} session
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showInventory = async (session, client) => {
  const view = bindViewSession(session, client);
  const observer = Far('InventoryTUI', {
    changed: snapshot => {
      if (view.isClosing()) return;
      session.clearScreen();
      return session.write(renderInventory(snapshot));
    },
  });
  void (async () => {
    for await (const line of session.lines()) {
      if (line.trim() === 'q') break;
    }
    // 'q', end of input, or session teardown all end the reader.
    view.close();
  })();
  try {
    await client.call('watchInventory', observer);
    await client.closed;
  } catch (error) {
    if (!view.isClosing()) throw error;
  } finally {
    view.close();
  }
};
harden(showInventory);
