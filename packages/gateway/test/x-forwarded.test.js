// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  X_FORWARDED_FOR_HEADER,
  X_FORWARDED_PROTO_HEADER,
  X_FORWARDED_HOST_HEADER,
  NO_TRUSTED_PROXY_WARNING_PREAMBLE,
  renderNoTrustedProxyWarning,
  isLoopbackBindAddress,
  parseCidr,
  matchTrustedProxy,
  parseForwardedRequest,
} from '../index.js';

// -- header constants ---------------------------------------------

test('header constants are lowercase per the design', t => {
  // Regression: the parser matches headers case-insensitively but
  // the exported constants are the canonical names embedders use
  // to populate the request. The design names the headers in
  // camel-case prose; the wire form is lowercase per RFC 7230 §
  // 3.2. If any of these drifts to mixed case, downstream code
  // that compares with `===` against the constant fails silently.
  t.is(X_FORWARDED_FOR_HEADER, 'x-forwarded-for');
  t.is(X_FORWARDED_PROTO_HEADER, 'x-forwarded-proto');
  t.is(X_FORWARDED_HOST_HEADER, 'x-forwarded-host');
});

test('NO_TRUSTED_PROXY_WARNING_PREAMBLE matches the design wording', t => {
  // The design (`designs/gateway-package.md` § Feature 9) pins the
  // `[Gateway]` preamble so an operator who greps the docs finds
  // the same string the gateway prints.
  t.is(NO_TRUSTED_PROXY_WARNING_PREAMBLE, '[Gateway]');
});

test('renderNoTrustedProxyWarning includes the bind address and bearer-token rationale', t => {
  // The design pins the message wording: the operator must see
  // (a) the bind address, (b) the bearer-token concern, and (c)
  // the TLS-termination advice. If any clause drops, an operator
  // who only reads the first line of the warning may miss the
  // reason for the second.
  const msg = renderNoTrustedProxyWarning('0.0.0.0:3469');
  t.regex(msg, /\[Gateway\] Bound to 0\.0\.0\.0:3469/);
  t.regex(msg, /no trusted proxy configured/);
  t.regex(msg, /bearer tokens/);
  t.regex(msg, /TLS termination/);
});

test('renderNoTrustedProxyWarning rejects non-string input', t => {
  t.throws(() => renderNoTrustedProxyWarning(/** @type {any} */ (3469)), {
    message: /string/,
  });
});

// -- isLoopbackBindAddress ----------------------------------------

test('isLoopbackBindAddress accepts 127.0.0.1', t => {
  t.true(
    isLoopbackBindAddress(
      harden({ host: '127.0.0.1', port: 3469, kind: 'ipv4' }),
    ),
  );
});

test('isLoopbackBindAddress accepts 127.x in 127.0.0.0/8', t => {
  // The whole /8 is loopback per RFC 1122; not just 127.0.0.1.
  t.true(
    isLoopbackBindAddress(
      harden({ host: '127.0.0.42', port: 3469, kind: 'ipv4' }),
    ),
  );
});

test('isLoopbackBindAddress accepts ::1', t => {
  t.true(
    isLoopbackBindAddress(harden({ host: '::1', port: 3469, kind: 'ipv6' })),
  );
});

test('isLoopbackBindAddress accepts localhost as hostname', t => {
  t.true(
    isLoopbackBindAddress(
      harden({ host: 'localhost', port: 3469, kind: 'hostname' }),
    ),
  );
});

test('isLoopbackBindAddress rejects 0.0.0.0 (the IPv4 wildcard is not loopback)', t => {
  // Regression: 0.0.0.0 means "bind every interface"; treating it
  // as loopback would suppress the startup warning on every
  // public-facing deployment that uses the default. The whole
  // point of the warning is to fire on this case.
  t.false(
    isLoopbackBindAddress(
      harden({ host: '0.0.0.0', port: 3469, kind: 'ipv4' }),
    ),
  );
});

