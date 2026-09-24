// @ts-check
import test from 'ava';
import { turnStatusView } from '../src/MessageList.js';

// Live 2026-09-25: a failed turn showed the adapter's reason and a CLI's
// stderr as if it were the assistant's reply.
const status = (turnState, text) => ({
  role: 'assistant',
  text,
  meta: { turnStatus: true, turnState },
});

test('a failed turn reads plainly and keeps its raw reason as detail', t => {
  const raw =
    'Claude compaction capture did not complete\n--- stderr ---\nClaude compaction capture failed: Unsupported context attachment';
  t.deepEqual(turnStatusView(status('failed', `Turn failed: ${raw}`)), {
    summary: 'This turn did not finish.',
    detail: raw,
  });
});

test('a status without a reason has no detail', t => {
  t.deepEqual(turnStatusView(status('cancelled', 'Turn cancelled.')), {
    summary: 'This turn was stopped.',
    detail: '',
  });
});

test('an unknown outcome asks for a check before retrying', t => {
  t.regex(
    turnStatusView(status('outcome-unknown', 'Turn outcome-unknown: lost'))
      .summary,
    /Check any tool results before retrying/,
  );
});

test('an unrecognized state is named, not hidden', t => {
  const view = turnStatusView(status('stalled', 'Turn stalled: why'));
  t.is(view.summary, 'This turn ended: stalled.');
  t.is(view.detail, 'why');
});
