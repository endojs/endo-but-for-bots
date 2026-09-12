// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
import { Far } from '@endo/far';
import harden from '@endo/harden';

/** @import { connectLocalControl } from '../control/local-control.js' */

/** @param {string} text */
const terminalText = text =>
  [...text]
    .map(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');

/** @param {any} snapshot */
export const renderInventory = snapshot => {
  const rows = snapshot.entries.map(
    ([key, value]) => `${terminalText(key)}  ${terminalText(value)}`,
  );
  return `Inventory — revision ${terminalText(String(snapshot.revision))}\n${rows.length ? rows.join('\n') : '(empty)'}\n\nq / Ctrl-D / Ctrl-C: close view\n`;
};
harden(renderInventory);

/**
 * The TUI owns a dedicated connection. Every exit path closes it; the server
 * then explicitly removes the guest subscription before dropping its bridge.
 * @param {TerminalSession} session
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showInventory = async (session, client) => {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    session.close();
    client.close();
  };
  const observer = Far('InventoryTUI', {
    changed: snapshot => {
      if (closing) return;
      const text = renderInventory(snapshot);
      session.clearScreen();
      return session.write(text);
    },
  });
  void (async () => {
    for await (const line of session.lines()) {
      if (line.trim() === 'q') break;
    }
    // 'q', end of input, or session teardown all end the reader; every path
    // releases the dedicated control connection.
    close();
  })();
  session.onClose(close);
  void client.closed.then(close);
  try {
    await client.call('watchInventory', observer);
    await client.closed;
  } catch (error) {
    if (!closing) throw error;
  } finally {
    close();
  }
};
harden(showInventory);
