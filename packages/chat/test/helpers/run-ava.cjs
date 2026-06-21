#!/usr/bin/env node
/* global process, __dirname, require */

'use strict';

// Reliable AVA runner for the Node-24 CI hang.
//
// On Node 24 the chat `ava` run sometimes never exits: a worker keeps a libuv
// handle open after its tests have passed, so AVA waits for the worker, turbo
// waits for AVA, and the CI job wedges for hours. The leak is timing-dependent
// (it does not reproduce locally and the coverage job, whose instrumentation
// shifts timing, avoids it), and it is not specific to any test file (bisecting
// the suite showed every quarter — including a unit-only control — hangs).
//
// This wrapper runs `ava` in its OWN process group. If `ava` exits on its own
// we just forward its exit code. If it reports results but does not exit within
// the hard limit, we: (1) signal every surviving worker to write a Node
// diagnostic report (which lists the active libuv handles, naming the leak),
// (2) print those handles, and (3) SIGKILL the whole group and exit — green
// when the tests had passed, since a real failure exits non-zero on its own
// well before the limit. NODE_OPTIONS (unlike AVA's `nodeArguments`) propagates
// to the worker processes, so `--report-on-signal` reaches them.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HARD_LIMIT_MS = Number(process.env.AVA_HARD_LIMIT_MS || 180_000);
const reportDir = path.resolve(__dirname, '../_reports');
try {
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });
} catch (_e) {
  // best effort
}

let passed = false;
let failed = false;
const scan = (chunk, out) => {
  out.write(chunk);
  const s = chunk.toString();
  if (/\b\d+ tests? passed\b/.test(s)) passed = true;
  if (/\b\d+ tests? failed\b|remained pending|Timed out while/.test(s)) {
    failed = true;
  }
};

const child = spawn('ava', process.argv.slice(2), {
  detached: true, // own process group, so we can kill the whole tree
  stdio: ['inherit', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_OPTIONS: `${
      process.env.NODE_OPTIONS || ''
    } --report-on-signal --report-directory=${reportDir}`.trim(),
  },
});
child.stdout.on('data', c => scan(c, process.stdout));
child.stderr.on('data', c => scan(c, process.stderr));

let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_e) {
    // group already gone
  }
  process.exit(code);
};

child.on('exit', (code, signal) =>
  finish(code == null ? (signal ? 1 : 0) : code),
);
child.on('error', err => {
  console.error('[run-ava] failed to spawn ava:', err);
  finish(1);
});

setTimeout(() => {
  console.error(
    `[run-ava] ava did not exit within ${HARD_LIMIT_MS}ms — Node-24 worker-exit leak. passed=${passed} failed=${failed}`,
  );
  // Ask every surviving worker (and the main process) to dump active handles.
  try {
    process.kill(-child.pid, 'SIGUSR2');
  } catch (_e) {
    // ignore
  }
  setTimeout(() => {
    try {
      for (const f of fs.readdirSync(reportDir)) {
        try {
          const r = JSON.parse(
            fs.readFileSync(path.join(reportDir, f), 'utf8'),
          );
          const handles = (r.libuv || [])
            .filter(h => h.is_active)
            .map(
              h =>
                `${h.type}${h.fd >= 0 ? `:fd${h.fd}` : ''}${
                  h.address ? `@${h.address}` : ''
                }`,
            );
          console.error(
            `[run-ava] ${f}: active libuv handles ${JSON.stringify(handles)}`,
          );
        } catch (e) {
          console.error(`[run-ava] could not parse report ${f}: ${e.message}`);
        }
      }
    } catch (_e) {
      // no reports
    }
    finish(failed ? 1 : passed ? 0 : 1);
  }, 3000);
}, HARD_LIMIT_MS);
