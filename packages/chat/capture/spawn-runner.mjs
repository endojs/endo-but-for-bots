#!/usr/bin/env node
// spawn-runner — the execution half of "propose a sub-agent". Watches the
// spawn-queue (written by the dashboard when the operator APPROVES a spawn-agent
// proposal) and instantiates each approved sub-agent as a headless worker
// (`claude -p`) running in its own folder, scoped (by prompt) to the granted
// objects, writing results to its scratch. Approval = authorization; this is the
// grant-on-approve execution for sub-agents.
//
// v1 scoping caveat: the worker runs as the same user with full tool access;
// "least privilege" is enforced by the prompt + cwd, not a hard sandbox. The
// hard-sandbox version (a kernel-isolated persona per sub-agent, holding only the
// granted endo caps) is the next step. The operator-approval gate is the control.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const QUEUE = path.join(HOME, '.local/state/field-dashboard/spawn-queue.json');
const CLAUDE = '/home/dan/.local/bin/claude';
const NOTIFY = '/home/dan/endo-bfb/packages/chat/capture/notify.mjs';
const POLL_MS = 15000;
const WORKER_TIMEOUT_MS = 20 * 60 * 1000;

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
const readQ = async () => { try { return JSON.parse(await fsp.readFile(QUEUE, 'utf8')); } catch { return { items: [] }; } };
const writeQ = async q => { q.updated = new Date().toISOString(); await fsp.mkdir(path.dirname(QUEUE), { recursive: true }); await fsp.writeFile(QUEUE, JSON.stringify(q, null, 2)); };

const buildPrompt = it => {
  const capStr = it.caps && it.caps.length ? it.caps.join(', ') : '(only your scratch folder)';
  const endowments = it.endowments && typeof it.endowments === 'object' ? it.endowments : {};
  const powerLines = Object.entries(endowments).map(([name, def]) =>
    `  ${name}: ${def.desc || ''}\n    Invoke: ${(def.usage || '').replace('<script>', def.script || '')}`
  );
  const powersBlock = powerLines.length
    ? `\nGranted powers (invoke exactly as shown):\n${powerLines.join('\n')}`
    : '';
  return [
    `You are "${it.name}", a least-privilege sub-agent spawned to do ONE bounded task and then stop.`,
    `Granted capabilities — use ONLY these: ${capStr}.`,
    powersBlock,
    `You do NOT have dan's private Obsidian graph, personal data, or credentials unless explicitly listed above.`,
    `Your working directory is this folder; write outputs to ./scratch/. When finished, write a concise result to ./scratch/result.md and stop.`,
    '',
    `TASK: ${it.task || '(no task specified)'}`,
    it.prompt ? `\nCONTEXT:\n${it.prompt}` : '',
  ].filter(Boolean).join('\n');
};

const runWorker = it => new Promise(res => {
  const child = spawn(CLAUDE, ['--dangerously-skip-permissions', '-p', buildPrompt(it)], {
    cwd: it.folder, timeout: WORKER_TIMEOUT_MS,
    env: { ...process.env, PATH: `${process.env.PATH}:/home/dan/.local/bin` },
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('close', code => res({ code, out }));
  child.on('error', e => res({ code: -1, out: String(e && e.message) }));
});

const notify = (title, message) => new Promise(r => {
  const c = spawn('node', [NOTIFY, '--title', title, '--message', message, '--priority', 'default'], { timeout: 15000 });
  c.on('close', () => r()); c.on('error', () => r());
});

const tick = async () => {
  const q = await readQ();
  for (const it of (q.items || []).filter(i => i.status === 'approved')) {
    it.status = 'running'; it.startedAt = new Date().toISOString();
    await writeQ(q);
    log('spawning worker', it.name, 'in', it.folder);
    const { code, out } = await runWorker(it);
    try { await fsp.writeFile(path.join(it.folder, 'scratch', 'worker-output.md'), `# ${it.name} worker output (exit ${code})\n\n${out}\n`); } catch { /* */ }
    it.status = code === 0 ? 'done' : 'error'; it.finishedAt = new Date().toISOString(); it.exit = code;
    await writeQ(q);
    log('worker', it.name, 'finished exit', code);
    await notify(`Sub-agent ${it.name} ${it.status}`, String(it.task).slice(0, 200)).catch(() => {});
  }
};

log('spawn-runner started; watching', QUEUE);
// eslint-disable-next-line no-constant-condition
for (;;) {
  try { await tick(); } catch (e) { log('tick error', e && e.message); }
  await new Promise(r => setTimeout(r, POLL_MS));
}
