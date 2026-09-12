// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertPublicNetworkEvidence,
  makePublicNetworkEnvironment,
} from '../src/public-network.js';

const network = harden({
  policy: 'public-internet',
  proxyUrl: 'http://127.0.0.1:23457',
  dnsHost: '127.0.0.53',
  resolverConfigPath: '/private-runtime/public-resolv.conf',
});

test('shared network environment preserves local inference bypass', t => {
  t.deepEqual(makePublicNetworkEnvironment(undefined), {});
  t.deepEqual(makePublicNetworkEnvironment(network), {
    HTTP_PROXY: network.proxyUrl,
    HTTPS_PROXY: network.proxyUrl,
    http_proxy: network.proxyUrl,
    https_proxy: network.proxyUrl,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
  });
});

test('shared network evidence excludes foreign endpoints and unexpected authority', t => {
  t.is(assertPublicNetworkEvidence(network), network);
  for (const change of [
    { proxyUrl: 'http://example.com:23457' },
    { proxyUrl: 'http://user:secret@127.0.0.1:23457' },
    { proxyUrl: 'http://127.0.0.1:23457/private' },
    { dnsHost: '8.8.8.8' },
    { resolverConfigPath: '../etc/resolv.conf' },
    { token: 'unexpected' },
    { policy: 'off' },
  ]) {
    t.throws(() => makePublicNetworkEnvironment({ ...network, ...change }), {
      message: /Invalid public network evidence/,
    });
  }
});
