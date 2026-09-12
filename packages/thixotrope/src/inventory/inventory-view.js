// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
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
 * @param {NodePowers} powers
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const showInventory = async (powers, client) => {
  const {
    process,
    readline: { createInterface },
  } = powers;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  let closing = false;
  /** @type {(() => void) | undefined} */
  let finishRender;
  const close = () => {
    if (closing) return;
    closing = true;
    terminal.close();
    finishRender?.();
    process.stdin.destroy();
    if (!process.stdout.isTTY) process.stdout.destroy();
    client.close();
  };
  const observer = Far('InventoryTUI', {
    changed: snapshot => {
      if (closing) return;
      const text = renderInventory(snapshot);
      return new Promise(resolve => {
        const done = () => {
          process.stdout.removeListener('drain', done);
          process.stdout.removeListener('error', done);
          finishRender = undefined;
          resolve(undefined);
        };
        if (
          process.stdout.write(
            `${process.stdout.isTTY ? '\x1b[2J\x1b[H' : ''}${text}`,
          )
        ) {
          done();
        } else {
          finishRender = done;
          process.stdout.once('drain', done);
          process.stdout.once('error', done);
        }
      });
    },
  });
  process.stdout.once('error', close);
  terminal.on('line', line => {
    if (line.trim() === 'q') close();
  });
  terminal.once('close', close);
  terminal.once('SIGINT', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  void client.closed.then(close);
  try {
    await client.call('watchInventory', observer);
    await client.closed;
  } catch (error) {
    if (!closing) throw error;
  } finally {
    close();
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    process.stdout.removeListener('error', close);
  }
};
harden(showInventory);
