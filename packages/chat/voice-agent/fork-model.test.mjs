// fork-model.test.mjs — the retry-as-fork data-model the chat client drives.
//   node --test packages/chat/voice-agent/fork-model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { forkRetry, forkPage, forkCount, forkIndex } from './public/fork-model.js';

// a small transcript: you → agent → you → agent
const seed = () => [
  { who: 'you', text: 'plan a Copenhagen trip' },
  { who: 'agent', text: 'Here are some ideas…' },
  { who: 'you', text: 'now find museums' },
  { who: 'agent', text: 'Museum list…' },
];

test('retry forks at a user turn: clears everything below + starts a fresh branch with the new prompt', () => {
  const tx = seed();
  const ok = forkRetry(tx, 0, 'plan a Stockholm trip'); // retry the FIRST user turn
  assert.equal(ok, true);
  assert.equal(tx.length, 1, 'everything below the bubble is cleared');
  assert.equal(tx[0].text, 'plan a Stockholm trip', 'the bubble now shows the new prompt');
  assert.equal(forkCount(tx[0]), 2, 'two forks now exist (original + new)');
  assert.equal(forkIndex(tx[0]), 1, 'the new fork is active');
  // the original branch (prompt + its whole tail) is preserved in fork 0
  assert.equal(tx[0].forks[0].prompt, 'plan a Copenhagen trip');
  assert.equal(tx[0].forks[0].tail.length, 3, 'the original continuation (agent + you + agent) is stashed');
});

test('paging restores the OTHER branch: its prompt + entire continuation come back; current branch is re-stashed', () => {
  const tx = seed();
  forkRetry(tx, 0, 'plan a Stockholm trip');
  // grow the new branch a little so paging has something to stash/restore
  tx.push({ who: 'agent', text: 'Stockholm ideas…' });
  assert.equal(forkPage(tx, 0, -1), true, 'page back to the original branch');
  assert.equal(tx[0].text, 'plan a Copenhagen trip', 'the original prompt is restored');
  assert.equal(tx.length, 4, 'the original continuation is fully restored');
  assert.deepEqual(tx.map(m => m.text), ['plan a Copenhagen trip', 'Here are some ideas…', 'now find museums', 'Museum list…']);
  // page forward again → the Stockholm branch (with the extra agent turn we added) returns intact
  assert.equal(forkPage(tx, 0, 1), true);
  assert.equal(tx[0].text, 'plan a Stockholm trip');
  assert.equal(tx.at(-1).text, 'Stockholm ideas…', 'the second branch kept the turn added while it was active');
});

test('paging wraps around and is a no-op when there is only one branch', () => {
  const tx = seed();
  assert.equal(forkPage(tx, 0, 1), false, 'no forks yet → nothing to page');
  forkRetry(tx, 0, 'B'); forkRetry(tx, 0, 'C'); // forks: [A, B, C], active C
  assert.equal(forkIndex(tx[0]), 2);
  forkPage(tx, 0, 1); // wrap forward 2 → 0
  assert.equal(forkIndex(tx[0]), 0);
  forkPage(tx, 0, -1); // wrap back 0 → 2
  assert.equal(forkIndex(tx[0]), 2);
});

test('nested forks survive: a fork on a LATER turn is preserved inside an earlier turn\'s stashed tail', () => {
  const tx = seed();
  // fork the later user turn (index 2) first
  forkRetry(tx, 2, 'find playgrounds instead');
  assert.equal(forkCount(tx[2]), 2);
  // now fork the FIRST user turn — this stashes the (already-forked) turn 2 into turn 0's tail
  forkRetry(tx, 0, 'a totally different trip');
  assert.equal(tx.length, 1);
  const stashedLaterTurn = tx[0].forks[0].tail.find(e => e.who === 'you');
  assert.ok(stashedLaterTurn, 'the later user turn is stashed');
  assert.equal(forkCount(stashedLaterTurn), 2, 'its own forks are preserved inside the stash');
  // page back to the original first-turn branch → the nested-forked turn 2 comes back with its forks intact
  forkPage(tx, 0, -1);
  assert.equal(tx[0].text, 'plan a Copenhagen trip');
  assert.equal(forkCount(tx[2]), 2, 'the nested fork is restored');
});

test('forkRetry refuses a non-user (or missing) turn', () => {
  const tx = seed();
  assert.equal(forkRetry(tx, 1, 'x'), false, 'cannot fork an agent turn');
  assert.equal(forkRetry(tx, 99, 'x'), false, 'cannot fork a missing turn');
  assert.equal(tx.length, 4, 'the transcript is untouched on refusal');
});
