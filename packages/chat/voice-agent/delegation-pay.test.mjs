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

test('normalizeGrant: raw ERC-7715 wallet response → the redeemable triple; junk/old-fixtures → null', () => {
  // CURRENT MetaMask Flask (13.x) ExecutionPermissionResponse — request-echo + TOP-LEVEL
  // context/delegationManager/dependencies (ground truth: Flask 13.37 bundle schema + the
  // wallet-e2e probes, 2026-07-01). This is the shape the live grant flow now round-trips.
  const flask = {
    chainId: '0xaa36a7', from: '0xFFf0000000000000000000000000000000000001', to: '0x2222222222222222222222222222222222222222',
    permission: { type: 'native-token-periodic', isAdjustmentAllowed: true, data: { periodAmount: '0x38d7ea4c68000', periodDuration: 2592000, startTime: 1, justification: 'x' } },
    rules: [{ type: 'expiry', data: { timestamp: 2 } }],
    context: '0xdef456', delegationManager: '0x3333333333333333333333333333333333333333',
    dependencies: [{ factory: '0xfa', factoryData: '0xfd' }],
  };
  assert.deepEqual(dp.normalizeGrant(flask), { permissionsContext: '0xdef456', delegationManager: '0x3333333333333333333333333333333333333333', accountMetadata: [{ factory: '0xfa', factoryData: '0xfd' }] }, 'current Flask 13.x shape');
  assert.deepEqual(dp.normalizeGrant([flask]), dp.normalizeGrant(flask), 'array-wrapped (the wallet returns a list)');
  // the 2025 toolkit-0.12 nesting still normalizes (older wallets / stored grants)
  const raw = { context: '0xabc123', signerMeta: { delegationManager: '0x1111111111111111111111111111111111111111' }, dependencyInfo: [{ factory: '0xf', factoryData: '0xd' }] };
  assert.deepEqual(dp.normalizeGrant(raw), { permissionsContext: '0xabc123', delegationManager: '0x1111111111111111111111111111111111111111', accountMetadata: [{ factory: '0xf', factoryData: '0xd' }] });
  const norm = { permissionsContext: '0xff00', delegationManager: null, accountMetadata: [] };
  assert.deepEqual(dp.normalizeGrant(norm), norm, 'already-normalized passes through');
  // the shapes that used to slip through and then fail at charge time
  for (const junk of [null, undefined, 'x', {}, { sig: 'mock' }, { context: '0xMOCKGRANT' }, { context: 'deadbeef' }]) {
    assert.equal(dp.normalizeGrant(junk), null, `rejects ${JSON.stringify(junk)}`);
  }
});

test('grantParams: null when the settlement service is unreachable; to+chain+rate when up', async () => {
  assert.equal(await dp.grantParams(async () => { throw new Error('down'); }), null, 'unreachable → null (client refuses the wallet round-trip)');
  const info = { ok: true, delegate: '0x2222222222222222222222222222222222222222', chainId: '0xaa36a7', chain: 'sepolia' };
  const gp = await dp.grantParams(async () => ({ json: async () => info }));
  assert.deepEqual(gp, { chainId: '0xaa36a7', to: info.delegate, signer: info.delegate, chain: 'sepolia', weiPerUsd: '1000000000000' }, 'vends `to` (the 7715 delegate) + legacy signer alias; weiPerUsd = weiPerUusd × 1e6');
});
