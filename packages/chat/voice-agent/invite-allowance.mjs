// invite-allowance.mjs — the durable registry behind "an invite carries a usage-credit allowance".
//
// When the owner mints an invite WITH an allowance (µUSD — the same units as component-shares' and
// invite-policy's allowance schemes), the new member's caps get ONE shared wallet, seeded at ZERO and
// credited exactly the allowance the inviter's purse was debited (conservation lives in the server
// wiring — this module only remembers which cap draws from which wallet). This mirrors the Bluesky
// zero-until-claim namespace model (bluesky-claim.mjs): wallet routing by cap, one wallet per invite.
//
// `adopt(parentCap, childCap)` extends the wallet to caps MINTED FROM a funded cap (sub-chats via
// /subchat), so a member's delegated sub-agents spend the member's allowance — not a fresh thin-air
// default purse. Adoption is a no-op for parents without a wallet.
//
// CAP-HYGIENE: only SHA-256 hashes of caps touch disk (like purse-store / bluesky-claim); the wallet id
// IS a cap hash, so it designates without disclosing. Nothing here holds a purse — purses stay with the
// server's purse ledger, keyed `invite-wallet:<walletId>`.
//
// Plain-node harden fallback (no-op under the SES server), same as bluesky-claim.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const hashCap = c => crypto.createHash('sha256').update(`invite-allowance:${String(c)}`).digest('hex').slice(0, 32);

export const makeInviteAllowances = ({ file } = {}) => {
  const read = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; d.wallets = d.wallets || {}; d.children = d.children || {}; return d; } catch { return { wallets: {}, children: {} }; } };
  const write = d => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); } catch { /* best-effort; a lost write costs at most one registration */ } };

  // fund(cap, uusd, label?) → walletId. Registers `cap` as the OWNER of an allowance wallet (idempotent;
  // repeat funding accumulates `granted` for the ledger view). The caller credits the actual purse.
  const fund = (cap, uusd, label = '') => {
    const wid = hashCap(cap);
    const d = read();
    const prior = d.wallets[wid];
    d.wallets[wid] = { granted: (prior ? prior.granted : 0) + Math.max(0, Math.round(Number(uusd) || 0)), label: String(label || (prior ? prior.label : '')), createdAt: prior ? prior.createdAt : new Date().toISOString() };
    write(d);
    return wid;
  };

  // walletIdFor(cap) → the wallet this cap draws from (its own, or an adopted parent's), or null.
  const walletIdFor = cap => {
    const h = hashCap(cap);
    const d = read();
    if (d.wallets[h]) return h;
    return d.children[h] || null;
  };

  // adopt(parentCap, childCap) — a cap minted FROM a wallet-bearing cap draws from the SAME wallet.
  // Returns the shared walletId, or null when the parent has no wallet (no-op — nothing recorded).
  const adopt = (parentCap, childCap) => {
    const wid = walletIdFor(parentCap);
    if (!wid) return null;
    const d = read();
    d.children[hashCap(childCap)] = wid;
    write(d);
    return wid;
  };

  const info = wid => read().wallets[String(wid || '')] || null;
  const list = () => { const d = read(); return Object.entries(d.wallets).map(([wid, w]) => ({ walletId: wid, ...w, members: 1 + Object.values(d.children).filter(x => x === wid).length })); };

  return harden({ fund, walletIdFor, adopt, info, list });
};
harden(makeInviteAllowances);
