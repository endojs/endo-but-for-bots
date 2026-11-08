// @ts-check
import harden from '@endo/harden';

/**
 * The live watch owns the newest page. Fetch older pages on request, merging
 * by durable turn ID. A reconnect supplies a new initial window; outstanding
 * reads of its predecessor may no longer publish.
 * @param {(before:string) => Promise<{turns:any[],before:string|null}>} read
 * @param {(messages:any[], more:boolean, loading:boolean) => void} publish
 * @param {(error:unknown) => void} report
 */
export const makeFlootHistoryPages = (read, publish, report) => {
  /** @type {readonly any[]} */
  let newest = [];
  /** @type {readonly any[]} */
  let older = [];
  /** @type {string|null} */
  let boundary = null;
  /** @type {string|null} */
  let next = null;
  let wanted = 0;
  let loadedPages = 0;
  let reload = false;
  let generation = 0;
  let closed = false;
  let reading = false;
  const emit = () => {
    if (closed) return;
    const byId = new Map([...older, ...newest].map(turn => [turn.id, turn]));
    const sorted = [...byId.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );
    const receipts = new Set();
    const messages = [];
    for (const turn of sorted) {
      let omit = turn.receipt !== undefined && receipts.has(turn.receipt);
      if (turn.receipt !== undefined) receipts.add(turn.receipt);
      for (const message of turn.messages) {
        if (omit && message.role === 'user') omit = false;
        else messages.push(message);
      }
    }
    publish(messages, next !== null, reading);
  };
  const refresh = async () => {
    generation += 1;
    if (reading || closed) return;
    reading = true;
    try {
      for (;;) {
        const version = generation;
        let cursor = reload ? boundary : next;
        const pages = reload ? [] : [...older];
        let count = reload ? 0 : loadedPages;
        reload = false;
        while (
          count < wanted &&
          cursor !== null &&
          !closed &&
          version === generation
        ) {
          let page;
          try {
            // eslint-disable-next-line no-await-in-loop
            page = await read(cursor);
          } catch (error) {
            if (closed || version !== generation) break;
            throw error;
          }
          if (closed || version !== generation) break;
          if (page.before !== null && BigInt(page.before) >= BigInt(cursor))
            throw Error('History cursor did not advance');
          pages.push(...page.turns);
          count += 1;
          cursor = page.before;
        }
        if (closed) return;
        if (version === generation) {
          older = pages;
          next = cursor;
          wanted = count;
          loadedPages = count;
          return;
        }
      }
    } catch (error) {
      reload = true;
      wanted = loadedPages;
      if (!closed) report(error);
    } finally {
      reading = false;
      emit();
    }
  };
  return harden({
    /** @param {readonly any[]} turns @param {string | null} before @param {boolean} reset */
    setLatest(turns, before, reset) {
      newest = turns;
      boundary = before;
      if (reset) {
        older = [];
        wanted = 0;
        loadedPages = 0;
      }
      reload = true;
      if (!wanted) next = before;
      emit();
      if (wanted || reading) void refresh();
    },
    more() {
      if (closed || reading || next === null) return;
      wanted += 1;
      void refresh();
      emit();
    },
    // Late tool evidence can change a previously displayed, unresolved turn.
    journalChanged() {
      if (wanted) {
        reload = true;
        void refresh();
      }
    },
    close() {
      closed = true;
    },
  });
};
harden(makeFlootHistoryPages);
