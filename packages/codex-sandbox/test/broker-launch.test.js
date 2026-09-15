// @ts-check
import '@endo/init';

import { assertPublicNetworkEvidence } from '@endo/hosted-agent/public-network.js';
import test from 'ava';

import {
  assertBrokerEndpoint,
  assertBrokerRuntimeConfig,
  makeBrokerAppServerArgv,
  makeBrokerEnvironment,
} from '../src/broker-launch.js';

const endpoint = 'http://127.0.0.1:23456';
const network = harden({
  policy: 'public-internet',
  proxyUrl: 'http://127.0.0.1:23457',
  dnsHost: '127.0.0.53',
  resolverConfigPath: '/private/provider/public-resolv.conf',
});
const config = harden({
  model_provider: 'endo_broker',
  approval_policy: 'never',
  sandbox_mode: 'danger-full-access',
  features: { network_proxy: { enabled: false } },
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

test('broker launch uses a credential-free responses provider and outer-container execution', t => {
  const argv = makeBrokerAppServerArgv(endpoint);
  t.deepEqual(argv.slice(-4), [
    'features.network_proxy.enabled=false',
    'app-server',
    '--listen',
    'stdio://',
  ]);
  t.true(argv.includes('model_provider="endo_broker"'));
  t.true(argv.includes('sandbox_mode="danger-full-access"'));
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

test('public networking uses the host proxy without a second Codex proxy', t => {
  const argv = makeBrokerAppServerArgv(endpoint, 'codex', network);
  t.true(argv.includes('features.network_proxy.enabled=false'));
  t.false(argv.some(value => value.startsWith('sandbox_workspace_write.')));
  const env = makeBrokerEnvironment(network);
  t.is(env.HTTP_PROXY, network.proxyUrl);
  t.is(env.http_proxy, env.HTTP_PROXY);
  t.is(env.NO_PROXY, '127.0.0.1');
  t.notThrows(() => assertBrokerRuntimeConfig(config, endpoint, network));
});

test('public proxy evidence requires canonical loopback without credentials', t => {
  for (const proxyUrl of [
    'http://8.8.8.8:23457',
    'http://2130706433:23457',
    'http://[::ffff:127.0.0.1]:23457',
    'http://user@127.0.0.1:23457',
    'http://127.0.0.1:23457/path',
    'http://127.0.0.1:23457/',
  ]) {
    t.throws(() => assertPublicNetworkEvidence({ ...network, proxyUrl }), {
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

for (const change of [
  { sandbox_mode: 'workspace-write' },
  { sandbox_mode: 'external-sandbox' },
  { features: { network_proxy: { enabled: true } } },
  { features: {} },
  { approval_policy: 'on-request' },
]) {
  test(`runtime rejects incompatible external execution config ${JSON.stringify(change)}`, t => {
    t.throws(
      () => assertBrokerRuntimeConfig({ ...config, ...change }, endpoint),
      {
        message: /configuration mismatch/,
      },
    );
  });
}
