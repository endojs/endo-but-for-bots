// purse.mjs — Increment 1 in-memory stub ledger for the prepaid inference toll-bridge.
//
// A purse holds a µUSD balance for ONE conversation. This is deliberately a throwaway
// stub: Increment 6 migrates the ledger to agora's conserved, journaled, restart-safe
// `makeBank` (the journal becomes the social-collateral draw history), behind this same
// {balance, canAfford, credit, debit} shape. Until then, balances are in-memory and
// reset on a server restart (see SELF-IMPROVEMENT-ROADMAP.md risk #6).
//
// `granted` tracks the total ever granted (initial + top-ups) so the UI can show
// "X of Y left". `debit` may drive the balance at or below zero by at most one call's
// cost (we check-before / charge-after); the NEXT call is then refused by canAfford.

// opts.granted restores the total-ever-granted when rehydrating a persisted purse (it can exceed the
// balance once spending has happened). opts.onChange(balance, granted) fires after every mutation, so a
// caller can persist the new balance — that is how purses survive a restart.
export const makePurse = (initial = 0, { granted: grantedInit, onChange } = {}) => {
  let balance = Math.max(0, Math.round(Number(initial) || 0));
  let granted = grantedInit != null ? Math.max(balance, Math.round(Number(grantedInit) || 0)) : balance;
  const changed = () => { if (typeof onChange === 'function') { try { onChange(balance, granted); } catch { /* persistence is best-effort */ } } };
  return harden({
    balance: () => balance,
    granted: () => granted,
    canAfford: (amt) => balance >= Math.max(0, Math.round(Number(amt) || 0)),
    credit: (amt) => { const a = Math.max(0, Math.round(Number(amt) || 0)); balance += a; granted += a; changed(); return balance; },
    debit: (amt) => { balance -= Math.max(0, Math.round(Number(amt) || 0)); changed(); return balance; },
    set: (amt) => { const a = Math.max(0, Math.round(Number(amt) || 0)); balance = a; granted = a; changed(); return balance; },
  });
};
harden(makePurse);
