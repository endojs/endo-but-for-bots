// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
/** @import { Logger } from '../platform/logging.js' */
import harden from '@endo/harden';

import { bindViewSession } from './view-session.js';

/** @import { connectLocalControl } from '../control/local-control.js' */

/**
 * The workspace REPL: each non-empty line is evaluated in the workspace vat
 * and its result printed. Bindings the user wants to keep go on the guest's
 * `globalThis`, which is durable; nothing here is.
 *
 * A failed evaluation is ordinary interactive output, so the returned flag
 * only reports whether any line failed. The caller decides what that means —
 * a piped script should fail the process, a human at a prompt should not.
 *
 * @param {TerminalSession} session
 * @param {Logger} logging
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 * @returns {Promise<boolean>} whether any line failed to evaluate
 */
export const showAttach = async (session, logging, client) => {
  const { close } = bindViewSession(session, client);
  let failed = false;
  try {
    if (session.isTTY) {
      logging.log(
        'Workspace JavaScript; retain bindings with globalThis. Ctrl-D detaches.',
      );
      session.setPrompt('thix> ');
      session.prompt();
    }
    for await (const source of session.lines()) {
      // eslint-disable-next-line no-continue
      if (!source.trim()) continue;
      try {
        logging.log(await client.call('evaluate', source));
      } catch (error) {
        logging.error(/** @type {Error} */ (error).message);
        failed = true;
      }
      if (session.isTTY) session.prompt();
    }
  } finally {
    close();
  }
  return failed;
};
harden(showAttach);
