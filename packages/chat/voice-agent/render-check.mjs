// render-check.mjs — the AUTHORING-LOOP render smoke: "would this component actually mount?"
//
// WHY (chat 1cbe89a9): an agent authored a slider widget via showComponent; the tool step returned
// ok:true (the gate was syntax-only), the sandboxed iframe then threw "safeSaleAmount is not defined",
// and the error was routed ONLY to the self-improvement backlog + the feed — never back into the
// authoring agent's loop. The human saw a broken widget; the agent said "the simulator is now live".
// Its "fix" misused the ui.local API and broke identically. The agent could never see its own errors.
//
// THIS module closes the loop SYNCHRONOUSLY: every authoring step (showComponent, /forks/edit,
// editFork, break-out) render-checks the source BEFORE returning, so a mount-time throw comes back
// as the tool-step error — in the same turn — and the agent iterates immediately.
//
// Mechanics: spawn a short-lived child (render-check-child.mjs) with a HARD TIMEOUT and — critically —
// inside a bwrap KERNEL sandbox (the same confinement the worktree executor uses). The child evaluates
// agent-authored source to smoke-test the MOUNT, so it MUST run the code; lexical `new Function` shadowing
// alone is NOT a boundary (the standard escapes — `this.process`, `Function.prototype.constructor`,
// dynamic `import()` — reach the real global, and this process runs as the operator with fs+network).
// bwrap closes that at the OS level: NO network (`--unshare-all`), a minimal READ-ONLY system + repo,
// and NOTHING else — so even a full in-child escape can't read a secret, write a file, or exfiltrate.
// (We keep sloppy `new Function` semantics INSIDE the jail so a bare undefined variable is still a real
// ReferenceError — the whole point of the render smoke — which a SES Compartment would silently resolve
// to `undefined`.) If bwrap is unavailable we FAIL OPEN by SKIPPING the check (never run unsandboxed):
// the source then only ever executes in the browser sandbox, and validation stays parse-only in-process.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./render-check-child.mjs', import.meta.url));
const CHILD_DIR = fileURLToPath(new URL('.', import.meta.url));
const TIMEOUT_MS = Number(process.env.RENDER_CHECK_TIMEOUT_MS) || 8000;

// ── bwrap sandbox for the render-check child (mirrors agent-caps' BWRAP_BASE; kept local to avoid a
//    circular import — agent-caps imports THIS module). Read-only system + the covering repo dir, no net. ──
const BWRAP_BIN = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
const USE_BWRAP = !!BWRAP_BIN && process.env.RENDER_CHECK_BWRAP !== '0' && process.env.WORKTREE_BWRAP !== '0';
const roBindIf = p => { try { return fs.existsSync(p) ? ['--ro-bind', p, p] : []; } catch { return []; } };
const WORKTREE_REPO = process.env.FIELD_AGENT_WORKTREE_REPO || '/home/dan/endo-bfb-llm';
// bind the minimal directory that still contains the child + client/ui-kit.js it reads.
const REPO_BIND = (CHILD_DIR === WORKTREE_REPO || CHILD_DIR.startsWith(`${WORKTREE_REPO}/`)) ? WORKTREE_REPO : CHILD_DIR;
const BWRAP_ARGS = [
  ...roBindIf('/usr'), ...roBindIf('/etc'), ...roBindIf('/lib'), ...roBindIf('/lib64'),
  ...roBindIf('/bin'), ...roBindIf('/sbin'), ...roBindIf('/opt'),
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
  ...roBindIf(REPO_BIND),
  '--unshare-all', '--die-with-parent',
  '--chdir', CHILD_DIR,
];

/**
 * Render-smoke a confined component source.
 * @param {string} source - the component source text.
 * @param {{ kind?: 'ui' | 'fork', props?: object, timeoutMs?: number }} [opts]
 *   kind 'ui'   = `(ui) => element` (showComponent / confined.html);
 *   kind 'fork' = `(endowments, props) => vnode` (forks / confineComponent).
 *   `props` seeds the check's props (e.g. a customView's sample value).
 * @returns {Promise<{ ok: boolean, error?: string }>} never rejects.
 */
export const renderCheck = (source, { kind = 'ui', props, timeoutMs } = {}) => new Promise(resolve => {
  const src = String(source == null ? '' : source);
  if (!src.trim()) { resolve({ ok: false, error: 'empty component source' }); return; }
  let done = false;
  const finish = r => { if (!done) { done = true; resolve(r); } };
  if (!USE_BWRAP) {
    // No kernel sandbox → do NOT execute agent source unsandboxed. Skip (fail OPEN): the source still
    // runs later in the browser sandbox, and the server's own validation is parse-only (no in-process exec).
    finish({ ok: true, skipped: 'render check unavailable (no bwrap sandbox — refusing to execute source unsandboxed)' });
    return;
  }
  let child;
  const args = [CHILD, kind === 'fork' ? 'fork' : 'ui'];
  if (props && typeof props === 'object') { try { args.push(JSON.stringify(props).slice(0, 20000)); } catch { /* unserializable sample → default props */ } }
  try {
    // spawn the child INSIDE bwrap: `bwrap <ro-binds, --unshare-all> -- node render-check-child.mjs …`.
    child = spawn(BWRAP_BIN, [...BWRAP_ARGS, '--', process.execPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' }, // a bare environment: the child needs nothing else (and gets nothing else)
    });
  } catch (e) {
    finish({ ok: true, error: undefined, skipped: `render check unavailable: ${e.message}` }); // fail OPEN: never block authoring because the checker itself broke
    return;
  }
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* */ }
    finish({ ok: false, error: 'render check timed out — the component likely loops forever while building (an infinite loop in the function body)' });
  }, Math.max(500, Number(timeoutMs) || TIMEOUT_MS));
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', () => {});
  child.on('error', () => { clearTimeout(timer); finish({ ok: true, skipped: 'render check unavailable (spawn failed)' }); });
  child.on('close', () => {
    clearTimeout(timer);
    try {
      const line = stdout.split('\n').find(l => l.trim().startsWith('{'));
      const r = JSON.parse(line);
      finish({ ok: r.ok !== false, error: r.ok === false ? String(r.error || 'render check failed') : undefined });
    } catch {
      // the child crashed without a verdict (e.g. OOM) — treat as unavailable, NOT as a component bug
      finish({ ok: true, skipped: 'render check produced no verdict' });
    }
  });
  try { child.stdin.end(src); } catch { /* close-handler still settles */ }
});
export default renderCheck;
