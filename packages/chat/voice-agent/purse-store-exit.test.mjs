// purse-store-exit.test.mjs — INT-5 residual: a debited-but-unflushed purse is persisted on a process exit.
//
// The debounce (default 250ms) means a set() can sit unwritten in memory. SIGTERM/SIGINT already flush
// (server.mjs), but a plain process.exit() (a FATAL path / uncaughtException handler) used to drop that window.
// We now flush on 'exit' + 'beforeExit'. This test spawns a CHILD that debits then immediately process.exit(0)
// WITHOUT calling flushNow — and asserts the balance reached disk via the exit hook, not the (never-fired) timer.
//
//   node --test packages/chat/voice-agent/purse-store-exit.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { makePurseStore, hashKey } from './purse-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("process.exit() flushes a debited-but-unflushed purse (exit hook, not the debounce timer)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purse-exit-'));
  const file = path.join(dir, 'purses.json');
  // Child: create a store with a LONG debounce (so the timer can't be what wrote the file), set a balance,
  // then exit immediately WITHOUT flushNow(). Only the 'exit' hook can have persisted it.
  const child = `
    import '@endo/init';
    import { makePurseStore } from './purse-store.mjs';
    const store = makePurseStore({ file: ${JSON.stringify(file)}, debounceMs: 60000 });
    store.set('cap:sid', 4200, 5000);
    process.exit(0); // no flushNow — the exit hook must catch the pending debit
  `;
  // The child lives INSIDE the package dir so '@endo/init' resolves via the package node_modules.
  const script = path.join(HERE, `.purse-exit-child-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(script, child);
  try { execFileSync('node', [script], { stdio: 'ignore', cwd: HERE }); }
  finally { try { fs.rmSync(script, { force: true }); } catch { /* */ } }

  assert.ok(fs.existsSync(file), 'the purse file was written on exit despite a 60s debounce + no flushNow');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rec = data[hashKey('cap:sid')];
  assert.ok(rec, 'the debited purse is present on disk (keyed by the hashed cap:sid)');
  assert.equal(rec.balance, 4200, 'the balance persisted');
  assert.equal(rec.granted, 5000, 'the grant persisted');

  // sanity: a fresh store reloads the persisted balance (durable across the simulated restart)
  const reopened = makePurseStore({ file, registerExitFlush: false });
  assert.deepEqual(reopened.get('cap:sid'), { balance: 4200, granted: 5000 });

  fs.rmSync(dir, { recursive: true, force: true });
});
