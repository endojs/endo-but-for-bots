#!/usr/bin/env node
// timer-runner — fires the agent's durable timers when due. Polls the schedule
// store; for each active timer past its time, runs the action (notify | command),
// then reschedules intervals / retires one-shots.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const STORE = path.join(HOME, '.local/state/field-timers/schedule.json');
const NOTIFY = '/home/dan/endo-bfb/packages/chat/capture/notify.mjs';
const POLL_MS = 10000;

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);
const read = async () => { try { return JSON.parse(await fsp.readFile(STORE, 'utf8')); } catch { return { timers: [] }; } };
const write = async s => { s.updated = new Date().toISOString(); await fsp.writeFile(STORE, JSON.stringify(s, null, 2)); };

const fire = a => new Promise(r => {
  let child;
  if (a.type === 'notify') {
    child = spawn('node', [NOTIFY, '--title', a.title || 'timer', '--message', a.message || '', '--priority', a.priority || 'default'], { timeout: 20000 });
  } else if (a.type === 'command') {
    child = spawn('bash', ['-lc', a.cmd || 'true'], { timeout: 10 * 60 * 1000, env: { ...process.env, PATH: `${process.env.PATH}:/home/dan/.local/bin` } });
  } else { return r({ code: -1 }); }
  child.on('close', code => r({ code })); child.on('error', () => r({ code: -1 }));
});

const tick = async () => {
  const s = await read();
  const t0 = Date.now();
  let changed = false;
  for (const t of (s.timers || [])) {
    if (t.status !== 'active') continue;
    const due = new Date(t.kind === 'interval' ? t.nextAt : t.dueAt).getTime();
    if (Number.isNaN(due) || due > t0) continue;
    log('firing', t.id, t.kind, t.action.type, t.label || '');
    const { code } = await fire(t.action);
    t.lastFired = new Date().toISOString(); t.lastExit = code;
    if (t.kind === 'interval') t.nextAt = new Date(t0 + t.everyMs).toISOString();
    else t.status = 'done';
    changed = true;
  }
  if (changed) await write(s);
};

log('timer-runner started; watching', STORE);
// eslint-disable-next-line no-constant-condition
for (;;) { try { await tick(); } catch (e) { log('tick error', e && e.message); } await new Promise(r => setTimeout(r, POLL_MS)); }
