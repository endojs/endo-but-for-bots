// codemode-idempotency.test.mjs — P1-5 at the CodeMode-loop layer, deterministically (no server, no model).
//
// The money invariant: a DESTRUCTIVE tool must fire EXACTLY ONCE even when a mid-turn restart forces a recovery
// re-run. We prove it two ways, each SIMULATING a restart by rebuilding the durable stores (ledger, transcript)
// from the same on-disk dir into fresh objects (a fresh process would do exactly this):
//   (1) LEDGER path (defense-in-depth): the recovery is a FULL re-run (no saved transcript). The scripted model
//       re-emits the same destructive program — but the durable ledger returns the prior result, so the real tool
//       is NOT re-invoked. counter stays 1.
//   (2) REPLAY path (the primary layer): the recovery replays the persisted transcript-with-outputs, so the tool
//       is never even reached. counter stays 1.
// Plus: a FRESH turn (empty ledger) fires normally — the guard doesn't suppress legitimate first-time actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@endo/init';
import { runAgentCode } from '../../ocapn-noise/codemode.mjs';
import { makeSideEffectLedger } from './side-effect-ledger.mjs';

const mkLLM = scripted => { let i = 0; return async () => { const r = scripted[Math.min(i, scripted.length - 1)]; i += 1; return typeof r === 'string' ? { text: r } : r; }; };
const manifest = [{ name: 'sendEmail', args: { to: 'string' }, description: 'send an email (destructive)' }];
const destructiveVerbs = new Set(['sendEmail']);
const bUC = t => String(t || '');
const FIRE_PROG = '```js\nconst r = await sendEmail({ to: "boss@example.com" });\nreturn r;\n```';
const ANSWER_PROG = "```js\nanswer('done');\n```";

// A durable email tool whose fire-count lives on disk (survives a "restart") + an in-memory counter.
const makeMailer = counterFile => {
  const bump = () => { let n = 0; try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {} n += 1; fs.writeFileSync(counterFile, String(n)); return n; };
  const toolbox = { sendEmail: { run: async ({ to }) => ({ ok: true, sent: true, to, n: bump() }) } };
  return toolbox;
};
const counterOf = f => { try { return parseInt(fs.readFileSync(f, 'utf8'), 10) || 0; } catch { return 0; } };

test('LEDGER path: a full-rerun recovery does NOT re-fire the destructive tool (fires exactly once)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-cm-'));
  try {
    const counterFile = path.join(dir, 'counter');
    const turnId = 'chatA_send the report';
    const toolbox = makeMailer(counterFile);

    // ── original run: fires sendEmail, then answers. The ledger records the committed fire (durably).
    const l1 = makeSideEffectLedger({ dir }).forTurn(turnId);
    let transcript = null;
    const r1 = await runAgentCode({ toolbox, manifest, userText: 'send the report',
      llm: mkLLM([FIRE_PROG, ANSWER_PROG]), buildUserContent: bUC,
      sideEffectLedger: l1, destructiveVerbs, persist: t => { transcript = t; } });
    assert.equal(r1.answer, 'done', 'original turn completed');
    assert.equal(counterOf(counterFile), 1, 'the tool fired exactly once on the original run');
    assert.ok(transcript && JSON.stringify(transcript).includes('sent'), 'the transcript-with-output was persisted');

    // ── SIMULATED RESTART: fresh ledger from disk. RECOVERY = a FULL re-run (NO resumeMessages), the model
    //    re-emits the SAME destructive program. The ledger must short-circuit the real tool.
    const l2 = makeSideEffectLedger({ dir }).forTurn(turnId);
    const r2 = await runAgentCode({ toolbox, manifest, userText: 'send the report',
      llm: mkLLM([FIRE_PROG, ANSWER_PROG]), buildUserContent: bUC,
      sideEffectLedger: l2, destructiveVerbs });
    assert.equal(r2.answer, 'done', 'recovery turn still completes with the right answer');
    assert.equal(counterOf(counterFile), 1, 'THE MONEY SHOT: the tool fired EXACTLY ONCE total — NOT twice — across the restart');
    // the recovery saw the prior result (marked replayed) rather than a fresh fire
    const reEmail = (r2.toolsUsed || []).find(u => u.name === 'sendEmail');
    assert.ok(reEmail && reEmail.result && reEmail.result.n === 1, 'the recovery got back the PRIOR fire result (n===1), not a second fire');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('REPLAY path: a recovery that replays the persisted transcript never reaches the tool (fires once)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-cm-'));
  try {
    const counterFile = path.join(dir, 'counter');
    const turnId = 'chatB_send it';
    const toolbox = makeMailer(counterFile);
    const l1 = makeSideEffectLedger({ dir }).forTurn(turnId);
    let transcript = null;
    await runAgentCode({ toolbox, manifest, userText: 'send it', llm: mkLLM([FIRE_PROG, ANSWER_PROG]), buildUserContent: bUC,
      sideEffectLedger: l1, destructiveVerbs, persist: t => { transcript = t; } });
    assert.equal(counterOf(counterFile), 1, 'fired once originally');

    // RESTART + REPLAY: hand the persisted transcript back as resumeMessages. The model, seeing the tool OUTPUT
    // already present, just answers — the destructive program is history, never re-run.
    const l2 = makeSideEffectLedger({ dir }).forTurn(turnId);
    const r2 = await runAgentCode({ toolbox, manifest, userText: 'send it', resumeMessages: transcript,
      llm: mkLLM([ANSWER_PROG]), buildUserContent: bUC, sideEffectLedger: l2, destructiveVerbs });
    assert.equal(r2.answer, 'done', 'replay completed');
    assert.equal(counterOf(counterFile), 1, 'the tool fired EXACTLY ONCE — the replay saw the prior OUTPUT and did not re-run it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a FRESH turn (empty ledger) fires the destructive tool normally — the guard does not suppress it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-cm-'));
  try {
    const counterFile = path.join(dir, 'counter');
    const toolbox = makeMailer(counterFile);
    const l = makeSideEffectLedger({ dir }).forTurn('chatC_new ask');
    const r = await runAgentCode({ toolbox, manifest, userText: 'new ask', llm: mkLLM([FIRE_PROG, ANSWER_PROG]), buildUserContent: bUC,
      sideEffectLedger: l, destructiveVerbs });
    assert.equal(r.answer, 'done');
    assert.equal(counterOf(counterFile), 1, 'a fresh turn fires the tool exactly once (not zero — the guard is not over-eager)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two DIFFERENT destructive args in one turn both fire (dedup is per-call-key, not per-verb)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-cm-'));
  try {
    const counterFile = path.join(dir, 'counter');
    const toolbox = makeMailer(counterFile);
    const l = makeSideEffectLedger({ dir }).forTurn('chatD_two mails');
    const TWO = '```js\nawait sendEmail({ to: "a@x.com" });\nawait sendEmail({ to: "b@x.com" });\nreturn "ok";\n```';
    await runAgentCode({ toolbox, manifest, userText: 'two mails', llm: mkLLM([TWO, ANSWER_PROG]), buildUserContent: bUC,
      sideEffectLedger: l, destructiveVerbs });
    assert.equal(counterOf(counterFile), 2, 'distinct recipients → distinct call keys → both fire');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