test('isLoopbackBindAddress rejects :: (the IPv6 unspecified address)', t => {
  // Mirror of the IPv4 wildcard case; the symmetry matters when
  // an operator binds IPv6.
  t.false(
    isLoopbackBindAddress(harden({ host: '::', port: 3469, kind: 'ipv6' })),
  );
});

test('isLoopbackBindAddress rejects a public IPv4', t => {
  t.false(
    isLoopbackBindAddress(
      harden({ host: '10.0.0.1', port: 3469, kind: 'ipv4' }),
    ),
  );
});

test('isLoopbackBindAddress rejects malformed input', t => {
  t.false(isLoopbackBindAddress(/** @type {any} */ (null)));
  t.false(isLoopbackBindAddress(/** @type {any} */ ('not-an-address')));
  t.false(
    isLoopbackBindAddress(
      /** @type {any} */ ({ host: 42, port: 0, kind: 'ipv4' }),
    ),
  );
});

// -- parseCidr ----------------------------------------------------

test('parseCidr accepts an IPv4 /8', t => {
  const parsed = parseCidr('10.0.0.0/8');
  t.truthy(parsed);
  t.is(parsed?.kind, 'ipv4');
  t.is(parsed?.prefix, 8);
});

test('parseCidr accepts a bare IPv4 host (treated as /32)', t => {
  const parsed = parseCidr('10.0.0.1');
  t.is(parsed?.kind, 'ipv4');
  t.is(parsed?.prefix, 32);
});

test('parseCidr accepts an IPv6 /32', t => {
  const parsed = parseCidr('2001:db8::/32');
  t.is(parsed?.kind, 'ipv6');
  t.is(parsed?.prefix, 32);
});

test('parseCidr accepts a bare IPv6 host (treated as /128)', t => {
  const parsed = parseCidr('::1');
  t.is(parsed?.kind, 'ipv6');
  t.is(parsed?.prefix, 128);
});

test('parseCidr rejects malformed input', t => {
  t.is(parseCidr(''), undefined);
  t.is(parseCidr('not-a-cidr'), undefined);
  t.is(parseCidr('10.0.0.0/33'), undefined);
  t.is(parseCidr('10.0.0.0/-1'), undefined);
  t.is(parseCidr('10.0.0.0/abc'), undefined);
  t.is(parseCidr('::1/129'), undefined);
  t.is(parseCidr('256.0.0.0/8'), undefined);
  t.is(parseCidr(/** @type {any} */ (null)), undefined);
});

test('parseCidr rejects leading zeros in IPv4 octets', t => {
  // `010.0.0.0` is ambiguous between decimal 10 and octal 8; the
  // safe behavior is to refuse rather than guess.
  t.is(parseCidr('010.0.0.0/8'), undefined);
});

// -- matchTrustedProxy --------------------------------------------

test('matchTrustedProxy accepts an IPv4 inside an explicit /24', t => {
  t.true(matchTrustedProxy('192.168.1.42', ['192.168.1.0/24']));
});

test('matchTrustedProxy rejects an IPv4 outside the /24', t => {
  t.false(matchTrustedProxy('192.168.2.42', ['192.168.1.0/24']));
});

test('matchTrustedProxy honors a /32 host', t => {
  t.true(matchTrustedProxy('10.0.0.1', ['10.0.0.1/32']));
  t.false(matchTrustedProxy('10.0.0.2', ['10.0.0.1/32']));
});

test('matchTrustedProxy honors a bare IPv4 (treated as /32)', t => {
  t.true(matchTrustedProxy('10.0.0.1', ['10.0.0.1']));
  t.false(matchTrustedProxy('10.0.0.2', ['10.0.0.1']));
});

test('matchTrustedProxy honors /0 (every IPv4)', t => {
  // Regression: a /0 mask must accept every IPv4 literal. If the
  // mask arithmetic produces NaN or -1 at /0 (a 32-bit-shift
  // pitfall in JavaScript), this assertion fails.
  t.true(matchTrustedProxy('1.2.3.4', ['0.0.0.0/0']));
});

