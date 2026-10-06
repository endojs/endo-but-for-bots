// @ts-check
/** @import * as process from 'node:process' */
/** @import * as readline from 'node:readline' */
/** @import { TerminalPowers } from '../terminal.js' */
import harden from '@endo/harden';

import { makeLineReader } from './line-reader.js';

/**
 * Node's readline over this process's own stdin and stdout. Opening a
 * session takes ownership of them until it closes, including the SIGINT
 * and SIGTERM handlers that close it.
 *
 * @param {object} host
 * @param {typeof readline} host.readline
 * @param {typeof process} host.process
 * @returns {TerminalPowers}
 */
export const makeTerminalPowers = ({ readline, process }) => {
  const open = () => {
    const { stdin, stdout } = process;
    const isTTY = Boolean(stdin.isTTY);
    const terminal = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: isTTY,
    });
    // The reader ends by itself when input ends (a piped script ran out)
    // or the session closes; lines already read stay available, and the
    // consumer closes the session after draining them.
    const lines = makeLineReader(terminal, stdin);
    let closed = false;
    const closeListeners = new Set();
    const close = () => {
      if (closed) return;
      closed = true;
      // Closing the interface releases stdin (and restores its mode) without
      // touching stdout, which the process may still print to afterwards.
      terminal.close();
      process.removeListener('SIGINT', close);
      process.removeListener('SIGTERM', close);
      for (const listener of closeListeners) listener();
    };
    // Readline owns Ctrl-C on a raw terminal; the process sees it otherwise.
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
      clearScreen: () => {
        if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
      },
      lines: () => lines,
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
