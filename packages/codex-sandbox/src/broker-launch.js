// @ts-check

import { Fail, makeError, X } from '@endo/errors';

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
 */
export const makeBrokerAppServerArgv = (endpoint, executable = 'codex') => {
  const origin = assertBrokerEndpoint(endpoint);
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
    'sandbox_workspace_write.network_access=false',
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
 */
export const assertBrokerRuntimeConfig = (config, endpoint) => {
  const origin = assertBrokerEndpoint(endpoint);
  (config?.model_provider === 'endo_broker' &&
    config.approval_policy === 'never' &&
    config.sandbox_mode === 'workspace-write' &&
    config.sandbox_workspace_write?.network_access === false &&
    config.sandbox_workspace_write?.exclude_slash_tmp === true &&
    config.sandbox_workspace_write?.exclude_tmpdir_env_var === true &&
    JSON.stringify(config.sandbox_workspace_write?.writable_roots) ===
      JSON.stringify(['/workspace', '/tmp', '/run', '/scratch'])) ||
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
