// machine-checkout.test.mjs — a "full-VM" machine in the roster (a machines.json entry with a `git` field,
// e.g. tinix) grants BOTH a remote shell over the box AND a LOCAL config checkout (the repo whose HEAD is its
// source-of-truth config). Proves repoStatus reads the checkout's HEAD, repoExec runs IN the checkout, and
// readOnly() keeps the read (repoStatus) but drops the writes (exec + repoExec).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import '@endo/init';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });

test('a machine with a `git` field grants a local config checkout (repoStatus/repoExec); readOnly drops writes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const repo = path.join(tmp, 'cfg'); fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'deployments.yaml'), 'model: gemma\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed config');

  const machinesFile = path.join(tmp, 'machines.json');
  // local:true so exec() doesn't ssh anywhere; git points at our temp checkout.
  fs.writeFileSync(machinesFile, JSON.stringify([{ name: 'testbox', local: true, git: repo, role: 'test full-vm' }]));
  process.env.MACHINES_FILE = machinesFile;

  const { makeAgentRoster } = await import('./agents-roster.mjs');
  const roster = await makeAgentRoster();
  const box = roster.root.agent('testbox');
  assert.ok(box, 'the machine is in the roster');
  assert.equal(box.describe().git, repo, 'describe() advertises the config checkout path');

  // repoStatus reads the checkout's current HEAD
  const st = await box.repoStatus();
  assert.equal(st.ok, true);
  assert.equal(st.repo, repo);
  assert.match(st.head, /^[0-9a-f]{7,}$/, `HEAD short sha — got ${st.head}`);
  assert.equal(st.subject, 'seed config', 'reads the HEAD commit subject');
  assert.equal(st.dirty, 0, 'clean checkout');

  // repoExec runs IN the checkout (default cwd = repo root)
  const pwd = await box.repoExec('pwd');
  assert.equal(pwd.ok, true);
  assert.equal(pwd.stdout.trim(), fs.realpathSync(repo), 'repoExec runs in the checkout root');
  const cat = await box.repoExec('cat deployments.yaml');
  assert.match(cat.stdout, /model: gemma/, 'repoExec can read the config in the checkout');

  // a write through repoExec shows up as dirty in repoStatus
  await box.repoExec('echo "changed: yes" >> deployments.yaml');
  const st2 = await box.repoStatus();
  assert.ok(st2.dirty >= 1 && st2.changed.some(c => /deployments\.yaml/.test(c)), 'repoStatus sees the edit');

  // readOnly() keeps the read (repoStatus) but drops the writes (exec + repoExec)
  const ro = box.readOnly();
  assert.equal(typeof ro.repoStatus, 'function', 'read-only keeps repoStatus');
  assert.equal(ro.repoExec, undefined, 'read-only DROPS repoExec');
  assert.equal(ro.exec, undefined, 'read-only DROPS exec');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a plain ssh-only machine (no `git`) has no checkout verbs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc2-'));
  const machinesFile = path.join(tmp, 'machines.json');
  fs.writeFileSync(machinesFile, JSON.stringify([{ name: 'plainbox', ssh: 'nowhere.invalid', role: 'ssh only' }]));
  process.env.MACHINES_FILE = machinesFile;
  const { makeAgentRoster } = await import('./agents-roster.mjs');
  const roster = await makeAgentRoster();
  const box = roster.root.agent('plainbox');
  assert.equal(box.describe().git, undefined, 'no git field → no checkout advertised');
  assert.equal(box.repoStatus, undefined, 'no repoStatus without a checkout');
  assert.equal(box.repoExec, undefined, 'no repoExec without a checkout');
  assert.equal(typeof box.exec, 'function', 'still has the remote shell');
  fs.rmSync(tmp, { recursive: true, force: true });
});
