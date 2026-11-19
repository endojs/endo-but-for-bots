// @ts-check
// Client endpointing (designs/m11-interfaces.md section 9, acceptance 6;
// R5-19..R5-33, R5-46): synthetic level sequences of 85 ms blocks through
// the pure endpointer, the pre-roll, the junk filter and the grace send.
import test from '@endo/ses-ava/prepare-endo.js';

import {
  keptFinal,
  makeEndpointer,
  makePreRoll,
  makeSpokenDraft,
  meterFraction,
} from '../../ui/src/voice/endpointing.js';
import {
  endpointingDefaults as d,
  junkFinals,
} from '../../ui/src/voice/endpointing-defaults.js';

const BLOCK_MS = 85;

/**
 * Feed `[level, ms]` runs as 85 ms blocks from `atMs`.
 *
 * @param {ReturnType<typeof makeEndpointer>} endpointer
 * @param {Array<[number, number]>} runs
 * @param {{ at: number }} clock
 */
const feed = (endpointer, runs, clock) => {
  /** @type {Array<{ at: number } & ReturnType<ReturnType<typeof makeEndpointer>['block']>>} */
  const out = [];
  for (const [level, ms] of runs) {
    const until = clock.at + ms;
    while (clock.at < until) {
      out.push({ at: clock.at, ...endpointer.block(level, clock.at) });
      clock.at += BLOCK_MS;
    }
  }
  return out;
};

/** @param {Array<{ action: string }>} decisions */
const actionsOf = decisions => decisions.map(x => x.action);

/**
 * A calibrated endpointer with a floor of 0.004 (threshold 0.01).
 *
 * @param {Parameters<typeof makeEndpointer>[1]} [options]
 */
const calibrated = (options = {}) => {
  const endpointer = makeEndpointer(d, options);
  const clock = { at: 0 };
  feed(endpointer, [[0.004, d.calibrationMs + BLOCK_MS]], clock);
  return { endpointer, clock };
};

test('calibration measures, then sets the floor at the 75th percentile', t => {
  const endpointer = makeEndpointer();
  const levels = [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008];
  /** @type {string[]} */
  const actions = [];
  let at = 0;
  let last;
  for (let i = 0; at < d.calibrationMs; i += 1) {
    last = endpointer.block(levels[i % levels.length], at);
    actions.push(last.action);
    at += BLOCK_MS;
  }
  t.true(actions.every(a => a === 'calibrating'));
  t.is(last?.threshold, d.thresholdMinimum);
  // the block that closes the window: 13 samples sorted, index 9
  last = endpointer.block(0.002, at);
  t.is(last.action, 'quiet');
  const samples = [];
  for (let i = 0; i < 12; i += 1) samples.push(levels[i % levels.length]);
  samples.push(0.002);
  samples.sort((a, b) => a - b);
  const floor = samples[Math.floor(samples.length * d.calibrationPercentile)];
  t.is(last.floor, floor);
  t.is(
    last.threshold,
    Math.max(d.thresholdMinimum, floor * d.thresholdMultiplier),
  );
  // a loud room raises the threshold above the minimum
  const loud = makeEndpointer();
  let x = 0;
  let decision;
  for (; x < d.calibrationMs + BLOCK_MS; x += BLOCK_MS) {
    decision = loud.block(0.02, x);
  }
  t.is(decision?.threshold, 0.02 * d.thresholdMultiplier);
  // a loud level during calibration opens nothing
  const quietRoom = makeEndpointer();
  t.is(quietRoom.block(0.5, 0).action, 'calibrating');
});

test('the floor drifts toward a quiet room', t => {
  const { endpointer, clock } = calibrated();
  const before = endpointer.block(0.004, clock.at).floor;
  clock.at += BLOCK_MS;
  const after = feed(endpointer, [[0.001, 20 * BLOCK_MS]], clock).at(-1);
  t.true((after?.floor ?? 1) < before);
  const expected = (1 - d.floorDrift) * before + d.floorDrift * 0.001;
  const one = calibrated();
  t.is(one.endpointer.block(0.001, one.clock.at).floor, expected);
});

