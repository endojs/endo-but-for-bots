import test from '@endo/ses-ava/test.js';

import {
  formatAuthority,
  formatAuthorityPath,
  formatHint,
  makeHintKey,
  parseAuthority,
  parseAuthorityPath,
  parseHint,
  parseHintKey,
} from '../src/hints.js';

// The locator layer percent-encodes each `@`-delimited path component, per
// designs/daemon-locator-reference.md § Locator with Connection Hints.
const encodeComponents = components =>
  `/${components.map(encodeURIComponent).join('@')}`;
const decodeComponents = path =>
  path.replace(/^\//, '').split('@').map(decodeURIComponent);

test('makeHintKey and parseHintKey compose a transport-and-codec key', t => {
  t.is(makeHintKey('tcp', 'cbor'), 'tcp+cbor');
  t.is(makeHintKey('wss', 'cbor'), 'wss+cbor');
  t.deepEqual(parseHintKey('ws+cbor'), { transport: 'ws', codec: 'cbor' });
  // A future codec is a distinct key, not a second value under `tcp`.
  t.not(makeHintKey('tcp', 'syrup'), makeHintKey('tcp', 'cbor'));
});

test('hint keys reject malformed names', t => {
  for (const key of [
    'tcp',
    'tcp+',
    '+cbor',
    'TCP+cbor',
    'tcp+cbor+x',
    'tcp:url',
  ]) {
    t.throws(() => parseHintKey(key), undefined, key);
  }
  t.throws(() => makeHintKey('tcp', ''));
  t.throws(() => makeHintKey('tcp+cbor', 'cbor'));
});

test('a tcp+cbor authority round-trips through a locator path', t => {
  const value = formatAuthority({ host: '127.0.0.1', port: 3469 });
  t.is(value, '127.0.0.1:3469');
  const component = formatHint('tcp+cbor', value);
  t.is(component, 'tcp+cbor:127.0.0.1:3469');
  const [decoded] = decodeComponents(encodeComponents([component]));
  const hint = parseHint(decoded);
  t.deepEqual(hint, {
    key: 'tcp+cbor',
    transport: 'tcp',
    codec: 'cbor',
    value: '127.0.0.1:3469',
  });
  t.deepEqual(parseAuthority(hint.value), { host: '127.0.0.1', port: 3469 });
});

test('an IPv6 authority is bracketed and unbracketed', t => {
  const value = formatAuthority({ host: '::1', port: 3469 });
  t.is(value, '[::1]:3469');
  const [decoded] = decodeComponents(
    encodeComponents([formatHint('tcp+cbor', value)]),
  );
  t.deepEqual(parseAuthority(parseHint(decoded).value), {
    host: '::1',
    port: 3469,
  });
  t.deepEqual(parseAuthority('[2001:db8::7]:443'), {
    host: '2001:db8::7',
    port: 443,
  });
});

test('a wss+cbor host:port/path value round-trips', t => {
  const value = formatAuthorityPath({
    host: 'minion.town',
    port: 443,
    path: '/.well-known/ocapn-cbor-np',
  });
  t.is(value, 'minion.town:443/.well-known/ocapn-cbor-np');
  const [decoded] = decodeComponents(
    encodeComponents([formatHint('wss+cbor', value)]),
  );
  const hint = parseHint(decoded);
  t.is(hint.key, 'wss+cbor');
  t.deepEqual(parseAuthorityPath(hint.value), {
    host: 'minion.town',
    port: 443,
    path: '/.well-known/ocapn-cbor-np',
  });
  t.deepEqual(parseAuthorityPath('[::1]:8080/a/b'), {
    host: '::1',
    port: 8080,
    path: '/a/b',
  });
});

test('an @ in a WebSocket path is percent-encoded and decoded back', t => {
  const value = formatAuthorityPath({
    host: 'example.com',
    port: 443,
    path: '/peers/@alice',
  });
  const components = [
    formatHint('wss+cbor', value),
    formatHint('tcp+cbor', '127.0.0.1:3469'),
  ];
  const path = encodeComponents(components);
  t.true(path.includes('%40alice'));
  // Exactly one unencoded `@` separates the two hints.
  t.is(path.split('@').length, 2);
  const decoded = decodeComponents(path);
  t.deepEqual(decoded, components);
  t.is(parseAuthorityPath(parseHint(decoded[0]).value).path, '/peers/@alice');
});

test('the external locator example from the design parses in order', t => {
  const decoded = [
    'wss+cbor:minion.town:443/.well-known/ocapn-cbor-np',
    'tcp+cbor:127.0.0.1:3469',
  ];
  const hints = decodeComponents(encodeComponents(decoded)).map(parseHint);
  t.deepEqual(
    hints.map(({ key }) => key),
    ['wss+cbor', 'tcp+cbor'],
  );
  t.is(hints[0].value, 'minion.town:443/.well-known/ocapn-cbor-np');
});

test('a WebSocket value without a path is rejected', t => {
  t.throws(() => parseAuthorityPath('minion.town:443'), {
    message: /missing path/,
  });
  t.throws(() => parseAuthorityPath('[::1]:443'), { message: /missing path/ });
  t.throws(() =>
    formatAuthorityPath({ host: 'minion.town', port: 443, path: '' }),
  );
  t.throws(() =>
    formatAuthorityPath({ host: 'minion.town', port: 443, path: 'relative' }),
  );
  t.throws(() => parseAuthorityPath('minion.town:443/a?type=x'));
  t.throws(() => parseAuthorityPath('minion.town:443/a\u0000b'));
  t.throws(() => parseAuthorityPath('minion.town:443/a b'));
});

test('malformed authorities are rejected', t => {
  for (const value of [
    '',
    '127.0.0.1',
    '127.0.0.1:',
    ':3469',
    '127.0.0.1:0',
    '127.0.0.1:65536',
    '127.0.0.1:03469',
    '127.0.0.1:34a',
    '::1:3469',
    '[::1',
    '[::1]3469',
    '[example.com]:3469',
    'user@example.com:3469',
    'tcp://127.0.0.1:3469',
    '127.0.0.1:3469/path',
  ]) {
    t.throws(() => parseAuthority(value), undefined, value);
  }
  t.throws(() => formatAuthority({ host: '127.0.0.1', port: 0 }));
  t.throws(() => formatAuthority({ host: '127.0.0.1', port: 1.5 }));
  t.throws(() => formatAuthority({ host: '[::1]', port: 3469 }));
  t.throws(() => formatAuthority({ host: '', port: 3469 }));
});

test('hint components must carry a key and a non-empty value', t => {
  t.throws(() => parseHint('tcp+cbor'), { message: /must have the form/ });
  t.throws(() => parseHint('tcp+cbor:'), { message: /empty value/ });
  t.throws(() => parseHint('tcp:127.0.0.1:3469'));
  t.throws(() => formatHint('tcp+cbor', ''));
  t.throws(() => formatHint('tcp', '127.0.0.1:3469'));
});
