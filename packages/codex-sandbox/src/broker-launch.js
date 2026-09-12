// @ts-check

import { Fail, makeError, X } from '@endo/errors';
import {
  assertPublicNetworkEvidence,
  makePublicNetworkEnvironment,
} from '@endo/hosted-agent/public-network.js';

/**
 * @param {any} [network]
 * @returns {Readonly<Record<string, string>>}
 */
export const makeBrokerEnvironment = (network = undefined) => {
  return harden({
    CODEX_HOME: '/codex-home',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TEMP: '/tmp',
    TMP: '/tmp',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    ...makePublicNetworkEnvironment(network),
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
 * The outer container confines the CLI and all of its commands as one domain.
 * Codex 0.152.0 has no external-sandbox configuration/thread mode; use its
 * unrestricted baseline inside that container and explicit externalSandbox
 * policies for turns. Configuration alone is not evidence of containment.
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
  assertPublicNetworkEvidence(network);
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
    'sandbox_mode="danger-full-access"',
    '-c',
    'approval_policy="never"',
    '-c',
    'features.network_proxy.enabled=false',
    'app-server',
    '--listen',
    'stdio://',
  ]);
};
harden(makeBrokerAppServerArgv);

/**
 * Reject inherited provider credentials and alternate routes after CLI merges.
 * This checks configuration only; the outer sandbox confines all guest processes.
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
  assertPublicNetworkEvidence(network);
  (config?.model_provider === 'endo_broker' &&
    config.approval_policy === 'never' &&
    config.sandbox_mode === 'danger-full-access' &&
    config.features?.network_proxy?.enabled === false) ||
    Fail`Codex broker runtime configuration mismatch`;
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
