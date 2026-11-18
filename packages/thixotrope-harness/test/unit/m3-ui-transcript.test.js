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
