// @ts-check
/**
 * Recovery of the turn a restart interrupted (M1a W1a.5; architecture 4.4,
 * D-5, D-17; `designs/m1a-interfaces.md` section 7; spec R4-32, R4-66, A.4
 * hold `restart`).
 *
 * A daemon restart retires every adapter object. The session learns of it
 * from the first retired break on its turn path: the lease
 * (`Endpoint.holdTurn`, delivered during startup replay, before the daemon
 * serves) or an `AdapterTool.execute` answer. Those call sites, and only
 * those, call `recover(active)` of the session's `makeRecovery` (made once
 * per session by the turn runner). A retired break from a
 * guest vat (the manager's `Backend.open`, an exec vat, a child session)
 * means that vat is lost, never a restart (D-17), and must not reach here.
 *
 * Recovery runs in the crank that received the break and never awaits
 * anything: it is synchronous, so a guest call that stays pending forever
 * (a vat given up during startup, J-9048, C-10) cannot hold it up. Calls the
 * turn left open are abandoned by generation: once the turn is settled, the
 * session's handlers ignore every late answer of that generation.
 *
 * The steps, in the order they run in the crank (section 7 lists the same
 * steps; the hold is set before the settle so that the settle, which claims
 * the next entry, finds the queue held):
 *
 * 1. Only the current turn of this generation is recovered; anything else
 *    (an old lease of a settled turn, a second break of the same turn, a
 *    late break after a newer turn started) returns `false` and does
 *    nothing.
 * 2. `active.dropPorts()`: the endpoint, publisher and tools are tombstones.
 * 3. Never dispatched: the turn will be settled `interrupted` with
 *    `texts.interruptedBeforeDispatch`. Its input stays in the log once (the
 *    entry was removed at claim and is never re-queued).
 * 4. Dispatched: every intent of the current round without a `ToolResult`
 *    gets `ToolResult{ result: texts.toolOutcomeUnknown, failed: true,
 *    outcome: 'unknown' }`; the turn will be settled `outcome-unknown`.
 *    Nothing is re-sent and no further round is requested.
 * 5. Guest calls of the turn are abandoned by generation (none in M1a).
 * 6. The runtime parts' `onRecover` hooks (`runtime-parts.js`), each called
 *    with the turn's `HookTurn`; a step that throws or rejects is skipped,
 *    so one failing step cannot leave the turn unrecovered (exec, then
 *    packages; M9 adds child asks).
 * 7. A non-empty queue is held `restart` (`texts.holdRestart`).
 * 8. `settle(active, { status, error? })` appends `TurnSettled`,
 *    clears the current turn, reports the row and publishes the settle
 *    batch outside the turn (the ports are gone, so through
 *    `host.liveChannel()`); the queue's hold keeps it from claiming.
 *
 * Vat module: prelude globals only; no clock, no awaits.
 */
import { texts } from '../lib/guards/session.js';
import { isRetiredBreak } from '../lib/retired.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ActiveTurn } from './turn-types.js' */
/** @import { HookTurn } from './runtime-parts.js' */
const { harden } = /** @type {GuestGlobals} */ (globalThis);

/**
 * Whether a rejection at an adapter call site on the turn path is a restart
 * (the lease, `AdapterTool.execute`). Call it only there: at a guest-vat
 * call site the same text means that vat is lost (section 7 table).
 * @param {unknown} error
 * @returns {boolean}
 */
export const isRestartSignal = error => isRetiredBreak(error);
harden(isRestartSignal);

/**
 * The session's recovery (one per session; the turn runner makes it).
 * @param {object} options
 * @param {{ append(record: any): number, ofTurn(turnId: string): any[] }} options.records
 * @param {{ size(): number, hold(reason: string, message: string): void }} options.queue
 * @param {() => ActiveTurn | undefined} options.current
 * @param {(active: ActiveTurn, outcome: { status: string, error?: string }) => void} options.settle
 * @param {{ onRecover: (turn: HookTurn) => void }} options.hooks the
 *   runtime's combined hooks (each step guarded there)
 * @param {(active: ActiveTurn) => HookTurn} options.hookTurn
 */
export const makeRecovery = ({
  records,
  queue,
  current: currentTurn,
  settle,
  hooks,
  hookTurn,
}) => {
  /**
   * The last generation recovered: a second break for the same turn does
   * nothing even if the runner still reports it.
   */
  let recoveredGeneration = -1;

  /**
   * Whether the log has `Dispatched` for the turn. `active.dispatched` is
   * the session's own flag; the record is the durable truth (it is written
   * in the crank that answers `dispatching(0)`), so either suffices.
   * @param {ActiveTurn} active
   */
  const wasDispatched = active =>
    active.dispatched ||
    records.ofTurn(active.turnId).some(record => record.kind === 'dispatched');

  /**
   * @param {ActiveTurn} active the turn whose call site saw the break, as
   *   that call site captured it
   * @returns {boolean} true when this call recovered the turn; false when
   *   there was nothing to recover for this generation
   */
  const recover = active => {
    // 1. Only the current turn, once per generation.
    const current = currentTurn();
    if (
      current === undefined ||
      current.generation !== active.generation ||
      recoveredGeneration === active.generation
    ) {
      return false;
    }
    recoveredGeneration = active.generation;
    const { turnId } = current;

    // 2. The ports are tombstones.
    current.dropPorts();

    const dispatched = wasDispatched(current);
    if (dispatched) {
      // 4. Every open intent's outcome is unknown; nothing is re-sent.
      for (const intent of current.openIntents()) {
        records.append(
          harden({
            kind: 'tool-result',
            turnId,
            opId: intent.opId,
            name: intent.name,
            result: texts.toolOutcomeUnknown,
            failed: true,
            outcome: 'unknown',
          }),
        );
      }
    }

    // 5. Guest calls are abandoned by generation: the settle below ends this
    // generation, and the session ignores its late answers.

    // 6. The parts' recovery hooks; a failing step is skipped.
    hooks.onRecover(hookTurn(current));

    // 7. What waited behind the turn waits for the user (A.4 hold restart).
    if (queue.size() > 0) {
      queue.hold('restart', texts.holdRestart);
    }

    // 3 / 4 / 8. Settle.
    settle(
      current,
      dispatched
        ? { status: 'outcome-unknown' }
        : { status: 'interrupted', error: texts.interruptedBeforeDispatch },
    );
    return true;
  };

  return harden({ recover });
};
harden(makeRecovery);
