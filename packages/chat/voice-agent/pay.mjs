// pay.mjs — Phase 2 billing: convert an exhausted prepaid allowance into a paid top-up via Stripe
// Checkout. The purse (purse.mjs) stays the REAL-TIME meter/quota; Stripe only moves money. Research
// note: raw Stripe credits apply at invoice finalization, NOT in real time — so we keep gating in the
// purse and use Stripe purely for the payment, crediting the purse on the webhook.
//
// CAP HYGIENE: the swissnum NEVER goes to Stripe. /pay/checkout stores {cap, sid, uusd} server-side
// under a random `payId`, and only `payId` travels in Stripe metadata; the webhook maps it back.
import fs from 'node:fs';
import crypto from 'node:crypto';

import { writeJsonAtomic, loadJson } from './write-json-atomic.mjs';

const HOME = process.env.HOME || '/home/dan';
const STRIPE_CFG = process.env.STRIPE_CONFIG || `${HOME}/.config/field-agent/stripe.json`;
const PAY_STORE = process.env.PAY_STORE || `${HOME}/.local/state/field-agent/pending-payments.json`;

// stripe.json: { secretKey, webhookSecret, successUrl?, cancelUrl? }. Absent → payments not set up.
export const loadStripeCfg = () => { try { const c = JSON.parse(fs.readFileSync(STRIPE_CFG, 'utf8')); return (c && c.secretKey) ? c : null; } catch { return null; } };
export const stripeConfigured = () => !!loadStripeCfg();

// INT-1: MONEY store — atomic writes (temp+fsync+rename), a .bak of the last-known-good, and a GUARDED
// load that refuses to silently reset to {} on a corrupt-but-present file (it would drop pending payments
// mid-redeem). A throw here surfaces the corruption instead of quietly losing money state.
const loadPays = () => loadJson(PAY_STORE, {}, { guard: true });
const savePays = o => { try { writeJsonAtomic(PAY_STORE, o, { pretty: true, mode: 0o600, bak: true }); } catch { /* best effort */ } };

// Record a pending payment; returns the payId that travels in Stripe metadata (no cap leaves the host).
export const recordPending = ({ cap, sid, uusd, now }) => {
  const payId = crypto.randomBytes(12).toString('hex');
  const pays = loadPays();
  pays[payId] = { cap, sid, uusd, status: 'pending', createdAt: now };
  savePays(pays);
  return payId;
};

// Form-encode a Stripe Checkout Session create (pay mode, one ad-hoc line item for `cents`).
export const checkoutForm = ({ cents, payId, successUrl, cancelUrl }) => {
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('line_items[0][quantity]', '1');
  f.set('line_items[0][price_data][currency]', 'usd');
  f.set('line_items[0][price_data][unit_amount]', String(cents));
  f.set('line_items[0][price_data][product_data][name]', 'Agent C credits');
  f.set('metadata[payId]', payId);
  f.set('success_url', successUrl);
  f.set('cancel_url', cancelUrl);
  return f;
};

// Verify a Stripe webhook signature (t=…,v1=… header; signed payload = `${t}.${rawBody}`).
export const verifyWebhook = (rawBody, sigHeader, secret) => {
  try {
    const parts = Object.fromEntries(String(sigHeader || '').split(',').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    if (!parts.t || !parts.v1 || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
};

// On a verified checkout.session.completed event, resolve the pending payment and hand the caller
// {cap, sid, uusd} to credit (idempotent: a payId is credited at most once). Returns null otherwise.
export const settleEvent = (evt) => {
  if (!evt || evt.type !== 'checkout.session.completed') return null;
  const payId = evt.data?.object?.metadata?.payId;
  if (!payId) return null;
  const pays = loadPays();
  const rec = pays[payId];
  if (!rec || rec.status !== 'pending') return null;
  rec.status = 'paid';
  savePays(pays);
  return { cap: rec.cap, sid: rec.sid, uusd: rec.uusd, payId };
};
