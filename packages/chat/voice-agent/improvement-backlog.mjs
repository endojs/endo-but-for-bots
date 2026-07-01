// improvement-backlog.mjs — a concrete dataset of improvement targets the self-improvement loop optimizes
// against (applying FAPO's principle: drive a closed loop with a concrete dataset, not open-ended research).
// Research PROPOSES targets into the backlog; the loop DRAINS the top one, implements + INDEPENDENTLY
// verifies it, and RECORDS the outcome (FAPO's failure attribution). Targets need NOT be file-scoped — a
// larger ARCHITECTURAL change is fine; the GATE is the suite (the loop merges only if it stays green +
// re-verifies post-merge). A precise goal still implements more reliably, but breadth is allowed now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const file = () => process.env.IMPROVEMENT_BACKLOG || path.join(os.homedir(), '.local/state/field-agent/improvement-backlog.json');
const now = () => new Date().toISOString();
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { items: [] }; } };
const save = s => { try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), `${JSON.stringify(s, null, 2)}\n`); } catch { /* best effort */ } return s; };

export const listBacklog = ({ status } = {}) => load().items.filter(i => !status || i.status === status).map(i => ({ id: i.id, goal: i.goal, status: i.status, priority: i.priority, attempts: i.attempts, by: i.by, lastOutcome: i.lastOutcome || null }));

// add an improvement target (precise file-scoped OR a larger architectural change). de-dupes against an
// existing OPEN item with the same goal. The suite — not file-scoping — is what gates a target landing.
export const addBacklog = ({ goal, successCommand, rationale, by, priority } = {}) => {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: 'a goal is required' };
  if (g.length < 12) return { ok: false, error: 'goal too short — describe the change + how the suite verifies it (a few words will not implement)' };
  const s = load();
  if (s.items.some(i => i.status === 'open' && i.goal === g)) return { ok: true, deduped: true };
  const item = { id: `imp-${crypto.randomBytes(4).toString('hex')}`, goal: g, successCommand: successCommand ? String(successCommand) : null, rationale: String(rationale || '').slice(0, 600), priority: Number(priority) || 0, status: 'open', by: String(by || ''), addedAt: now(), attempts: 0 };
  s.items.push(item); save(s);
  return { ok: true, id: item.id };
};

// the FAILURE THRESHOLD: after this many unsuccessful attempts a target is parked in a terminal status
// ('failed') by recordOutcome so it can NEVER be picked again — one failing target can't block the whole queue.
export const FAILURE_THRESHOLD = 3;

// the highest-priority OPEN target (ties broken oldest-first). Only 'open' items below the failure threshold
// are eligible; once a target hits FAILURE_THRESHOLD it is moved to a terminal 'failed' status (see recordOutcome)
// and is no longer 'open', so it drops out of the queue and the loop drains the next target instead of stalling.
export const nextOpen = ({ maxAttempts = FAILURE_THRESHOLD } = {}) => load().items
  .filter(i => i.status === 'open' && (i.attempts || 0) < maxAttempts)
  .sort((a, b) => (b.priority - a.priority) || (a.addedAt < b.addedAt ? -1 : 1))[0] || null;

// Canonicalize a verification command to the runner that actually works in THIS repo. The loop (an LLM) keeps
// emitting `npm test <file>` — but root `npm test` is `yarn workspaces foreach --all run test` (slow, ignores
// the file, and a worktree has no deps) — or `yarn test <file>`. Tests here run via `node --test <file>`. Rewrite
// the leading runner accordingly; an already-correct `node --test …` (or anything else) is left untouched.
export const normalizeTestCmd = cmd => String(cmd || '').replace(/^\s*(?:npm|yarn|pnpm)\s+(?:run\s+)?test\b/, 'node --test');

// PRE-FLIGHT target guard: the slash-containing file paths a goal names (its targets). A goal that names files
// but NONE exist is aimed at a phantom/wrong path (the #1 way the loop burned attempts — e.g. a non-existent
// eval/improvement-executor.mjs, or packages/chat/ocapn-noise when it's packages/ocapn-noise). `exists(rel)` is
// injected (caller resolves against the repo root). ok when the goal names no path, OR at least one path exists
// (a real source it edits — a NEW test file alongside is fine).
export const goalTargets = goal => [...new Set(String(goal || '').match(/\b[\w.-]+\/[\w./-]*\.\w+/g) || [])];
export const missingTargets = (goal, exists) => {
  const targets = goalTargets(goal);
  const missing = targets.filter(p => { try { return !exists(p); } catch { return true; } });
  return { ok: targets.length === 0 || missing.length < targets.length, targets, missing };
};

// map a selfImprover.improve() result to the backlog outcome status. THE one place the attribution rule
// lives (agent-caps uses it): merged → 'merged'; verified-but-unmerged-through-no-fault-of-the-change
// (auto-merge off, or the LIVE tree was dirty → readyToReview) → 'staged'; everything else → 'failed'.
export const outcomeStatus = r => ((r && r.merged) ? 'merged' : (r && r.readyToReview) ? 'staged' : 'failed');

// record the outcome of an attempt (FAPO attribution): 'merged' | 'staged' (verified, awaiting review) |
// 'failed' (empty/red — keep the reason so the next attempt or the operator can learn). An unsuccessful attempt
// returns the target to 'open' for a BOUNDED retry — but once it has racked up FAILURE_THRESHOLD (default 3)
// unsuccessful attempts it is parked in a TERMINAL 'failed' status so it leaves the open queue permanently and
// one persistently-failing target can never block the rest of the backlog from draining.
// A 'staged' outcome does NOT charge the retry budget: the change was verified GREEN and is merely awaiting
// review (e.g. auto-merge refused only because the live tree was dirty) — that is not a burned attempt, and if
// the item is ever re-opened its budget must not be pre-charged by outcomes that were not the change's fault.
export const recordOutcome = (id, { status, branch, reason, failureThreshold = FAILURE_THRESHOLD } = {}) => {
  const s = load(); const it = s.items.find(x => x.id === String(id));
  if (!it) return { ok: false, error: 'no such backlog item' };
  it.attempts = (it.attempts || 0) + (status === 'staged' ? 0 : 1);
  if (status === 'merged' || status === 'staged') {
    it.status = status; // a successful (or verified-staged) attempt is terminal
  } else if (it.attempts >= failureThreshold) {
    it.status = 'failed'; // exhausted the retry budget → terminal 'failed', no longer 'open' (queue is never blocked)
  } else {
    it.status = 'open'; // failed but under the threshold → back to open for a bounded retry/refine
  }
  it.lastOutcome = { at: now(), status, branch: branch || null, reason: String(reason || '').slice(0, 400) };
  save(s);
  return { ok: true, status: it.status, attempts: it.attempts, threshold: failureThreshold };
};

// summarize the backlog by status — counts items in each lifecycle bucket. REUSES load().
export const backlogStats = () => {
  const stats = { open: 0, staged: 0, merged: 0, failed: 0 };
  for (const i of load().items) {
    if (Object.prototype.hasOwnProperty.call(stats, i.status)) stats[i.status] += 1;
  }
  return stats;
};

// prune RESOLVED targets — remove every item whose status is 'merged' or 'staged' (verified work that
// no longer needs to be tracked) and return the number removed. REUSES load()/save().
export const clearResolved = () => {
  const s = load();
  const before = s.items.length;
  s.items = s.items.filter(i => i.status !== 'merged' && i.status !== 'staged');
  const removed = before - s.items.length;
  save(s);
  return removed;
};

export const backlogFile = file;
