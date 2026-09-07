// @ts-check
import '@endo/init';

import test from 'ava';

import {
  assertBrokerEndpoint,
  assertBrokerRuntimeConfig,
  makeBrokerAppServerArgv,
} from '../src/broker-launch.js';

const endpoint = 'http://127.0.0.1:23456';
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
