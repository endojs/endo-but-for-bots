// @ts-check
import { projectJournalTurnHistory } from './journal-history.js';
import { makeJournalUsageReader } from './journal-usage.js';
import { recoverTurnTranscript } from './transcript-projection.js';

/**
 * Read-only projections of the same journal used by the active writer.
 * No guest, provider, preset, or inbox is needed to inspect the records.
 * @param {ReturnType<typeof import('./turn-journal.js').makeTurnJournal>} journal
 * @param {() => string | undefined} [activeTurn]
 */
export const makeSessionRecords = (journal, activeTurn = () => undefined) => {
  const read = ref => journal.readContent(ref);
  const allTurns = async () => {
    const { retained, archiveCursor } = await journal.readView();
    const turns = [...retained];
    let cursor = archiveCursor;
    while (cursor !== null) {
      // eslint-disable-next-line no-await-in-loop
      const page = await journal.listArchivedPage(cursor);
      turns.push(...page.records);
      cursor = page.next;
    }
    return turns.sort((a, b) => (BigInt(a.turnId) < BigInt(b.turnId) ? -1 : 1));
  };
  const getHistory = async (excludeTurnId = undefined, settledOnly = false) => {
    const messages = [];
    const receipts = new Set();
    for (const turn of await allTurns()) {
      if (
        turn.turnId !== excludeTurnId &&
        (!settledOnly ||
          (turn.state !== 'pending' && turn.turnId !== activeTurn()))
      ) {
        const receipt = turn.mail?.messageNumber;
        const duplicate = receipt !== undefined && receipts.has(receipt);
        if (receipt !== undefined) receipts.add(receipt);
        messages.push(
          // eslint-disable-next-line no-await-in-loop
          ...(await projectJournalTurnHistory(turn, read, duplicate)),
        );
      }
    }
    return harden(messages);
  };
  const getTranscript = async (excludeTurnId = undefined) => {
    const records = [];
    for (const turn of await allTurns()) {
      if (turn.turnId !== excludeTurnId && turn.state !== 'pending') {
        // eslint-disable-next-line no-await-in-loop
        records.push(...(await recoverTurnTranscript(turn, read)));
      }
    }
    return harden(records);
  };
  return harden({
    getHistory,
    getSettledHistory: () => getHistory(undefined, true),
    getTranscript,
    getUsage: makeJournalUsageReader(journal),
    getTurns: journal.list,
    getArchivedTurns: journal.listArchived,
    getArchivedTurnsPage: journal.listArchivedPage,
    getTurnContent: journal.readContent,
    getJournalStatus: async () =>
      harden({ ...(await journal.status()), storage: 'explicit' }),
    /** @param {string} [before] Exclusive turn ID; independent of archive publication order. */
    getHistoryPage: async before => {
      const page = await journal.historyPage(before, activeTurn());
      const turns = [];
      for (const turn of page.records) {
        // Keep receipts until rendering so a duplicate across a page boundary
        // is suppressed once both turns are on screen.
        turns.push({
          id: turn.turnId,
          ...(turn.mail?.messageNumber === undefined
            ? {}
            : { receipt: turn.mail.messageNumber }),
          // eslint-disable-next-line no-await-in-loop
          messages: await projectJournalTurnHistory(turn, read),
        });
      }
      return harden({ turns, before: page.before });
    },
  });
};
harden(makeSessionRecords);
