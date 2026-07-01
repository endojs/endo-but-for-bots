// bluesky-ns-wallet.mjs — ONE conserved wallet per Bluesky namespace, adoptable by its sub-chat caps.
//
// Before this module, a Bluesky-namespace member's /subchat children fell through purseFor's default
// branch and each got a FRESH default-allowance purse minted from nothing (thin air) — invite wallets
// adopted (invite-allowance.mjs), Bluesky didn't. Now a namespace gets a registered wallet, keyed
// `bsky-ns-wallet:<walletId>` in the server's purse ledger, and children ADOPT it exactly the way
// invite-wallet children do (same registry shape — this module rides makeInviteAllowances).
//
// CONSERVATION (the semantics change, made conservative):
//   - The wallet is SEEDED with `seedUusd` (BLUESKY_NS_WALLET_UUSD, default $5 in the server) as a
//     TRANSFER from wallet:root — a real debit, never minted. If the root wallet can't cover the full
//     seed, we clamp to what it has (a short seed + a log line beats stranding a signed-in user).
//   - Seeding happens ONCE, at ensure() time: for a NEW namespace that IS creation (the claim flow's
//     grantCredits routes through purseFor → ensure); for a PRE-EXISTING namespace it's first use.
//   - MIGRATION: pre-registry namespaces kept their claim-granted credit in the legacy shared purse
//     (`${nsCap}:_namespace`, zero-seeded). ensure() moves that balance into the new wallet, so a
//     user who already claimed keeps every µUSD they had — plus the seed.
//
// CAP-HYGIENE: inherited from invite-allowance.mjs — only SHA-256 hashes of caps touch disk; the
// walletId IS a cap hash. Purses stay in the server's purse ledger (also hashed at rest).
//
// Plain-node harden fallback comes with the invite-allowance import.
import { makeInviteAllowances } from './invite-allowance.mjs';

export const makeBskyNsWallets = ({ file, purseAt, rootWallet, seedUusd = 0, legacyKeyFor, log = () => {} } = {}) => {
  const reg = makeInviteAllowances({ file });
  const purseKeyFor = wid => `bsky-ns-wallet:${wid}`;

  // ensure(nsCap) → walletId. Register the namespace's wallet on first use (idempotent): seed it from
  // wallet:root (conserved transfer, clamped to what root holds) + migrate any legacy-purse balance in.
  const ensure = nsCap => {
    const prior = reg.walletIdFor(nsCap);
    if (prior) return prior;
    const root = rootWallet();
    const want = Math.max(0, Math.round(Number(seedUusd) || 0));
    const seed = Math.min(want, Math.max(0, root.balance())); // never mint: clamp to what root actually has
    if (seed < want) log(`root wallet short — seeding ${seed} of ${want}µUSD (top up under Settings → Usage)`);
    const wid = reg.fund(nsCap, seed, 'bluesky namespace');
    const w = purseAt(purseKeyFor(wid), 0);
    if (seed > 0) { root.debit(seed); w.credit(seed); }
    if (typeof legacyKeyFor === 'function') {
      const legacy = purseAt(legacyKeyFor(nsCap), 0);
      const bal = Math.max(0, legacy.balance());
      if (bal > 0) { legacy.debit(bal); w.credit(bal); log(`migrated ${bal}µUSD from the legacy shared namespace purse`); }
    }
    return wid;
  };

  return harden({ ensure, adopt: reg.adopt, walletIdFor: reg.walletIdFor, purseKeyFor, info: reg.info, list: reg.list });
};
harden(makeBskyNsWallets);
