// toll-ownership.test.mjs — SEC-10 residual: the toll account→owner binding survives a restart.
//
// Before: the binding was an in-memory Map, so after a restart a DIFFERENT cap could re-TOFU and claim an
// existing account. Now it's persisted (writeJsonAtomic); a reload refuses the foreign owner just as the live
// map did.
//
//   node --test packages/chat/voice-agent/toll-ownership.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeTollOwnership } from './toll-ownership.mjs';

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toll-own-'));
  return { file: path.join(dir, 'toll-ownership.json'), dir };
};

test('first non-root cap owns the account; a different cap is refused (in one process)', () => {
  const { file, dir } = mk();
  const store = makeTollOwnership({ file });
  assert.deepEqual(store.claim('acctA', 'ownerX'), { ok: true }, 'first touch binds (TOFU)');
  assert.deepEqual(store.claim('acctA', 'ownerX'), { ok: true }, 'the owner may touch its own account again');
  assert.deepEqual(store.claim('acctA', 'ownerY'), { ok: false, foreign: true }, 'a DIFFERENT cap is refused');
  assert.equal(store.ownerOf('acctA'), 'ownerX');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ownership SURVIVES a restart: a different cap is still refused after reload', () => {
  const { file, dir } = mk();

  // ── process 1: owner X binds acctA ──
  const before = makeTollOwnership({ file });
  assert.deepEqual(before.claim('acctA', 'ownerX'), { ok: true });
  assert.ok(fs.existsSync(file), 'the binding was persisted to disk');

  // ── simulate a restart: a fresh store reloads the persisted binding ──
  const after = makeTollOwnership({ file });
  assert.equal(after.ownerOf('acctA'), 'ownerX', 'the binding reloaded from disk');
  assert.deepEqual(after.claim('acctA', 'ownerY'), { ok: false, foreign: true }, 'a DIFFERENT cap is STILL refused post-restart (was the bug: it re-TOFUd)');
  assert.deepEqual(after.claim('acctA', 'ownerX'), { ok: true }, 'the original owner still holds it');

  // an account nobody bound yet is free to first-use post-restart
  assert.deepEqual(after.claim('acctB', 'ownerZ'), { ok: true });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the store persists only HASHES/owner-keys — never a swissnum shape', () => {
  const { file, dir } = mk();
  const store = makeTollOwnership({ file });
  store.claim('acct-hash-abc', 'u:deadbeef');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!/swiss|secret|token|#cap/i.test(raw), 'no bearer-secret shape on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});
