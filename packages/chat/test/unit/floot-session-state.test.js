// @ts-check
import '@endo/init/debug.js';

import test from 'ava';

import { applyTranscript } from '@endo/floot/src/transcript-delta.js';

import { normalizePending } from '../../floot-session-state.js';

const user = text => ({ role: 'user', content: text });

test('a snapshot starts a transcript and deltas extend or rewrite its tail', t => {
  let held = applyTranscript(null, {
    version: 3,
    base: 0,
    keep: 0,
    append: [user('a')],
  });
  t.deepEqual(held, { version: 3, messages: [user('a')] });
  held = applyTranscript(held || null, {
    version: 4,
    base: 3,
    keep: 1,
    append: [user('b'), user('c')],
  });
  t.deepEqual(held?.messages, [user('a'), user('b'), user('c')]);
  // A resolution rewrites the tail.
  held = applyTranscript(held || null, {
    version: 5,
    base: 4,
    keep: 2,
    append: [user('c, resolved')],
  });
  t.deepEqual(held?.messages, [user('a'), user('b'), user('c, resolved')]);
});

test('an event already applied changes nothing; a gap is refused', t => {
  const held = { version: 5, messages: [user('a')] };
  t.deepEqual(
    applyTranscript(held, { version: 5, base: 4, keep: 0, append: [] }),
    held,
  );
  // Version 7 follows 6, which this view never saw.
  t.is(
    applyTranscript(held, { version: 7, base: 6, keep: 1, append: [] }),
    undefined,
  );
  // A delta cannot start a transcript.
  t.is(
    applyTranscript(null, { version: 2, base: 1, keep: 1, append: [] }),
    undefined,
  );
  // Nor keep more than is held.
  t.is(
    applyTranscript(held, { version: 6, base: 5, keep: 9, append: [] }),
    undefined,
  );
  t.is(applyTranscript(held, /** @type {any} */ ({})), undefined);
});

test('what the daemon reports as pending is held to the shape the view uses', t => {
  t.deepEqual(normalizePending(null), { entries: [], hold: null });
  t.deepEqual(normalizePending({ entries: 'nope' }), {
    entries: [],
    hold: null,
  });
  t.deepEqual(
    normalizePending({
      entries: [
        { id: 'p1', text: 'one', state: 'interrupted', createdAt: 5 },
        { id: 7, text: 'no id' },
        { id: 'p2', text: 'two' },
      ],
      hold: { reason: 'restart', message: 'held', extra: true },
    }),
    {
      entries: [
        { id: 'p1', text: 'one', state: 'interrupted' },
        { id: 'p2', text: 'two', state: 'queued' },
      ],
      hold: { reason: 'restart', message: 'held' },
    },
  );
});
