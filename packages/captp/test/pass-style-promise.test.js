// @ts-check

import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/marshal';
import { isPassStylePromise, passStyleOf } from '@endo/pass-style';
import { HandledPromise, makeSubscribableKit } from '@endo/eventual-send';

import { E, makeLoopback } from '../src/loopback.js';

test('outbound: pass-style carrier crosses CapTP as a "p" slot', async t => {
  const { makeFar } = makeLoopback('outbound');
  // The far side returns a pass-style carrier directly. CapTP must
  // recognize it as a 'p' slot on the way out and notify CTP_RESOLVE
  // when the producer settles.
  const { promise: carrier, settle } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => carrier,
  });
  const far = await makeFar(remote);
  // Settle BEFORE calling so CTP_RESOLVE flows once the answer arrives.
  settle('hello');
  // Default near-side mode chases the inbound HandledPromise to its
  // ground value through native await.
  const observed = await E(far).getCarrier();
  t.is(observed, 'hello');
});

test('inbound: pass-style mode produces a non-thenable carrier', async t => {
  // Opt in to the pass-style inbound mode on the near side.
  const { makeFar } = makeLoopback(
    'inbound-passStyle',
    /* nearOptions */ { usePassStylePromiseInbound: true },
  );
  const { promise: producerCarrier, settle } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => producerCarrier,
  });
  const far = await makeFar(remote);

  // The result of E(far).getCarrier() is the answer-promise (a
  // HandledPromise that fulfills when CTP_RETURN arrives). Settling
  // the producer carrier makes that answer fulfill with the inbound
  // pass-style carrier.
  settle('payload');
  const inboundCarrier = await E(far).getCarrier();
  // Inbound under pass-style mode is a non-thenable carrier.
  t.is(passStyleOf(inboundCarrier), 'promise');
  t.true(isPassStylePromise(inboundCarrier));
  t.is(/** @type {any} */ (inboundCarrier).then, undefined);
  // To observe its eventual settlement, the consumer must call settle
  // explicitly. At this point the producer already settled with
  // 'payload', so the bridge should have invoked
  // resolveExternalPassStylePromise on the inbound carrier.
  const observed = await HandledPromise.settle(inboundCarrier);
  t.is(observed, 'payload');
});

test('inbound: pass-style mode bridges late settlement', async t => {
  const { makeFar } = makeLoopback(
    'inbound-late',
    /* nearOptions */ { usePassStylePromiseInbound: true },
  );
  const { promise: producerCarrier, settle } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => producerCarrier,
  });
  const far = await makeFar(remote);

  // Send the carrier across before it has settled. To do that, settle
  // the answer promise to the carrier on the far side first.
  // `getCarrier()` returns the carrier synchronously; the answer
  // promise on the near side fulfills with the inbound carrier.
  // We can't easily await the inbound carrier identity without
  // settling something, so use E.when:
  let inboundCarrier;
  const carrierP = E(far).getCarrier();
  carrierP.then(c => {
    inboundCarrier = c;
  });
  // Allow CapTP to deliver the answer.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // Now settle the producer.
  settle('late-value');
  // The settle propagates through CTP_RESOLVE to the inbound carrier
  // via resolveExternalPassStylePromise.
  const observed = await HandledPromise.settle(await carrierP);
  t.is(observed, 'late-value');
  t.true(isPassStylePromise(/** @type {any} */ (inboundCarrier)));
});

test('inbound: pass-style mode propagates rejection', async t => {
  const { makeFar } = makeLoopback(
    'inbound-reject',
    /* nearOptions */ { usePassStylePromiseInbound: true },
  );
  const { promise: producerCarrier, reject } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => producerCarrier,
  });
  const far = await makeFar(remote);
  reject(new Error('producer-failed'));
  const inboundCarrier = await E(far).getCarrier();
  await t.throwsAsync(() => HandledPromise.settle(inboundCarrier), {
    message: 'producer-failed',
  });
});

test('default mode: native await synchronizes through inbound HandledPromise', async t => {
  // Default behavior: inbound 'p' slots are HandledPromises (thenable),
  // so `await E(far).getCarrier()` chases through the HandledPromise to
  // the eventual value 'classic'. (Compare with the
  // `usePassStylePromiseInbound: true` test, where the inbound carrier
  // is non-thenable and `await` resolves to the carrier itself.)
  const { makeFar } = makeLoopback('default-inbound');
  const { promise: producerCarrier, settle } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => producerCarrier,
  });
  const far = await makeFar(remote);
  settle('classic');
  // Default mode: native await chases through to the value.
  t.is(await E(far).getCarrier(), 'classic');
});

test('inbound: rejection with no local subscriber does not get swallowed', async t => {
  // Regression for the prior `promise.catch(() => {})` band-aid: a real
  // producer-side rejection flowing across CapTP must reach the standard
  // CapTP `onReject` diagnostic path even when the local consumer never
  // attaches a subscriber to the inbound carrier.
  /** @type {any[]} */
  const observedRejections = [];
  const { makeFar } = makeLoopback(
    'inbound-reject-no-subscriber',
    /* nearOptions */ {
      usePassStylePromiseInbound: true,
      onReject: reason => {
        observedRejections.push(reason);
      },
    },
  );
  const { promise: producerCarrier, reject } = makeSubscribableKit();
  const remote = Far('holder', {
    getCarrier: () => producerCarrier,
  });
  const far = await makeFar(remote);
  reject(new Error('no-subscriber'));
  // Receive the inbound carrier but DO NOT subscribe to it: that is the
  // hostile shape the band-aid hid.
  const inboundCarrier = await E(far).getCarrier();
  t.true(isPassStylePromise(inboundCarrier));
  // Allow the bridged settler to fire.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  // The producer-side rejection still surfaced to CapTP's onReject.
  t.true(observedRejections.length >= 1);
  t.is(
    /** @type {Error} */ (observedRejections[0]).message,
    'no-subscriber',
  );
});

test('round-trip: send carrier and receive it back', async t => {
  // The carrier minted on the near side, sent to the far side, and
  // sent back: the near side recognizes its own export.
  const { makeFar } = makeLoopback('round-trip');
  const remote = Far('echo', {
    echo: x => x,
  });
  const far = await makeFar(remote);

  const { promise: carrier, settle } = makeSubscribableKit();
  // Send and immediately receive.
  const echoedP = E(far).echo(carrier);
  settle('roundtrip-value');
  const echoed = await echoedP;
  // The carrier identity may or may not be preserved depending on the
  // CapTP table state; the important property is that the value
  // settles correctly.
  t.is(await HandledPromise.settle(echoed), 'roundtrip-value');
});
