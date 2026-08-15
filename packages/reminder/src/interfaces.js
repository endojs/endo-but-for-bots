// @ts-check

import { M } from '@endo/patterns';

/**
 * The one-shot response capability carried on every delivered reminder
 * message. The plugin's delivery callback calls `resolve()` once the message
 * has been handled - the ordinary guest-mail send fulfilled - so the scheduler
 * arms the next period, or `reschedule()` after a send failure to retry the
 * same message (same `messageNumber`) after a jittered backoff. Both are
 * one-shot: whichever fires first consumes the delivery, and every later call -
 * including a late call after the message-timeout already auto-resolved - is
 * inert. It stays internal to delivery and is never serialized into the
 * mailbox.
 */
export const ReminderResponseInterface = M.interface('ReminderResponse', {
  resolve: M.call().returns(M.undefined()),
  reschedule: M.call().returns(M.undefined()),
});
