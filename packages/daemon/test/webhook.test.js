import test from '@endo/ses-ava/prepare-endo.js';

import { makeWebhookKit } from '../src/webhook.js';

test('webhook url and secret', t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'abc123',
    gatewayBaseUrl: 'https://my-daemon.example.com',
  });
  t.is(endpoint.url(), 'https://my-daemon.example.com/webhooks/abc123');
  t.is(typeof endpoint.secret(), 'string');
  t.is(endpoint.secret().length, 64); // 32 bytes hex
});

test('handleRequest delivers payload', t => {
  const payloads = [];
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook1',
    gatewayBaseUrl: 'http://localhost:8920',
    onPayload: (body, headers) => payloads.push({ body, headers }),
  });

  const result = handleRequest('{"event":"push"}', {
    'content-type': 'application/json',
  });
  t.is(result.status, 200);
  t.is(payloads.length, 1);
  t.is(payloads[0].body, '{"event":"push"}');
});

test('handleRequest enforces payload size limit', t => {
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook2',
    gatewayBaseUrl: 'http://localhost:8920',
    maxPayloadBytes: 10,
  });

  const result = handleRequest('x'.repeat(100), {});
  t.is(result.status, 413);
});

test('handleRequest enforces rate limit', t => {
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook3',
    gatewayBaseUrl: 'http://localhost:8920',
    rateLimit: 3,
  });

  t.is(handleRequest('1', {}).status, 200);
  t.is(handleRequest('2', {}).status, 200);
  t.is(handleRequest('3', {}).status, 200);
  t.is(handleRequest('4', {}).status, 429);
});

test('disable and enable', t => {
  const { endpoint, handleRequest } = makeWebhookKit({
    webhookId: 'hook4',
    gatewayBaseUrl: 'http://localhost:8920',
  });

  endpoint.disable();
  t.is(handleRequest('test', {}).status, 503);

  endpoint.enable();
  t.is(handleRequest('test', {}).status, 200);
});

test('revoke permanently disables', t => {
  const { endpoint, control, handleRequest } = makeWebhookKit({
    webhookId: 'hook5',
    gatewayBaseUrl: 'http://localhost:8920',
  });

  control.revoke();
  t.is(handleRequest('test', {}).status, 410);
  t.throws(() => endpoint.url(), { message: /revoked/ });
});

test('control setMaxPayloadBytes and setRateLimit', t => {
  const { control } = makeWebhookKit({
    webhookId: 'hook6',
    gatewayBaseUrl: 'http://localhost:8920',
  });

  control.setMaxPayloadBytes(500);
  control.setRateLimit(10);
  t.throws(() => control.setMaxPayloadBytes(0), { message: /must be >= 1/ });
  t.throws(() => control.setRateLimit(0), { message: /must be >= 1/ });
  t.pass();
});

test('help returns documentation', t => {
  const { endpoint, control } = makeWebhookKit({
    webhookId: 'hook7',
    gatewayBaseUrl: 'http://localhost:8920',
  });
  t.true(endpoint.help().includes('WebhookEndpoint'));
  t.true(control.help().includes('WebhookControl'));
});
