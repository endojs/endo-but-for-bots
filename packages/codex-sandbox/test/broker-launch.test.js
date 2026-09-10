// @ts-check
import '@endo/init';

import test from 'ava';

import {
  assertBrokerEndpoint,
  assertBrokerRuntimeConfig,
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
  assertCodexNetworkEvidence,
} from '../src/broker-launch.js';

const endpoint = 'http://127.0.0.1:23456';
const network = harden({
  policy: 'public-internet',
  proxyUrl: 'http://207.148.100.198:23457',
  dnsHost: '127.0.0.53',
  resolverConfigPath: '/private/provider/public-resolv.conf',
});
const config = harden({
  model_provider: 'endo_broker',
  approval_policy: 'never',
  sandbox_mode: 'workspace-write',
  sandbox_workspace_write: {
    network_access: false,
    writable_roots: ['/workspace', '/tmp', '/run', '/scratch'],
    exclude_slash_tmp: true,
    exclude_tmpdir_env_var: true,
  },
  model_providers: {
    endo_broker: {
      name: 'Endo broker',
      base_url: `${endpoint}/v1`,
      wire_api: 'responses',
      requires_openai_auth: false,
      env_key: null,
      experimental_bearer_token: null,
      http_headers: null,
      supports_websockets: false,
    },
  },
});

test('broker launch uses a credential-free responses provider and fixed tool policy', t => {
  const argv = makeBrokerAppServerArgv(endpoint);
  t.deepEqual(argv.slice(-4), [
    'sandbox_workspace_write.network_access=false',
    'app-server',
    '--listen',
    'stdio://',
  ]);
  t.true(argv.includes('model_provider="endo_broker"'));
  t.true(argv.includes('sandbox_mode="workspace-write"'));
  t.notThrows(() => assertBrokerRuntimeConfig(config, endpoint));
});

for (const bad of [
  'https://127.0.0.1',
  'http://localhost',
  'http://user@127.0.0.1',
  'http://127.0.0.1/v1',
  'http://127.0.0.1?token=x',
  'http://example.com',
]) {
  test(`broker rejects alternate endpoint ${bad}`, t => {
    t.throws(() => assertBrokerEndpoint(bad), { message: /broker endpoint/ });
  });
}

test('public networking pins a managed proxy while retaining private-address denial', t => {
  const argv = makeBrokerAppServerArgv(endpoint, 'codex', network);
  t.true(argv.includes('features.network_proxy.allow_local_binding=false'));
  t.true(argv.includes('features.network_proxy.allow_upstream_proxy=true'));
  t.true(argv.includes('features.network_proxy.enable_socks5=false'));
  const env = makeBrokerEnvironment(network);
  t.is(env.HTTP_PROXY, network.proxyUrl);
  t.is(env.http_proxy, env.HTTP_PROXY);
  t.is(env.NO_PROXY, '127.0.0.1');
  const observed = {
    ...config,
    sandbox_workspace_write: {
      ...config.sandbox_workspace_write,
      network_access: true,
    },
    features: {
      network_proxy: {
        enabled: true,
        allow_upstream_proxy: true,
        allow_local_binding: false,
        enable_socks5: false,
        enable_socks5_udp: false,
        domains: { '*': 'allow' },
      },
    },
  };
  t.notThrows(() => assertBrokerRuntimeConfig(observed, endpoint, network));
  for (const [key, value] of Object.entries({
    allow_local_binding: true,
    enable_socks5: true,
    allow_upstream_proxy: false,
    proxy_url: 'http://0.0.0.0:9999',
    dangerously_allow_all_unix_sockets: true,
    unix_sockets: ['/run/private.sock'],
    dangerously_allow_non_loopback_proxy: true,
    unknown_future: true,
  })) {
    t.throws(
      () =>
        assertBrokerRuntimeConfig(
          {
            ...observed,
            features: {
              network_proxy: {
                ...observed.features.network_proxy,
                [key]: value,
              },
            },
          },
          endpoint,
          network,
        ),
      { message: /managed proxy/ },
    );
  }
  t.throws(() => assertBrokerRuntimeConfig(observed, endpoint), {
    message: /configuration mismatch/,
  });
});

test('public proxy evidence rejects loopback, credentials, and noncanonical URLs', t => {
  for (const proxyUrl of [
    'http://127.0.0.1:23457',
    'http://2130706433:23457',
    'http://[::ffff:127.0.0.1]:23457',
    'http://user@207.148.100.198:23457',
    'http://207.148.100.198:23457/path',
    'http://207.148.100.198:23457/',
  ]) {
    t.throws(() => assertCodexNetworkEvidence({ ...network, proxyUrl }), {
      message: /network evidence/,
    });
  }
  t.throws(
    () => makeBrokerAppServerArgv('http://[::1]:23456', 'codex', network),
    { message: /IPv4 loopback/ },
  );
});

for (const [key, value] of Object.entries({
  env_key: 'OPENAI_API_KEY',
  experimental_bearer_token: 'inherited-token',
  http_headers: { Authorization: 'inherited-token' },
  base_url: 'https://api.openai.com/v1',
  supports_websockets: true,
  unknown_future_auth: 'enabled',
})) {
  test(`merged provider setting ${key} fails runtime admission`, t => {
    const poisoned = {
      ...config,
      model_providers: {
        endo_broker: { ...config.model_providers.endo_broker, [key]: value },
      },
    };
    t.throws(() => assertBrokerRuntimeConfig(poisoned, endpoint), {
      message: /Codex broker provider/,
    });
  });
}

test('runtime configured with tool network access fails admission', t => {
  t.throws(
    () =>
      assertBrokerRuntimeConfig(
        { ...config, sandbox_workspace_write: { network_access: true } },
        endpoint,
      ),
    { message: /configuration mismatch/ },
  );
});

for (const change of [
  { writable_roots: ['/workspace', '/tmp', '/run', '/scratch', '/codex-home'] },
  { exclude_slash_tmp: false },
  { exclude_tmpdir_env_var: false },
]) {
  test(`runtime tool roots reject drift ${JSON.stringify(change)}`, t => {
    t.throws(
      () =>
        assertBrokerRuntimeConfig(
          {
            ...config,
            sandbox_workspace_write: {
              ...config.sandbox_workspace_write,
              ...change,
            },
          },
          endpoint,
        ),
      { message: /configuration mismatch/ },
    );
  });
}
