#!/usr/bin/env node
// rover-battery-watch — push an ntfy when Rovie's battery reads full.
//
// Reads the rover's read-only /feedback route (battery 'v', ×100 fixed-point)
// over the proven key-only `ssh rovie` path — the rover binds :5000 to
// localhost, so the Endo/cap-architecture access path is ssh, never the LAN.
// Fires once per charge cycle: latches at FULL_V, re-arms after dropping below
// REARM_V. Tolerant of the rover being down (fd leak / WiFi flap / reboot) —
// just skips the tick and retries.
//
// This is the first consumer of the rover-as-telemetry-cap (observer facet,
// pre-Endo-grunt). Non-actuating: it only ever reads.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const NOTIFY = path.join(HOME, 'endo-bfb/packages/chat/capture/notify.mjs');
const STATE = path.join(HOME, '.local/state/field-rover/battery-watch.json');

const FULL_V = 12.5; // 3S Li-ion "full" resting ≈12.4–12.6 V
const REARM_V = 11.8; // must drop below this to re-arm the next-cycle notify
const NEED_SAMPLES = 3; // consecutive samples ≥ FULL_V before firing (debounce)
const POLL_MS = 60_000;

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);

const readState = async () => {
  try { return JSON.parse(await fsp.readFile(STATE, 'utf8')); } catch { return { latched: false, hi: 0 }; }
};
const writeState = async s => {
  await fsp.mkdir(path.dirname(STATE), { recursive: true });
  await fsp.writeFile(STATE, JSON.stringify(s, null, 2));
};

// fetch the latest feedback frame over ssh; returns the parsed object or null.
const fetchFrame = () => new Promise(res => {
  const c = spawn('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'rovie',
    'curl -sf --max-time 6 http://127.0.0.1:5000/feedback',
  ], { timeout: 20_000 });
  let out = '';
  c.stdout.on('data', d => { out += d; });
  c.on('close', () => { try { res(JSON.parse(out)); } catch { res(null); } });
  c.on('error', () => res(null));
});

const notify = (title, message, priority = 'high') => new Promise(r => {
  const c = spawn('node', [NOTIFY, '--title', title, '--message', message, '--priority', priority, '--tags', 'battery,robot'], { timeout: 15_000 });
  c.on('close', () => r()); c.on('error', () => r());
});

const tick = async () => {
  const frame = await fetchFrame();
  if (!frame || typeof frame.v !== 'number') { log('no frame (rover down or no telemetry) — skip'); return; }
  const volts = frame.v / 100;
  const s = await readState();
  if (volts >= FULL_V) {
    s.hi = (s.hi || 0) + 1;
    if (s.hi >= NEED_SAMPLES && !s.latched) {
      s.latched = true;
      s.notifiedAt = new Date().toISOString();
      log(`FULL: ${volts.toFixed(2)} V — notifying`);
      await notify('Rovie battery full', `Rovie is charged — ${volts.toFixed(2)} V. Ready to roll.`);
    }
  } else {
    s.hi = 0;
    if (volts < REARM_V && s.latched) { s.latched = false; log(`re-armed (${volts.toFixed(2)} V < ${REARM_V})`); }
  }
  s.lastVolts = volts;
  s.lastSeen = new Date().toISOString();
  await writeState(s);
  log(`v=${volts.toFixed(2)} latched=${s.latched} hi=${s.hi}`);
};

log('rover-battery-watch started; FULL≥', FULL_V, 'V re-arm<', REARM_V, 'V poll', POLL_MS / 1000, 's');
// eslint-disable-next-line no-constant-condition
for (;;) { try { await tick(); } catch (e) { log('tick error', e && e.message); } await new Promise(r => setTimeout(r, POLL_MS)); }
