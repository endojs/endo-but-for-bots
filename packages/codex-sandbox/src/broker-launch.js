// @ts-check

import { Fail, makeError, X } from '@endo/errors';

import { isPublicEgressAddress } from './public-egress.js';

/**
 * Validate evidence from the operator-owned listener, never session input.
 * @param {any} network
 */
export const assertCodexNetworkEvidence = network => {
  if (network === undefined) return undefined;
  let proxy;
  try {
    proxy = new URL(network.proxyUrl);
  } catch {
    throw makeError(X`Invalid Codex public network evidence`);
  }
  (Object.keys(network).sort().join(',') ===
    'dnsHost,policy,proxyUrl,resolverConfigPath' &&
    network.policy === 'public-internet' &&
    network.dnsHost === '127.0.0.53' &&
    proxy.protocol === 'http:' &&
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(proxy.hostname) &&
    isPublicEgressAddress(proxy.hostname) &&
    proxy.port !== '' &&
    proxy.username === '' &&
    proxy.password === '' &&
    proxy.pathname === '/' &&
    proxy.search === '' &&
    proxy.hash === '' &&
    network.proxyUrl === proxy.origin &&
    typeof network.resolverConfigPath === 'string' &&
    /^(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(network.resolverConfigPath)) ||
    Fail`Invalid Codex public network evidence`;
  return network;
};
harden(assertCodexNetworkEvidence);

/** @param {any} [network] */
export const makeBrokerEnvironment = (network = undefined) => {
  assertCodexNetworkEvidence(network);
  return harden({
    CODEX_HOME: '/codex-home',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TEMP: '/tmp',
    TMP: '/tmp',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    ...(network
      ? {
          HTTP_PROXY: network.proxyUrl,
          HTTPS_PROXY: network.proxyUrl,
          http_proxy: network.proxyUrl,
          https_proxy: network.proxyUrl,
          NO_PROXY: '127.0.0.1',
          no_proxy: '127.0.0.1',
        }
      : {}),
  });
};
harden(makeBrokerEnvironment);

/**
 * Validate the credential-free listener address, never an upstream URL.
 * @param {string} endpoint
 */
export const assertBrokerEndpoint = endpoint => {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw makeError(X`Invalid Codex broker endpoint`);
  }
  (url.protocol === 'http:' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '') ||
    Fail`Codex broker endpoint must be credential-free loopback`;
  return url.origin;
};
harden(assertBrokerEndpoint);

/**
 * This is configuration, not evidence that the OS applied an inner sandbox.
 * CLI overrides merge home configuration; admission must also call
 * assertBrokerRuntimeConfig against the pinned runtime's config/read response.
 * @param {string} endpoint
 * @param {string} [executable]
 * @param {any} [network]
 */
export const makeBrokerAppServerArgv = (
  endpoint,
  executable = 'codex',
  network = undefined,
) => {
  const origin = assertBrokerEndpoint(endpoint);
  assertCodexNetworkEvidence(network);
  !network ||
    new URL(origin).hostname === '127.0.0.1' ||
    Fail`Public network requires IPv4 loopback broker`;
  return harden([
    executable,
    '-c',
    'model_provider="endo_broker"',
    '-c',
    `model_providers.endo_broker={name="Endo broker",base_url="${origin}/v1",wire_api="responses",requires_openai_auth=false}`,
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.writable_roots=["/workspace","/tmp","/run","/scratch"]',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c',
    `sandbox_workspace_write.network_access=${network ? 'true' : 'false'}`,
    ...(network
      ? [
          '-c',
          'features.network_proxy.enabled=true',
          '-c',
          'features.network_proxy.domains={"*"="allow"}',
          '-c',
          'features.network_proxy.allow_upstream_proxy=true',
          '-c',
          'features.network_proxy.allow_local_binding=false',
          '-c',
          'features.network_proxy.enable_socks5=false',
          '-c',
          'features.network_proxy.enable_socks5_udp=false',
        ]
      : []),
    'app-server',
    '--listen',
    'stdio://',
  ]);
};
harden(makeBrokerAppServerArgv);

/**
 * Reject inherited provider credentials and alternate routes after CLI merges.
 * This attests configuration only, not the provider listener or tool isolation.
 * @param {any} config
 * @param {string} endpoint
 * @param {any} [network]
 */
export const assertBrokerRuntimeConfig = (
  config,
  endpoint,
  network = undefined,
) => {
  const origin = assertBrokerEndpoint(endpoint);
  assertCodexNetworkEvidence(network);
  (config?.model_provider === 'endo_broker' &&
    config.approval_policy === 'never' &&
    config.sandbox_mode === 'workspace-write' &&
    config.sandbox_workspace_write?.network_access === Boolean(network) &&
    config.sandbox_workspace_write?.exclude_slash_tmp === true &&
    config.sandbox_workspace_write?.exclude_tmpdir_env_var === true &&
    JSON.stringify(config.sandbox_workspace_write?.writable_roots) ===
      JSON.stringify(['/workspace', '/tmp', '/run', '/scratch'])) ||
    Fail`Codex broker runtime configuration mismatch`;
  if (network) {
    const proxy = config.features?.network_proxy;
    (proxy &&
      Object.keys(proxy).sort().join(',') ===
        'allow_local_binding,allow_upstream_proxy,domains,enable_socks5,enable_socks5_udp,enabled' &&
      proxy.enabled === true &&
      proxy.allow_upstream_proxy === true &&
      proxy.allow_local_binding === false &&
      proxy.enable_socks5 === false &&
      proxy.enable_socks5_udp === false &&
      JSON.stringify(proxy.domains) === JSON.stringify({ '*': 'allow' })) ||
      Fail`Codex managed proxy configuration mismatch`;
  }
  const provider = config.model_providers?.endo_broker;
  const expected = {
    name: 'Endo broker',
    base_url: `${origin}/v1`,
    wire_api: 'responses',
    requires_openai_auth: false,
  };
  (provider &&
    Object.entries(expected).every(
      ([key, value]) => provider[key] === value,
    )) ||
    Fail`Codex broker provider configuration mismatch`;
  for (const [key, value] of Object.entries(provider)) {
    // Pinned 0.152.0 reports absent optional values as null and disabled
    // capabilities as false. Unknown enabled settings fail admission too.
    Object.hasOwn(expected, key) ||
      value === null ||
      value === false ||
      Fail`Codex broker provider contains additional configuration`;
  }
};
harden(assertBrokerRuntimeConfig);
