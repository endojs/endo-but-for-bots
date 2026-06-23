// @ts-nocheck
/**
 * The `objects`-power dial path: dialIrohObject() against a LOCAL stand-in
 * iroh service. Proves the Kumavis fix end-to-end — a held endo-iroh ref is
 * now CALLABLE: we dial BY EndpointId (no host:port), fetch the object by its
 * swissnum (locator key) over the iroh CapTP session, and invoke a method.
 *
 * The stand-in is a real ocapn-noise service over the iroh transport (the
 * service side of captp-over-iroh). It vends a Greeter under a swissnum and
 * advertises an `iroh://<id>?addr=<udp>&key=<noiseKeyId>` address — exactly
 * the form parseIrohAddress() consumes from a stored accepted-object record.
 *
 * node:test (not ses-ava): the iroh NAPI addon is outside the SES sandbox.
 *
 * Run:  node --test test/iroh-dialer.test.js   (from packages/ocapn-noise)
 */
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Far } from '@endo/marshal';

import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from '../index.js';
import { makeIrohTransport } from '../src/transports/iroh.js';
import { dialIrohObject, parseIrohAddress } from '../src/iroh-dialer.js';

test('parseIrohAddress extracts id, addr and key', t => {
  assert.deepEqual(parseIrohAddress('iroh://abc123'), {
    id: 'abc123',
    addr: undefined,
    key: undefined,
  });
  assert.deepEqual(
    parseIrohAddress('iroh://abc123?addr=1.2.3.4:55&key=deadbeef'),
    { id: 'abc123', addr: '1.2.3.4:55', key: 'deadbeef' },
  );
  assert.deepEqual(parseIrohAddress('not-an-iroh-link'), {
    id: '',
    addr: undefined,
    key: undefined,
  });
});

test('dialIrohObject calls a method on a stand-in iroh service by EndpointId + swissnum', async t => {
  // --- Stand-in service: a real ocapn-noise peer over iroh vending a cap. ---
  // The locator key is the "swissnum" the objects power fetches by.
  const SWISSNUM = 'greeter-swissnum-0001';

  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keyId = network.addSigningKeys(network.generateSigningKeys());
  const transport = await makeIrohTransport({
    alpn: 'field/captp/0',
    preset: 'minimal',
  });
  await network.addTransport(transport);
  t.after(() => transport.shutdown());

  const locator = new Map();
  locator.set(
    SWISSNUM,
    Far('Greeter', {
      hello: (who = 'world') => `hello, ${who}`,
      describe: () => ['hello', 'describe'],
    }),
  );
  const service = await makeOcapn({
    codec: cborCodec,
    network: /** @type {any} */ (network),
    debugLabel: 'service',
    locator,
    debugMode: true,
  });
  t.after(() => service.shutdown());

  // Build the stored address from the service's own location: its iroh
  // hints + its ocapn-noise designator (the `key=`). This is exactly what a
  // real iroh invite link would carry before `#cap=<swissnum>`.
  const location = network.locationFor(keyId);
  const irohId = location.hints['iroh:id'];
  const irohAddr = location.hints['iroh:addr'];
  assert.ok(irohId, 'service location must carry an iroh:id');
  assert.equal(location.hints['tcp:port'], undefined, 'no tcp port in location');
  const address = `iroh://${irohId}?addr=${irohAddr}&key=${location.designator}`;

  // --- The objects-power dial. This is what callObject() now runs. ---
  const r1 = await dialIrohObject({
    address,
    swissnum: SWISSNUM,
    method: 'hello',
    args: ['Kumavis'],
  });
  assert.deepEqual(r1, { ok: true, value: 'hello, Kumavis' });

  const r2 = await dialIrohObject({
    address,
    swissnum: SWISSNUM,
    method: 'describe',
    args: [],
  });
  assert.deepEqual(r2, { ok: true, value: ['hello', 'describe'] });

  // A bad address fails legibly, not by crashing.
  const r3 = await dialIrohObject({
    address: 'not-an-iroh-link',
    swissnum: SWISSNUM,
    method: 'hello',
  });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /not a dialable iroh address/);
});