test('matchTrustedProxy matches an IPv6 inside an explicit /64', t => {
  t.true(matchTrustedProxy('2001:db8::1', ['2001:db8::/64']));
  t.false(matchTrustedProxy('2001:db9::1', ['2001:db8::/64']));
});

test('matchTrustedProxy strips bracketed IPv6 in the peer argument', t => {
  // Some embedders pass the bracketed form through. The trust
  // gate must accept both shapes.
  t.true(matchTrustedProxy('[2001:db8::1]', ['2001:db8::/64']));
});

test('matchTrustedProxy rejects on empty CIDR list', t => {
  // Regression: an empty list is the default; it must fail
  // closed. If the function ever returned `true` (perhaps from a
  // vacuous-truth bug in a for-of over no entries), every
  // request would be classified as proxied.
  t.false(matchTrustedProxy('10.0.0.1', []));
});

test('matchTrustedProxy skips malformed CIDR entries', t => {
  // A typo in one CIDR entry should not crash the whole match;
  // it should be treated as a miss while still consulting the
  // other entries.
  t.true(matchTrustedProxy('10.0.0.1', ['not-a-cidr', '10.0.0.0/24']));
});

test('matchTrustedProxy is fail-closed on a malformed peer', t => {
  t.false(matchTrustedProxy('not-an-ip', ['10.0.0.0/8']));
  t.false(matchTrustedProxy('', ['10.0.0.0/8']));
});

test('matchTrustedProxy does not cross-match IPv4 against IPv6 ranges', t => {
  // The two address families are distinct; a peer in 10/8 is not
  // inside a 2001:db8::/32 range.
  t.false(matchTrustedProxy('10.0.0.1', ['2001:db8::/32']));
});

// -- parseForwardedRequest ----------------------------------------

test('parseForwardedRequest treats an untrusted peer as direct', t => {
  // Regression: an untrusted peer must not have its X-Forwarded
  // headers honored. If this assertion fails, any caller can
  // masquerade as any IP simply by setting the header.
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-for', '1.2.3.4'],
      ['x-forwarded-proto', 'https'],
      ['host', 'real.example.com'],
    ],
    peerAddress: '203.0.113.42',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.callerIp, '203.0.113.42');
  t.is(result.scheme, 'http');
  t.is(result.host, 'real.example.com');
  t.false(result.trusted);
});

