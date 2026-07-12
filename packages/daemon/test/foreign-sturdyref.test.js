// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import { locationToLocationId } from '@endo/ocapn';
import { makeKnownSturdyRefsStore } from '../src/known-sturdyrefs-store.js';
import { makeForeignSturdyRefInternalizer } from '../src/foreign-sturdyref.js';

const makeSha256 = () => {
  const digester = crypto.createHash('sha256');
  return {
    update: chunk => digester.update(chunk),
    updateText: chunk => digester.update(chunk),
    digestHex: () => digester.digest('hex'),
  };
};

const selfLocation = harden({
  type: 'ocapn-peer',
  designator: 'self-designator',
  transport: 'ocapn-unarmed',
  hints: false,
});
const foreignLocation = harden({
  type: 'ocapn-peer',
  designator: 'peerC-designator',
  transport: 'tcp-testing-only',
  hints: false,
});

// A test rig: a fake swiss-num store, a real dedup index, and counting
// formulate helpers that hand back deterministic ids.
const makeRig = ({ revealDetails } = {}) => {
  const map = new Map();
  const store = {
    getBySwissNum: swissNum => map.get(`self:${swissNum}`),
    bindSelf: (swissNum, id) => map.set(`self:${swissNum}`, id),
  };
  const knownSturdyRefs = makeKnownSturdyRefsStore({
    getState: key => map.get(`kss:${key}`),
    setState: (key, value) => map.set(`kss:${key}`, value),
    stateKey: 'kss',
    makeSha256,
  });
  let peerSeq = 0;
  let srSeq = 0;
  const peerCalls = [];
  const srCalls = [];
  const internalize = makeForeignSturdyRefInternalizer({
    reveal: sturdyRef => revealDetails(sturdyRef),
    getSelfLocation: () => selfLocation,
    locationToLocationId,
    store,
    knownSturdyRefs,
    formulateOcapnPeer: async location => {
      peerCalls.push(location);
      peerSeq += 1;
      return `ocapn-peer-${peerSeq}:node`;
    },
    formulateOcapnSturdyRef: async (peerId, swissNum) => {
      srCalls.push({ peerId, swissNum });
      srSeq += 1;
      return `ocapn-sturdyref-${srSeq}:node`;
    },
  });
  return { internalize, store, knownSturdyRefs, peerCalls, srCalls };
};

test('a foreign SturdyRef internalizes to a fresh ocapn-sturdyref formula id', async t => {
  const ref = harden({});
  const { internalize, peerCalls, srCalls } = makeRig({
    revealDetails: () => ({ location: foreignLocation, secret: 'swiss-1' }),
  });
  const id = await internalize(ref);
  t.is(id, 'ocapn-sturdyref-1:node');
  t.is(peerCalls.length, 1, 'formulated one ocapn-peer');
  t.deepEqual(peerCalls[0], foreignLocation);
  t.is(srCalls.length, 1, 'formulated one ocapn-sturdyref');
  t.is(srCalls[0].peerId, 'ocapn-peer-1:node');
  t.is(srCalls[0].swissNum, 'swiss-1');
});

test('dedup: repeated internalizations of one (location, swissNum) converge on one id', async t => {
  // Two distinct SturdyRef objects that reveal the same foreign grant.
  const refA = harden({});
  const refB = harden({});
  const details = { location: foreignLocation, secret: 'swiss-1' };
  const { internalize, peerCalls, srCalls } = makeRig({
    revealDetails: () => details,
  });
  const idA = await internalize(refA);
  const idB = await internalize(refB);
  t.is(idA, idB, 'a stable identifier across repeated internalizations');
  t.is(peerCalls.length, 1, 'the ocapn-peer is deduped (formulated once)');
  t.is(srCalls.length, 1, 'the ocapn-sturdyref is deduped (formulated once)');
});

test('two swiss-nums at the same peer share one ocapn-peer but get distinct ocapn-sturdyrefs', async t => {
  const details = { location: foreignLocation, secret: 'swiss-1' };
  const { internalize, peerCalls, srCalls } = makeRig({
    revealDetails: () => details,
  });
  await internalize(harden({}));
  details.secret = 'swiss-2';
  const id2 = await internalize(harden({}));
  t.is(id2, 'ocapn-sturdyref-2:node');
  t.is(peerCalls.length, 1, 'one shared ocapn-peer (same-peer rule)');
  t.is(srCalls.length, 2, 'two distinct ocapn-sturdyrefs');
});

test('a self-minted SturdyRef arriving over the wire resolves through the swiss-num store', async t => {
  const { internalize, store } = makeRig({
    revealDetails: () => ({ location: selfLocation, secret: 'self-swiss' }),
  });
  store.bindSelf('self-swiss', 'local-formula:node');
  const id = await internalize(harden({}));
  t.is(id, 'local-formula:node', 'no dial: the store answers for a self-mint');
});

test('a self-location grant with no store row rejects secret-free', async t => {
  const { internalize } = makeRig({
    revealDetails: () => ({ location: selfLocation, secret: 'revoked-swiss' }),
  });
  await t.throwsAsync(() => internalize(harden({})), {
    message: /swiss-num store has no capability/,
  });
});

test('a forged look-alike (reveal returns undefined) yields undefined for the seam to reject', async t => {
  const { internalize, peerCalls, srCalls } = makeRig({
    revealDetails: () => undefined,
  });
  t.is(await internalize(harden({})), undefined);
  t.is(peerCalls.length, 0, 'nothing formulated for an unrevealable ref');
  t.is(srCalls.length, 0);
});

test('the rejection and the reveal details never name the swiss-num', async t => {
  // Confinement / secret-free discipline: an error surfaced by internalization
  // must not smear the swiss-num into a message that may ride up into logs.
  const { internalize } = makeRig({
    revealDetails: () => ({
      location: selfLocation,
      secret: 'super-secret-swiss',
    }),
  });
  const error = await t.throwsAsync(() => internalize(harden({})));
  t.false(
    String(error).includes('super-secret-swiss'),
    'the swiss-num is absent from the rejection',
  );
});
