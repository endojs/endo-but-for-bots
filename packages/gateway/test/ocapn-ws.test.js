// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  OCAPN_WS_PATH,
  OCAPN_WS_LEGACY_ALIAS_PATH,
  OCAPN_WS_CODEC,
  OCAPN_WS_NETWORK,
  OCAPN_WS_SUPPORTED,
  matchOcapnWebSocketPath,
  parseOcapnWebSocketPath,
  ocapnWebSocketConnectionHint,
} from '../index.js';

test('canonical path is /ocapn-cbor-np', t => {
  // Regression: the design's Feature 8 pins the canonical path to
  // /ocapn-cbor-np so siblings (/ocapn-syrups-tcp, /ocapn-cbor-tls)
  // can coexist. If this drifts, the wire path and every locator
  // hint drift with it.
  t.is(OCAPN_WS_PATH, '/ocapn-cbor-np');
  t.is(OCAPN_WS_LEGACY_ALIAS_PATH, '/ocapn');
  t.is(OCAPN_WS_CODEC, 'cbor');
  t.is(OCAPN_WS_NETWORK, 'np');
});

test('matchOcapnWebSocketPath decomposes the canonical path', t => {
  const route = matchOcapnWebSocketPath('/ocapn-cbor-np');
  t.deepEqual(
    { ...route },
    {
      requestedPath: '/ocapn-cbor-np',
      canonicalPath: '/ocapn-cbor-np',
      protocol: 'ocapn',
      codec: 'cbor',
      network: 'np',
      isAlias: false,
      isSupported: true,
    },
  );
});

test('matchOcapnWebSocketPath maps the legacy /ocapn alias', t => {
  const route = matchOcapnWebSocketPath('/ocapn');
  t.truthy(route);
  t.true(route && route.isAlias);
  t.is(route && route.canonicalPath, '/ocapn-cbor-np');
  t.is(route && route.codec, 'cbor');
  t.is(route && route.network, 'np');
  t.true(route && route.isSupported);
});

test('matchOcapnWebSocketPath ignores query and fragment', t => {
  for (const raw of [
    '/ocapn-cbor-np?token=abc',
    '/ocapn-cbor-np#frag',
    '/ocapn-cbor-np/',
    '/ocapn?x=1',
  ]) {
    const route = matchOcapnWebSocketPath(raw);
    t.truthy(route, raw);
    t.is(route && route.canonicalPath, '/ocapn-cbor-np', raw);
  }
});

test('matchOcapnWebSocketPath recognizes a reserved sibling as unsupported', t => {
  // The path scheme reserves siblings even before they are
  // implemented, so the caller can answer "unsupported subprotocol"
  // rather than a generic miss.
  for (const sibling of ['/ocapn-syrups-tcp', '/ocapn-cbor-tls']) {
    const route = matchOcapnWebSocketPath(sibling);
    t.truthy(route, sibling);
    t.false(route && route.isSupported, sibling);
    t.is(route && route.isAlias, false, sibling);
  }
  const syrups = matchOcapnWebSocketPath('/ocapn-syrups-tcp');
  t.is(syrups && syrups.codec, 'syrups');
  t.is(syrups && syrups.network, 'tcp');
});

test('matchOcapnWebSocketPath returns undefined for non-OCapN paths', t => {
  for (const miss of [
    '/',
    '/git/repo/info/refs',
    '/ocapnx',
    '/ocapn-cbor',
    '/ocapn-cbor-np-extra',
    '/x-ocapn-cbor-np',
    '/ocapn-CBOR-np',
    '/ocapn-cbor-',
  ]) {
    t.is(matchOcapnWebSocketPath(miss), undefined, miss);
  }
});

test('matchOcapnWebSocketPath rejects a non-string path', t => {
  t.throws(
    // @ts-expect-error intentional: testing input validation
    () => matchOcapnWebSocketPath(42),
    { message: /must be a string/ },
  );
});

test('parseOcapnWebSocketPath returns the supported route', t => {
  const route = parseOcapnWebSocketPath('/ocapn-cbor-np');
  t.is(route.canonicalPath, '/ocapn-cbor-np');
  t.true(route.isSupported);
  // The alias parses too.
  t.is(parseOcapnWebSocketPath('/ocapn').canonicalPath, '/ocapn-cbor-np');
});

test('parseOcapnWebSocketPath throws on a non-OCapN path', t => {
  t.throws(() => parseOcapnWebSocketPath('/git/repo'), {
    message: /Not an OCapN WebSocket path/,
  });
});

test('parseOcapnWebSocketPath throws on a reserved-but-unsupported sibling', t => {
  t.throws(() => parseOcapnWebSocketPath('/ocapn-syrups-tcp'), {
    message: /Unsupported OCapN codec\/network/,
  });
});

test('OCAPN_WS_SUPPORTED lists cbor/np', t => {
  t.deepEqual(
    OCAPN_WS_SUPPORTED.map(p => ({ ...p })),
    [{ codec: 'cbor', network: 'np' }],
  );
});

test('ocapnWebSocketConnectionHint builds the ws and wss forms', t => {
  // Per the design's Feature 8: wss:host=<hostname>;path=/ocapn-cbor-np;np
  t.is(
    ocapnWebSocketConnectionHint({ host: 'gateway.example.com', secure: true }),
    'wss:host=gateway.example.com;path=/ocapn-cbor-np;np',
  );
  t.is(
    ocapnWebSocketConnectionHint({ host: '127.0.0.1' }),
    'ws:host=127.0.0.1;path=/ocapn-cbor-np;np',
  );
});

test('ocapnWebSocketConnectionHint rejects an empty host', t => {
  t.throws(() => ocapnWebSocketConnectionHint({ host: '' }), {
    message: /non-empty string/,
  });
});
