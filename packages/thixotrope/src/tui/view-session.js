// @ts-check
/** @import { TerminalSession } from '../platform/terminal.js' */
/** @import { connectLocalControl } from '../control/local-control.js' */
import harden from '@endo/harden';

/**
 * Join a terminal session and its dedicated control connection into one
 * lifetime. Whichever end goes first — the user typing the view's quit
 * command, Ctrl-C, end of piped input, a dropped socket, or the supervisor
 * stopping — closes the other, and `close` is idempotent, so a view can call
 * it from every exit path without tracking whether it already ran.
 *
 * Each view holds its own connection precisely so that closing it is
 * meaningful: the supervisor then releases that view's ephemeral guest
 * subscriptions and nothing else.
 *
 * @param {TerminalSession} session
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const bindViewSession = (session, client) => {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    session.close();
    client.close();
  };
  session.onClose(close);
  void client.closed.then(close);
  return harden({
    close,
    /** True once closing has begun; a late notification should stay quiet. */
    isClosing: () => closing,
  });
};
harden(bindViewSession);
