// component-sync.mjs — DURABILITY: continuously mirror every component/fork git repo to a remote (gitea), so a
// local DB/disk failure loses NO version history. Each component under component-git/ is its own real git repo;
// we push each to its OWN branch (`comp/<id>`) of a single remote repo — independent histories coexist as
// orphan branches, and any component is restorable by fetching its branch. (Forks are separate component ids →
// separate branches, so every user variant stays alive on the remote, per dan's plan: Root → main canonical,
// variants → their own branches.) OPT-IN: a no-op unless a remote is configured (COMPONENT_GIT_REMOTE), so it
// never makes a surprise outward push. Best-effort + debounced from each commit, with a periodic full sweep.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { hostGitLock } from './host-git-mutex.mjs';

const sh = (cmd, args, cwd) => new Promise(res => execFile(cmd, args, { cwd, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => res({ ok: !err, out: String(so || ''), err: String((se || (err && err.message)) || '') })));
const encId = id => encodeURIComponent(String(id)).replace(/%/g, '_'); // matches component-git's repoDir encoding

// `lock` (default: the shared host-git mutex) serializes each push against componentGit commits + the
// self-improver merge, so concurrent `git` invocations don't collide on index.lock (P2-5).
export const makeComponentSync = ({ baseDir, remote = process.env.COMPONENT_GIT_REMOTE || '', branchPrefix = 'comp', log = () => {}, lock = fn => hostGitLock.runExclusive(fn) }) => {
  const enabled = !!remote;
  const repoDir = id => path.join(baseDir, encId(id));
  const branchOf = id => `${branchPrefix}/${encId(id)}`;
  const isRepo = dir => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

  // push ONE component repo to its branch. `+` allows non-fast-forward (a revert/fork can rewrite the tip).
  const pushOne = async id => {
    if (!enabled) return { ok: false, skipped: true };
    const dir = repoDir(id); if (!isRepo(dir)) return { ok: false, error: 'no such component repo' };
    const r = await lock(() => sh('git', ['push', remote, `+HEAD:refs/heads/${branchOf(id)}`], dir)); // serialize vs commits/merge (P2-5)
    if (!r.ok) { log('component-sync push', id, r.err.slice(0, 160)); return { ok: false, error: r.err.slice(0, 200) }; }
    return { ok: true, branch: branchOf(id) };
  };

  const listIds = () => { try { return fs.readdirSync(baseDir).filter(d => isRepo(path.join(baseDir, d))).map(d => { try { return decodeURIComponent(d.replace(/_/g, '%')); } catch { return d; } }); } catch { return []; } };

  // full sweep — push every component (boot + the periodic backstop). Serial to be gentle on the remote.
  const syncAll = async () => {
    if (!enabled) return { skipped: true, pushed: 0 };
    let pushed = 0, failed = 0; for (const id of listIds()) { const r = await pushOne(id); if (r.ok) pushed += 1; else if (!r.skipped) failed += 1; } // eslint-disable-line no-await-in-loop
    return { pushed, failed };
  };

  // DEBOUNCED per-component push — call from each commit; coalesces a burst of edits into one push per id.
  const pending = new Map(); // id → timer
  const schedule = (id, delayMs = 1500) => {
    if (!enabled) return; const key = String(id);
    if (pending.has(key)) clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => { pending.delete(key); pushOne(key).catch(() => {}); }, delayMs));
  };

  return { enabled, remote, pushOne, syncAll, schedule, branchOf, listIds };
};
