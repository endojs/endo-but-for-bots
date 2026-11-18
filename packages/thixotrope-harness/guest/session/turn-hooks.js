// @ts-check
/**
 * Turn hook tables (M1a W1a.4; `designs/m1a-interfaces.md` section 12).
 *
 * Append-only for later milestones: each adds its functions to a list here
 * and never edits another milestone's entries. Every hook is called in
 * order, synchronously, with a context `{ core, active, round }`
 * (`core` the session's `SessionCore`, `active` the `ActiveTurn`, `round` the
 * turn's current round), inside the crank named below. A hook may append
 * records through `core.records` and add events through the turn's crank;
 * it must not await anything (the crank's sends and records are decided
 * before its outbound messages leave, intent before effect).
 *
 * - `beforeRound`: before each `startRound` (in the crank that sends it);
 *   M8 compaction.
 * - `onCancel`: in the crank of `Turn.cancel()`; M6 stops a shell.
 * - `onSettle`: in the settle crank, after `TurnSettled` is appended.
 * - `turnSources`: sources of turns besides the queue (M9 mail); each is
 *   `(core) => undefined | { text, at }`, asked in order when the session is
 *   idle and the queue has nothing to claim.
 * - `recoverySteps`: step 6 of `recoverAfterRestart()` (W1a.5; M9).
 * - `onClaim` (M5 W5.3, seam S3): in the claim crank, after `TurnStarted`
 *   is appended and before the first round request is built, with
 *   `{ core, active, item }` (`item` the queue entry, `undefined` for a
 *   direct start or a `turnSources` turn). W5.7 opens the turn's package
 *   and sets `active.systemNote` here.
 *
 * In M1a every list is empty. M1b W1b.4 appends the exec tool's hooks.
 */
import { execHooks } from './tools/exec.js';

/**
 * @typedef {(context: { core: any, active: any, round: number }) => void} TurnHook
 * @typedef {(context: { core: any, active: any, item: any }) => void} ClaimHook
 */

export const turnHooks = harden({
  /** @type {TurnHook[]} */
  beforeRound: [],
  /** @type {TurnHook[]} */
  onCancel: [execHooks.onCancel],
  /** @type {TurnHook[]} */
  onSettle: [],
  /** @type {((core: any) => (undefined | { text: string, at: number }))[]} */
  turnSources: [],
  /** @type {TurnHook[]} */
  recoverySteps: [execHooks.recoverySteps],
  /** @type {ClaimHook[]} M5 S3 */
  onClaim: [],
});
