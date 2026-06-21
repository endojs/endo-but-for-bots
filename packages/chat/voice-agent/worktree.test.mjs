// worktree.test.mjs — the per-sub-agent git-worktree isolation that retires THE WRITE RULE.
// Real-run evidence (no model): drive makeWorktrees against a throwaway git repo and prove the
// lifecycle, SAFE teardown (dirty work is committed to a branch, never lost), parallel writers
// editing the SAME path don't collide, and the cwd-escape guard holds.
//
//   node --test packages/chat/voice-agent/worktree.test.mjs
import '@endo/init';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeWorktrees, resolveJailedCwd } from './agent-caps.mjs';

// a minimal UNCONFINED host shell facet (what the worktree manager runs on).
const shell = (cmd, { timeoutMs = 60000 } = {}) => new Promise(resolve => {
  execFile('bash', ['-lc', String(cmd)], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) =>
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(so || ''), stderr: String(se || '') }));
});
const host = { exec: shell };
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// one throwaway repo + worktree base for the whole suite.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
const repo = path.join(tmp, 'repo');
const wtbase = path.join(tmp, 'worktrees');
await shell(`mkdir -p ${q(repo)} && cd ${q(repo)} && git init -q && git config user.email t@t.invalid && git config user.name tester && echo seed > seed.txt && git add -A && git commit -qm init`);
const wt = makeWorktrees({ host, repo, dir: wtbase, baseRef: 'HEAD' });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

test('create() spins a fresh worktree+branch with the repo content', async () => {
  const h = await wt.create('exec-abc');
  assert.equal(h.branch, 'agentwt/exec-abc');
  assert.ok(fs.existsSync(h.dir), 'worktree dir exists on disk');
  assert.ok(fs.existsSync(path.join(h.dir, 'seed.txt')), 'it is a real checkout (repo content present)');
  await wt.teardown('exec-abc'); // cleanup
});

test('SAFE teardown: a sub-agent’s dirty work is COMMITTED to its branch (never lost), then removed', async () => {
  const h = await wt.create('writer-1');
  fs.writeFileSync(path.join(h.dir, 'newfile.txt'), 'sub-agent work product');
  fs.writeFileSync(path.join(h.dir, 'seed.txt'), 'edited by the sub-agent');
  const t = await wt.teardown('writer-1', { commitMessage: 'did the work' });
  assert.equal(t.dirty, true, 'detected the dirty tree');
  assert.equal(t.committed, true, 'committed the work before removing');
  assert.equal(t.removed, true, 'removed the worktree dir');
  assert.equal(fs.existsSync(h.dir), false, 'dir is gone');
  // the work is RECOVERABLE from the branch — nothing was destroyed
  const log = await shell(`git -C ${q(repo)} log --oneline ${q('agentwt/writer-1')}`);
  assert.match(log.stdout, /did the work/, 'the commit is on the branch');
  const show = await shell(`git -C ${q(repo)} show ${q('agentwt/writer-1:newfile.txt')}`);
  assert.match(show.stdout, /sub-agent work product/, 'the new file is recoverable');
  const edit = await shell(`git -C ${q(repo)} show ${q('agentwt/writer-1:seed.txt')}`);
  assert.match(edit.stdout, /edited by the sub-agent/, 'the edit is recoverable');
});

test('clean teardown: an untouched worktree is removed with nothing to commit', async () => {
  const h = await wt.create('clean-xyz');
  const t = await wt.teardown('clean-xyz');
  assert.equal(t.dirty, false);
  assert.equal(t.committed, false);
  assert.equal(t.removed, true);
  assert.equal(fs.existsSync(h.dir), false);
});

test('RACE-SAFETY: two parallel writers editing the SAME path do not collide', async () => {
  const [a, b] = await Promise.all([wt.create('par-A'), wt.create('par-B')]);
  assert.notEqual(a.dir, b.dir, 'disjoint checkouts');
  assert.ok(fs.existsSync(a.dir) && fs.existsSync(b.dir));
  // both edit seed.txt — the SAME path — concurrently; isolation means no stomp
  fs.writeFileSync(path.join(a.dir, 'seed.txt'), 'A wrote this');
  fs.writeFileSync(path.join(b.dir, 'seed.txt'), 'B wrote this');
  await Promise.all([wt.teardown('par-A', { commitMessage: 'A' }), wt.teardown('par-B', { commitMessage: 'B' })]);
  assert.match((await shell(`git -C ${q(repo)} show ${q('agentwt/par-A:seed.txt')}`)).stdout, /A wrote this/);
  assert.match((await shell(`git -C ${q(repo)} show ${q('agentwt/par-B:seed.txt')}`)).stdout, /B wrote this/, 'each writer kept its own edit — no race');
});

test('a leaked worktree does NOT block future spawns, and its branch is preserved (never force-deleted)', async () => {
  const h1 = await wt.create('leak-1');
  fs.writeFileSync(path.join(h1.dir, 'wip.txt'), 'crash work');
  // simulate a CRASH: the dir vanishes without teardown (stale registration + branch left behind)
  fs.rmSync(h1.dir, { recursive: true, force: true });
  // a fresh spawn (unique id — real spawns never reuse an id) is unaffected
  const h2 = await wt.create('leak-2');
  assert.ok(fs.existsSync(h2.dir), 'a new spawn succeeds despite the leak');
  // the leaked branch is PRESERVED (safe reclaim never force-deletes it — un-merged work is recoverable)
  const br = await shell(`git -C ${q(repo)} branch --list ${q('agentwt/leak-1')}`);
  assert.match(br.stdout, /agentwt\/leak-1/, 'leaked branch preserved, not destroyed');
  await wt.teardown('leak-2');
  await shell(`git -C ${q(repo)} worktree prune && git -C ${q(repo)} branch -D agentwt/leak-1`); // test cleanup
});

test('a symlink inside the worktree that points outside it is refused (TOCTOU symlink defense)', async () => {
  const h = await wt.create('symlink-1');
  fs.symlinkSync('/etc', path.join(h.dir, 'escape')); // sub-agent makes a symlink-to-outside
  const r = resolveJailedCwd(h.dir, 'escape');
  assert.equal(r.ok, false, 'cwd into a symlink-to-outside is refused (would otherwise reach /etc)');
  fs.mkdirSync(path.join(h.dir, 'realsub'));
  assert.equal(resolveJailedCwd(h.dir, 'realsub').ok, true, 'a real in-worktree subdir is still allowed');
  await wt.teardown('symlink-1');
});

test('resolveJailedCwd confines a sub-agent cwd to its worktree (escape refused)', () => {
  const jail = '/home/dan/.local/state/field-agent/worktrees/x';
  assert.deepEqual({ ...resolveJailedCwd(jail, null) }, { ok: true, cwd: jail }, 'no cwd → the jail root');
  assert.equal(resolveJailedCwd(jail, 'pkg/sub').cwd, `${jail}/pkg/sub`, 'a relative cwd resolves inside');
  assert.equal(resolveJailedCwd(jail, '/etc/passwd').cwd, `${jail}/etc/passwd`, 'an ABSOLUTE cwd is treated relative-to-jail — cannot escape');
  assert.equal(resolveJailedCwd(jail, '../../etc').ok, false, '../ traversal out of the jail is refused');
  assert.equal(resolveJailedCwd(jail, '../sibling-worktree').ok, false, 'cannot reach a sibling worktree');
  assert.match(resolveJailedCwd(jail, '..').error || '', /escapes your worktree/);
});
