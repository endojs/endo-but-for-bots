// chat-sync-version.test.mjs — ARCH-4 client-side unit proof for the cross-device chat-sync
// version vector. The server stamps a monotonic per-cap `seq`; the client adopts a remote bundle
// only when its seq is strictly HIGHER than the local one (replacing the old wall-clock LWW that
// let a skewed-clock device always win). Backward-compatible: with no server `seq`, fall back to
// the legacy `updated` gate. Mirrors the exact decision app.js wires into syncLoad/scheduleSync.
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAdoptRemote } from './public/chat-sync-version.mjs';

test('ARCH-4: adopt-when-higher on the server seq (not wall-clock)', () => {
  // a HIGHER remote seq is adopted even when our wall-clock is newer (skewed-clock device can't win)
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: 5, localSeq: 4, remoteUpdated: 0, localUpdated: 9e12 }),
    true,
    'remote.seq (5) > localSeq (4) → adopt, regardless of our newer wall-clock',
  );
  // an EQUAL seq is NOT adopted (we already hold this state)
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: 4, localSeq: 4 }),
    false,
    'remote.seq == localSeq → do not adopt',
  );
  // a LOWER seq (a stale device) is NOT adopted, even with a newer wall-clock
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: 3, localSeq: 4, remoteUpdated: 9e12, localUpdated: 0 }),
    false,
    'remote.seq (3) < localSeq (4) → do not adopt (stale device cannot clobber a higher-seq state)',
  );
});

test('ARCH-4: an empty remote bundle is never adopted', () => {
  assert.equal(shouldAdoptRemote({ hasChats: false, remoteSeq: 99, localSeq: 0 }), false);
});

test('ARCH-4: a fresh local client (localSeq 0) adopts any real server bundle (seq >= 1)', () => {
  assert.equal(shouldAdoptRemote({ hasChats: true, remoteSeq: 1, localSeq: 0 }), true);
});

test('ARCH-4: backward-compat — no server seq falls back to the legacy wall-clock gate', () => {
  // remoteSeq null/undefined ⇒ legacy server ⇒ adopt when remoteUpdated >= localUpdated
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: null, remoteUpdated: 200, localUpdated: 100 }),
    true,
    'legacy: newer remote wall-clock → adopt',
  );
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: undefined, remoteUpdated: 50, localUpdated: 100 }),
    false,
    'legacy: older remote wall-clock → do not adopt',
  );
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: null, remoteUpdated: 100, localUpdated: 100 }),
    true,
    'legacy: equal wall-clock → adopt (>= gate, preserved)',
  );
});

test('ARCH-4: seq 0 is a real (typeof number) version, not a legacy fallback', () => {
  // a server that returns seq 0 with chats (unusual, but explicit) must use the seq path, not wall-clock
  assert.equal(
    shouldAdoptRemote({ hasChats: true, remoteSeq: 0, localSeq: 0, remoteUpdated: 9e12, localUpdated: 0 }),
    false,
    'remote.seq 0 == localSeq 0 → do not adopt (0 is a number, so no wall-clock fallback)',
  );
});
