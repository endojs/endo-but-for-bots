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

export const makePurse = (initial = 0) => {
  let balance = Math.max(0, Math.round(Number(initial) || 0));
  let granted = balance;
  return harden({
    balance: () => balance,
    granted: () => granted,
    canAfford: (amt) => balance >= Math.max(0, Math.round(Number(amt) || 0)),
    credit: (amt) => { const a = Math.max(0, Math.round(Number(amt) || 0)); balance += a; granted += a; return balance; },
    debit: (amt) => { balance -= Math.max(0, Math.round(Number(amt) || 0)); return balance; },
    set: (amt) => { const a = Math.max(0, Math.round(Number(amt) || 0)); balance = a; granted = a; return balance; },
  });
};
harden(makePurse);
