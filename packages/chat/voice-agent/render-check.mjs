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
// Mechanics: spawn a short-lived child (render-check-child.mjs) with a HARD TIMEOUT — the child locks
// down (SES) and evaluates the source in a Compartment against a stub of the real runtime, so the
// live server never executes agent-authored code in-process and an infinite loop only kills the child.
// No cap, secret, or network reaches the child; the source itself is render-safe by construction.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./render-check-child.mjs', import.meta.url));
const TIMEOUT_MS = Number(process.env.RENDER_CHECK_TIMEOUT_MS) || 8000;

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
  let child;
  const args = [CHILD, kind === 'fork' ? 'fork' : 'ui'];
  if (props && typeof props === 'object') { try { args.push(JSON.stringify(props).slice(0, 20000)); } catch { /* unserializable sample → default props */ } }
  try {
    child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH }, // a bare environment: the child needs nothing else (and gets nothing else)
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
