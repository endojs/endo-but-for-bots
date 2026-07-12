// @ts-nocheck
/* global process */
import test from '@endo/ses-ava/prepare-endo.js';

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { passStyleOf } from '@endo/pass-style';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeOcapn, formatSturdyRefUri } from '@endo/ocapn';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { makeSturdyRefStore } from '../src/sturdyref-store.js';
import { makeOcapnIdentity, UNARMED_OCAPN_TRANSPORT } from '../src/ocapn.js';

// Whether this environment permits binding a localhost TCP listener; the
// armed cross-peer tests need a real `tcp-test-only` netlayer and skip when it
// does not (mirrors the OCapN package's own net-permission gate).
const netListenAllowed = (() => {
  const script = `
    const net = require('net');
    const server = net.createServer();
    server.once('error', () => process.exit(1));
    server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));
  `;
  return spawnSync(process.execPath, ['-e', script], { stdio: 'ignore' }).status === 0;
})();
const tcpTest = netListenAllowed ? test : test.skip;

// A `tcp-test-only` netlayer factory shaped for `makeOcapn`/`makeOcapnIdentity`
// (`(handlers, logger) => Promise<netlayer>`), capturing the netlayer so the
// test can read its dialable location.
const makeCapturingNetworkFactory = designator => {
  const ref = {};
  const factory = (handlers, logger) =>
    makeTcpNetLayer({ handlers, logger, specifiedDesignator: designator }).then(
      netlayer => {
        ref.netlayer = netlayer;
        return netlayer;
      },
    );
  return { factory, ref };
};

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

const makeIdentity = async (fixture, makeNetwork) =>
  makeOcapnIdentity({
    getState: fixture.state.getState,
    setState: fixture.state.setState,
    stateKey: 'ocapn/test',
    randomHex256,
    store: fixture.store,
    provide: fixture.provide,
    transport: fixture.transport,
    makeNetwork,
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
  t.is(passStyleOf(sturdyRef), 'sturdyRef');

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

// --- Cut 5: the client (dial+serve) surface -----------------------------

test('an unarmed identity cannot dial: enliven and provideSession reject secret-free', async t => {
  const identity = await makeIdentity(makeFixture());
  t.false(identity.isArmed, 'no netlayer armed');
  await t.throwsAsync(() => identity.enliven(identity.getSelfLocation(), 'sw'), {
    message: /no netlayer armed/,
  });
  await t.throwsAsync(() => identity.provideSession(identity.getSelfLocation()), {
    message: /no netlayer armed/,
  });
});

test('formatUri emits a parseable ocapn:// sturdyref URI for a self-mint (out-of-band export)', async t => {
  const fixture = makeFixture({ transport: 'tcp-testing-only' });
  const identity = await makeIdentity(fixture);
  const { sturdyRef } = await identity.exporter.mintGrant('0:node-a');

  const uri = identity.formatUri(sturdyRef);
  t.true(uri.startsWith('ocapn://'), 'an ocapn:// URI');
  t.true(uri.includes('/s/'), 'carries a non-empty swiss-num path segment');
  // The daemon can re-accept its own exported URI (materialize + reveal), and
  // the recovered swiss-num bytes ASCII-decode back to the hex string the
  // exporter's locator keys on — so a peer could fetch it.
  const materialized = identity.materializeFromUri(uri);
  t.is(passStyleOf(materialized), 'sturdyref');
  const recovered = identity.reveal(materialized);
  t.deepEqual(recovered.location, identity.getSelfLocation());
  // reveal normalizes a materialized secret to a Uint8Array; it ASCII-decodes
  // back to the hex swiss-num string the exporter's locator keys on.
  const asString = new TextDecoder('ascii').decode(recovered.secret);
  t.is(asString, identity.reveal(sturdyRef).secret, 'ASCII-decodes to the hex swiss-num');
});

test('materializeFromUri round-trips a foreign byte-secret sturdyref URI (the accept path)', async t => {
  const fixture = makeFixture({ transport: 'tcp-testing-only' });
  const identity = await makeIdentity(fixture);

  const foreignLocation = harden({
    type: 'ocapn-peer',
    designator: 'peerc-designator',
    transport: 'tcp-testing-only',
    hints: false,
  });
  // A Spritely-style 24-byte non-ASCII random secret (cut 1's byte case).
  const secret = new Uint8Array(24);
  for (let i = 0; i < 24; i += 1) secret[i] = (i * 37 + 200) % 256;
  const uri = formatSturdyRefUri({ location: foreignLocation, swissNum: secret });

  const materialized = identity.materializeFromUri(uri);
  t.is(passStyleOf(materialized), 'sturdyref');
  const recovered = identity.reveal(materialized);
  t.deepEqual(recovered.location, foreignLocation, 'the foreign location round-trips');
  // reveal normalizes the materialized secret to a Uint8Array of the exact bytes.
  t.deepEqual(
    new Uint8Array(recovered.secret),
    secret,
    'the byte swiss-num round-trips verbatim',
  );
});

test('materializeFromUri rejects a plain peer URI (no swiss-num)', async t => {
  const fixture = makeFixture({ transport: 'tcp-testing-only' });
  const identity = await makeIdentity(fixture);
  const peerUri = formatSturdyRefUri({ location: identity.getSelfLocation() });
  t.throws(() => identity.materializeFromUri(peerUri), {
    message: /not a sturdyref URI/,
  });
});

tcpTest(
  'armed cross-peer enliven: daemon-as-B dials a foreign peer and fetches over tcp-test-only',
  async t => {
    // The foreign peer C: a plain OCapN client serving one exported value by
    // swiss-num over a real tcp-test-only netlayer.
    const exported = Far('Exported', { ping: () => 'pong' });
    const tableC = new Map([['swiss-C', exported]]);
    const netC = makeCapturingNetworkFactory('C');
    const clientC = await makeOcapn({
      codec: syrupCodec,
      locator: tableC,
      debugLabel: 'C',
      network: netC.factory,
    });
    const locationC = netC.ref.netlayer.location;

    // Daemon-as-B: an ARMED OCapN identity.
    const fixtureB = makeFixture({ transport: 'tcp-testing-only' });
    const netB = makeCapturingNetworkFactory('B');
    const identityB = await makeIdentity(fixtureB, netB.factory);
    t.true(identityB.isArmed, 'B has a netlayer armed');

    try {
      // B dials C directly and fetches the exported value — exactly the path
      // an `ocapn-sturdyref` formula's value drives (cross-peer enliven only
      // via the mediator; B makes the connection, not a guest).
      const value = await identityB.enliven(locationC, 'swiss-C');
      t.false(passStyleOf(value) === 'sturdyref', 'enliven yields a presence');
      t.is(await E(value).ping(), 'pong', 'the fetched value works');

      // A session to C is now live and reusable.
      const session = await identityB.provideSession(locationC);
      t.truthy(session, 'provideSession returns a session');

      // A failed fetch (a swiss-num C never minted / a revoked grant) rejects
      // WITHOUT naming the secret.
      const error = await t.throwsAsync(() =>
        identityB.enliven(locationC, 'super-secret-missing'),
      );
      t.false(
        String(error).includes('super-secret-missing'),
        'the rejection never names the swiss-num',
      );
    } finally {
      clientC.shutdown();
    }
  },
);
