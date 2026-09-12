// @ts-check

import { Fail, makeError, X } from '@endo/errors';

/**
 * Validate evidence from the operator-owned listener, never session input.
 * @param {any} network
 */
export const assertPublicNetworkEvidence = network => {
  if (network === undefined) return undefined;
  let proxy;
  try {
    proxy = new URL(network.proxyUrl);
  } catch {
    throw makeError(X`Invalid public network evidence`);
  }
  (Object.keys(network).sort().join(',') ===
    'dnsHost,policy,proxyUrl,resolverConfigPath' &&
    network.policy === 'public-internet' &&
    network.dnsHost === '127.0.0.53' &&
    proxy.protocol === 'http:' &&
    proxy.hostname === '127.0.0.1' &&
    proxy.port !== '' &&
    proxy.username === '' &&
    proxy.password === '' &&
    proxy.pathname === '/' &&
    proxy.search === '' &&
    proxy.hash === '' &&
    network.proxyUrl === proxy.origin &&
    typeof network.resolverConfigPath === 'string' &&
    /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(network.resolverConfigPath)) ||
    Fail`Invalid public network evidence`;
  return network;
};
harden(assertPublicNetworkEvidence);

/**
 * @param {any} [network]
 * @returns {Readonly<Record<string, string>>}
 */
export const makePublicNetworkEnvironment = network => {
  assertPublicNetworkEvidence(network);
  if (network === undefined) return harden({});
  return harden({
    HTTP_PROXY: network.proxyUrl,
    HTTPS_PROXY: network.proxyUrl,
    http_proxy: network.proxyUrl,
    https_proxy: network.proxyUrl,
    NO_PROXY: '127.0.0.1',
    no_proxy: '127.0.0.1',
  });
};
harden(makePublicNetworkEnvironment);
