// project-ops.mjs — the operations a project's agent can perform on ITS repo + live deployment,
// as plain harness functions (our own loop/tool logic — NOT a `claude -p` black box). These become
// the confine-gated tool ring of a project agent (#2 runner wires them in). Outward-facing ops
// (redeploy, takedown) take {confirm:true} and refuse otherwise — they change live, public state.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProject, ensureCheckout } from './project-registry.mjs';

const TOKEN_FILE = process.env.GITEA_TOKEN_FILE || path.join(os.homedir(), '.config/field-agent/secrets/gitea-token');
const token = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
const hdr = () => `http.extraheader=AUTHORIZATION: token ${token()}`;
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sh = cmd => execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

/** Commit the working changes in a project's checkout onto a branch + push it to gitea, and (if the
 *  project's gitea repo is the deploy source) opening a PR is the human gate. Returns {ok, branch, head}. */
export const commitAndPushBranch = (id, branch, message) => {
  const p = getProject(id); if (!p) return { ok: false, error: `unknown project ${id}` };
  try {
    git(p.checkout, ['checkout', '-B', branch]);
    git(p.checkout, ['add', '-A']);
    git(p.checkout, ['commit', '-m', message || `work on ${id}`]);
    git(p.checkout, ['-c', hdr(), 'push', '-f', 'origin', `${branch}:${branch}`]);
    return { ok: true, branch, head: git(p.checkout, ['rev-parse', '--short', 'HEAD']).trim() };
  } catch (e) { return { ok: false, error: String(e && e.message || e).split('\n')[0] }; }
};

/** MERGE-BACK (#4): a downstream agent pushed `branch`; the requester's agent merges it into the
 *  project's main (ff-only) and pushes — i.e. "accept the merge into my repository". Confirm-gated. */
export const mergeBranch = (id, branch, { confirm = false } = {}) => {
  const p = getProject(id); if (!p) return { ok: false, error: `unknown project ${id}` };
  if (!confirm) return { ok: false, needsConfirm: true, action: `merge ${branch} → ${p.branch} of ${id} and push (changes the deploy source)` };
  try {
    ensureCheckout(id); // fast-forward main first
    git(p.checkout, ['-c', hdr(), 'fetch', 'origin', branch]);
    const out = git(p.checkout, ['merge', '--ff-only', `origin/${branch}`]);
    git(p.checkout, ['-c', hdr(), 'push', 'origin', p.branch || 'main']);
    return { ok: true, merged: branch, into: p.branch || 'main', detail: out.trim() };
  } catch (e) { return { ok: false, error: String(e && e.message || e).split('\n')[0] }; }
};

/** REDEPLOY (#3): push the checkout's main → gitea, which fires archua-deploy's webhook to redeploy
 *  the live service. Confirm-gated (it ships to the live, public instance). */
export const redeploy = (id, { confirm = false } = {}) => {
  const p = getProject(id); if (!p) return { ok: false, error: `unknown project ${id}` };
  if (!confirm) return { ok: false, needsConfirm: true, action: `push ${id} ${p.branch} → gitea → archua-deploy redeploys ${p.live?.url || 'the live service'}` };
  try {
    git(p.checkout, ['-c', hdr(), 'push', 'origin', `${p.branch || 'main'}:${p.branch || 'main'}`]);
    return { ok: true, pushed: p.branch || 'main', note: `archua-deploy will redeploy ${p.deploy?.service || id}` };
  } catch (e) { return { ok: false, error: String(e && e.message || e).split('\n')[0] }; }
};

/** TAKEDOWN (#3): remove the live service container + its public ngrok sidecar. Confirm-gated —
 *  this makes the public URL go dark. dryRun returns the exact commands without running them. */
export const takedown = (id, { confirm = false, dryRun = false } = {}) => {
  const p = getProject(id); if (!p) return { ok: false, error: `unknown project ${id}` };
  const cmds = p.takedown || [];
  if (!cmds.length) return { ok: false, error: `no takedown commands for ${id}` };
  if (dryRun) return { ok: true, dryRun: true, commands: cmds };
  if (!confirm) return { ok: false, needsConfirm: true, action: `take DOWN the live ${id} (${p.live?.url}) — runs: ${cmds.join('; ')}` };
  const results = [];
  for (const c of cmds) { try { sh(`sudo ${c}`); results.push({ cmd: c, ok: true }); } catch (e) { results.push({ cmd: c, ok: false, error: String(e.message).split('\n')[0] }); } }
  return { ok: results.every(r => r.ok), results };
};
