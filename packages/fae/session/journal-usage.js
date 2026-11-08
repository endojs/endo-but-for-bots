// @ts-check
import { addUsage, projectUsage } from '@endo/hosted-agent/token-usage.js';

/**
 * Project accounting from a pinned journal cut. The cache is disposable; it
 * contains only immutable archived aggregates, never a second durable total.
 * @param {{ readView(): Promise<{ archivedTurns: number, archiveCursor: string, retained: any[] }>, listArchivedPage(cursor: string): Promise<{ records: any[], next: string | null }> }} journal
 */
export const makeJournalUsageReader = journal => {
  const emptySummary = () => ({
    counts: projectUsage(undefined),
    turns: 0,
    incompleteTurns: 0,
    used: { position: 0n, value: 0 },
    window: { position: 0n, value: 0 },
  });
  /** @type {{ archived: number, summary: ReturnType<typeof emptySummary> } | undefined} */
  let cached;
  /** @param {ReturnType<typeof emptySummary>} sum @param {any[]} turns */
  const tally = (sum, turns) => {
    for (const turn of turns) {
      if (turn.terminal) {
        if (turn.state === 'completed') sum.turns += 1;
        else sum.incompleteTurns += 1;
        const { context, ...counts } = projectUsage(turn.usage);
        sum.counts = addUsage(sum.counts, counts);
        const position = BigInt(turn.turnId);
        // Independent provenance: zero means unreported, not a newer reading.
        if (context?.usedTokens && position > sum.used.position) {
          sum.used = { position, value: context.usedTokens };
        }
        if (context?.windowTokens && position > sum.window.position) {
          sum.window = { position, value: context.windowTokens };
        }
      }
    }
  };
  return harden(async () => {
    const { archivedTurns, archiveCursor, retained } = await journal.readView();
    let archived = cached;
    if (!archived || archived.archived !== archivedTurns) {
      const summary = emptySummary();
      /** @type {string | null} */
      let cursor = archiveCursor;
      while (cursor !== null) {
        // eslint-disable-next-line no-await-in-loop
        const page = await journal.listArchivedPage(cursor);
        tally(summary, page.records);
        cursor = page.next;
      }
      archived = harden({ archived: archivedTurns, summary });
      cached = archived;
    }
    // Keep this request's cut even if an overlapping read updates the cache.
    // tally replaces nested counts/readings instead of mutating cached objects.
    const sum = { ...archived.summary };
    tally(sum, retained);
    return harden({
      ...sum.counts,
      ...(sum.used.value || sum.window.value
        ? {
            context: {
              usedTokens: sum.used.value,
              windowTokens: sum.window.value,
            },
          }
        : {}),
      turns: sum.turns,
      incompleteTurns: sum.incompleteTurns,
    });
  });
};
harden(makeJournalUsageReader);
