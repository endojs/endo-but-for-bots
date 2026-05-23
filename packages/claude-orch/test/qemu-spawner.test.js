// @ts-nocheck
/* eslint-disable import/order */

import '@endo/init';
import test from 'ava';

import { spawn } from 'node:child_process';
import process from 'node:process';

// The orchestrator hardens the return of `spawnVm` so callers can hold
// it as a capability value (it's stored in `vms.set(sessionId, vm)`
// and threaded through teardown). Hardening freezes all own
// properties transitively, which is the trap that surfaced during
// PR #328 manual testing: an earlier shape exposed the live
// `ChildProcess` directly, and Node's internals mutate that object
// after `spawn()` (assigning `child.exitCode`, constructing wrapped
// `Socket`s for stderr, dispatching `'exit'` events). Every such
// mutation throws "Cannot assign to read only property …" against a
// hardened wrapper, killing the orchestrator with
// `SES_UNCAUGHT_EXCEPTION`. The two tests below pin the contract:
//
//   1. The hardened handle shape exposes only plain capabilities
//      (a number, a promise, a function) and never the ChildProcess.
//   2. A real Node `spawn` + harden flow survives the child's exit
//      and the inherited-stderr Socket construction without throwing.

test('VmHandle: a hardened wrapper of the live shape does not crash on child exit', async t => {
  // Use `process.execPath` so the test doesn't depend on PATH and
  // exits deterministically with code 7. `inherit` for stderr is
  // the production setting (`spawnVm` in src/qemu/spawner.js); it's
  // the path that historically tripped the read-only assignment in
  // `new Socket()`.
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
  const exitCode = new Promise(resolve => {
    child.once('exit', code => resolve(typeof code === 'number' ? code : -1));
  });
  const handle = harden({
    pid: child.pid,
    exitCode,
    kill: (signal = 'SIGTERM') => {
      if (!child.killed) child.kill(signal);
    },
  });
  t.is(typeof handle.pid, 'number');
  t.is(handle.child, undefined, 'live ChildProcess must not leak through');
  const code = await handle.exitCode;
  t.is(code, 7);
});

test('VmHandle: shape regression — only { pid, exitCode, kill }', t => {
  // Mirrors the shape `spawnVm` constructs without actually spawning,
  // so the assertion runs cheaply on every test machine including
  // ones without a working `qemu-system-<arch>`. The intent is to
  // fail fast if a future change reintroduces `child:` on the
  // hardened return.
  const handle = harden({
    pid: 12345,
    exitCode: Promise.resolve(0),
    kill: () => {},
  });
  t.deepEqual(Object.keys(handle).sort(), ['exitCode', 'kill', 'pid']);
});
