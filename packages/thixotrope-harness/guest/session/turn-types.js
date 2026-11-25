// @ts-check
/**
 * The turn runner's vat-internal records, as types only (HR-GUEST-11): the
 * modules of the runner (`turn.js`, `recovery.js`, `usage.js`, `ports.js`,
 * `turn-index.js`, `turn-import.js`) and the runtime parts' hooks import
 * them with `@import`, so this module is not in the session bundle.
 */

/**
 * @typedef {object} TurnInfo a plain record kept for the session's life
 *   (history pages, receipts); the Turn exo is minted from it on demand
 * @property {string} turnId
 * @property {any} input a string or a StagedText
 * @property {number} at
 * @property {string} state
 * @property {number} round
 * @property {string} [error]
 * @property {string} [resolution]
 * @property {any} [finished] promise kit while the turn is live
 * @property {boolean} [sealed] the turn's records are archived (M2)
 */

/**
 * @typedef {{ opId: string, callId: string, name: string, args: any }} ToolIntent
 */

/**
 * @typedef {object} RoundCalls the tool calls of one round
 * @property {any[]} waiting intents in call order that were not issued at
 *   once; only appended to, read from `issued` on (no in-place element
 *   moves: C-16, QC advisory 2)
 * @property {number} issued how many of `waiting` were issued
 * @property {number} inFlight
 * @property {number} unsettled calls without a recorded result
 * @property {boolean} frameLimited
 * @property {any} kit resolves when every call has a result
 * @property {Map<string, { entry: any, context: any }>} running issued
 *   calls without a result, by op id (deadlines reach their entry)
 */

/**
 * @typedef {object} ActiveTurn the current turn (vat-internal, mutable).
 *   The runner owns it. A runtime part reads it through `HookTurn.active`
 *   and writes only the fields marked "a part writes" below, in the hook
 *   named there; nothing else of it (runtime-parts.js; WX.1).
 * @property {any} turn
 * @property {any} sink
 * @property {string} turnId
 * @property {number} generation
 * @property {string} state 'running' | 'cancelling', then the settled status
 * @property {number} round
 * @property {boolean} dispatched
 * @property {any} ports TurnPorts, or undefined before crank B, while
 *   reopening, or after recovery
 * @property {number} claimAt the claim's time (`TurnStarted.at`)
 * @property {boolean} reopening the lease broke before Dispatched; fresh
 *   ports decide between in flight (recovery) and stale (round 0 again)
 * @property {boolean} engineStarted
 * @property {any} request the last RoundRequest sent (round 0 is sent again
 *   on fresh ports when the first ones were already dead)
 * @property {() => ToolIntent[]} openIntents intents of the current round
 *   without a result
 * @property {() => void} dropPorts forget the ports (recovery: they are
 *   tombstones), and the held ports when they are the same
 * @property {TurnInfo} info
 * @property {any} tools the tool set for these ports
 * @property {RoundCalls | undefined} calls
 * @property {any} roundKit pending until the round's roundFinal
 * @property {any} usage summed counts, or undefined before any round reported
 * @property {{ round: number, partial: any } | undefined} checkpoint the
 *   latest progress of the streaming round (W1b.1): kept outside the log,
 *   appended as one Partial only if the round ends without roundFinal
 * @property {number} [deadlineMs] the turn deadline fired (M2 seam 4): the
 *   cancel settles `failed` with `textOf.turnDeadline`
 * @property {string | undefined} systemNote a line every round request of
 *   this turn adds to the stored prompt (R4-29; a part writes it, in
 *   `onClaim`)
 * @property {number} [startIndex] the index of this turn's `TurnStarted`
 *   record (m8-interfaces.md T-1, set in the claim crank by the runner
 *   once the context window is built, seam S-5a)
 * @property {any} [compactionAsk] this round's `CompactionAsk`
 *   (m8-interfaces.md T-1, 4.1; a part writes it, in `beforeRound`; the
 *   runner puts it into the round request, seam S-5b)
 */

export {};
