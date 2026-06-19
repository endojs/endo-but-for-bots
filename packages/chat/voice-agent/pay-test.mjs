// pay-test.mjs — prove the billing plumbing without live Stripe: signature verify, pending-payment
// record/settle, idempotency. Uses a temp store + a test webhook secret.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-test-'));
process.env.PAY_STORE = path.join(tmp, 'pending.json');
process.env.STRIPE_CONFIG = path.join(tmp, 'stripe.json'); // absent at first

const { stripeConfigured, recordPending, checkoutForm, verifyWebhook, settleEvent } = await import('./pay.mjs');

let pass = 0; let fail = 0;
const ok = (n, c) => { if (c) { pass += 1; console.log('  ✓', n); } else { fail += 1; console.log('  ✗', n); } };

ok('unconfigured Stripe → stripeConfigured() is false', stripeConfigured() === false);

// configure a test secret
const SECRET = 'whsec_testsecret';
fs.writeFileSync(process.env.STRIPE_CONFIG, JSON.stringify({ secretKey: 'sk_test_x', webhookSecret: SECRET }));
ok('configured → stripeConfigured() is true', stripeConfigured() === true);

const form = checkoutForm({ cents: 500, payId: 'pidX', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
ok('checkoutForm carries the payId in metadata (NOT the cap)', form.get('metadata[payId]') === 'pidX' && form.get('line_items[0][price_data][unit_amount]') === '500' && !form.toString().includes('cap'));

// record a pending payment (the cap stays server-side, only payId travels)
const payId = recordPending({ cap: 'SECRET_SWISSNUM', sid: 'chat-9', uusd: 5_000_000, now: 'now' });
ok('recordPending returns a payId', typeof payId === 'string' && payId.length > 8);

// build a signed webhook event and verify it
const mkEvent = pid => JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { payId: pid } } } });
const sign = (raw, secret) => { const t = 1700000000; const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'); return `t=${t},v1=${v1}`; };
const raw = mkEvent(payId);
ok('verifyWebhook accepts a correctly-signed body', verifyWebhook(raw, sign(raw, SECRET), SECRET) === true);
ok('verifyWebhook rejects a wrong signature', verifyWebhook(raw, sign(raw, 'wrong'), SECRET) === false);
ok('verifyWebhook rejects a tampered body', verifyWebhook(`${raw} `, sign(raw, SECRET), SECRET) === false);

// settle the event → returns the purse to credit
const settled = settleEvent(JSON.parse(raw));
ok('settleEvent returns {cap, sid, uusd} for the pending payId', settled && settled.cap === 'SECRET_SWISSNUM' && settled.sid === 'chat-9' && settled.uusd === 5_000_000);
// idempotency: settling the same event again returns null (credit at most once)
ok('settleEvent is idempotent (second settle → null)', settleEvent(JSON.parse(raw)) === null);
// unknown payId → null
ok('settleEvent on an unknown payId → null', settleEvent(JSON.parse(mkEvent('nope'))) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
