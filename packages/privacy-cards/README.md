# @endo/privacy-cards

[Privacy.com](https://privacy.com) virtual cards as an Endo daemon
caplet.
The account owner provisions the caplet once with their API key; the
caplet mints attenuated **card issuer** facets that can be granted to
guests and agents.
An issuer can create cards — but only up to a fixed budget across any
number of cards — and can never see the API key, other grants' cards,
or the account at large.

See [`designs/privacy-card-issuer.md`](../../designs/privacy-card-issuer.md)
for the user stories, the budget (reservation) model, and the threat
notes.

## Provisioning (account owner)

```sh
endo make --UNCONFINED packages/privacy-cards/src/caplet.js \
  --name privacy-account --powers @none \
  -E PRIVACY_API_KEY="$PRIVACY_API_KEY" \
  -E PRIVACY_STATE_FILE="$HOME/.local/state/endo/privacy-ledger.json"
```

The `-E`/`--env` flags populate the formula `env`:

- `PRIVACY_API_KEY` (required) — the account API key.
  It stays inside the caplet; no facet method returns it.
- `PRIVACY_API_BASE_URL` (optional) — defaults to
  `https://api.privacy.com/v1`; use `https://sandbox.privacy.com/v1`
  to rehearse against the sandbox.
- `PRIVACY_STATE_FILE` (optional) — path for the JSON budget ledger,
  so grants survive daemon restarts.

## Granting a budget

```js
// Owner side: mint a $1000 grant for an agent.
const { issuer, control } = await E(account).makeIssuer('shopper', {
  budgetCents: 100_000,
});
// Send `issuer` to the agent; keep `control`.

// Or a renewing allowance: $200 now and $200 more each month,
// carrying over when unspent (root grants only).
await E(account).makeIssuer('kid', {
  budgetCents: 20_000,
  renewal: { amountCents: 20_000, periodMs: 30 * 24 * 60 * 60 * 1000 },
});
```

For a reference that survives daemon restarts, name an eval formula
over the recovery method — the daemon persists the formula and
re-derives the facet on demand:

```sh
endo eval "E(account).provideIssuer('shopper').then(kit => kit.issuer)" \
  account:privacy-account --name shopper-issuer
endo send agent @shopper-issuer
```

```js
// Agent side: create cards freely — the sum of the spend limits of
// all cards ever created here can never exceed the budget.
const card = await E(issuer).createCard({
  spendLimitCents: 4_299,
  memo: 'noise-cancelling headphones',
});
// card.pan, card.cvv, card.expMonth, card.expYear — ready for checkout.
const left = await E(issuer).remainingCents();
// Closing a card refunds its unspent reservation to the budget.
await E(issuer).closeCard(card.cardToken);
// Budgets split recursively:
const { issuer: sub } = await E(issuer).makeSubIssuer('vendor-a', {
  budgetCents: 25_000,
});
```

```js
// Owner side, later:
await E(control).audit(); // budget, remaining, per-card reservations
await E(control).reconcile(); // + live approved spend per card
const auditor = await E(control).makeAuditor(); // read-only facet for
// an accountant: audit() and reconcile(), no mutation authority
await E(control).startSpendMonitor({ intervalMs: 60_000 }); // poll
await E(control).readSpendMonitor(); // latest per-card approved spend
await E(control).deposit(50_000); // top the budget up
await E(control).revoke(); // brick issuer + subs, pause open cards

// After a crash or an interrupted create, reconcile the ledger with
// reality: adopt cards found at the API by their grant memo tag, and
// clear reservations that never became cards.
await E(account).repair();
```

## Confined variant

`src/confined-caplet.js` is the same account with the opposite trust
posture: it imports no Node builtins and holds **no API key** — its
`powers` must be a mediated HTTP capability, bound to the Privacy base
URL, that injects the `Authorization` header outside the caplet (the
endoclaw-oauth idiom).
A fully compromised confined caplet cannot exfiltrate the key because
no path from its capabilities reaches it.
Both entry points share the portable core in `src/account.js`; the
confined one currently keeps its ledger in memory and disables spend
monitors, pending standard storage and timer capabilities.

## How the budget holds

Creating a card reserves its full spend limit from the grant's budget
before the Privacy.com API is called, and every card is created with
`spend_limit_duration: FOREVER`, so Privacy.com itself enforces each
card's cap.
Even if the daemon halts, outstanding cards cannot draw more than what
was already reserved.
Closing a card returns `spend_limit − approved spend` to the budget;
ambiguous transaction states count as spent, so refunds err small.
