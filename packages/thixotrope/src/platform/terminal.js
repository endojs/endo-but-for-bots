// @ts-check
import harden from '@endo/harden';

/**
 * One open terminal session: a line reader plus helpers for the screen
 * idioms the CLI views share. `write` resolves when the text has been
 * flushed, so a caller can pace refreshes.
 *
 * @typedef {object} TerminalSession
 * @property {boolean} isTTY
 * @property {(text: string) => Promise<void>} write
 * @property {(text: string) => void} writeError
 * @property {() => void} clearScreen
 * @property {() => AsyncIterable<string>} lines
 * @property {(listener: () => void) => void} onClose
 * @property {(text: string) => void} setPrompt
 * @property {() => void} prompt
 * @property {() => void} close
 *
 * Opening a session is a power because a host without an interactive
 * terminal (a daemon, an embedder) can refuse it; each session owns
 * stdin/stdout until closed.
 *
 * @typedef {object} TerminalPowers
 * @property {() => TerminalSession} open
 *
 * @param {object} host
 * @param {import('readline')} host.readline
 * @param {import('process')} host.process
 * @returns {TerminalPowers}
 */
export const makeTerminalPowers = ({ readline, process }) => {
  const open = () => {
    const { stdin, stdout, stderr } = process;
    const isTTY = Boolean(stdin.isTTY);
    const terminal = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: isTTY,
    });
    let closed = false;
    const closeListeners = new Set();
    /** @type {string[]} */
    const pendingLines = [];
    /** @type {(value?: unknown) => void} */
    let wake = () => {};
    let ended = false;
    terminal.on('line', line => {
      pendingLines.push(line);
      wake();
    });
    const close = () => {
      if (closed) return;
      closed = true;
      ended = true;
      terminal.close();
      process.removeListener('SIGINT', close);
      process.removeListener('SIGTERM', close);
      stdin.removeListener('SIGINT', close);
      for (const listener of closeListeners) listener();
      wake();
      stdin.destroy();
      if (!stdout.isTTY) stdout.destroy();
    };
    terminal.once('close', () => {
      // Input ended (for example, a piped script ran out). Keep already
      // queued lines available; the consumer closes the session after it
      // drains them.
      ended = true;
      wake();
    });
    terminal.once('SIGINT', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return harden({
      isTTY,
      write: text =>
        new Promise(resolve => {
          const done = () => {
            stdout.removeListener('drain', done);
            stdout.removeListener('error', done);
            resolve(undefined);
          };
          if (stdout.write(text)) done();
          else {
            stdout.once('drain', done);
            stdout.once('error', done);
          }
        }),
      writeError: text => {
        stderr.write(text);
      },
      clearScreen: () => {
        if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
      },
      lines: async function* lines() {
        for (;;) {
          if (pendingLines.length > 0) {
            yield /** @type {string} */ (pendingLines.shift());
          } else if (ended) {
            return;
          } else {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
              wake = resolve;
            });
          }
        }
      },
      onClose: listener => {
        closeListeners.add(listener);
      },
      setPrompt: text => terminal.setPrompt(text),
      prompt: () => terminal.prompt(),
      close,
    });
  };
  return harden({ open });
};
harden(makeTerminalPowers);
