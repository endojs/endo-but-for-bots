// resume.test.mjs — seamless top-up RESUME of an out-of-allowance turn. When a turn exhausts its budget
// mid-flight, the CodeMode loop must hand back its in-flight transcript (prior reasoning + tool OUTPUTs), and
// a resume must CONTINUE from there — NOT re-run the work already done. This guards the exact regression the
// user reported: "topping up throws away that entire last step's reasoning + tool use."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '@endo/init';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';

const mkLLM = scripted => { let i = 0; return async () => { const r = scripted[Math.min(i, scripted.length - 1)]; i += 1; return r; }; };
const manifest = [{ name: 'gatherData', args: {}, description: 'gather some data' }];
const bUC = t => String(t || '');

test('exhaustion returns the in-flight transcript; resume continues WITHOUT re-running tools', async () => {
  let gathered = 0;
  const toolbox = { gatherData: { run: async () => { gathered += 1; return { ok: true, data: 'FOURTY-TWO' }; } } };

  // Turn 1: a program calls gatherData → OUTPUT; the NEXT invoke hits the (simulated) budget wall.
  const llm1 = mkLLM([
    { text: '```js\nconst d = await gatherData();\nreturn d;\n```' },
    { exhausted: true, remaining: 0 },
  ]);
  const r1 = await runAgentCode({ toolbox, manifest, userText: 'do the thing', llm: llm1, buildUserContent: bUC });
  assert.equal(r1.exhausted, true, 'turn 1 reports exhausted');
  assert.equal(gathered, 1, 'the tool ran exactly once before exhaustion');
  assert.ok(Array.isArray(r1.resumeFrom) && r1.resumeFrom.length >= 3, 'resumeFrom carries the in-flight transcript');
  assert.ok(JSON.stringify(r1.resumeFrom).includes('FOURTY-TWO'), 'the gathered data is preserved in the transcript');
  assert.ok(!r1.resumeFrom.some(m => m.role === 'system'), 'resumeFrom excludes the system prompt (server re-adds a fresh one)');

  // RESUME: hand the saved transcript back; the model now just answers. The tool must NOT run again.
  const llm2 = mkLLM([{ text: 'The data is 42.' }]);
  const r2 = await runAgentCode({ toolbox, manifest, userText: 'do the thing', resumeMessages: r1.resumeFrom, llm: llm2, buildUserContent: bUC });
  assert.equal(r2.answer, 'The data is 42.', 'resume produced the final answer');
  assert.equal(gathered, 1, 'the tool did NOT re-run on resume — no wasted re-work');
  assert.ok(!r2.exhausted, 'resume completed');
});

test('resume prepends a FRESH system prompt then continues the saved transcript verbatim', async () => {
  const toolbox = { gatherData: { run: async () => ({ ok: true, data: 'X' }) } };
  const seen = [];
  const llm = async (messages, model) => { seen.push(messages); return { text: 'ok' }; };
  const saved = [
    { role: 'user', content: 'original ask' },
    { role: 'assistant', content: '```js\nreturn await gatherData();\n```' },
    { role: 'user', content: 'OUTPUT:\nreturned: {"ok":true,"data":"X"}' },
  ];
  await runAgentCode({ toolbox, manifest, userText: 'original ask', resumeMessages: saved, llm, buildUserContent: bUC });
  const msgs = seen[0];
  assert.equal(msgs[0].role, 'system', 'a fresh system prompt is prepended');
  assert.deepEqual(msgs.slice(1), saved, 'the saved transcript follows verbatim — it continues, it does not restart');
});

test('a normal (non-resume) turn is unaffected — builds from userText + history', async () => {
  const toolbox = { gatherData: { run: async () => ({ ok: true }) } };
  const seen = [];
  const llm = async (messages) => { seen.push(messages); return { text: 'hi' }; };
  const r = await runAgentCode({ toolbox, manifest, userText: 'hello', history: [{ role: 'user', content: 'prior' }, { role: 'assistant', content: 'earlier' }], llm, buildUserContent: bUC });
  assert.equal(r.answer, 'hi');
  const msgs = seen[0];
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[msgs.length - 1].content, 'hello', 'the fresh user message is last');
  assert.ok(msgs.some(m => m.content === 'prior'), 'history is included on a normal turn');
});
