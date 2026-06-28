// component-sync.test.mjs — the durability sync pushes each component's git repo to a remote as its own
// branch, and the content is RESTORABLE from the remote. Verified against a LOCAL BARE repo (real git push,
// no network) so it proves the mechanism without touching gitea. Also proves OPT-IN: no remote → no-op.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeComponentGit } from './component-git.mjs';
import { makeComponentSync } from './component-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

test('component-sync pushes each component to its own branch + the tree is restorable', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-base-'));
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', remoteDir]); // a local bare repo standing in for gitea
  try {
    const cg = makeComponentGit({ baseDir: base });
    await cg.commit('tool-abc', { 'tool.js': 'export const make = () => ({ help: () => "v1" });' }, 'v1');
    await cg.commit('tool-abc', { 'tool.js': 'export const make = () => ({ help: () => "v2" });' }, 'v2');
    await cg.fork('tool-abc', 'tool-abc-fork', 'HEAD'); // a variant → a separate id → its own branch

    const sync = makeComponentSync({ baseDir: base, remote: remoteDir });
    assert.equal(sync.enabled, true, 'a configured remote enables sync');
    const r1 = await sync.pushOne('tool-abc');
    assert.ok(r1.ok, `pushOne succeeds — ${JSON.stringify(r1)}`);
    const all = await sync.syncAll();
    assert.ok(all.pushed >= 2, `syncAll pushes every component (got ${JSON.stringify(all)})`);

    // the remote now holds a branch per component, with the full history + restorable content
    const branches = git(['branch', '--list', 'comp/*'], remoteDir);
    assert.match(branches, /comp\/tool-abc\b/, 'the component has a branch on the remote');
    assert.match(branches, /comp\/tool-abc-fork\b/, 'the FORK/variant has its own branch (kept alive)');

    // RESTORE: clone the remote, check out the component's branch, confirm the latest source is there
    const restore = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-restore-'));
    execFileSync('git', ['clone', '-q', '--branch', 'comp/tool-abc', remoteDir, restore]);
    const restored = fs.readFileSync(path.join(restore, 'tool.js'), 'utf8');
    assert.match(restored, /"v2"/, 'the latest version is restorable from the remote (durability)');
    const log = git(['log', '--oneline'], restore);
    assert.ok(log.trim().split('\n').length >= 2, 'the full version history is preserved on the remote');
    fs.rmSync(restore, { recursive: true, force: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(remoteDir, { recursive: true, force: true });
  }
});

test('component-sync is OPT-IN: no remote → enabled:false + no-op', async () => {
  const sync = makeComponentSync({ baseDir: '/tmp/does-not-matter', remote: '' });
  assert.equal(sync.enabled, false);
  assert.deepEqual(await sync.syncAll(), { skipped: true, pushed: 0 });
  assert.deepEqual(await sync.pushOne('x'), { ok: false, skipped: true });
});