test('a 400 ms burst is discarded; a longer one ends with END', t => {
  const { endpointer, clock } = calibrated();
  const burst = feed(
    endpointer,
    [
      [0.05, 400],
      [0.002, d.trailingSilenceMs + 2 * BLOCK_MS],
    ],
    clock,
  );
  const actions = actionsOf(burst);
  t.is(actions[0], 'onset');
  t.true(burst[0].send);
  t.false(actions.includes('end'));
  t.is(actions.filter(a => a === 'discard').length, 1);
  const discard = burst.find(x => x.action === 'discard');
  t.false(discard?.send);

  const speech = feed(
    endpointer,
    [
      [0.05, 600],
      [0.002, d.trailingSilenceMs + 2 * BLOCK_MS],
    ],
    clock,
  );
  t.is(speech[0].action, 'onset');
  const end = speech.findIndex(x => x.action === 'end');
  t.true(end > 0);
  t.true(speech[end].send);
  // every block from onset to END belongs to the utterance
  t.true(speech.slice(0, end + 1).every(x => x.send));
  t.false(endpointer.speaking());
});

test('1,200 ms of trailing silence sends END, not earlier', t => {
  const { endpointer, clock } = calibrated();
  const run = feed(
    endpointer,
    [
      [0.05, 1000],
      [0.002, 2000],
    ],
    clock,
  );
  const firstQuiet = run.find(x => x.level === 0.002);
  const end = run.find(x => x.action === 'end');
  if (!firstQuiet || !end) throw Error('no END');
  const silence = end.at - firstQuiet.at;
  t.true(silence >= d.trailingSilenceMs);
  t.true(silence < d.trailingSilenceMs + BLOCK_MS);
  // a word in the silence resets the timer
  const reset = feed(
    endpointer,
    [
      [0.05, 600],
      [0.002, 1000],
      [0.05, 170],
      [0.002, 1100],
    ],
    clock,
  );
  t.false(actionsOf(reset).includes('end'));
  t.true(endpointer.speaking());
});

test('barge-in: a busy turn needs the barge-in threshold, audible speech the echo factor', t => {
  let busy = false;
  let audible = false;
  const { endpointer, clock } = calibrated({
    busy: () => busy,
    audible: () => audible,
  });
  const speech = Math.max(d.thresholdMinimum, 0.004 * d.thresholdMultiplier);
  const barge = Math.max(d.bargeInMinimum, speech * d.bargeInMultiplier);
  t.is(barge, 0.05);

  busy = true;
  t.is(endpointer.block(0.04, clock.at).action, 'quiet');
  const opened = endpointer.block(barge + 0.001, clock.at + BLOCK_MS);
  t.is(opened.action, 'onset');
  t.true(opened.bargeIn);
  clock.at += 2 * BLOCK_MS;
  feed(endpointer, [[0.002, d.trailingSilenceMs + 2 * BLOCK_MS]], clock);
  t.false(endpointer.speaking());

  // not busy: the speech threshold opens, and it is not a barge-in
  busy = false;
  const plain = endpointer.block(0.04, clock.at);
  t.is(plain.action, 'onset');
  t.false(plain.bargeIn);
  clock.at += BLOCK_MS;
  feed(endpointer, [[0.002, d.trailingSilenceMs + 2 * BLOCK_MS]], clock);

  // the page's own speech is audible: barge x echo factor, busy or not
  audible = true;
  const echo = barge * d.echoBargeInFactor;
  t.is(endpointer.block(echo - 0.01, clock.at).action, 'quiet');
  t.is(endpointer.block(echo + 0.01, clock.at + BLOCK_MS).action, 'onset');
});

test('invocation mode skips calibration and opens at once', t => {
  const endpointer = makeEndpointer(d, { immediate: true });
  const first = endpointer.block(0.0001, 0);
  t.is(first.action, 'onset');
  t.is(first.floor, 0);
  t.is(first.threshold, d.thresholdMinimum);
  t.true(endpointer.speaking());
});

test('pause aborts an open utterance; resume calibrates again', t => {
  const { endpointer, clock } = calibrated();
  t.is(endpointer.block(0.05, clock.at).action, 'onset');
  t.true(endpointer.pause());
  t.is(endpointer.block(0.05, clock.at + BLOCK_MS).action, 'paused');
  t.false(endpointer.block(0.05, clock.at + 2 * BLOCK_MS).send);
  endpointer.resume();
  t.is(endpointer.block(0.05, clock.at + 3 * BLOCK_MS).action, 'calibrating');
  t.false(endpointer.pause());
});

