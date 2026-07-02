// toll-bridge.mjs — the CENTRAL meter for two rights that cost real resources:
//
//   1. EDIT  — rewriting a component/site spends AI credits. Priced at the real model
//              usage (costModel µUSD), debited from the editor's toll account. An account
//              that can't afford inference is refused BEFORE the model call (the meter.mjs
//              rule: never route exhaustion through the model itself).
//   2. SAVE / HOST — publishing an app is a HOSTING right: storage over time, NOT a flat
//              fee. Each published artifact accrues rent = bytes × elapsed × rate, debited
//              from the same account. Saving is refused when the account can't host.
//
// One ACCOUNT (an opaque secret string) funds both. The OWNER funds their own account; when
// you share an editing cap with someone you fund THEIR account from the allowance you grant —
// so "publishing rights come out of the allowance" (dan). fund() is the only balance-increasing
// op and is root-gated at the route layer; charge/accrue only ever decrease a balance, so a
// leaked account can be griefed but never used to steal. Account secrets stay host-side
// (the SPWA server calls this over loopback; the browser never sees the account).
//
// Reuses purse.mjs / purse-store.mjs (durable, hashed) + costModel.costOf — the same µUSD
// ledger the inference toll-bridge uses, so edit-spend and hosting land in ONE accounting.

import crypto from 'node:crypto';

import { writeJsonAtomic, loadJson } from './write-json-atomic.mjs';

const DAY_MS = 86_400_000;
// Hosting rate: storage × time. Default ≈ $0.02 / MB / 30 days = 667 µUSD per MB-day. Storage
// over time is accounted (not flat): a 50 KB app ≈ 33 µUSD/day; many/large apps add up.
const DEFAULT_HOST_UUSD_PER_MB_DAY = Number(process.env.HOST_UUSD_PER_MB_DAY) || 667;

export const makeTollBridge = ({ purseStore, makePurse, costOf, ledgerFile, hostRate = DEFAULT_HOST_UUSD_PER_MB_DAY }) => {
  const KEY = account => `toll:${crypto.createHash('sha256').update(`toll:${account}`).digest('hex').slice(0, 32)}`;
  const purses = new Map();
  const accountPurse = account => {
    const k = KEY(String(account || ''));
    let p = purses.get(k);
    if (!p) {
      const s = purseStore.get(k); // {balance, granted} if ever persisted
      p = makePurse(s ? s.balance : 0, { granted: s ? s.granted : 0, onChange: (b, g) => purseStore.set(k, b, g) });
      if (!s) purseStore.set(k, p.balance(), p.granted());
      purses.set(k, p);
    }
    return p;
  };

  // hosting ledger: key → { account, bytes, appName, since, lastTick, accrued, delinquent }
  // INT-1: MONEY store (hosting-rent ledger) — atomic write + .bak + guarded load (a corrupt-but-present
  // ledger must NOT silently reset to {}, which would erase every artifact's accrued rent + delinquency).
  let ledger = {};
  try { ledger = loadJson(ledgerFile, {}, { guard: true }); } catch (e) { if (e && e.code === 'STORE_CORRUPT') throw e; /* other IO → fresh */ }
  const saveLedger = () => { try { writeJsonAtomic(ledgerFile, ledger, { pretty: true, bak: true }); } catch { /* best-effort */ } };
  const rentDue = (e, now) => { const last = Date.parse(e.lastTick || e.since) || now; return Math.round(((e.bytes || 0) / 1e6) * hostRate * Math.max(0, now - last) / DAY_MS); };

  // Accrue storage rent for every artifact up to `now`, debiting each owner's account. Short-paid
  // entries are flagged delinquent (not auto-removed — taking down a site is the operator's call).
  const accrue = (now = Date.now()) => {
    let total = 0; const delinquent = [];
    for (const [k, e] of Object.entries(ledger)) {
      const due = rentDue(e, now);
      if (due <= 0) continue;
      const p = accountPurse(e.account); const pay = Math.min(due, p.balance());
      if (pay > 0) p.debit(pay);
      e.lastTick = new Date(now).toISOString(); e.accrued = (e.accrued || 0) + pay;
      e.delinquent = pay < due; if (e.delinquent) delinquent.push(k);
      total += pay;
    }
    if (total > 0 || delinquent.length) saveLedger();
    return { total, delinquent };
  };

  const quote = () => harden({
    hostUuidPerMbDay: hostRate,
    hosting: `storage × time: ${hostRate} µUSD per MB per day (≈ $${(hostRate * 30 / 1e6).toFixed(4)} / MB / month)`,
    edit: 'priced at the real model usage (costModel µUSD); refused before the model call when the account is empty',
  });

  const check = account => { const p = accountPurse(account); return { ok: p.canAfford(1), remaining: p.balance(), allowance: p.granted() }; };

  const chargeEdit = ({ account, model, usage }) => {
    const p = accountPurse(account); const cost = costOf(model, usage) || 0;
    if (cost > 0 && !p.canAfford(cost)) return { ok: false, error: 'insufficient', cost, remaining: p.balance() };
    if (cost > 0) p.debit(cost);
    return { ok: true, cost, remaining: p.balance() };
  };

  // Saving requires the HOSTING right: the account must be able to host at all, and pay the upfront
  // rent for any NEW bytes (a re-save at the same size pays only ongoing accrued rent).
  const chargeSave = ({ account, key, bytes, appName }, now = Date.now()) => {
    accrue(now);
    const p = accountPurse(account);
    if (!p.canAfford(1)) return { ok: false, error: 'no hosting allowance — top up to keep this app published', remaining: p.balance() };
    const existing = ledger[key];
    const newBytes = Math.max(0, Math.round(bytes || 0));
    const deltaMb = Math.max(0, (newBytes - (existing ? existing.bytes : 0))) / 1e6;
    const upfront = existing ? Math.round(deltaMb * hostRate) : Math.max(1, Math.round((newBytes / 1e6) * hostRate)); // one day's rent on first publish / growth
    if (upfront > 0 && !p.canAfford(upfront)) return { ok: false, error: 'insufficient hosting allowance for this size', need: upfront, remaining: p.balance() };
    if (upfront > 0) p.debit(upfront);
    ledger[String(key)] = { account: String(account), bytes: newBytes, appName: String(appName || ''), since: existing ? existing.since : new Date(now).toISOString(), lastTick: new Date(now).toISOString(), accrued: (existing ? existing.accrued || 0 : 0) + upfront, delinquent: false };
    saveLedger();
    return { ok: true, charged: upfront, remaining: p.balance() };
  };

  const unregister = (account, key) => { const e = ledger[key]; if (e && e.account === String(account)) { delete ledger[key]; saveLedger(); return { ok: true }; } return { ok: false, error: 'unknown artifact for this account' }; };
  const fund = ({ account, uusd }) => { const p = accountPurse(account); p.credit(Math.max(0, Math.round(uusd || 0))); return { ok: true, remaining: p.balance(), allowance: p.granted() }; };
  const accountStatus = (account, now = Date.now()) => { accrue(now); const p = accountPurse(account); const hosting = Object.entries(ledger).filter(([, e]) => e.account === String(account)).map(([key, e]) => ({ key, appName: e.appName, bytes: e.bytes, since: e.since, accrued: e.accrued, delinquent: !!e.delinquent })); return { remaining: p.balance(), allowance: p.granted(), hosting }; };

  return harden({ accountPurse, quote, check, chargeEdit, chargeSave, unregister, fund, accrue, accountStatus });
};
harden(makeTollBridge);
