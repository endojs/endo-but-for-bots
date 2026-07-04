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
  --name privacy-account --powers @none
```

with the following in the formula `env`:

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
await E(control).revoke(); // brick issuer + subs, pause open cards
```

## How the budget holds

Creating a card reserves its full spend limit from the grant's budget
before the Privacy.com API is called, and every card is created with
`spend_limit_duration: FOREVER`, so Privacy.com itself enforces each
card's cap.
Even if the daemon halts, outstanding cards cannot draw more than what
was already reserved.
Closing a card returns `spend_limit − approved spend` to the budget;
ambiguous transaction states count as spent, so refunds err small.
