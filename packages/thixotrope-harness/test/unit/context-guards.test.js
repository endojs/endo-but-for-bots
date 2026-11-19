// @ts-check
// The context window's shapes as the session table holds them
// (guest/lib/guards/context.js, spread into guards/session.js by WX.1;
// designs/m8-interfaces.md 3.3): each accepts the contract's examples and
// refuses an extra key; `TurnRecord` takes the three record kinds; the
// archive letters stay unique; an inline summary over `inlineBytes` (the
// adapter must stage it) is refused at the sink's guard.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes } from '../../guest/lib/interfaces.js';
import { archiveKindLetters } from '../../guest/lib/guards/session.js';
import {
  compactionKindLetters,
  compactionKinds,
  compactionTexts,
} from '../../guest/lib/guards/session.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const usage = harden({
  inputTokens: 5,
  outputTokens: 7,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});
const stagedText = harden({ blob: Far('Blob', {}), preview: 'p', bytes: 9000 });

const examples = harden({
  CompactionAsk: {
    epoch: 1,
    boundary: 0,
    askedAt: 9,
    startIndex: 8,
    floor: 0,
    usedTokens: 80,
    windowTokens: 100,
    thresholdTokens: 70,
  },
  CompactionStarted: {
    kind: 'compaction-started',
    turnId: 't2',
    round: 0,
    epoch: 1,
    boundary: 0,
    usedTokens: 80,
    windowTokens: 100,
    at: 1,
  },
  Compaction: {
    kind: 'compaction',
    turnId: 't2',
    round: 0,
    epoch: 1,
    boundary: 4,
    summary: 'the summary',
    at: 2,
    directive: 'the input',
  },
  CompactionSkipped: {
    kind: 'compaction-skipped',
    turnId: 't2',
    round: 0,
    reason: compactionTexts.invalidBoundary,
    at: 2,
  },
  CompactionResult: {
    round: 0,
    at: 2,
    outcome: 'done',
    boundary: 4,
    summary: 'the summary',
    usage,
  },
  CompactionReply: {
    go: true,
    base: { count: 6, epoch: 1, boundary: 4 },
    append: [
      {
        kind: 'compaction-skipped',
        turnId: 't2',
        round: 0,
        reason: 'r',
        at: 2,
      },
    ],
  },
});

test('each shape accepts the contract example and refuses an extra key', t => {
  for (const [name, example] of Object.entries(examples)) {
    const shape = /** @type {any} */ (shapes)[name];
    t.true(matches(example, shape), name);
    t.false(matches(harden({ ...example, extra: 1 }), shape), `${name} extra`);
  }
  // The alternatives the examples above do not show.
  t.true(
    matches(
      harden({ round: 0, at: 2, outcome: 'skipped', reason: 'r' }),
      shapes.CompactionResult,
    ),
  );
  t.true(matches(harden({ go: false }), shapes.CompactionReply));
  t.true(
    matches(
      harden({ ...examples.Compaction, summary: stagedText }),
      shapes.Compaction,
    ),
    'a staged summary',
  );
  t.true(
    matches(
      harden({ ...examples.CompactionResult, summary: stagedText }),
      shapes.CompactionResult,
    ),
  );
});

test('TurnRecord takes the three kinds; their archive letters are unique', t => {
  for (const name of ['CompactionStarted', 'Compaction', 'CompactionSkipped']) {
    t.true(
      matches(/** @type {any} */ (examples)[name], shapes.TurnRecord),
      name,
    );
  }
  const kinds = compactionKindLetters.map(([kind]) => kind);
  t.deepEqual(kinds, [...compactionKinds]);
  const letters = archiveKindLetters.map(([, letter]) => letter);
  t.is(new Set(letters).size, letters.length);
  for (const [kind, letter] of compactionKindLetters) {
    t.true(
      archiveKindLetters.some(([k, l]) => k === kind && l === letter),
      kind,
    );
  }
});

test('a 30 KB inline summary is refused: the adapter stages over inlineBytes', t => {
  const summary = 'x'.repeat(30 * 1024);
  t.true(summary.length > limits.inlineBytes);
  t.false(
    matches(
      harden({ ...examples.CompactionResult, summary }),
      shapes.CompactionResult,
    ),
  );
  t.true(
    matches(
      harden({
        ...examples.CompactionResult,
        summary: 'x'.repeat(limits.inlineBytes),
      }),
      shapes.CompactionResult,
    ),
  );
});
