// bsky-handoff.test.mjs — SEC-16. The one-time OAuth-cap handoff must swap exactly once and expire, so the
// scoped cap never needs to ride the (proxy-loggable) 302 Location fragment. Injected clock → no real waits.
import '@endo/init'; // SES: makeBskyHandoffs hardens its export at load
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeBskyHandoffs } from './bsky-handoff.mjs';

test('SEC-16: a nonce swaps for the cap exactly ONCE (single-use)', () => {
  const h = makeBskyHandoffs({ ttlMs: 60_000 });
  const CAP = 'scoped-abc123deadbeef';
  const nonce = h.mint(CAP);
  assert.notEqual(nonce, CAP, 'the nonce is NOT the swissnum (that is the whole point)');
  assert.equal(h.redeem(nonce), CAP, 'first redemption yields the cap');
  assert.equal(h.redeem(nonce), null, 'a replayed nonce yields nothing — a logged nonce is dead once used');
  assert.equal(h.size(), 0, 'the entry is gone after redemption');
});

test('SEC-16: an expired nonce yields nothing (and is not returned even on first read)', () => {
  let t = 1_000_000;
  const h = makeBskyHandoffs({ ttlMs: 120_000, now: () => t });
  const nonce = h.mint('scoped-xyz');
  t += 120_001; // past the TTL
  assert.equal(h.redeem(nonce), null, 'a nonce past its TTL never yields the cap');
  assert.equal(h.size(), 0, 'and it is cleaned up on the (failed) read');
});

test('SEC-16: unknown / empty nonces are rejected', () => {
  const h = makeBskyHandoffs();
  assert.equal(h.redeem('never-minted'), null);
  assert.equal(h.redeem(''), null);
  assert.equal(h.redeem(undefined), null);
});

test('SEC-16: sweep drops expired entries but keeps live ones', () => {
  let t = 0;
  const h = makeBskyHandoffs({ ttlMs: 100, now: () => t });
  h.mint('a'); // exp 100
  t = 60;
  const live = h.mint('b'); // exp 160
  t = 120; // a expired, b still live
  h.sweep();
  assert.equal(h.size(), 1, 'only the expired entry was swept');
  assert.equal(h.redeem(live), 'b', 'the live nonce still redeems');
});

test('SEC-16: distinct mints get distinct nonces', () => {
  const h = makeBskyHandoffs();
  const a = h.mint('cap-1');
  const b = h.mint('cap-2');
  assert.notEqual(a, b, 'each mint is a fresh random nonce');
  assert.equal(h.redeem(a), 'cap-1');
  assert.equal(h.redeem(b), 'cap-2');
});
