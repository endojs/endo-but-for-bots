#!/usr/bin/env node
// ingress-warden — periodic self-check that the field's agent infrastructure is
// actually handling incoming captures ("ingress"). Run by ingress-warden.timer.
//
// Two layers, cheapest first:
//   1. SELF-HEAL (no LLM): restart any dead ingress service; un-stick input/
//      spawn queue items wedged in 'processing' by a crashed/killed worker.
//   2. ESCALATE (claude -p): only when there's genuine UNHANDLED ingress —
//      voice captures sitting unprocessed in the inbox, etc. — spawn a warden
//      agent that processes them (per the process-captures skill) and handles
//      what it safely can, flagging anything risky to the operator.
//
// All-healthy ticks just append one line to the log — no agent, no feed spam.
// Standing rules apply to the agent: safe/internal actions only; hardware /
// destructive / outward-facing / proposal decisions are flagged, never taken.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const VAULT = path.join(HOME, 'obsidian/vault');
const INBOX = path.join(VAULT, 'inbox');
const CLAUDE = path.join(HOME, '.local/bin/claude');
const LOG = path.join(HOME, '.local/state/field-warden/warden.log');
const STATE = path.join(HOME, '.local/state/field-warden/state.json');
const INPUT_QUEUE = path.join(HOME, '.local/state/field-dashboard/input-queue.json');
const SPAWN_QUEUE = path.join(HOME, '.local/state/field-dashboard/spawn-queue.json');

// Services whose job is to handle ingress. If any is dead, restart it.
const INGRESS_SERVICES = [
  'field-capture', 'capture-watch-clippings', 'input-runner',
  'spawn-runner', 'field-dashboard', 'rover-battery-watch',
];
const CAPTURE_STALE_MIN = 15; // a capture older than this with no processing = unhandled
const STUCK_MIN = 30; // a queue item 'processing' longer than this = crashed worker
const WORKER_TIMEOUT_MS = 25 * 60 * 1000;

const log = async (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  await fsp.mkdir(path.dirname(LOG), { recursive: true });
  await fsp.appendFile(LOG, line);
  process.stderr.write(line);
};

const sh = (cmd, args) => new Promise(res => {
  const c = spawn(cmd, args, { timeout: 20000 });
  let out = '';
  c.stdout.on('data', d => { out += d; });
  c.stderr.on('data', d => { out += d; });
  c.on('close', code => res({ code, out: out.trim() }));
  c.on('error', e => res({ code: -1, out: String(e && e.message) }));
});

const isActive = async svc => (await sh('systemctl', ['--user', 'is-active', `${svc}.service`])).out === 'active';

// --- layer 1: self-heal dead services -------------------------------------
const healServices = async () => {
  const healed = [];
  for (const svc of INGRESS_SERVICES) {
    if (!(await isActive(svc))) {
      const r = await sh('systemctl', ['--user', 'restart', `${svc}.service`]);
      await new Promise(t => setTimeout(t, 1500));
      const ok = await isActive(svc);
      healed.push(`${svc}:${ok ? 'restarted' : `FAILED(${r.code})`}`);
    }
  }
  return healed;
};

// --- layer 1: un-stick crashed-worker queue items -------------------------
const unstick = async (queuePath, minAge) => {
  let q;
  try { q = JSON.parse(await fsp.readFile(queuePath, 'utf8')); } catch { return 0; }
  if (!Array.isArray(q.items)) return 0;
  const cutoff = Date.now() - minAge * 60_000;
  let n = 0;
  for (const i of q.items) {
    if (i.status === 'processing' && new Date(i.startedAt || i.ts || 0).getTime() < cutoff) {
      i.status = 'pending'; // re-queue so the runner retries it
      n += 1;
    }
  }
  if (n) await fsp.writeFile(queuePath, JSON.stringify(q, null, 2));
  return n;
};

