// @ts-check
// A turn re-attached mid-stream (W3.8, J-9605): the newest history page was
// read while the turn ran, so its records stop at `turn-started`; once the
// turn ends, the page must show the live fold, not those records.
import test from '@endo/ses-ava/prepare-endo.js';

import { turnContent } from '../../ui/src/conversation/transcript.js';

const fold = {
  messages: [{ role: 'assistant', text: 'c0 c1 c39', id: 'm1' }],
  streamingText: '',
  phase: '',
};
const started = { kind: 'turn-started', turnId: 't1', input: 'stream', at: 1 };

test('a settled turn whose records stop before its end shows its fold', t => {
  const shown = turnContent({
    turnId: 't1',
    state: 'completed',
    records: [started],
    fold,
  });
  t.true(shown.fromFold);
  t.is(shown.messages[0].text, 'c0 c1 c39');
});

test('a settled turn with its turn-settled record shows its records', t => {
  const shown = turnContent({
    turnId: 't1',
    state: 'completed',
    records: [
      started,
      {
        kind: 'round-settled',
        turnId: 't1',
        round: 0,
        text: 'from records',
        callCount: 0,
      },
      { kind: 'turn-settled', turnId: 't1', status: 'completed', at: 2 },
    ],
    fold,
  });
  t.false(shown.fromFold);
});

test('a cut history preview keeps the streamed reply through its final character', t => {
  const prefix = 'a'.repeat(1024);
  const text = `${prefix}!`;
  const shown = turnContent({
    turnId: 't1',
    state: 'completed',
    cut: true,
    records: [
      started,
      { kind: 'round-settled', text: prefix },
      { kind: 'turn-settled', final: prefix },
    ],
    fold: { ...fold, messages: [{ role: 'assistant', text }] },
  });
  t.is(shown.messages[0].text, text);
});

// M3-FIX, acceptance 8: a long reply watched live settles with its records,
// so its staged text can be read in full; the fold keeps thoughts and tools.
test('a watched settled turn shows the records’ staged text in the fold', t => {
  const staged = { blob: 'b1', preview: 'long rep', bytes: 1_048_576 };
  const shown = turnContent({
    turnId: 't1',
    state: 'completed',
    records: [
      started,
      {
        kind: 'tool-intents',
        turnId: 't1',
        intents: [{ opId: 'op1', name: 'read', args: '{"path":"a"}' }],
      },
      { kind: 'tool-result', turnId: 't1', opId: 'op1', result: 'A' },
      { kind: 'round-settled', turnId: 't1', round: 1, text: staged },
      { kind: 'turn-settled', turnId: 't1', status: 'completed', at: 2 },
    ],
    fold: {
      messages: [
        { role: 'thinking', text: 'hmm', id: 'th1' },
        { role: 'tool', id: 'op1', name: 'read', args: '', result: 'A…' },
        { role: 'assistant', text: 'long rep', id: 'm1' },
      ],
      streamingText: '',
      phase: '',
    },
  });
  t.deepEqual(
    shown.messages.map(message => message.role),
    ['thinking', 'tool', 'assistant'],
  );
  t.is(shown.messages[2].text, staged, 'the staged field, readable in full');
  t.is(shown.messages[1].result, 'A', 'the tool result from the records');
});

test('a fold that does not pair with the records gives the records', t => {
  const shown = turnContent({
    turnId: 't1',
    state: 'completed',
    records: [
      started,
      { kind: 'round-settled', turnId: 't1', round: 0, text: 'one' },
      { kind: 'round-settled', turnId: 't1', round: 1, text: 'two' },
      { kind: 'turn-settled', turnId: 't1', status: 'completed', at: 2 },
    ],
    fold,
  });
  t.deepEqual(
    shown.messages.map(message => message.text),
    ['one', 'two'],
  );
});
