// @ts-check
// Runs a session's queued submissions, one at a time, in order.
//
// `pending-queue.js` is the durable record; this is what decides when its head
// may start. The rules, all of which exist so a message is never sent twice
// and never sent as a surprise:
//
// - One turn at a time. The head starts when the session's turn slot is empty
//   and the session admits work; otherwise it waits and is tried again when
//   either changes.
// - An entry is claimed (durably `dispatching`) before its turn starts and
//   given up once the turn journal has the input (`onBegun`). A turn that ends
//   without having begun sent nothing: its message goes back to the queue.
// - A hold stops dispatch until the user acts. The queue is held when it comes
//   back from a restart with messages in it (nobody may be watching, and the
//   turn they waited behind is gone), when a turn was refused (retrying on its
//   own would spin), when the session was emergency-stopped, and while the
//   head is an interrupted dispatch whose outcome is unknown. Sending a new
//   message, or asking for a queued one to be sent, releases every hold but
//   the last: that one needs a decision about that message.

import { E } from '@endo/eventual-send';

/**
 * @typedef {{ reason: 'restart' | 'refused' | 'stopped' | 'interrupted' | 'unavailable', message: string }} SubmissionHold
 */

const HOLD_MESSAGES = harden({
  restart:
    'These messages were queued before the service restarted. Nothing is sent until you send one.',
  stopped:
    'The session was stopped with messages queued. Nothing is sent until you send one.',
  interrupted:
    'The service restarted while this message was being sent, so it may or may not have reached the agent. Check the conversation, then send it again or delete it.',
});

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./pending-queue.js').makePendingQueue>} options.queue
 * @param {() => unknown} options.getCurrentTurn the slot's turn in flight, if any
 * @param {() => string} options.refusal why the session admits no work right
 *   now (stopped, changing network policy), or '' when it does. Transient: the
 *   pump is simply run again when it may have changed.
 * @param {(text: string, options: { pendingId: string, onBegun: () => Promise<void> }) => object} options.startTurn
 *   starts a turn in the slot and returns the FlootTurn; throws if refused
 * @param {() => void} [options.onChange]
 */
