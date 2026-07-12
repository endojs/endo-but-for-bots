// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import { makeKnownSturdyRefsStore } from '../src/known-sturdyrefs-store.js';

// A daemon-shaped SHA-256 digester (crypto.makeSha256 surface).
const makeSha256 = () => {
  const digester = crypto.createHash('sha256');
  return {
    update: chunk => digester.update(chunk),
    updateText: chunk => digester.update(chunk),
    digestHex: () => digester.digest('hex'),
  };
};

// In-memory key/value state, re-openable to simulate a daemon restart.
const makeFakeState = () => {
  const map = new Map();
  return {
    getState: key => map.get(key),
    setState: (key, value) => map.set(key, value),
    map,
  };
};

const stateKey = 'known-sturdyrefs-store/0';

test('a foreign grant round-trips to its formula id (dedup)', t => {
  const { getState, setState } = makeFakeState();
  const store = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });

  const locationId = 'ocapn://peerC.tcp-testing-only';
  const swissNum = 'deadbeef';
  t.is(store.getSturdyRef(locationId, swissNum), undefined, 'miss before set');

  store.setSturdyRef(locationId, swissNum, 'formula-id-A:node');
  t.is(
    store.getSturdyRef(locationId, swissNum),
    'formula-id-A:node',
    'the same (location, swissNum) resolves to the recorded id',
  );
});

test('distinct swiss-nums at one peer are distinct grants', t => {
  const { getState, setState } = makeFakeState();
  const store = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  const locationId = 'ocapn://peerC.tcp-testing-only';

  store.setSturdyRef(locationId, 'one', 'id-1:node');
  store.setSturdyRef(locationId, 'two', 'id-2:node');
  t.is(store.getSturdyRef(locationId, 'one'), 'id-1:node');
  t.is(store.getSturdyRef(locationId, 'two'), 'id-2:node');
});

test('a raw-byte swiss-num dedups with itself and differs from a distinct byte secret', t => {
  const { getState, setState } = makeFakeState();
  const store = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  const locationId = 'ocapn://peerC.tcp-testing-only';

  // A Spritely-style 24-byte non-ASCII random secret (the case cut 1's
  // bytes-preserving read exists for): it must key consistently on its bytes.
  const random = new Uint8Array(24);
  for (let i = 0; i < 24; i += 1) random[i] = (i * 37 + 200) % 256;
  const other = new Uint8Array(24);
  for (let i = 0; i < 24; i += 1) other[i] = (i * 11 + 5) % 256;

  store.setSturdyRef(locationId, random, 'id-random:node');
  // A fresh Uint8Array with identical bytes dedups (keys on content, not identity).
  t.is(store.getSturdyRef(locationId, random.slice()), 'id-random:node');
  // A genuinely different byte secret is a different grant.
  t.is(store.getSturdyRef(locationId, other), undefined);
});

test('the peer keyspace is disjoint from the sturdyref keyspace', t => {
  const { getState, setState } = makeFakeState();
  const store = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  const locationId = 'ocapn://peerC.tcp-testing-only';

  store.setPeer(locationId, 'peer-id:node');
  store.setSturdyRef(locationId, 'sn', 'sr-id:node');
  t.is(store.getPeer(locationId), 'peer-id:node');
  t.is(store.getSturdyRef(locationId, 'sn'), 'sr-id:node');
});

test('entries survive a restart (re-open the same state)', t => {
  const { getState, setState } = makeFakeState();
  const first = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  first.setSturdyRef('ocapn://peerC.t', 'sn', 'sr-id:node');
  first.setPeer('ocapn://peerC.t', 'peer-id:node');

  // A fresh store over the same persisted state = the daemon after restart.
  const second = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  t.is(second.getSturdyRef('ocapn://peerC.t', 'sn'), 'sr-id:node');
  t.is(second.getPeer('ocapn://peerC.t'), 'peer-id:node');
});

test('forget removes every entry pointing at a formula id', t => {
  const { getState, setState } = makeFakeState();
  const store = makeKnownSturdyRefsStore({
    getState,
    setState,
    stateKey,
    makeSha256,
  });
  const locationId = 'ocapn://peerC.t';

  store.setPeer(locationId, 'peer-id:node');
  store.setSturdyRef(locationId, 'sn', 'sr-id:node');
  t.true(store.forget('sr-id:node'), 'removed the sturdyref entry');
  t.is(store.getSturdyRef(locationId, 'sn'), undefined);
  // The peer entry keyed on a different id survives.
  t.is(store.getPeer(locationId), 'peer-id:node');
  t.false(store.forget('nonexistent:node'), 'nothing to remove');
});
