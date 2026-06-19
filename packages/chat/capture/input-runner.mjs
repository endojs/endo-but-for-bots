#!/usr/bin/env node
// input-runner — makes the dashboard's "Input provided ↻" button actually kick
// off agent action. Watches the input-queue (written when the operator clicks
// the button) and, for each pending item, launches a worker (claude -p) that
// re-reads the Obsidian doc where the operator gave input and continues the
// work it unblocks. The operator's click is the trigger/authorization.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const QUEUE = path.join(HOME, '.local/state/field-dashboard/input-queue.json');
const CLAUDE = '/home/dan/.local/bin/claude';
const NOTIFY = '/home/dan/endo-bfb/packages/chat/capture/notify.mjs';
const POLL_MS = 12000;
const WORKER_TIMEOUT_MS = 25 * 60 * 1000;

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
const read = async () => { try { return JSON.parse(await fsp.readFile(QUEUE, 'utf8')); } catch { return { items: [] }; } };
const write = async q => { q.updated = new Date().toISOString(); await fsp.writeFile(QUEUE, JSON.stringify(q, null, 2)); };

const itemLine = (u, i) => {
  if (u.prompt) {
    return `${i + 1}. REPLY on "${u.title || u.label || 'item'}"${u.doc ? ` (context doc: ~/obsidian/vault/${u.doc})` : ''} — the operator's instruction: "${u.prompt}"`;
  }
  return `${i + 1}. doc: ~/obsidian/vault/${u.doc} — operator input on: "${u.label}"`;
};

const buildPrompt = uniq => [
  'You are the field\'s input-review agent (you have the operator\'s full context). For each item below the operator either clicked "Input provided" (their answer is written in the linked Obsidian doc) or used "Reply" (their instruction is given inline). Act on each to CONTINUE / refine that item.',
  '',
  'Items to act on:',
  ...uniq.map(itemLine),
  '',
  'For EACH item: if it is a REPLY, the operator\'s instruction is given inline — read the context doc for background, then carry out the instruction (e.g. fix a typo, switch an approach, pick the best option, do a follow-up). If it is an "Input provided" item, open the doc and find the operator\'s answer/edit (usually an indented sub-bullet under the flagged line). Then act:',
  '- Safe, clear, INTERNAL → DO it (integrate the note/clipping, update the relevant plan/memory/skill, answer, route, file).',
  '- 🚫 Risky / physical-device / security-sensitive / outward-facing / destructive (e.g. changing or taking offline a robot, exposing a service, deleting data, force-push) → DO NOT do it autonomously. Write a concise plan + recommendation and (re)flag it in ~/TOQU/needs-review.md; push a notify. Never actuate hardware.',
  'Honor standing rules: tailnet-first, keep work quiet (IP/legal), don\'t disrupt running services, no force-push to archua-deploy-watched repos, correct factual errors.',
  'Record what you did: append a line to ~/TADA/capture-log.md AND run `node ~/endo-bfb/packages/chat/dashboard/feed.mjs post --title "..." --status "..." --body "..."`. If you resolved a TOQU decision, append "✅ resolved (<date>): <what you did>" under it (do NOT delete the operator\'s text).',
  'Then stop.',
].join('\n');

const runWorker = uniq => new Promise(res => {
  const child = spawn(CLAUDE, ['--dangerously-skip-permissions', '-p', buildPrompt(uniq)], {
    cwd: HOME, timeout: WORKER_TIMEOUT_MS, env: { ...process.env, PATH: `${process.env.PATH}:/home/dan/.local/bin` },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => res({ code, out }));
  child.on('error', e => res({ code: -1, out: String(e && e.message) }));
});

const notify = (title, message) => new Promise(r => {
  // --no-feed: operational status ping, not reviewable feed content.
  const c = spawn('node', [NOTIFY, '--title', title, '--message', message, '--priority', 'default', '--no-feed'], { timeout: 15000 });
  c.on('close', () => r()); c.on('error', () => r());
});

const tick = async () => {
  const q = await read();
  const pending = (q.items || []).filter(i => i.status === 'pending');
  if (!pending.length) return;
  // dedupe identical (doc,label) "Input provided" clicks; replies are unique (keep each).
  const seen = new Set();
  const uniq = [];
  for (const i of pending) { const k = i.prompt ? `reply:${i.id}` : `${i.doc} ${i.label}`; if (!seen.has(k)) { seen.add(k); uniq.push(i); } }
  pending.forEach(i => { i.status = 'processing'; i.startedAt = new Date().toISOString(); });
  await write(q);
  log('input worker for', uniq.length, 'unique item(s) (', pending.length, 'clicks )');
  const { code, out } = await runWorker(uniq);
  try { await fsp.writeFile(path.join(HOME, '.local/state/field-dashboard/input-worker.log'), `# input worker (exit ${code}) ${new Date().toISOString()}\n\n${out}\n`); } catch { /* */ }
  const q2 = await read();
  for (const i of (q2.items || [])) if (i.status === 'processing') { i.status = code === 0 ? 'done' : 'error'; i.finishedAt = new Date().toISOString(); }
  await write(q2);
  log('input worker finished exit', code);
  await notify('Input review done', `${uniq.length} item(s), exit ${code}`).catch(() => {});
};

log('input-runner started; watching', QUEUE);
// eslint-disable-next-line no-constant-condition
for (;;) { try { await tick(); } catch (e) { log('tick error', e && e.message); } await new Promise(r => setTimeout(r, POLL_MS)); }
