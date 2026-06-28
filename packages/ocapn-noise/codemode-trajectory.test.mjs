// codemode-trajectory.test.mjs — the lightweight "trajectory critic" hook.
//
// After each program result, the CodeMode loop emits an OBSERVATIONAL onStep event of kind
// "trajectory" carrying the running progress counters — { failStreak, repeatErr, lastError } —
// so an observer can SCORE the trajectory (e.g. detect a stall) WITHOUT changing control flow.
//
// Here the stub LLM emits a program that THROWS on the first turn, then ANSWERs on the second so
// the loop terminates cleanly. We assert that a kind:"trajectory" event was emitted AND that it
// carried the current lastError produced by the throw.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert';
import { runAgentCode } from './codemode.mjs';

test('emits a kind:"trajectory" onStep carrying lastError after a program throws', async () => {
  let turns = 0;
  const llm = async (_messages, _model) => {
    turns += 1;
    if (turns === 1) return { text: '```js\nthrow new Error("boom-trajectory");\n```' };
    return { text: 'done' };
  };

  const steps = [];
  const result = await runAgentCode({
    toolbox: {},
    manifest: [],
    userText: 'do the thing',
    llm,
    onStep: ev => { steps.push(ev); },
  });

  assert.ok(result, 'should return a result object');

  const traj = steps.filter(s => s && s.kind === 'trajectory');
  assert.ok(traj.length >= 1, 'should emit at least one kind:"trajectory" event');

  // The trajectory event emitted right after the throwing program must carry the current lastError.
  const afterThrow = traj.find(t => t.lastError && t.lastError.includes('boom-trajectory'));
  assert.ok(afterThrow, 'a trajectory event should carry the lastError from the throw');
  assert.strictEqual(afterThrow.failStreak, 1, 'failStreak should reflect the single throw');
  assert.strictEqual(afterThrow.repeatErr, 0, 'repeatErr should be 0 for the first (non-repeated) error');
  assert.strictEqual(typeof afterThrow.lastError, 'string', 'lastError should be a string');
});
