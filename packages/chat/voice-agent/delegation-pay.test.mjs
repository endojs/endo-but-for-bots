// delegation-pay.test.mjs — the ERC-7715 SUBSCRIPTION rail: a recurring allowance the server auto-draws from to
// keep the purse funded (inference + hosting), respecting the per-period cap + resetting each period. The
// on-chain settlement is mocked (fetchImpl) — this proves OUR accounting, which is what "simply pay" rides on.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
process.env.DELEGATION_STORE = path.join(TMP, 'deleg.json');
process.env.GATOR_CONFIG = path.join(TMP, 'gator.json');
fs.writeFileSync(process.env.GATOR_CONFIG, JSON.stringify({ chargeServerUrl: 'http://mock', treasury: '0xpayee', weiPerUusd: '1000000' }));
const { default: test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const dp = await import('./delegation-pay.mjs');
const mockFetch = async () => ({ json: async () => ({ ok: true, ref: '0xMOCK' }) });

test('subscription auto-top-up: credits within the period cap, refuses when reached, resets next period', async () => {
  const cap = 'capX', sid = 's1', t0 = 1_000_000_000_000;
  dp.recordDelegation({ cap, sid, delegation: { sig: 'x' }, now: new Date(t0).toISOString(), subscription: { periodUusd: 3_000_000, periodMs: 86400000 } }); // $3/day
  let r = await dp.autoTopup({ cap, sid, uusd: 1_000_000, fetchImpl: mockFetch, now: t0 });
  assert.deepEqual([r.ok, r.uusd], [true, 1_000_000], 'first top-up $1');
  r = await dp.autoTopup({ cap, sid, uusd: 5_000_000, fetchImpl: mockFetch, now: t0 });
  assert.deepEqual([r.ok, r.uusd], [true, 2_000_000], 'second capped to the $2 left in the period');
  r = await dp.autoTopup({ cap, sid, uusd: 1_000_000, fetchImpl: mockFetch, now: t0 });
  assert.equal(r.ok, false, 'period cap reached → refused');
  assert.equal(dp.subscriptionStatus(cap, sid, t0).periodRemaining, 0, 'status shows 0 left this period');
  r = await dp.autoTopup({ cap, sid, uusd: 1_000_000, fetchImpl: mockFetch, now: t0 + 86400001 });
  assert.equal(r.ok, true, 'cap RESETS in the next period');
});

test('a plain (non-subscription) delegation is not auto-drawn', async () => {
  dp.recordDelegation({ cap: 'capY', sid: 's', delegation: { x: 1 }, now: new Date().toISOString() }); // no subscription
  assert.equal((await dp.autoTopup({ cap: 'capY', sid: 's', uusd: 1e6, fetchImpl: mockFetch })).ok, false);
  assert.equal(dp.subscriptionStatus('capY', 's').subscribed, false);
});

test('status never leaks the delegation/key — only terms + remaining', () => {
  const st = dp.subscriptionStatus('capX', 's1');
  assert.equal(JSON.stringify(st).includes('sig'), false);
  assert.ok('periodRemaining' in st && 'periodUusd' in st);
});
