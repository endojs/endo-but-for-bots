// @ts-nocheck
/**
 * Iroh transport regression gate (node:test, NOT ava/ses-ava).
 *
 * Why node:test and not the package's ava/ses-ava harness: the
 * `@number0/iroh` binding is a native NAPI addon that runs in the
 * privileged Node realm OUTSIDE the SES sandbox (IROH-V1-DESIGN.md §4).
 * It binds fine under `@endo/init` lockdown (verified), but ava's
 * worker-per-file SES harness adds nothing here and the addon's own
 * async accept loop is easier to reason about under a plain runner.
 * `@endo/init` is still imported first so the transport's `harden()`
 * calls and the @endo/stream/netstring framing run exactly as in
 * production.
 *
 * Proves, dialing BY EndpointId (no host:port):
 *   1. raw bytes round-trip both ways over an Iroh QUIC bidi stream;
 *   2. a netstring-framed CapTP-style message round-trips (one
 *      writer.next == one reader.next, the contract CapTP assumes);
 *   3. a SINGLE 200 000-byte frame survives — > 3x the 65519-byte Noise
 *      message ceiling — empirically dissolving that ceiling on QUIC;
 *   4. a persisted 32-byte seed yields a STABLE EndpointId (cap-link
 *      stability across restarts).
 *
 * Run:  node --test test/iroh-transport.test.js
 *   (from packages/ocapn-noise so @endo/* + @number0/iroh resolve.)
 */
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SecretKey } from '@number0/iroh';
import { makeIrohTransport } from '../src/transports/iroh.js';

const te = new TextEncoder();
const td = new TextDecoder();

/** Read exactly one whole (framed) message off a reader. */
const oneFrame = async reader => {
  const { value, done } = await reader.next();
  assert.ok(!done, 'stream ended before a frame arrived');
  return value;
};

test('iroh transport: dial-by-EndpointId round-trips raw + framed bytes, dissolves the Noise ceiling', async t => {
  // --- Persisted seed => STABLE EndpointId (cap-link stability). ---
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
  const expectedId = SecretKey.fromBytes(Array.from(seed)).public().toString();

  // Server B: the "service". Two listeners on stable identities — one raw,
  // one framed — to keep the proofs cleanly separated.
  const serverRaw = await makeIrohTransport({
    secretKey: seed,
    alpn: 'field/raw/0',
    preset: 'minimal',
    framing: 'none',
  });
  const serverFramed = await makeIrohTransport({
    secretKey: seed,
    alpn: 'field/captp/0',
    preset: 'minimal',
    framing: 'netstring',
  });
  t.after(() => serverRaw.shutdown());
  t.after(() => serverFramed.shutdown());

  // PROOF 4: stable EndpointId from the persisted seed.
  assert.equal(
    serverRaw.endpointId,
    expectedId,
    'EndpointId must derive deterministically from the persisted seed',
  );

  let sawRaw;
  const rawSeen = new Promise(r => {
    sawRaw = r;
  });
  let sawBig;
  const bigSeen = new Promise(r => {
    sawBig = r;
  });

  const rawListener = await serverRaw.listen(async stream => {
    const { value } = await stream.reader.next();
    const got = td.decode(value);
    await stream.writer.next(te.encode(got.toUpperCase()));
    await stream.writer.return();
    sawRaw(got);
  });
  t.after(() => rawListener.close());

  const BIG = 200_000; // > 3x the 65519-byte Noise ceiling
  const framedListener = await serverFramed.listen(async stream => {
    const m1 = await oneFrame(stream.reader);
    await stream.writer.next(te.encode(`ACK:${td.decode(m1)}`));
    const m2 = await oneFrame(stream.reader);
    await stream.writer.next(
      te.encode(`GOT ${m2.length} first=${m2[0]} last=${m2[m2.length - 1]}`),
    );
    sawBig(m2.length);
  });
  t.after(() => framedListener.close());

  // The listener hints carry id + addr (StaticProvider), NEVER host:port.
  assert.ok(rawListener.hints.id, 'listener must advertise an EndpointId');
  assert.equal(
    rawListener.hints.host,
    undefined,
    'an iroh listener must NOT advertise a tcp host',
  );
  assert.equal(
    rawListener.hints.port,
    undefined,
    'an iroh listener must NOT advertise a tcp port',
  );

  // Dialer A: knows ONLY B's EndpointId (+ a direct addr hint for the
  // offline 'minimal' preset). On a real LAN with discovery the addr hint
  // is unnecessary; here it stands in for StaticProvider addressing.
  const dialerRaw = await makeIrohTransport({
    alpn: 'field/raw/0',
    preset: 'minimal',
    framing: 'none',
  });
  const dialerFramed = await makeIrohTransport({
    alpn: 'field/captp/0',
    preset: 'minimal',
    framing: 'netstring',
  });
  t.after(() => dialerRaw.shutdown());
  t.after(() => dialerFramed.shutdown());

  // PROOF 1: raw bytes both ways, dialed by key.
  const rawStream = await dialerRaw.connect({
    id: rawListener.hints.id, // <-- a pubkey, not an IP
    addr: rawListener.hints.addr,
  });
  await rawStream.writer.next(te.encode('hello over iroh'));
  await rawStream.writer.return();
  const echoed = td.decode((await rawStream.reader.next()).value);
  assert.equal(echoed, 'HELLO OVER IROH', 'raw echo must round-trip');
  assert.equal(await rawSeen, 'hello over iroh');

  // PROOF 2: a netstring-framed CapTP-style message round-trips.
  const capStream = await dialerFramed.connect({
    id: framedListener.hints.id,
    addr: framedListener.hints.addr,
  });
  await capStream.writer.next(te.encode('captp-op:fetch swissnum'));
  const ack = td.decode(await oneFrame(capStream.reader));
  assert.equal(ack, 'ACK:captp-op:fetch swissnum', 'framed msg must round-trip');

  // PROOF 3: ONE frame > the 65519-byte Noise ceiling survives.
  const big = new Uint8Array(BIG);
  for (let i = 0; i < BIG; i += 1) big[i] = (i * 31 + 7) & 0xff;
  await capStream.writer.next(big);
  const summary = td.decode(await oneFrame(capStream.reader));
  assert.equal(
    summary,
    `GOT ${BIG} first=${big[0]} last=${big[BIG - 1]}`,
    'a single 200KB frame must survive (Noise ceiling dissolved by QUIC)',
  );
  assert.equal(await bigSeen, BIG, 'server must receive the whole big frame');
});
