// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import { passStyleOf } from '@endo/pass-style';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { syrupCodec } from '@endo/ocapn/syrup';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { makeSturdyRefStore } from '../src/sturdyref-store.js';
import { makeOcapnIdentity, UNARMED_OCAPN_TRANSPORT } from '../src/ocapn.js';

// A daemon-shaped SHA-256 digester and a fresh-256-bit source, matching the
// daemon's cryptoPowers surface (makeSha256 / randomHex256).
const makeSha256 = () => {
  const digester = crypto.createHash('sha256');
  return {
    update: chunk => digester.update(chunk),
    updateText: chunk => digester.update(chunk),
    digestHex: () => digester.digest('hex'),
  };
};
const randomHex256 = async () => crypto.randomBytes(32).toString('hex');

// An in-memory stand-in for the daemon's key/value state (getState/setState),
// so the same instance can be re-opened to simulate a restart.
const makeFakeState = () => {
  const map = new Map();
  return {
    getState: key => map.get(key),
    setState: (key, value) => map.set(key, value),
    map,
  };
};

// The base32 designator encoding, replicated here from the identity (and the
// websocket netlayer) so the test independently derives the expected
// designator from the public key rather than trusting the module's own output.
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const base32Encode = bytes => {
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    value = value * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      const divisor = 2 ** (bits - 5);
      const index = Math.floor(value / divisor);
      output += BASE32_ALPHABET[index];
      value -= index * divisor;
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[value * 2 ** (5 - bits)];
  }
  return output;
};
const bytesFromHex = hex => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const designatorForPrivateKeyHex = privateKeyHex => {
  const cryptography = makeCryptography(syrupCodec);
  const keyPair = cryptography.makeOcapnKeyPairFromPrivateKey(
    bytesFromHex(privateKeyHex),
  );
  return base32Encode(bytesFromImmutable(keyPair.publicKey.bytes));
};

const makeFixture = ({ state = makeFakeState(), transport } = {}) => {
  const store = makeSturdyRefStore({
    getState: state.getState,
    setState: state.setState,
    stateKey: 'sturdyref-store/test',
    makeSha256,
  });
  const values = new Map([
    ['0:node-a', harden({ label: 'alpha' })],
    ['1:node-a', harden({ label: 'beta' })],
  ]);
  const provide = async id => values.get(id);
  return { state, store, values, provide, transport };
};

const makeIdentity = async fixture =>
  makeOcapnIdentity({
    getState: fixture.state.getState,
    setState: fixture.state.setState,
    stateKey: 'ocapn/test',
    randomHex256,
    store: fixture.store,
    provide: fixture.provide,
    transport: fixture.transport,
  });

test('self-location round-trips a keypair-derived designator and the transport', async t => {
  const fixture = makeFixture({ transport: 'tcp-testing-only' });
  const identity = await makeIdentity(fixture);

  const selfLocation = identity.getSelfLocation();
  t.is(selfLocation.type, 'ocapn-peer');
  t.is(selfLocation.transport, 'tcp-testing-only', 'the configured transport');
  t.is(selfLocation.hints, false);

  // The designator IS the daemon's OCapN public key, base32-encoded: derive it
  // independently from the persisted private key and compare.
  const { privateKeyHex } = JSON.parse(fixture.state.getState('ocapn/test'));
  t.is(selfLocation.designator, designatorForPrivateKeyHex(privateKeyHex));
  t.true(/^[a-z2-7]+$/.test(selfLocation.designator), 'lowercase base32');
});

test('the transport defaults to the unarmed marker (no live netlayer)', async t => {
  const identity = await makeIdentity(makeFixture());
  t.is(identity.getSelfLocation().transport, UNARMED_OCAPN_TRANSPORT);
  t.not(
    UNARMED_OCAPN_TRANSPORT,
    'tcp-testing-only',
    'the unarmed marker is distinct from any real netlayer transport',
  );
});

test('a self-minted SturdyRef reveals the real self-location and enlivens locally', async t => {
  const fixture = makeFixture({ transport: 'tcp-testing-only' });
  const identity = await makeIdentity(fixture);
  const selfLocation = identity.getSelfLocation();

  const { sturdyRef } = await identity.exporter.mintGrant('0:node-a');
  t.is(passStyleOf(sturdyRef), 'sturdyref');

  // The mint stamps the real self-location (not cut 3's placeholder).
  const details = identity.exporter.reveal(sturdyRef);
  t.deepEqual(details.location, selfLocation);

  // A self-minted SturdyRef enlivens locally through the store-backed locator.
  const enlivened = await identity.exporter.enlivenSelf(sturdyRef);
  t.is(enlivened, fixture.values.get('0:node-a'));
  // ...which is exactly the serve path a peer's bootstrap.fetch would drive.
  const served = await identity.exporter.locator.get(details.secret);
  t.is(served, fixture.values.get('0:node-a'));
});

test('the identity is persistent: a restart recovers the same designator', async t => {
  const state = makeFakeState();
  const first = await makeIdentity(makeFixture({ state }));
  const firstDesignator = first.getSelfLocation().designator;

  // Re-open against the same persisted state (a daemon restart): same key, so
  // a sturdy reference minted against this identity still resolves.
  const second = await makeIdentity(makeFixture({ state }));
  t.is(second.getSelfLocation().designator, firstDesignator);
});

test('the identity is distinct-by-default: independent daemons differ', async t => {
  const a = await makeIdentity(makeFixture());
  const b = await makeIdentity(makeFixture());
  t.not(
    a.getSelfLocation().designator,
    b.getSelfLocation().designator,
    'a fresh keypair per daemon, never a shared or node-key-derived designator',
  );
});
