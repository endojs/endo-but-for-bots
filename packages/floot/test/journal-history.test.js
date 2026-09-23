// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { projectJournalTurnHistory } from '../src/journal-history.js';
import { encodeJournalPresentation } from '../src/journal-presentation.js';
import { encodeJournalTranscript } from '../src/journal-transcript.js';

const noContent = async () => {
  throw Error('Unexpected content read');
};
const transcript = records =>
  records.map((record, index) => ({
    ordinal: `${index}`,
    payload: encodeJournalTranscript(record),
  }));

test('sealed multi-round output is not duplicated; unsealed mismatched output remains visible', async t => {
  const turn = {
    turnId: '1',
    input: 'Request',
    state: 'completed',
    transcript: transcript([
      { kind: 'message', role: 'user', content: 'Request' },
      { kind: 'message', role: 'assistant', content: 'Working' },
      { kind: 'message', role: 'user', content: 'Continuation' },
      { kind: 'message', role: 'assistant', content: 'Answer' },
    ]),
    transcriptComplete: true,
    output: 'Answer',
  };
  t.deepEqual(
    (await projectJournalTurnHistory(turn, noContent, true)).map(
      row => row.content,
    ),
    ['Working', 'Continuation', 'Answer'],
  );
  const history = await projectJournalTurnHistory(
    {
      ...turn,
      transcriptComplete: false,
      state: 'failed',
      output: 'Other reply',
    },
    noContent,
  );
  t.like(history.at(-2).meta, { recoveredEvidence: true, orderUnknown: true });
  t.regex(history.at(-2).content, /unknown\.\]\nOther reply$/);
});

test('journal history preserves thinking anchors and repeated tool IDs without displaying compaction context', async t => {
  const records = [
    { kind: 'message', role: 'assistant', content: 'Before' },
    { kind: 'tool-call', id: 'same', name: 'read', args: '{}' },
    { kind: 'tool-result', id: 'same', content: 'A' },
    {
      kind: 'compaction',
      summary: 'hidden summary',
      retainedTail: [{ kind: 'message', role: 'user', content: 'hidden tail' }],
    },
    { kind: 'tool-call', id: 'same', name: 'read', args: '{}' },
    { kind: 'tool-result', id: 'same', content: 'B' },
    { kind: 'message', role: 'assistant', content: 'After' },
  ];
  const blocks = [1, 3, 7].map((anchor, index) => ({
    id: `thinking-${index}`,
    text: `Thinking ${index}`,
    startedAt: index,
    endedAt: index + 1,
    truncated: false,
    beforeTranscriptOrdinal: `${anchor}`,
  }));
  const turn = {
    turnId: '1',
    input: 'Request',
    state: 'completed',
    mail: { from: 'sender', messageNumber: '7' },
    transcript: transcript(records),
    transcriptComplete: true,
    presentation: {
      payload: encodeJournalPresentation(blocks, records.length),
    },
    output: 'BeforeAfter',
  };
  const history = await projectJournalTurnHistory(turn, noContent);
  t.deepEqual(
    history.map(row => row.content ?? row.result),
    [
      'Request',
      'Before',
      'Thinking 0',
      'A',
      'Thinking 1',
      'B',
      'After',
      'Thinking 2',
    ],
  );
  t.deepEqual(
    history.filter(row => row.role === 'tool').map(row => row.id),
    ['same', 'same'],
  );
  t.deepEqual(history[0].meta.mail, turn.mail);
  t.like(history[2].thinking, { startedAt: 0, endedAt: 1, truncated: false });
  t.false(JSON.stringify(history).includes('hidden'));
  t.deepEqual(
    (await projectJournalTurnHistory(turn, noContent, true)).map(
      row => row.content ?? row.result,
    ),
    ['Before', 'Thinking 0', 'A', 'Thinking 1', 'B', 'After', 'Thinking 2'],
  );
});

test('history hydrates an input whose first transcript publication failed and preserves status', async t => {
  const full = 'x'.repeat(9000);
  const turn = {
    turnId: '1',
    input: 'preview',
    inputRef: { name: 'input', chars: full.length },
    state: 'failed',
    error: 'Storage failure',
    resolution: 'Inspected',
    mail: { messageNumber: '7' },
  };
  const history = await projectJournalTurnHistory(turn, async ref => {
    t.is(ref.name, 'input');
    return full;
  });
  t.is(history[0].content, full);
  t.like(history[0].meta, {
    turnId: '1',
    turnState: 'failed',
    resolution: 'Inspected',
    mail: { messageNumber: '7' },
  });
  t.like(history[1], {
    content: 'Turn failed: Storage failure',
    meta: { turnStatus: true },
  });
  t.is((await projectJournalTurnHistory(turn, noContent, true)).length, 1);
});

test('supplemental effects are explicitly unordered and cannot replace the acknowledged reply', async t => {
  const turn = {
    turnId: '1',
    input: 'Request',
    state: 'failed',
    error: 'Lost stream',
    transcript: transcript([
      { kind: 'message', role: 'assistant', content: 'Prefix' },
    ]),
    output: 'Prefix suffix',
    tools: [
      {
        callId: 'host-1',
        name: 'effect',
        args: '{}',
        result: 'Done',
        settled: true,
      },
    ],
  };
  const history = await projectJournalTurnHistory(turn, noContent);
  t.deepEqual(
    history.slice(0, 3).map(row => row.content),
    ['Request', 'Prefix', ' suffix'],
  );
  t.like(history[3].meta, { orderUnknown: true, recoveredEvidence: true });
  t.regex(history[3].result, /ordering relative to the reply is unknown/);
  t.regex(history[3].result, /Done/);
  t.true(history.at(-1).meta.turnStatus);
});