test('parseForwardedRequest honors X-Forwarded-For from a trusted peer', t => {
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-for', '1.2.3.4'],
      ['host', 'real.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.callerIp, '1.2.3.4');
  t.true(result.trusted);
});

test('parseForwardedRequest honors X-Forwarded-Proto from a trusted peer', t => {
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-proto', 'https'],
      ['host', 'real.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.scheme, 'https');
});

test('parseForwardedRequest honors X-Forwarded-Host from a trusted peer', t => {
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-host', 'public.example.com'],
      ['host', 'internal.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.host, 'public.example.com');
});

test('parseForwardedRequest defaults to http when X-Forwarded-Proto is absent', t => {
  // Regression: the gateway never terminates TLS itself; absent
  // an X-Forwarded-Proto, the request the gateway sees is plain
  // HTTP, regardless of the peer's trust status.
  const result = parseForwardedRequest({
    headers: [['host', 'real.example.com']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.scheme, 'http');
});

test('parseForwardedRequest rejects an unrecognized X-Forwarded-Proto value', t => {
  // A trusted proxy that sends `X-Forwarded-Proto: ftp` is buggy;
  // we fall back to `http` (the safe default) rather than
  // propagating the garbage value into the rest of the gateway.
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-proto', 'ftp'],
      ['host', 'real.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.scheme, 'http');
});

test('parseForwardedRequest takes the leftmost X-Forwarded-Proto when comma-separated', t => {
  // RFC 7239 / convention: proxies append; the leftmost is the
  // original client's scheme.
  const result = parseForwardedRequest({
    headers: [
      ['x-forwarded-proto', 'https, http'],
      ['host', 'real.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.scheme, 'https');
});

test('parseForwardedRequest with maxHops=1 returns the rightmost X-Forwarded-For entry', t => {
  // The XFF list grows left-to-right; with one hop budget, the
  // gateway trusts only the immediate upstream's view (the
  // rightmost entry).
  const result = parseForwardedRequest({
    headers: [['x-forwarded-for', 'client, proxy1, proxy2']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.callerIp, 'proxy2');
});

test('parseForwardedRequest with maxHops=3 returns the leftmost X-Forwarded-For entry', t => {
  // With a budget that covers every hop, the leftmost (the
  // original client) is returned.
  const result = parseForwardedRequest({
    headers: [['x-forwarded-for', '1.2.3.4, 10.0.0.5, 10.0.0.6']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 3,
  });
  t.is(result.callerIp, '1.2.3.4');
});

test('parseForwardedRequest with maxHops larger than the list size returns the leftmost', t => {
  // A budget greater than the actual list length collapses to
  // the leftmost entry; the parser does not over-walk.
  const result = parseForwardedRequest({
    headers: [['x-forwarded-for', '1.2.3.4']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 10,
  });
  t.is(result.callerIp, '1.2.3.4');
});

test('parseForwardedRequest with a non-integer maxHops clamps to 1', t => {
  // Defensive: a malformed config (somebody pushed a string or 0
  // or -1 into `maxProxyHops`) must not crash the parser. The
  // safe fallback is the minimum trust-one-hop budget.
  const result = parseForwardedRequest({
    headers: [['x-forwarded-for', 'client, proxy1, proxy2']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: /** @type {any} */ ('not-a-number'),
  });
  t.is(result.callerIp, 'proxy2');
});

test('parseForwardedRequest header lookup is case-insensitive', t => {
  // RFC 7230: header names are case-insensitive. A proxy sending
  // `X-Forwarded-For` (mixed case) must match the same as
  // `x-forwarded-for`.
  const result = parseForwardedRequest({
    headers: [
      ['X-Forwarded-For', '1.2.3.4'],
      ['Host', 'real.example.com'],
    ],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.callerIp, '1.2.3.4');
  t.is(result.host, 'real.example.com');
});

test('parseForwardedRequest tolerates a bracketed IPv6 peer', t => {
  // Some embedders pass `[::1]` literally; the parser strips the
  // brackets before trust evaluation and before the returned
  // callerIp.
  const result = parseForwardedRequest({
    headers: [],
    peerAddress: '[::1]',
    trustedCidrs: ['::1/128'],
    maxHops: 1,
  });
  t.true(result.trusted);
  t.is(result.callerIp, '::1');
});

test('parseForwardedRequest falls back to peer IP when X-Forwarded-For is empty', t => {
  // A trusted proxy that omits the header (a misconfiguration on
  // the proxy side) does not crash the parser; the gateway falls
  // back to treating the request as if it came directly from the
  // proxy.
  const result = parseForwardedRequest({
    headers: [['host', 'real.example.com']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.callerIp, '10.0.0.1');
  t.true(result.trusted);
});

test('parseForwardedRequest preserves Host header when X-Forwarded-Host absent and trusted', t => {
  // When the proxy passes the Host header through unrewritten,
  // the gateway uses it. The trust-bit is `true` because the peer
  // was inside the CIDR list, even though the X-Forwarded-Host
  // was absent.
  const result = parseForwardedRequest({
    headers: [['host', 'real.example.com']],
    peerAddress: '10.0.0.1',
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.is(result.host, 'real.example.com');
  t.true(result.trusted);
});

test('parseForwardedRequest tolerates a non-string peer address', t => {
  // Defensive: an embedder that omits the field collapses the
  // peer to the empty string, which fails the trust gate and
  // returns `callerIp` as the empty string. The handler then
  // treats the request as direct.
  const result = parseForwardedRequest({
    headers: [['host', 'real.example.com']],
    peerAddress: /** @type {any} */ (undefined),
    trustedCidrs: ['10.0.0.0/8'],
    maxHops: 1,
  });
  t.false(result.trusted);
  t.is(result.callerIp, '');
});
