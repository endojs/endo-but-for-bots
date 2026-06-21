// Diagnostic preload (loaded into every ava worker via `--import`).
//
// The Node-24 chat worker hang shows up as: a worker's libuv loop never
// empties, so the worker never exits and CI wedges. This watchdog arms an
// UNREF'd timer with a GENEROUS threshold (well above any legitimate per-file
// runtime — AVA's per-test timeout is 120s, and the slowest chat file runs in
// ~12s locally, so a healthy file always finishes first). An unref'd timer
// cannot keep the loop alive on its own, so a healthy worker exits before it
// fires. If the worker is STILL alive at the threshold, a real handle is
// holding the loop open: we dump the surviving resources/handles and
// force-exit so CI does not hang for hours.
//
// Runs before `@endo/init` lockdown, so `setTimeout`/`fs` are captured raw.

import fs from 'node:fs';
import { threadId } from 'node:worker_threads';

const LOG = '/tmp/handle-dump.log';
const file = process.env.PROBE_FILE || '<unknown>';
const THRESHOLD_MS = 120000;

const dumpTimer = setTimeout(() => {
  let out = `[handle-dump] FILE=${file} pid=${process.pid} threadId=${threadId}\n`;
  out += `  argv: ${JSON.stringify(process.argv.slice(1))}\n`;
  try {
    out += `  resources: ${JSON.stringify(process.getActiveResourcesInfo())}\n`;
  } catch (e) {
    out += `  resources-err: ${e}\n`;
  }
  try {
    // eslint-disable-next-line no-underscore-dangle
    const handles = process._getActiveHandles().map(h => {
      const name = h && h.constructor ? h.constructor.name : typeof h;
      const delay =
        h && h._idleTimeout !== undefined ? ` delay=${h._idleTimeout}` : '';
      const fd = h && h.fd !== undefined ? ` fd=${h.fd}` : '';
      return `${name}${delay}${fd}`;
    });
    out += `  handles: ${JSON.stringify(handles)}\n`;
  } catch (e) {
    out += `  handles-err: ${e}\n`;
  }
  try {
    // eslint-disable-next-line no-underscore-dangle
    const reqs = process
      ._getActiveRequests()
      .map(r => (r && r.constructor ? r.constructor.name : typeof r));
    out += `  requests: ${JSON.stringify(reqs)}\n`;
  } catch (e) {
    out += `  requests-err: ${e}\n`;
  }
  try {
    fs.appendFileSync(LOG, out);
  } catch (e) {
    // ignore
  }
  // Also emit to stderr so it survives even without the shared log file.
  // eslint-disable-next-line no-underscore-dangle
  process._rawDebug(out);
  process.exit(0);
}, THRESHOLD_MS);
dumpTimer.unref();
