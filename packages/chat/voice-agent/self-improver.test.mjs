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
  const r = await si.improve({ goal: 'make value GOOD', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/imp1', 'GOOD'), autoMerge: true, now: 't1' });
  assert.equal(r.merged, true, 'a verified-green change merges');
  assert.equal(r.verified, true);
  assert.match(read(path.join(repo, 'value.txt')), /GOOD/, 'the live working tree now has the change');
  const ml = si.listMerges();
  assert.ok(ml.find(m => m.id === r.id && !m.rolledBack), 'the merge is in the rollback ledger');
});

test('a REGRESSION (verifies red) is REFUSED — not merged, the branch kept for inspection', async () => {
  const before = read(path.join(repo, 'value.txt'));
  const r = await si.improve({ goal: 'set value BAD', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/bad1', 'BAD'), autoMerge: true, now: 't2' });
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
  const r = await si.improve({ goal: 'good change but base is dirty', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/imp2', 'GOOD'), autoMerge: true, now: 't4' });
  assert.equal(r.merged, false, 'refuses to merge into a dirty tree');
  assert.match(r.reason, /uncommitted|dirty/i);
  fs.rmSync(path.join(repo, 'uncommitted.txt'));
});

test('POST-MERGE re-verify (always the full default suite) catches a merge that breaks the live tree → AUTO-REVERTS', async () => {
  const before = read(path.join(repo, 'value.txt'));
  // an improver whose DEFAULT (post-merge) verify always fails: the branch passes its own successCommand so
  // it MERGES, but the post-merge re-verify (defaultTest) fails → auto-revert. Proves post-merge uses the
  // default suite, not the weaker per-call command.
  const siR = makeSelfImprover({ host, repo, baseBranch: 'main', verifyDir: path.join(tmp, 'verifyR'), ledgerFile: path.join(tmp, 'ledgerR.json'), defaultTest: 'exit 1' });
  const r = await siR.improve({ goal: 'passes its own check, fails the suite once merged', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/pm1', 'GOOD'), autoMerge: true, now: 'tpm' });
  assert.equal(r.merged, false, 'the merge did not stand');
  assert.equal(r.revertedAfterMerge, true, 'it auto-reverted after the post-merge re-verify failed');
  assert.equal(r.rolledBack, true);
  assert.equal(read(path.join(repo, 'value.txt')), before, 'the live tree was restored (the merged change reverted out)');
});

test('POST-MERGE re-verify passing → the merge STANDS (postVerified)', async () => {
  const r = await si.improve({ goal: 'good change that also passes merged', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/pm2', 'GOOD'), autoMerge: true, now: 'tpm2' });
  assert.equal(r.merged, true);
  assert.equal(r.postVerified, true, 'the merged tree was independently re-verified');
  assert.match(read(path.join(repo, 'value.txt')), /GOOD/);
});

test('autoMerge:false verifies but does NOT merge — a reviewable green branch (safe default)', async () => {
  const before = read(path.join(repo, 'value.txt'));
  const r = await si.improve({ goal: 'good change, review-only mode', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/review1', 'GOOD-review'), autoMerge: false, now: 't6' });
  assert.equal(r.verified, true, 'still verifies the change');
  assert.equal(r.merged, false, 'but does NOT merge when auto-merge is off');
  assert.equal(r.readyToReview, true);
  assert.equal(read(path.join(repo, 'value.txt')), before, 'live tree untouched');
  assert.match((await sh(`git -C ${q(repo)} branch --list agentwt/review1`)).stdout, /agentwt\/review1/, 'the verified branch is kept for review');
});

test('an EMPTY branch (executor only narrated, made no real change) is reported as a no-op, never staged/merged as verified', async () => {
  // a fake implementer that hands back a branch IDENTICAL to base (no diff) — what an executor that
  // narrates a change without editing files leaves behind.
  await sh(`git -C ${q(repo)} branch -f agentwt/empty1 main`);
  const r = await si.improve({ goal: 'a change that was only described', successCommand: 'sh check.sh', employExecutor: async () => ({ branch: 'agentwt/empty1' }), autoMerge: true, now: 'tempty' });
  assert.equal(r.empty, true, 'detected the empty (no-diff) branch');
  assert.equal(r.merged, false, 'a no-op is never merged');
  assert.equal(r.verified, undefined, 'short-circuited BEFORE verify — an unchanged tree must not count as verified');
  await sh(`git -C ${q(repo)} branch -D agentwt/empty1`);
});

test('"nothing implemented" is a safe no-op (no merge, attempted=true)', async () => {
  const r = await si.improve({ goal: 'x', successCommand: 'true', employExecutor: async () => ({ branch: null, answer: 'I could not implement it' }), now: 't5' });
  assert.equal(r.merged, false);
  assert.equal(r.attempted, true);
  assert.match(r.reason, /no branch|nothing/i);
});

test('verifyBranch is TRI-STATE: infra failure (bad branch) is ran:false; a real RED is ran:true — so a good merge is never reverted on a transient checkout hiccup', async () => {
  const infra = await si.verifyBranch('no-such-branch-xyz', 'true', 'tv1');
  assert.equal(infra.ok, false); assert.equal(infra.ran, false, 'could-not-check-out → ran:false (infra, NOT a regression)');
  const red = await si.verifyBranch('main', 'exit 3', 'tv2');
  assert.equal(red.ok, false); assert.equal(red.ran, true, 'tests RAN and failed → ran:true (a real regression)');
  const green = await si.verifyBranch('main', 'true', 'tv3');
  assert.equal(green.ok, true); assert.equal(green.ran, true);
});

test('a CORRUPT changelog/ledger FAILS CLOSED — a change that cannot be RECORDED for revert is NOT merged', async () => {
  const ledgerC = path.join(tmp, 'ledger-corrupt.json');
  fs.writeFileSync(ledgerC, '{ this is not valid json');
  const siC = makeSelfImprover({ host, repo, baseBranch: 'main', verifyDir: path.join(tmp, 'verifyC'), ledgerFile: ledgerC, defaultTest: 'sh check.sh' });
  const before = read(path.join(repo, 'value.txt'));
  // GOOD-containing (so it PASSES check.sh) but distinct from main (so it's a real, non-empty diff).
  const r = await siC.improve({ goal: 'good change but the changelog is corrupt', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/corrupt1', 'GOOD-corrupt-tc'), autoMerge: true, now: 'tc' });
  assert.equal(r.merged, false, 'refuses to ship a change it cannot record for revert');
  assert.match(r.reason, /corrupt|record|refus/i);
  assert.equal(read(path.join(repo, 'value.txt')), before, 'the live tree is unchanged (no untrackable merge)');
});

test('the ledger is written ATOMICALLY (temp + rename) and survives a re-read', async () => {
  // a normal merge writes the ledger; reading it back must parse (no truncation/corruption window).
  const siA = makeSelfImprover({ host, repo, baseBranch: 'main', verifyDir: path.join(tmp, 'verifyA'), ledgerFile: path.join(tmp, 'ledgerA.json'), defaultTest: 'sh check.sh' });
  const r = await siA.improve({ goal: 'atomic ledger write', successCommand: 'sh check.sh', employExecutor: implementer('agentwt/atom1', 'GOOD-atom-ta'), autoMerge: true, now: 'ta' });
  assert.equal(r.merged, true);
  const onDisk = JSON.parse(read(path.join(tmp, 'ledgerA.json')));
  assert.ok(onDisk.merges.some(m => m.id === r.id), 'the merge is durably recorded (parseable on re-read)');
  assert.equal(fs.existsSync(path.join(tmp, `ledgerA.json.tmp-${process.pid}`)), false, 'no temp file left behind');
});
