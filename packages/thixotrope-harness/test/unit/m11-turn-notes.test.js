// @ts-check
// M11 9.1 (designs/m11-interfaces.md): a turn's spoken-mode facts
// (`TurnStarted.spoken`, `.dictated`) become a note in that turn's user
// message as the provider sees it (resources/agent-host/impl/projection.js
// `projectRecords`, `turnNoteOf`), never in the system text; the record
// keeps the input as sent; the compaction summariser reads the history
// without the notes (providers/compaction.js `planCompaction`,
// `summaryRequest`). Pure functions over the real record log; no vat.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */
import {
  projectRecords,
  turnNoteOf,
} from '../../resources/agent-host/impl/projection.js';
import {
  planCompaction,
  summaryRequest,
} from '../../resources/agent-host/impl/providers/compaction.js';
import { askOf, makeTurnLog } from '../adapter/_compaction-records.js';

const { dictatedTurnNote, readAloudTurnNote } = texts;

/**
 * Every kept record of the log.
 * @param {ReturnType<typeof makeTurnLog>} log
 * @returns {readonly any[]}
 */
const recordsOf = log => log.planInput().records;

/** Three settled turns: typed, typed in spoken mode, dictated. */
const threeTurns = () => {
  const log = makeTurnLog();
  log.turn({ input: 'typed' });
  log.turn({ input: 'typed aloud', marker: { spoken: true } });
  log.turn({ input: 'dictated', marker: { spoken: true, dictated: true } });
  return log;
};

/** @param {readonly any[]} transcript */
const userContents = transcript =>
  transcript
    .filter(e => e.kind === 'message' && e.role === 'user')
    .map(e => e.content);

test('the note goes with its turn user message; a typed turn is unchanged', t => {
  const log = threeTurns();
  const { transcript } = projectRecords(recordsOf(log), {
    texts: new Map(),
  });
  t.deepEqual(userContents(transcript), [
    'typed',
    `typed aloud\n\n${readAloudTurnNote}`,
    `dictated\n\n${dictatedTurnNote}\n\n${readAloudTurnNote}`,
  ]);
  t.is(turnNoteOf({}), undefined);
  t.is(turnNoteOf({ dictated: true }), dictatedTurnNote);
  // The records keep the input as sent (history and transcript unchanged).
  t.deepEqual(
    recordsOf(log)
      .filter(r => r.kind === 'turn-started')
      .map(r => r.input),
    ['typed', 'typed aloud', 'dictated'],
  );
  const plain = projectRecords(recordsOf(log), {
    texts: new Map(),
    notes: false,
  });
  t.deepEqual(userContents(plain.transcript), [
    'typed',
    'typed aloud',
    'dictated',
  ]);
});

test('a compaction during a spoken turn: no spoken note in the summary round', t => {
  const log = threeTurns();
  for (let i = 0; i < 6; i += 1) {
    log.turn({
      input: `aloud ${i}`,
      marker: { spoken: true, dictated: true },
      rounds: [
        { text: 'calling', calls: [{ result: 'r'.repeat(2000) }] },
        { text: `answer ${i}` },
      ],
    });
  }
  const current = log.turn({
    input: 'the spoken directive',
    marker: { spoken: true, dictated: true },
    rounds: [],
    status: null,
  });
  const askedAt = log.started(current.turnId, 0);
  const system = 'You are a test assistant.';
  const plan = /** @type {any} */ (
    planCompaction({
      input: log.planInput(),
      ask: askOf({ askedAt, startIndex: current.startIndex }),
      system,
      tools: [],
    })
  );
  t.false('refuse' in plan, plan.refuse);
  t.is(plan.system, system, 'the round system text, with no note');
  const request = /** @type {any} */ (summaryRequest(plan));
  const sent = JSON.stringify(request.transcript);
  t.true(sent.includes('dictated'), 'the history is there');
  for (const note of [readAloudTurnNote, dictatedTurnNote]) {
    t.false(sent.includes(JSON.stringify(note).slice(1, 41)));
  }
  // The retained tail is sent to the provider after the summary: its turns
  // keep their notes.
  const tail = userContents(plan.retained);
  t.true(tail.length > 0);
  for (const content of tail) t.true(content.endsWith(readAloudTurnNote));
});
