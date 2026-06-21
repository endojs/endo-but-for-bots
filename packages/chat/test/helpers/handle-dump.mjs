// Diagnostic preload (loaded into every ava worker via `--import`).
//
// The Node-24 chat worker leak shows up as: all tests pass, then the worker's
// libuv loop never empties, so the worker never exits and CI hangs. This
// watchdog arms an UNREF'd timer: if the worker finishes cleanly the loop
// drains and the worker exits before the timer fires (an unref'd timer cannot
// keep the loop alive on its own). But if some other handle is holding the
// loop open past test completion, the timer DOES fire — at which point we dump
// the surviving libuv resources/handles (with the offending test file name)
// and force-exit so CI does not wedge.
//
// Runs before `@endo/init` lockdown, so `setTimeout`/`fs` are captured raw.

import fs from 'node:fs';

const LOG = '/tmp/handle-dump.log';
const file = process.env.PROBE_FILE || '<unknown>';

const dumpTimer = setTimeout(() => {
  let out = `[handle-dump] FILE=${file} pid=${process.pid}\n`;
  try {
    out += `  resources: ${JSON.stringify(process.getActiveResourcesInfo())}\n`;
  } catch (e) {
    out += `  resources-err: ${e}\n`;
  }
  try {
    // eslint-disable-next-line no-underscore-dangle
    const handles = process._getActiveHandles().map(h => {
      const name = h && h.constructor ? h.constructor.name : typeof h;
      // For Timeout handles, the idle delay pinpoints which setTimeout leaked.
      const delay =
        h && h._idleTimeout !== undefined ? ` delay=${h._idleTimeout}` : '';
      return `${name}${delay}`;
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
    // last resort: bypass any worker stdio piping
    // eslint-disable-next-line no-underscore-dangle
    process._rawDebug(out);
  }
  process.exit(0);
}, 8000);
dumpTimer.unref();
