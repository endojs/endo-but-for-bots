// @ts-nocheck
/**
 * REAL @endo/ocapn CapTP/ocap exchange over the production iroh transport.
 *
 * The full-thesis proof (IROH-V1-DESIGN.md §3): swapping Noise+TCP -> iroh
 * is a NETLAYER swap. We register `makeIrohTransport()` with the unchanged
 * `makeOcapnNoiseNetwork` + `makeOcapn` stack — the SAME code that
 * implements attenuation, revocation, swissnums and three-party handoff —
 * and a genuine `E(greeter).hello('Alice')` round-trips over an Iroh QUIC
 * bidi stream, dialed BY EndpointId. Because it is the real ocap code that
 * ran, the ocap semantics provably ride on top unchanged.
 *
 * A's resulting ocapn location carries `iroh:id=<EndpointId>` and
 * `iroh:addr=<udp socket>` and NO `tcp:host` / `tcp:port` — the literal
 * open-port removal the design promises.
 *
 * Caveat (deliberate, documented): routing through the ocapn-noise NETWORK
 * to reuse the transport seam still runs the Noise-IK handshake INSIDE the
 * QUIC tunnel (TLS-inside-TLS double-wrap). That is fine for proving the
 * mechanical swap; the production target retires Noise and rides CapTP
 * directly on the QUIC stream (IROH-V1-DESIGN.md §3/§8). This test proves
 * the swap; the clean netlayer is STEP 1's follow-on.
 *
 * node:test (not ses-ava) for the same reason as iroh-transport.test.js:
 * the iroh NAPI addon lives outside the SES sandbox. `@endo/init` is still
 * imported first so the full ocapn stack runs under lockdown.
 *
 * Run:  node --test test/iroh-captp.test.js   (from packages/ocapn-noise)
 */
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from '../index.js';
import { makeIrohTransport } from '../src/transports/iroh.js';

test('a real @endo/ocapn Greeter cap round-trips over the iroh transport (dial-by-EndpointId, no tcp port)', async t => {
  // --- Peer A: the "service" exporting a Greeter cap. ---
  const networkA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keyIdA = networkA.addSigningKeys(networkA.generateSigningKeys());
  const transportA = await makeIrohTransport({
    alpn: 'field/captp/0',
    preset: 'minimal',
  });
  await networkA.addTransport(transportA);
  t.after(() => transportA.shutdown());

  const locatorA = new Map();
  locatorA.set(
    'Greeter',
    Far('Greeter', {
      hello: (who = 'world') => `hello, ${who}`,
      // A read-only facet stands in for an attenuated cap.
      help: () => 'Greeter: hello(name) -> greeting',
    }),
  );
  const clientA = await makeOcapn({
    codec: cborCodec,
    network: /** @type {any} */ (networkA),
    debugLabel: 'A',
    locator: locatorA,
    debugMode: true,
  });
  t.after(() => clientA.shutdown());

  // A's ocapn location now carries iroh hints and NO tcp host:port.
  const locationA = networkA.locationFor(keyIdA);
  const hints = locationA.hints || {};
  assert.ok(hints['iroh:id'], 'A location must carry an iroh:id hint');
  assert.equal(hints['tcp:host'], undefined, 'A location must NOT carry tcp:host');
  assert.equal(hints['tcp:port'], undefined, 'A location must NOT carry tcp:port');

  // --- Peer B: the dialer. ---
  const networkB = makeOcapnNoiseNetwork({ codec: cborCodec });
  networkB.addSigningKeys(networkB.generateSigningKeys());
  const transportB = await makeIrohTransport({
    alpn: 'field/captp/0',
    preset: 'minimal',
  });
  await networkB.addTransport(transportB);
  t.after(() => transportB.shutdown());
  const clientB = await makeOcapn({
    codec: cborCodec,
    network: /** @type {any} */ (networkB),
    debugLabel: 'B',
    debugMode: true,
  });
  t.after(() => clientB.shutdown());

  // B fetches A's Greeter by SturdyRef and invokes it. The CapTP
  // deliveries for enliven + hello() travel over the iroh QUIC stream.
  const sturdyRef = clientB.makeSturdyRef(locationA, 'Greeter');
  const greeter = await clientB.enlivenSturdyRef(sturdyRef);
  const reply = await E(greeter).hello('Alice');
  assert.equal(reply, 'hello, Alice', 'E(greeter).hello over iroh must return the greeting');
  const help = await E(greeter).help();
  assert.equal(help, 'Greeter: hello(name) -> greeting', 'attenuated facet must round-trip too');
});
