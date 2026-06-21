// improvement-backlog.mjs — a concrete, FILE-SCOPED dataset of improvement targets the self-improvement
// loop optimizes against (applying FAPO's principle: drive a closed loop with a concrete dataset, not
// open-ended research). Research PROPOSES precise targets into the backlog; the loop DRAINS the top one,
// implements + independently verifies it, and RECORDS the outcome (FAPO's failure attribution). A precise,
// file-scoped goal is what makes the executor succeed — vague goals produce empty branches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const file = () => process.env.IMPROVEMENT_BACKLOG || path.join(os.homedir(), '.local/state/field-agent/improvement-backlog.json');
const now = () => new Date().toISOString();
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { items: [] }; } };
const save = s => { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), `${JSON.stringify(s, null, 2)}\n`); } catch { /* best effort */ } return s; };

export const listBacklog = ({ status } = {}) => load().items.filter(i => !status || i.status === status).map(i => ({ id: i.id, goal: i.goal, status: i.status, priority: i.priority, attempts: i.attempts, by: i.by, lastOutcome: i.lastOutcome || null }));

// add a precise, file-scoped target. de-dupes against an existing OPEN item with the same goal.
export const addBacklog = ({ goal, successCommand, rationale, by, priority } = {}) => {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: 'a goal is required' };
  if (g.length < 25) return { ok: false, error: 'goal too vague — name the EXACT file + the EXACT change (a one-liner will not implement)' };
  const s = load();
  if (s.items.some(i => i.status === 'open' && i.goal === g)) return { ok: true, deduped: true };
  const item = { id: `imp-${crypto.randomBytes(4).toString('hex')}`, goal: g, successCommand: successCommand ? String(successCommand) : null, rationale: String(rationale || '').slice(0, 600), priority: Number(priority) || 0, status: 'open', by: String(by || ''), addedAt: now(), attempts: 0 };
  s.items.push(item); save(s);
  return { ok: true, id: item.id };
};

// the highest-priority OPEN target (ties broken oldest-first). Skips items that already failed too often.
export const nextOpen = ({ maxAttempts = 2 } = {}) => load().items
  .filter(i => i.status === 'open' && (i.attempts || 0) < maxAttempts)
  .sort((a, b) => (b.priority - a.priority) || (a.addedAt < b.addedAt ? -1 : 1))[0] || null;

// record the outcome of an attempt (FAPO attribution): 'merged' | 'staged' (verified, awaiting review) |
// 'failed' (empty/red — keep the reason so the next attempt or the operator can learn).
export const recordOutcome = (id, { status, branch, reason } = {}) => {
  const s = load(); const it = s.items.find(x => x.id === String(id));
  if (!it) return { ok: false, error: 'no such backlog item' };
  it.attempts = (it.attempts || 0) + 1;
  it.status = status === 'merged' || status === 'staged' ? status : 'open'; // failed → back to open (bounded by maxAttempts) so it can be retried/refined
  it.lastOutcome = { at: now(), status, branch: branch || null, reason: String(reason || '').slice(0, 400) };
  save(s);
  return { ok: true, status: it.status, attempts: it.attempts };
};

// summarize the backlog by status — counts items in each lifecycle bucket. REUSES load().
export const backlogStats = () => {
  const stats = { open: 0, staged: 0, merged: 0, failed: 0 };
  for (const i of load().items) {
    if (Object.prototype.hasOwnProperty.call(stats, i.status)) stats[i.status] += 1;
  }
  return stats;
};

export const backlogFile = file;
