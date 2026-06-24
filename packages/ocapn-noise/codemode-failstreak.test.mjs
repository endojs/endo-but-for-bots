// codemode-failstreak.test.mjs — the consecutive-failure (failStreak) guard.
//
// The identical-error guard (`repeatErr >= 2`) only fires when the SAME error string repeats. A model
// that throws a DIFFERENT error every turn would slip past it and loop forever. The `failStreak >= 4`
// guard catches that: any run of 4 consecutive throws terminates the loop with a stalled answer.
//
// Here the stub LLM emits a program that throws a NEW (distinct) error each turn. We assert the loop
// TERMINATES (returns a stalled answer) instead of running unbounded.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert';
import { runAgentCode } from './codemode.mjs';

test('loop terminates on a streak of DIFFERENT (non-identical) errors', async () => {
  let turns = 0;
  const MAX = 100; // safety net: if the guard is missing this stub would be asked forever
  // Each turn emits a program that throws a UNIQUE message — so repeatErr never climbs past 0,
  // and only the failStreak guard can stop the loop.
  const llm = async (_messages, _model) => {
    turns += 1;
    if (turns > MAX) throw new Error(`loop did not terminate after ${MAX} turns`);
    return { text: '```js\nthrow new Error("distinct failure #" + ' + turns + ');\n```' };
  };

  const result = await runAgentCode({
    toolbox: {},
    manifest: [],
    userText: 'do the thing',
    llm,
  });

  assert.ok(result, 'should return a result object');
  assert.strictEqual(result.stalled, true, 'should report a stalled answer, not loop forever');
  assert.ok(typeof result.answer === 'string' && result.answer.length > 0, 'should produce a non-empty stall message');
  // The break fires at failStreak >= 4, so it must terminate within a handful of turns — well under MAX.
  assert.ok(turns >= 4 && turns <= 5, `should terminate around 4 turns, got ${turns}`);
});