// --- detect unhandled ingress (pending voice captures in the inbox) -------
const pendingCaptures = async () => {
  let names;
  try { names = await fsp.readdir(INBOX); } catch { return []; }
  let processed = new Set();
  try { processed = new Set(await fsp.readdir(path.join(INBOX, 'processed'))); } catch { /* none */ }
  const stale = Date.now() - CAPTURE_STALE_MIN * 60_000;
  const out = [];
  for (const n of names) {
    if (!/^capture-.*\.md$/.test(n)) continue; // only the voice pipeline's captures
    if (processed.has(n)) continue;
    try {
      const st = await fsp.stat(path.join(INBOX, n));
      if (st.isFile() && st.mtimeMs < stale) out.push(n);
    } catch { /* gone */ }
  }
  return out;
};

const buildPrompt = (captures, snapshot) => [
  'You are the field\'s ingress-warden — a periodic self-check that the capture/agent infrastructure is keeping up. The cheap self-heal pass already ran (services restarted, stuck queue items re-queued). Your job now: handle the UNHANDLED ingress below so nothing rots in the inbox.',
  '',
  `Infra snapshot: ${snapshot}`,
  '',
  `Pending voice captures (in ~/obsidian/vault/inbox/, older than ${CAPTURE_STALE_MIN} min, not yet processed):`,
  ...captures.map((c, i) => `  ${i + 1}. inbox/${c}`),
  '',
  'For EACH pending capture: process it by following the process-captures skill at ~/.claude/skills/process-captures/SKILL.md (read it, then do exactly what it says — evaluate the note, act on safe/clear/internal items, file artifacts, append the agent log, move to inbox/processed/, record to ~/TADA/capture-log.md AND the feed via dashboard/feed.mjs).',
  'Honor standing rules: safe internal actions only; anything risky / hardware / outward-facing / destructive / a proposal decision → DO NOT do it — flag it in ~/obsidian/vault/the field/TOQU/needs-review.md and push a notify. Tailnet-first; keep work quiet; correct factual errors.',
  'CRITICAL: if you pushed an answer to the phone (e.g. a phone number, a name, a fact the operator asked for), the feed entry body MUST contain that exact pushed answer verbatim — it is the most important detail; never summarize it away. (notify.mjs also mirrors the raw push into the feed, but your summary must carry the answer too.)',
  'When done, append a one-line summary to ~/.local/state/field-warden/warden.log (how many captures handled, anything flagged) and post ONE feed entry via: node ~/endo-bfb/packages/chat/dashboard/feed.mjs post --title "<the request>" --status "<short>" --body "<what you did INCLUDING any answer you pushed verbatim>". Then stop.',
].join('\n');

const runAgent = prompt => new Promise(res => {
  const child = spawn(CLAUDE, ['--dangerously-skip-permissions', '-p', prompt], {
    cwd: HOME, timeout: WORKER_TIMEOUT_MS, env: { ...process.env, PATH: `${process.env.PATH}:${HOME}/.local/bin` },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => res({ code, out }));
  child.on('error', e => res({ code: -1, out: String(e && e.message) }));
});

const main = async () => {
  const healed = await healServices();
  const stuckIn = await unstick(INPUT_QUEUE, STUCK_MIN);
  const stuckSpawn = await unstick(SPAWN_QUEUE, STUCK_MIN);
  const captures = await pendingCaptures();

  const snapshot = `healed=[${healed.join(',') || 'none'}] requeued_input=${stuckIn} requeued_spawn=${stuckSpawn} pending_captures=${captures.length}`;

  if (!captures.length) {
    await log(`healthy. ${snapshot}`);
    return;
  }

  await log(`UNHANDLED ingress → escalating to agent. ${snapshot}`);
  const { code, out } = await runAgent(buildPrompt(captures, snapshot));
  try { await fsp.writeFile(path.join(HOME, '.local/state/field-warden/last-agent.log'), `# warden agent (exit ${code}) ${new Date().toISOString()}\n\n${out}\n`); } catch { /* */ }
  await log(`agent finished exit ${code} (handled ${captures.length} capture(s))`);
};

main().catch(async e => { await log('ERROR', e && e.message); process.exitCode = 1; });
