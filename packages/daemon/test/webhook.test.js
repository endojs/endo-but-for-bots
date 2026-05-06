/* global crypto */
import test from '@endo/ses-ava/prepare-endo.js';

import { makeWebhookKit } from '../src/webhook.js';

const textEncoder = new TextEncoder();

/**
 * Compute the canonical hex HMAC-SHA256 of `body` under `secretHex`.
 * Mirrors what a properly-implemented sender would produce; the
 * webhook's own `verify()` should accept this signature.
 *
 * @param {string} secretHex
 * @param {string} body
 */
const hmacHex = async (secretHex, body) => {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secretHex.match(/.{2}/gu) || [], h => parseInt(h, 16)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, textEncoder.encode(body)),
  );
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
};

test('webhook url and secret', t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'abc123',
    gatewayBaseUrl: 'https://my-daemon.example.com',
  });
  t.is(endpoint.url(), 'https://my-daemon.example.com/webhooks/abc123');
  t.is(typeof endpoint.secret(), 'string');
  t.is(endpoint.secret().length, 64); // 32 bytes hex
});

test('handleRequest delivers payload', async t => {
  const payloads = [];
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook1',
    gatewayBaseUrl: 'http://localhost:8920',
    onPayload: (body, headers) => payloads.push({ body, headers }),
  });

  const result = await handleRequest('{"event":"push"}', {
    'content-type': 'application/json',
  });
  t.is(result.status, 200);
  t.is(payloads.length, 1);
  t.is(payloads[0].body, '{"event":"push"}');
});

test('handleRequest enforces payload size limit', async t => {
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook2',
    gatewayBaseUrl: 'http://localhost:8920',
    maxPayloadBytes: 10,
  });

  const result = await handleRequest('x'.repeat(100), {});
  t.is(result.status, 413);
});

test('handleRequest enforces rate limit', async t => {
  const { handleRequest } = makeWebhookKit({
    webhookId: 'hook3',
    gatewayBaseUrl: 'http://localhost:8920',
    rateLimit: 3,
  });

  t.is((await handleRequest('1', {})).status, 200);
  t.is((await handleRequest('2', {})).status, 200);
  t.is((await handleRequest('3', {})).status, 200);
  t.is((await handleRequest('4', {})).status, 429);
});

test('disable and enable', async t => {
  const { endpoint, handleRequest } = makeWebhookKit({
    webhookId: 'hook4',
    gatewayBaseUrl: 'http://localhost:8920',
  });

  endpoint.disable();
  t.is((await handleRequest('test', {})).status, 503);

  endpoint.enable();
  t.is((await handleRequest('test', {})).status, 200);
});

test('revoke permanently disables', async t => {
  const { endpoint, control, handleRequest } = makeWebhookKit({
    webhookId: 'hook5',
    gatewayBaseUrl: 'http://localhost:8920',
  });

  control.revoke();
  t.is((await handleRequest('test', {})).status, 410);
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

test('verify accepts a valid HMAC signature', async t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'hook-verify',
    gatewayBaseUrl: 'http://localhost:8920',
  });
  const body = '{"event":"ping"}';
  const sig = await hmacHex(endpoint.secret(), body);
  t.true(await endpoint.verify(body, sig));
});

test('verify rejects a tampered HMAC signature', async t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'hook-verify-bad',
    gatewayBaseUrl: 'http://localhost:8920',
  });
  const body = '{"event":"ping"}';
  const sig = await hmacHex(endpoint.secret(), body);
  // Flip the first hex nibble.
  const flipped = sig[0] === '0' ? `1${sig.slice(1)}` : `0${sig.slice(1)}`;
  t.false(await endpoint.verify(body, flipped));
});

test('verify rejects a signature for a different body', async t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'hook-verify-body',
    gatewayBaseUrl: 'http://localhost:8920',
  });
  const sig = await hmacHex(endpoint.secret(), 'original');
  t.false(await endpoint.verify('forged', sig));
});

test('verify rejects malformed signatures (odd length, non-hex)', async t => {
  const { endpoint } = makeWebhookKit({
    webhookId: 'hook-verify-malformed',
    gatewayBaseUrl: 'http://localhost:8920',
  });
  t.false(await endpoint.verify('body', 'abc'));
  t.false(await endpoint.verify('body', 'not-hex-at-all'));
  t.false(await endpoint.verify('body', ''));
});

test('handleRequest enforces signature when x-webhook-signature is present', async t => {
  const payloads = [];
  const { endpoint, handleRequest } = makeWebhookKit({
    webhookId: 'hook-signed',
    gatewayBaseUrl: 'http://localhost:8920',
    onPayload: (body, headers) => payloads.push({ body, headers }),
  });

  const body = '{"event":"signed"}';
  const sig = await hmacHex(endpoint.secret(), body);

  const ok = await handleRequest(body, { 'x-webhook-signature': sig });
  t.is(ok.status, 200);
  t.is(payloads.length, 1);

  const tampered = await handleRequest(body, {
    'x-webhook-signature': sig.replace(/.$/u, c => (c === '0' ? '1' : '0')),
  });
  t.is(tampered.status, 401);
  t.is(payloads.length, 1, 'tampered request must not deliver onPayload');
});
