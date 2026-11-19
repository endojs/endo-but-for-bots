// @ts-check
// The per-part table of in-flight tool calls (WX.1; m6-interfaces.md
// D-M6-17, m9-interfaces.md D-M9-22): the first ending wins, a late answer
// is ignored, a turn's calls end together quietly or not, and the table is
// bounded.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { makeCallTable } from '../../guest/session/tools/call-table.js';
/* eslint-enable import/no-relative-packages */

const turnA = harden({ name: 'turn a' });
const turnB = harden({ name: 'turn b' });

test('an answer ends its call once; a late answer or another generation is ignored', async t => {
  const table = makeCallTable();
  /** @type {any[]} */
  const ends = [];
  const entry = table.open({
    opId: 't1/r0/c0',
    turn: turnA,
    generation: 1,
    onEnd: (outcome, quiet) => ends.push([outcome, quiet]),
  });
  if (entry === undefined) throw Error('not opened');
  t.is(table.size(), 1);
  t.is(table.get('t1/r0/c0'), entry);
  t.false(table.answer('t1/r0/c0', 2, 'other generation'));
  t.true(table.answer('t1/r0/c0', 1, 'ok'));
  t.false(table.answer('t1/r0/c0', 1, 'late'));
  t.false(table.end(entry, 'late again'));
  t.is(await entry.promise, 'ok');
  t.deepEqual(ends, [['ok', false]]);
  t.is(table.size(), 0);
  t.is(table.get('t1/r0/c0'), undefined);
});

test("endTurn ends every open call of one turn, quietly or not, and only that turn's", async t => {
  const table = makeCallTable();
  /** @type {any[]} */
  const ends = [];
  /** @param {string} opId @param {any} turn */
  const open = (opId, turn) =>
    table.open({
      opId,
      turn,
      generation: 1,
      onEnd: (outcome, quiet) => ends.push([opId, outcome, quiet]),
    });
  const a1 = open('a/c0', turnA);
  const b1 = open('b/c0', turnB);
  const a2 = open('a/c1', turnA);
  t.is(table.endTurn(turnA, 'abandoned', false), 2);
  t.is(await a1?.promise, 'abandoned');
  t.is(await a2?.promise, 'abandoned');
  t.is(table.size(), 1);
  t.false(table.answer('a/c0', 1, 'late'), 'a late answer is ignored');
  t.is(table.endTurn(turnB, 'unknown', true), 1);
  t.is(await b1?.promise, 'unknown');
  t.deepEqual(ends, [
    ['a/c0', 'abandoned', false],
    ['a/c1', 'abandoned', false],
    ['b/c0', 'unknown', true],
  ]);
  t.is(table.endTurn(turnB, 'again', true), 0);
});

test('the table is bounded by the call window and refuses an open op id', t => {
  const table = makeCallTable();
  for (let i = 0; i < limits.callWindow; i += 1) {
    t.truthy(table.open({ opId: `t/c${i}`, turn: turnA, generation: 1 }));
  }
  t.is(table.open({ opId: 't/full', turn: turnA, generation: 1 }), undefined);
  const small = makeCallTable({ max: 1 });
  t.truthy(small.open({ opId: 'x', turn: turnA, generation: 1 }));
  t.is(small.open({ opId: 'x', turn: turnA, generation: 1 }), undefined);
});
