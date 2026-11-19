// @ts-check
// The turn runner's index of turns (guest/session/turn-index.js) and its
// import of records (guest/session/turn-import.js), at their interfaces:
// ids and the counter, the bounded recent handles, the current turn's own
// Turn, findTurn's three answers, crank Z's drop of sealed infos (an
// unresolved outcome-unknown turn stays resolvable), and the import's
// order checks, info rebuild, seal call and end settle.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { makeRecordLog } from '../../guest/session/records.js';
import { makeTurnImport } from '../../guest/session/turn-import.js';
import { makeTurnIndex } from '../../guest/session/turn-index.js';
/* eslint-enable import/no-relative-packages */

const makeArchive = () => {
  /** @type {Map<string, any>} */
  const kept = new Map();
  return {
    kept,
    unresolvedInfo: (/** @type {string} */ id) => kept.get(id),
    keepUnresolved: (/** @type {string} */ id, /** @type {any} */ info) =>
      kept.set(id, info),
    resolve: (/** @type {string} */ id) => kept.delete(id),
  };
};

/** @param {any} [live] */
const setup = (live = undefined) => {
  const archive = makeArchive();
  let minted = 0;
  const index = makeTurnIndex({
    limits: { retainedTurnHandles: 2 },
    archive,
    mint: info => {
      minted += 1;
      return harden({ turn: info.turnId, minted });
    },
    live: () => live,
  });
  return { index, archive, minted: () => minted };
};

/** @param {string} turnId @param {string} [state] */
const infoOf = (turnId, state = 'completed') => ({
  turnId,
  input: 'x',
  at: 1,
  state,
  round: 0,
});

test('ids follow the counter; handles are minted once and the recent ones kept', t => {
  const { index, minted } = setup();
  t.is(index.nextId(), 't1');
  index.claimed();
  index.add(infoOf('t1'));
  index.claimed();
  index.add(infoOf('t2'));
  index.claimed();
  index.add(infoOf('t3'));
  t.is(index.count(), 3);
  t.is(index.nextId(), 't4');
  const first = index.byId('t1');
  t.is(index.byId('t1'), first, 'a recent handle is reused');
  index.byId('t2');
  index.byId('t3');
  t.is(minted(), 3);
  t.not(index.byId('t1'), first, 'beyond retainedTurnHandles a Turn is minted again');
  t.is(index.byId('t9'), undefined);
  t.deepEqual(
    [...index.infos()].map(info => info.turnId),
    ['t1', 't2', 't3'],
  );
});

test("the current turn's own Turn; findTurn answers a handle, turnSealed or unknownTurn", t => {
  const info = infoOf('t1', 'running');
  const own = harden({ own: true });
  const { index, archive } = setup({ info, turn: own });
  index.claimed();
  index.add(info);
  t.is(index.handle(info), own);
  t.is(index.find('t1'), own);
  index.claimed();
  const unknown = infoOf('t2', 'outcome-unknown');
  index.add(unknown);
  index.claimed();
  index.add(infoOf('t3'));
  index.archived(['t2', 't3']);
  t.true(unknown.sealed);
  t.is(archive.kept.get('t2'), unknown, 'unresolved stays resolvable');
  t.is(index.info('t2'), undefined);
  t.truthy(index.find('t2'));
  t.throws(() => index.find('t3'), { message: texts.turnSealed });
  t.throws(() => index.find('t4'), { message: texts.unknownTurn });
  t.throws(() => index.find('x1'), { message: texts.unknownTurn });
});

test('import: order checks, infos rebuilt, sealed after each list; the end settles a running turn', t => {
  const { index, archive } = setup();
  const records = makeRecordLog();
  const seen = [];
  const settled = [];
  let seals = 0;
  const turnImport = makeTurnImport({
    records,
    index,
    archive,
    usage: { settled: status => settled.push(status) },
    see: at => seen.push(at),
    lastKnownTime: () => 77,
    idle: () => true,
    seal: () => {
      seals += 1;
    },
  });
  const usage = harden({
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });
  t.throws(() =>
    turnImport.importTurns([
      harden({ kind: 'turn-started', turnId: 't2', input: 'x', at: 1 }),
    ]),
  );
  turnImport.importTurns([
    harden({ kind: 'turn-started', turnId: 't1', input: 'a', at: 5 }),
    harden({
      kind: 'round-settled',
      turnId: 't1',
      round: 2,
      text: 'r',
      callCount: 0,
      usage,
      at: 6,
    }),
    harden({
      kind: 'turn-settled',
      turnId: 't1',
      status: 'outcome-unknown',
      at: 7,
    }),
  ]);
  t.is(seals, 1);
  t.deepEqual(seen, [5, 6, 7]);
  t.like(index.info('t1'), { state: 'outcome-unknown', round: 2 });
  t.throws(() =>
    turnImport.importTurns([
      harden({ kind: 'turn-settled', turnId: 't1', status: 'failed', at: 8 }),
    ]),
  );
  turnImport.importTurns([
    harden({ kind: 'turn-resolved', turnId: 't1', note: 'ok', at: 8 }),
    harden({ kind: 'turn-started', turnId: 't2', input: 'b', at: 9 }),
  ]);
  t.is(index.info('t1')?.resolution, 'ok');
  turnImport.importEnd();
  t.like(index.info('t2'), { state: 'outcome-unknown' });
  t.deepEqual(settled, ['outcome-unknown']);
  const last = records.at(records.count() - 1);
  t.like(last, { kind: 'turn-settled', turnId: 't2', at: 77 });
  t.is(seals, 3, 'a refused list seals nothing');
});
