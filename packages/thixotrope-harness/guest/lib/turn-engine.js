// @ts-check
/**
 * The provider/tool state machine of one turn (M1a W1a.1).
 *
 * Ported from Endo `packages/fae/src/turn-engine.js` at commit `1315bef86`
 * (86 lines). Changes for vats, and nothing else:
 * - `Fail` is the prelude global, not an import of `@endo/errors` (a guest
 *   bundle must not carry a second copy of an `@endo/*` library);
 * - `signal` is typed as any object with `throwIfAborted()` instead of an
 *   `AbortSignal`: vats have no `AbortController`, so a vat caller passes
 *   its own fence (the engine only ever calls `throwIfAborted`).
 *
 * The engine was already pure: every effect (tools, context, the provider
 * call, the tool run, the commits) is an injected callback, there is no
 * clock, no id minting and no persistence assumption. In a vat each `await`
 * below may span cranks (a provider round arrives as a later delivery); the
 * engine keeps no state outside the async function's frame, which Thixotrope
 * persists with the vat heap (M0 S5: suspended async functions survive
 * deliveries and restarts).
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Fail } = /** @type {GuestGlobals} */ (globalThis);

/** Finite runaway-loop guard, not a provider or model-context limit. */
export const DEFAULT_MAX_TOOL_ROUNDS = 1024;
harden(DEFAULT_MAX_TOOL_ROUNDS);

/**
 * Run the provider/tool state machine shared by FAE and Floot.
 *
 * Persistence, wire encoding, streaming, and inbox policy stay in the caller.
 * This engine owns the invariant that each model response is followed by all
 * of its tool results before another model call, and that exactly one toolless
 * response ends the logical turn.
 *
 * @param {object} options
 * @param {string} options.cursor
 * @param {number} options.maxRounds
 * @param {{ throwIfAborted(): void }} [options.signal] Fence late provider outcomes and further tool admission.
 * @param {(round: number) => Promise<any>} options.getTools
 * @param {(cursor: string, tools: any, round: number) => Promise<{cursor: string, messages: readonly any[]}>} options.getContext A selected context snapshot; checkpoint selection may advance the durable head.
 * @param {(context: readonly any[], tools: any, round: number) => Promise<{ message?: any }>} options.invoke
 * @param {(message: any) => readonly any[]} options.getToolCalls
 * @param {(calls: readonly any[], tools: any, round: number) => Promise<any>} options.runTools
 * @param {(cursor: string, message: any, results: any) => Promise<string>} options.commitStep
 * @param {(cursor: string, message: any) => Promise<string>} options.commitFinal
 */
export const runAgenticTurn = async ({
  cursor,
  maxRounds,
  signal,
  getTools,
  getContext,
  invoke,
  getToolCalls,
  runTools,
  commitStep,
  commitFinal,
}) => {
  (Number.isInteger(maxRounds) && maxRounds > 0) ||
    Fail`agentic turn maxRounds must be a positive integer`;
  let currentCursor = cursor;
  await null;
  for (let round = 0; round < maxRounds; round += 1) {
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    const tools = await getTools(round);
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await getContext(currentCursor, tools, round);
    currentCursor = snapshot.cursor;
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    const outcome = await invoke(snapshot.messages, tools, round);
    signal?.throwIfAborted();
    if (!outcome.message) {
      return harden({
        answered: false,
        exhausted: false,
        cursor: currentCursor,
      });
    }
    const calls = getToolCalls(outcome.message);
    if (calls.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      currentCursor = await commitFinal(currentCursor, outcome.message);
      return harden({
        answered: true,
        exhausted: false,
        cursor: currentCursor,
        message: outcome.message,
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const results = await runTools(calls, tools, round);
    // eslint-disable-next-line no-await-in-loop
    currentCursor = await commitStep(currentCursor, outcome.message, results);
  }
  return harden({
    answered: false,
    exhausted: true,
    cursor: currentCursor,
  });
};
harden(runAgenticTurn);
