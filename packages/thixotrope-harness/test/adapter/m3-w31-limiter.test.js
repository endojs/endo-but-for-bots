// @ts-check
// M3 W3.1: the failed sign-in limiter and the client address it keys on
// (designs/m3-interfaces.md 4.3; R6-76, R7-49, W-8), with a fake clock.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { m3TextOf, m3Texts } from '../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import { gatewayLimits } from '../../resources/agent-host/impl/gateway/contract-m3.js';
import {
  clientAddress,
  makeSignInLimiter,
} from '../../resources/agent-host/impl/gateway/limiter.js';

const makeClock = (start = 1_000_000) => {
  let t = start;
  return {
    now: () => t,
    /** @param {number} ms */
    advance: ms => {
      t += ms;
    },
  };
};

test('defaults are the contract limits', t => {
  t.is(gatewayLimits.signInPenaltyMs, 1000);
  t.is(gatewayLimits.signInForgetMs, 10_000);
  t.is(gatewayLimits.signInFailuresPerMinute, 20);
});

test('a failure delays the next attempt by the penalty (R7-49 text)', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  t.deepEqual(limiter.check('10.0.0.1'), { ok: true });
  limiter.failed('10.0.0.1');
  t.deepEqual(limiter.check('10.0.0.1'), {
    ok: false,
    text: m3TextOf.rateLimited(1000),
  });
  t.is(m3TextOf.rateLimited(1000), 'Rate limit exceeded, try in 1000ms');
  clock.advance(400);
  t.deepEqual(limiter.check('10.0.0.1'), {
    ok: false,
    text: 'Rate limit exceeded, try in 600ms',
  });
  // Another address is not delayed.
  t.deepEqual(limiter.check('10.0.0.2'), { ok: true });
  clock.advance(600);
  t.deepEqual(limiter.check('10.0.0.1'), { ok: true });
});

test('penalties are cumulative from max(now, previous deadline)', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  // Three comparisons admitted together (concurrent fetches) all fail.
  limiter.failed('a');
  limiter.failed('a');
  limiter.failed('a');
  t.deepEqual(limiter.check('a'), {
    ok: false,
    text: m3TextOf.rateLimited(3000),
  });
  clock.advance(3000);
  t.true(limiter.check('a').ok);
  // A failure after the deadline counts from now, not from the old deadline.
  clock.advance(5000);
  limiter.failed('a');
  t.deepEqual(limiter.check('a'), {
    ok: false,
    text: m3TextOf.rateLimited(1000),
  });
});

test('a refused attempt does not extend the penalty', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  limiter.failed('a');
  for (let i = 0; i < 5; i += 1) t.false(limiter.check('a').ok);
  clock.advance(1000);
  t.true(limiter.check('a').ok);
});

test('an entry is forgotten 10 s after its deadline', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  limiter.failed('a');
  t.is(limiter.size().addresses, 1);
  clock.advance(1000 + 9999);
  limiter.check('b');
  t.is(limiter.size().addresses, 1, 'kept until deadline + forgetMs');
  clock.advance(1);
  limiter.check('b');
  t.is(limiter.size().addresses, 0, 'forgotten');
  // Forgotten: the next failure starts from now.
  limiter.failed('a');
  t.deepEqual(limiter.check('a'), {
    ok: false,
    text: m3TextOf.rateLimited(1000),
  });
});

test('a success clears only the caller entry', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  limiter.failed('a');
  limiter.failed('b');
  limiter.succeeded('a');
  t.true(limiter.check('a').ok);
  t.false(limiter.check('b').ok);
});

