// self-improver.test.mjs — the safe auto-merge loop, proven against a REAL throwaway repo (no model).
// Improvement (verifies green) MERGES; regression (verifies red) is REFUSED + the branch kept; rollback
// reverts a merge; a dirty live tree refuses to merge; "nothing changed" is a safe no-op.
//
//   node --test packages/chat/voice-agent/self-improver.test.mjs
import '@endo/init';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeSelfImprover } from './self-improver.mjs';

const sh = (cmd, { timeoutMs = 60000 } = {}) => new Promise(resolve => {
  execFile('bash', ['-lc', String(cmd)], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) =>
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(so || ''), stderr: String(se || '') }));
});
const host = { exec: sh };
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-test-'));
const repo = path.join(tmp, 'repo');
// a tiny "system": value.txt + check.sh (the spec suite). An IMPROVEMENT sets value.txt to GOOD (check
// passes); a REGRESSION sets it to BAD (check fails). check.sh is committed at base, so every branch has it.
await sh(`mkdir -p ${q(repo)} && cd ${q(repo)} && git -c init.defaultBranch=main init -q && git config user.email t@t.invalid && git config user.name tester && printf BASE > value.txt && printf 'grep -q GOOD value.txt' > check.sh && git add -A && git commit -qm init`);
const si = makeSelfImprover({ host, repo, baseBranch: 'main', verifyDir: path.join(tmp, 'verify'), ledgerFile: path.join(tmp, 'ledger.json'), defaultTest: 'sh check.sh' });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// a deterministic "implementer": commit `content` to a fresh branch off main, return { branch }.
const implementer = (branch, content) => async () => {
  const dir = path.join(tmp, 'wt-' + branch.replace(/\W/g, '_'));
  await sh(`git -C ${q(repo)} worktree add --quiet -b ${q(branch)} ${q(dir)} main`);
  fs.writeFileSync(path.join(dir, 'value.txt'), content);
  await sh(`git -C ${q(dir)} add -A && git -C ${q(dir)} -c user.email=a@a -c user.name=a commit -qm ${q('impl ' + content)}`);
  await sh(`git -C ${q(repo)} worktree remove --force ${q(dir)} && git -C ${q(repo)} worktree prune`);
  return { branch };
};

test('an IMPROVEMENT (verifies green) is auto-merged into the live branch + recorded for rollback', async () => {
  const r = await si.improve({ goal: 'make value GOOD', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/imp1', 'GOOD'), now: 't1' });
  assert.equal(r.merged, true, 'a verified-green change merges');
  assert.equal(r.verified, true);
  assert.match(read(path.join(repo, 'value.txt')), /GOOD/, 'the live working tree now has the change');
  const ml = si.listMerges();
  assert.ok(ml.find(m => m.id === r.id && !m.rolledBack), 'the merge is in the rollback ledger');
});

test('a REGRESSION (verifies red) is REFUSED — not merged, the branch kept for inspection', async () => {
  const before = read(path.join(repo, 'value.txt'));
  const r = await si.improve({ goal: 'set value BAD', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/bad1', 'BAD'), now: 't2' });
  assert.equal(r.merged, false, 'a failing change does NOT merge');
  assert.match(r.reason, /improvement|verification|pass/i);
  assert.equal(read(path.join(repo, 'value.txt')), before, 'the live tree is unchanged');
  assert.match((await sh(`git -C ${q(repo)} branch --list agentwt/bad1`)).stdout, /agentwt\/bad1/, 'the rejected branch is kept');
});

test('ROLLBACK reverts an auto-merge by its ledger id (history-preserving)', async () => {
  const m = si.listMerges().find(x => /make value GOOD/.test(x.goal));
  const rb = await si.rollback({ id: m.id, now: 't3' });
  assert.equal(rb.ok, true);
  assert.doesNotMatch(read(path.join(repo, 'value.txt')), /GOOD/, 'the merged change was reverted out of the live tree');
  assert.equal(si.listMerges().find(x => x.id === m.id).rolledBack, true, 'the ledger marks it rolled back');
});

test('a dirty LIVE tree REFUSES the merge (never clobbers uncommitted work)', async () => {
  fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'WIP');
  const r = await si.improve({ goal: 'good change but base is dirty', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/imp2', 'GOOD'), now: 't4' });
  assert.equal(r.merged, false, 'refuses to merge into a dirty tree');
  assert.match(r.reason, /uncommitted|dirty/i);
  fs.rmSync(path.join(repo, 'uncommitted.txt'));
});

test('autoMerge:false verifies but does NOT merge — a reviewable green branch (safe default)', async () => {
  const before = read(path.join(repo, 'value.txt'));
  const r = await si.improve({ goal: 'good change, review-only mode', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/review1', 'GOOD'), autoMerge: false, now: 't6' });
  assert.equal(r.verified, true, 'still verifies the change');
  assert.equal(r.merged, false, 'but does NOT merge when auto-merge is off');
  assert.equal(r.readyToReview, true);
  assert.equal(read(path.join(repo, 'value.txt')), before, 'live tree untouched');
  assert.match((await sh(`git -C ${q(repo)} branch --list agentwt/review1`)).stdout, /agentwt\/review1/, 'the verified branch is kept for review');
});

test('"nothing implemented" is a safe no-op (no merge, attempted=true)', async () => {
  const r = await si.improve({ goal: 'x', successCommand: 'true', employExecutor: async () => ({ branch: null, answer: 'I could not implement it' }), now: 't5' });
  assert.equal(r.merged, false);
  assert.equal(r.attempted, true);
  assert.match(r.reason, /no branch|nothing/i);
});