export const makeSessionSubmissions = ({
  queue,
  getCurrentTurn,
  refusal,
  startTurn,
  onChange = () => {},
}) => {
  /** @type {SubmissionHold | null} */
  let hold = null;
  let initialised = false;
  let chain = Promise.resolve();

  const changed = () => {
    try {
      onChange();
    } catch (error) {
      console.error('[floot-submissions] change observer failed:', error);
    }
  };
  /** @param {SubmissionHold | null} next */
  const setHold = next => {
    if (hold?.reason === next?.reason && hold?.message === next?.message)
      return;
    hold = next;
    changed();
  };

  /**
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  const serial = step => {
    const result = chain.then(step);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  // Why the queue could not be read, if it could not. The session is still
  // usable without it — it can be watched, and turns started directly — so a
  // record that will not load is reported as a hold rather than refusing the
  // session to everyone who opens it.
  let unavailable = '';
  const initialise = async () => {
    if (initialised) return;
    try {
      await queue.ready();
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
      setHold({
        reason: 'unavailable',
        message: `Queued messages cannot be read: ${unavailable}`,
      });
      throw error;
    }
    unavailable = '';
    if (hold?.reason === 'unavailable') setHold(null);
    initialised = true;
    // Whatever is here was queued by an earlier incarnation.
    if (queue.list().length > 0) {
      setHold({ reason: 'restart', message: HOLD_MESSAGES.restart });
    }
  };

  /** @param {{ id: string, text: string }} entry */
  const dispatch = async entry => {
    let begun = false;
    /** @type {object} */
    let turn;
    try {
      turn = startTurn(entry.text, {
        pendingId: entry.id,
        onBegun: async () => {
          begun = true;
          // The journal has the input now; a failure to let go of it here
          // costs an `interrupted` entry after a restart, never a second send.
          await queue.complete(entry.id).catch(error => {
            console.error(
              '[floot-submissions] could not retire a dispatched message:',
              error,
            );
          });
        },
      });
    } catch (error) {
      await queue.release(entry.id);
      // A slot that filled, or a session that stopped admitting work, between
      // the check and the start is not a refusal of this message: it waits,
      // and is tried again when that changes.
      if (getCurrentTurn() || refusal()) return;
      setHold({
        reason: 'refused',
        message: `Not sent: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    void E(turn)
      .whenFinished()
      .then(async () => {
        if (begun) return;
        const status = await E(turn)
          .getStatus()
          .catch(() => undefined);
        await serial(async () => {
          await queue.release(entry.id);
          setHold({
            reason: 'refused',
            message: `Not sent: ${status?.error || 'the turn ended before it started'}`,
          });
        });
      })
      .catch(error => {
        console.error('[floot-submissions] dispatch follow-up failed:', error);
      });
  };

  const pumpStep = async () => {
    await initialise();
    if (hold || getCurrentTurn() || refusal()) return;
    const [head] = queue.list();
    if (!head) return;
    if (head.state === 'interrupted') {
      setHold({ reason: 'interrupted', message: HOLD_MESSAGES.interrupted });
      return;
    }
    // A head already `dispatching` belongs to a dispatch of this incarnation
    // (one left by an earlier incarnation was loaded as `interrupted`): its
    // turn is starting, or has ended and its follow-up below is about to run.
    // Starting it again here would send it twice, or spin on a refusal.
    if (head.state !== 'queued') return;
    const entry = await queue.claim();
    if (!entry) return;
    // Re-check: the claim was a durable write, and the slot may have filled.
    if (getCurrentTurn() || refusal()) {
      await queue.release(entry.id);
      return;
    }
    await dispatch(entry);
  };
  /** Try to start the head. Safe to call at any time, from anywhere. */
  const pump = () =>
    serial(pumpStep).catch(error => {
      console.error('[floot-submissions] pump failed:', error);
    });

  return harden({
    /**
     * Load the queue (and hold it if it came back non-empty). Never rejects:
     * a queue that cannot be read is reported through `read().hold`.
     */
    ready: () => serial(initialise).catch(() => undefined),
    /** `{ entries, hold }` as plain data; empty until `ready()`. */
    read: () => harden({ entries: queue.list(), hold }),
    pump,
    /**
     * Accept a message. It starts at once if nothing is ahead of it.
     *
     * @param {string} text
     */
    submit: text =>
      serial(async () => {
        await initialise();
        // The user is here and sending: whatever waited goes first, in order.
        if (hold && hold.reason !== 'interrupted') setHold(null);
        const idle =
          !hold && !getCurrentTurn() && !refusal() && queue.list().length === 0;
        const entry = await queue.enqueue(text, { claim: idle });
        if (entry.state !== 'dispatching') {
          await pumpStep();
        } else if (getCurrentTurn() || refusal()) {
          // The write took a moment, and something else took the slot (a
          // direct `startTurn`). Not a refusal: the message simply waits.
          await queue.release(entry.id);
        } else {
          await dispatch(entry);
        }
        return harden({ id: entry.id });
      }),
    /**
     * @param {string} entryId
     * @param {string} text
     */
    edit: (entryId, text) =>
      serial(async () => {
        await initialise();
        await queue.edit(entryId, text);
      }),
    /** @param {string} entryId */
    cancel: entryId =>
      serial(async () => {
        await initialise();
        const removed = await queue.cancel(entryId);
        const [head] = queue.list();
        if (!head) {
          // Nothing is left to hold.
          setHold(null);
        } else if (hold?.reason === 'interrupted') {
          if (head.state !== 'interrupted') setHold(null);
        }
        await pumpStep();
        return removed;
      }),
    /**
     * "Send this now." Releases a hold, re-queues an interrupted message, and
     * reports whether the caller should cut the running turn short: only the
     * head may do that, since ending a turn on behalf of a later message would
     * throw a reply away and still leave that message waiting.
     *
     * @param {string} entryId
     * @returns {Promise<{ cancelCurrent: boolean }>}
     */
    sendNow: entryId =>
      serial(async () => {
        await initialise();
        const entry = queue.list().find(item => item.id === entryId);
        if (!entry) throw Error(`No queued message "${entryId}"`);
        // Its own turn is already starting; there is nothing to jump.
        if (entry.state === 'dispatching')
          return harden({ cancelCurrent: false });
        if (entry.state === 'interrupted') await queue.retry(entryId);
        setHold(null);
        const [head] = queue.list();
        const isHead = head?.id === entryId;
        if (isHead && getCurrentTurn()) return harden({ cancelCurrent: true });
        await pumpStep();
        return harden({ cancelCurrent: false });
      }),
    /**
     * The session was emergency-stopped: whatever is queued waits for the
     * user even after a resume.
     */
    holdForStop: () =>
      serial(async () => {
        await initialise();
        if (queue.list().length > 0 && hold?.reason !== 'interrupted') {
          setHold({ reason: 'stopped', message: HOLD_MESSAGES.stopped });
        }
      }),
    destroy: () => serial(() => queue.destroy()),
  });
};
harden(makeSessionSubmissions);