test('a non-finite or negative level counts as silence', t => {
  const { endpointer, clock } = calibrated();
  t.is(endpointer.block(Number.NaN, clock.at).level, 0);
  t.is(endpointer.block(-1, clock.at + BLOCK_MS).action, 'quiet');
});

test('the pre-roll keeps the last six blocks, oldest first', t => {
  const preRoll = makePreRoll();
  for (let i = 0; i < 9; i += 1) preRoll.push(Uint8Array.of(i));
  t.deepEqual(
    preRoll.take().map(b => b[0]),
    [3, 4, 5, 6, 7, 8],
  );
  t.deepEqual(preRoll.take(), []);
});

test('junk finals are dropped (R5-21)', t => {
  for (const phrase of junkFinals) {
    t.is(keptFinal(phrase), '', phrase);
  }
  t.is(keptFinal('Thank you.'), '');
  t.is(keptFinal('  OKAY!  '), '');
  t.is(keptFinal('Um,'), '');
  t.is(keptFinal('a'), '');
  t.is(keptFinal(''), '');
  t.is(keptFinal(' Thank you for the help. '), 'Thank you for the help.');
  t.is(keptFinal('no'), 'no');
});

test('grace: the box is sent 800 ms after the final; edits kept, clearing cancels', t => {
  const draft = makeSpokenDraft();
  t.deepEqual(draft.onset(), { box: '', sendAt: undefined });
  t.is(draft.partial('hello').box, 'hello');
  const after = draft.final('hello there', 1000);
  t.deepEqual(after, { box: 'hello there', sendAt: 1000 + d.graceMs });
  const on = { micOn: true, utteranceOpen: false };
  t.is(
    draft.due(1000 + d.graceMs - 1, { box: 'hello there', ...on }),
    undefined,
  );
  t.is(
    draft.due(1000 + d.graceMs, { box: ' hello there, friend ', ...on }),
    'hello there, friend',
  );
  // sent once
  t.is(draft.due(5000, { box: 'hello there', ...on }), undefined);

  // clearing the box cancels and forgets the pending text
  draft.final('second message', 6000);
  t.is(draft.due(6000 + d.graceMs, { box: '  ', ...on }), undefined);
  t.is(draft.partial('next').box, 'next');

  // the mic went off: nothing is sent
  draft.final('third message', 8000);
  t.is(
    draft.due(9000, {
      box: 'third message',
      micOn: false,
      utteranceOpen: false,
    }),
    undefined,
  );
});

test('speech during grace joins the same message', t => {
  const draft = makeSpokenDraft();
  draft.final('book a table', 0);
  t.deepEqual(draft.onset(), { box: 'book a table', sendAt: undefined });
  t.is(draft.partial('for two').box, 'book a table for two');
  // the cancelled send does not fire
  t.is(
    draft.due(d.graceMs, {
      box: 'book a table',
      micOn: true,
      utteranceOpen: true,
    }),
    undefined,
  );
  const joined = draft.final('for two', 2000);
  t.is(joined.box, 'book a table for two');
  t.is(
    draft.due(2000 + d.graceMs, {
      box: joined.box,
      micOn: true,
      utteranceOpen: false,
    }),
    'book a table for two',
  );
});

test('a junk final arms no send, a dropped utterance re-arms the pending text', t => {
  const draft = makeSpokenDraft();
  t.deepEqual(draft.final('Thanks.', 0), { box: '', sendAt: undefined });
  draft.final('remind me at noon', 100);
  draft.onset();
  // a cough during grace is discarded: the earlier text is armed again
  const again = draft.dropped(500);
  t.deepEqual(again, { box: 'remind me at noon', sendAt: 500 + d.graceMs });
  t.true(draft.discard('remind me at noon'));
  t.deepEqual(draft.onset(), { box: '', sendAt: undefined });
  draft.final('typed over', 0);
  t.false(draft.discard('typed over, and more'));
});

test('the meter fills to full scale', t => {
  t.is(meterFraction(0), 0);
  t.is(meterFraction(d.meterFullScale / 2), 0.5);
  t.is(meterFraction(1), 1);
  t.is(meterFraction(Number.NaN), 0);
});
