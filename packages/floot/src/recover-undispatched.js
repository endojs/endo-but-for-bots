// @ts-check

/** @import { makeTurnJournal } from './turn-journal.js' */

/**
 * Startup-only repair, before any inbox/backend can run. A durable absence of
 * dispatch intent proves this turn never reached a backend. Anything that may
 * have dispatched stays uncertain, even if its observed calls all settled.
 * @param {ReturnType<typeof makeTurnJournal>} journal
 */
export const recoverUndispatchedTurns = async journal => {
  const turns = await journal.list();
  for (const turn of turns) {
    if (
      turn.state !== 'outcome-unknown' ||
      turn.resolution ||
      turn.dispatchState !== 'not-dispatched' ||
      turn.tools.length ||
      turn.activity.length
    )
      // eslint-disable-next-line no-continue
      continue;
    // No external effects are retried. Preserve a durable explanation.
    if (!turn.terminal) {
      // eslint-disable-next-line no-await-in-loop
      await journal.append(turn.turnId, {
        type: 'finish',
        state: 'cancelled',
        error: 'Interrupted before dispatch; no backend execution was started.',
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await journal.resolve(
        turn.turnId,
        'Automatically checked: no dispatch intent or execution evidence; no backend execution was started.',
      );
    }
  }
};
harden(recoverUndispatchedTurns);