test('the global ceiling: 21 failures in a minute from different addresses', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  for (let i = 0; i < 20; i += 1) {
    t.true(limiter.check(`10.0.1.${i}`).ok);
    limiter.failed(`10.0.1.${i}`);
    clock.advance(1000);
  }
  // 20 failures: not yet over the ceiling.
  t.true(limiter.check('10.0.2.1').ok);
  limiter.failed('10.0.2.1');
  // 21: every address is refused, a fresh one too.
  const refused = { ok: false, text: m3Texts.signInCeiling };
  t.deepEqual(limiter.check('10.0.9.9'), refused);
  t.is(
    m3Texts.signInCeiling,
    'Too many failed sign-ins; try again in a minute',
  );
  // Until the oldest failure (at t0) ages out of the 60 s window.
  clock.advance(60_000 - 20_000 - 1);
  t.deepEqual(limiter.check('10.0.9.9'), refused);
  clock.advance(1);
  t.true(limiter.check('10.0.9.9').ok);
  t.true(limiter.size().failures <= 21);
});

test('the ceiling is configurable (GatewayConfig.signInFailuresPerMinute)', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now, perMinute: 2 });
  limiter.failed('a');
  limiter.failed('b');
  t.true(limiter.check('c').ok);
  limiter.failed('c');
  t.false(limiter.check('d').ok);
});

test('retained state stays bounded under a long attack', t => {
  const clock = makeClock();
  const limiter = makeSignInLimiter({ now: clock.now });
  // One attempt per 100 ms from a new address each time, for ten minutes:
  // only admitted attempts fail, and the ceiling admits few.
  let admitted = 0;
  for (let i = 0; i < 6000; i += 1) {
    const address = `10.0.${Math.floor(i / 256)}.${i % 256}`;
    if (limiter.check(address).ok) {
      admitted += 1;
      limiter.failed(address);
    }
    clock.advance(100);
  }
  t.true(admitted <= 21 * 10 + 21, `admitted ${admitted}`);
  const { addresses, failures } = limiter.size();
  t.true(failures <= 21);
  t.true(addresses <= 21 + 11, `addresses ${addresses}`);
});

test('clientAddress: the peer, IPv4-mapped prefix removed', t => {
  t.is(clientAddress({ socketAddress: '::ffff:127.0.0.1' }), '127.0.0.1');
  t.is(clientAddress({ socketAddress: '::1' }), '::1');
  t.is(clientAddress({ socketAddress: undefined }), 'unknown');
});

test('clientAddress: an untrusted peer X-Forwarded-For is ignored', t => {
  t.is(
    clientAddress({
      socketAddress: '192.0.2.7',
      forwardedFor: '198.51.100.1',
      trustedProxies: ['127.0.0.1'],
    }),
    '192.0.2.7',
  );
  t.is(
    clientAddress({
      socketAddress: '::ffff:192.0.2.7',
      forwardedFor: '198.51.100.1',
    }),
    '192.0.2.7',
  );
});

test('clientAddress: through trusted proxies, the right-most untrusted entry', t => {
  const trustedProxies = ['127.0.0.1', '10.0.0.5'];
  t.is(
    clientAddress({
      socketAddress: '::ffff:127.0.0.1',
      forwardedFor: '203.0.113.9, 198.51.100.1, 10.0.0.5',
      trustedProxies,
    }),
    '198.51.100.1',
    'a client-written left entry cannot choose the key',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      forwardedFor: ['198.51.100.1', '10.0.0.5'],
      trustedProxies,
    }),
    '198.51.100.1',
    'repeated headers',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      forwardedFor: '10.0.0.5, 127.0.0.1',
      trustedProxies,
    }),
    '127.0.0.1',
    'all trusted: the peer',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      trustedProxies,
    }),
    '127.0.0.1',
    'no header: the peer',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      forwardedFor: 'not-an-address',
      trustedProxies,
    }),
    '127.0.0.1',
    'garbage: the peer',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      forwardedFor: '[2001:DB8::1]:4711, 198.51.100.2:8080',
      trustedProxies,
    }),
    '198.51.100.2',
    'ports stripped',
  );
  t.is(
    clientAddress({
      socketAddress: '127.0.0.1',
      forwardedFor: '[2001:DB8::1]:4711,',
      trustedProxies,
    }),
    '2001:db8::1',
    'IPv6 literal, lower case, empty entry skipped',
  );
});
