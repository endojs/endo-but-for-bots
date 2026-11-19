// @ts-check
// Test helper for the session's compaction (guest/session/compaction.js;
// designs/m8-interfaces.md 4): the real session over the W2.4 fakes
// (`_m2-queue-session.js`), with the `compaction` part's value captured so
// a test can call `imageSeen`, and round answers that carry a context
// reading. Import after `_m1a-prelude.js`.

/* eslint-disable import/no-relative-packages */
import { compactionPart } from '../../guest/session/compaction.js';
import { runtimeParts } from '../../guest/session/runtime-parts.js';
/* eslint-enable import/no-relative-packages */
import { AT, drain, makeQueueSession } from './_m2-queue-session.js';

export { AT, drain };

/**
 * Round usage with a context reading (or none).
 * @param {number} [usedTokens]
 * @param {number} [windowTokens]
 */
export const usageOf = (usedTokens, windowTokens) =>
  harden({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    ...(usedTokens === undefined
      ? {}
      : { context: harden({ usedTokens, windowTokens }) }),
  });

/** A reading over the 70 % threshold of a 100-token window. */
export const OVER = usageOf(80, 100);

export const makeCompactionSession = async () => {
  /** @type {any} */
  let part;
  const parts = harden(
    runtimeParts.map(p =>
      p.name === 'compaction'
        ? harden({
            name: 'compaction',
            make: (/** @type {any} */ runtime) => {
              part = compactionPart.make(runtime);
              return part;
            },
          })
        : p,
    ),
  );
  const s = await makeQueueSession({ parts });
  const last = () => s.rounds[s.rounds.length - 1];
  /** The events published so far, flattened. */
  const events = () =>
    s.published.flatMap((/** @type {any} */ batch) => batch.events);
  /** The phases of the published events, in order. */
  const phases = () =>
    events()
      .filter((/** @type {any} */ e) => e.type === 'phase')
      .map((/** @type {any} */ e) => e.phase);
  /**
   * Answer the last round: `calls` unknown tool calls (each fails at once,
   * so the next round starts in the same crank), else final.
   * @param {object} [options]
   * @param {any} [options.usage]
   * @param {number} [options.calls]
   * @param {number} [options.at]
   */
  const answer = async ({ usage = usageOf(), calls = 0, at = AT + 1 } = {}) => {
    const req = last();
    req.sink.dispatching(req.round);
    const toolCalls = Array.from({ length: calls }, (_, k) =>
      harden({ callId: `c${req.round}-${k}`, name: 'noSuchTool', args: '{}' }),
    );
    req.sink.roundFinal(
      harden({
        round: req.round,
        text: calls === 0 ? 'final' : '',
        toolCalls: harden(toolCalls),
        usage,
        at,
      }),
    );
    await drain();
  };
  /**
   * One whole turn: round 0 answered final with `usage`.
   * @param {string} text
   * @param {any} [usage]
   */
  const turn = async (text, usage = usageOf()) => {
    await s.submit(text);
    await answer({ usage });
  };
  /** The record log as the session exports it (from the kept start). */
  const records = () => {
    /** @type {any[]} */
    const all = [];
    let page = s.internal.exportState();
    for (;;) {
      if (page.part === 'records') all.push(...page.records);
      if (page.next === undefined) break;
      page = s.internal.exportState(page.next);
    }
    return all;
  };
  return {
    ...s,
    part: () => part,
    last,
    events,
    phases,
    answer,
    turn,
    records,
  };
};
