# Privacy.com Card Issuer Capability

| | |
|---|---|
| **Created** | 2026-07-04 |
| **Updated** | 2026-07-04 |
| **Author** | Aaron Davis (prompted) |
| **Status** | In Progress |

## Status

Phases 1 through 4 are implemented in `packages/privacy-cards`, with
the deviations and residue noted per phase under "Phased
Implementation" below.

- **Phase 1** — account caplet, budget ledger, issuer/control facets,
  unit tests against a mock Privacy API server.
- **Phase 2** — daemon integration tests (`test/daemon.test.js` forks
  a real daemon, provisions the caplet via `makeUnconfined`, and
  exercises the facets over CapTP), stranded-reservation repair
  (`E(account).repair()` adopts unknown cards by memo prefix and
  clears stale reservations), and the audit-only facet
  (`E(control).makeAuditor()`).
- **Phase 3** — renewing budgets via lazy carryover accrual against an
  injected clock (`makeIssuer(..., { renewal: { amountCents,
  periodMs } })`, root grants only), and polling spend telemetry
  (`startSpendMonitor` / `readSpendMonitor` / `stopSpendMonitor` on
  the control facet). Webhooks remain out of scope (inbound
  connectivity).
- **Phase 4** — the core is split into a portable, Node-free
  `src/account.js` consumed by two entry points: `src/caplet.js`
  (unconfined Node shell) and `src/confined-caplet.js`, which holds
  **no key at all** and runs over a mediated HTTP capability in the
  endoclaw-oauth shape. Durable per-grant references are delivered as
  persistent *eval formulas* over `provideIssuer` — proven across a
  daemon restart in the integration test — rather than waiting for
  SturdyRefs.

## What is the Problem Being Solved?

[Privacy.com](https://privacy.com) issues virtual payment cards through
a REST API.
The API is authenticated by a single bearer-style secret
(`Authorization: api-key <key>`), and that key carries the **whole
account**: whoever holds it can create cards against the owner's
funding source, raise limits on existing cards, read the full
transaction history, and pull the PAN and CVV of every card.
Privacy.com's own documentation is blunt about the stakes: *"You are
responsible for all financial activity on your Privacy.com account,
inclusive of API, CLI or MCP activity."*

Two audiences want to use the account without holding the key:

- **People** the owner trusts partially — a kid with an allowance, a
  contractor buying project supplies, a roommate managing shared
  subscriptions.
- **AI agents** the owner trusts even less — a shopping agent that
  needs to check out with a real card number, but that is one prompt
  injection away from being an adversary.

Privacy.com natively enforces **per-card** spend limits
(`spend_limit` in cents, with `FOREVER` / `MONTHLY` / `ANNUALLY` /
`TRANSACTION` durations), which is excellent last-line protection for a
single card.
But it has **no cross-card budget primitive**: nothing stops a key
holder from creating a thousand $1000 cards.
"Bob may spend up to $1000 in total, across any number of cards" is
exactly the grant people want to make, and it cannot be expressed with
the API key alone.

This design wraps the Privacy.com API in an Endo daemon caplet (an
unconfined `make-unconfined` formula) that:

1. Holds the API key structurally out of reach of guests, in the
   [endoclaw-oauth](endoclaw-oauth.md) idiom — authority to *use*, not
   authority to *extract*.
2. Adds the missing cross-card budget as daemon-side ledger code:
   issuer facets that reserve every card's spend limit against a
   fixed budget, so the sum of limits ever issued under a grant can
   never exceed it.
3. Follows the [daemon-capability-bank](daemon-capability-bank.md)
   patterns: caretaker separation (issuer facet for the guest, control
   facet for the host), recursive attenuation (issuers can mint
   sub-issuers from their own remaining budget), and per-method
   `M.interface` guards.

## Privacy.com API Background

Facts the design leans on (from
[developers.privacy.com](https://developers.privacy.com/llms.txt)):

- **Auth**: `Authorization: api-key <key>` header on every request.
  Production base `https://api.privacy.com/v1`; a full-featured
  sandbox lives at `https://sandbox.privacy.com/v1`.
- **`POST /cards`** creates a card with `type` (`SINGLE_USE`,
  `MERCHANT_LOCKED`, `UNLOCKED`, `DIGITAL_WALLET`), `spend_limit`
  (integer cents), `spend_limit_duration`, `memo`, and `state`.
  The response is a `FullCard` including `pan` and `cvv`.
  `UNLOCKED` and `DIGITAL_WALLET` require extra account privileges.
- **`PATCH /cards/{card_token}`** updates `state` (`OPEN`, `PAUSED`,
  `CLOSED` — closing is irreversible) and `spend_limit`.
- **`GET /transactions`** lists transactions, filterable by
  `card_token`, with `result` (`APPROVED` or a decline reason),
  `status`, `amount`, and `settled_amount`.
- **Spend-limit durations**: `FOREVER` caps the lifetime total of a
  card; `TRANSACTION` caps each individual transaction but not the
  total.
  Only `FOREVER` (and, for expendable single-use cards, the implicit
  close-after-first-use behavior) gives the ledger a sound upper bound
  on what a card can ever draw.

## User Stories

The stories below drove the capability shape.
For each: who holds what, what Privacy.com enforces natively, and what
the daemon-side ledger must add.

### Story 1 — Household allowance

Alice's teenager Bob gets a $200 budget for game subscriptions.
Alice runs `endo make --UNCONFINED` once to provision the account
caplet with her API key, then asks it for an issuer:
`E(account).makeIssuer('bob', { budgetCents: 20_000 })`, names the
issuer facet, and sends it to Bob's guest agent.

Bob creates merchant-locked cards for each service.
Each card's `spend_limit` is deducted from his remaining budget when
the card is created.
When a subscription lapses he closes the card; the unspent portion
(limit minus approved transactions) returns to his budget.
Bob never sees Alice's key, her other cards, or her transaction
history — the issuer facet only reaches cards it issued.

- Privacy.com enforces: each card stops at its own limit; a
  merchant-locked card only works at the first merchant that
  authorizes it.
- Ledger adds: the $200 cross-card cap, per-grant card scoping,
  reclaim-on-close.

### Story 2 — AI shopping agent with a hard $1000 cap

Alice tells her Endo shopping agent to buy a list of items, total not
to exceed $1000.
The agent holds an issuer facet with `budgetCents: 100_000` and
creates one `SINGLE_USE` card per checkout, sized to the cart total.

If the agent is prompt-injected into buying "gift cards for a nice
stranger", the blast radius is the *remaining* budget, never more:
every card it can ever mint draws from the same $1000 reservation
pool, and the issuer has no method that raises its own budget.
The injection also cannot exfiltrate the API key (no method returns
it) and cannot touch cards issued under other grants.

Alice watches `E(control).audit()` and can `E(control).revoke()`
mid-spree, which pauses every card the grant issued and bricks the
issuer facet.

- Privacy.com enforces: per-card limits; single-use cards die after
  first settlement.
- Ledger adds: the cross-card cap that makes "any number of cards"
  safe; revocation that sweeps the whole grant.

### Story 3 — Contractor procurement with audit

Alice engages a contractor for a renovation with a $1000 materials
budget.
The contractor's issuer facet is restricted to
`allowedTypes: ['MERCHANT_LOCKED', 'SINGLE_USE']` and every card it
mints carries a ledger-imposed memo prefix (`[reno] …`), so Alice can
recognize the grant's cards in the Privacy.com dashboard and in
`GET /transactions` even outside Endo.
`E(control).audit()` reports, per card: limit reserved, approved
spend so far, and state — the contractor's spending is reviewable
without giving Alice's accountant the API key either (an audit-only
facet is a natural later attenuation).

- Privacy.com enforces: per-card limits, merchant locking.
- Ledger adds: budget, memo tagging, per-grant audit rollup.

### Story 4 — Sub-delegation: an agent splits its budget

Bob (story 1) or the shopping agent (story 2) wants to fan work out to
helpers — say three sub-agents comparison-shopping different vendors,
each allowed $250 of the $1000.
The issuer mints sub-issuers from its own remaining budget:
`E(issuer).makeSubIssuer('vendor-a', { budgetCents: 25_000 })`.
Creating a sub-issuer *reserves* its full budget from the parent, so
parent + children can never exceed the original grant; revoking a
sub-issuer refunds its unreserved remainder to the parent.
Attenuation is recursive with no host involvement — the classic purse
split.

- Privacy.com enforces: nothing here (it has no notion of grants).
- Ledger adds: everything — the reservation tree and refund flow.

### Story 5 — One card, no issuer power

Alice owes a friend exactly $42 and wants to hand over a card, not a
capability to make cards.
She (or any issuer holder) creates the card herself and sends the
resulting hardened card record — PAN, CVV, expiry — as plain data.
The recipient gets a spendable card and nothing else; there is no
facet to abuse.
This story needs no new machinery, but it anchors a boundary decision:
**card details are data, card *management* is capability** (see Design
Decision 6).

### Story 6 — Owner oversight across all grants

Alice, months later, wants to know where her $3000 of outstanding
grants stand.
The account facet (host-only) lists grants with budget, reserved,
reclaimed, and remaining; each grant's control facet drills into
per-card detail and can reconcile against live transaction data,
revoke, or top up (`E(control).deposit(amountCents)` — the only way a
budget ever grows, and it is on the *control* facet, not the issuer).

After a daemon restart the account caplet reloads its ledger from its
state file and `E(account).provideIssuer('bob')` re-yields the same
grant's facets for re-granting (see Durability).

### Story 7 — Renewing allowance (shipped in Phase 3)

"Bob gets $200 *per month*."
Implemented as **carryover accrual**: `makeIssuer('bob', {
budgetCents: 20_000, renewal: { amountCents: 20_000, periodMs:
MONTH_MS } })` credits the budget once per whole elapsed period,
computed lazily against an injected clock on every ledger access — no
timers, deterministic, and testable with a hand-cranked clock.
Unused allowance accumulates (an allowance, not a use-it-or-lose-it
quota); non-carryover semantics remain future work because a reset
must decide what to do with escrow spanning the period boundary.
Renewal is **root grants only**: a renewing sub-grant would accrue
against the parent's escrow without a reservation-time check.
Privacy.com's per-card `MONTHLY` duration is not a substitute — it
renews per card, so N cards would leak N budgets monthly.

### Story 8 — Near-real-time oversight (shipped in Phase 3, polling)

Alice wants to watch the shopping agent spend, not just bound it.
`E(control).startSpendMonitor({ intervalMs })` polls
`GET /transactions` for the grant's open cards;
`readSpendMonitor()` returns the latest per-card approved spend.
Monitors stop on revocation, on caplet cancellation, and on demand.
This is telemetry, not enforcement — the reservation model already
bounds exposure — so polling lag is acceptable.
**Webhooks remain out of scope**: they need a reachable HTTPS
endpoint and add nothing to the safety argument.

### Stories considered and deferred

- **Merchant category / hostname policies** ("only groceries").
  Privacy.com does not expose category controls on card creation;
  merchant-locked cards are the available approximation. Revisit if
  the API grows controls.
- **Non-carryover (resetting) budgets** — see Story 7.

## Capability Shape

```ts
// Root facet — host only. Holds the key; never leaves the owner.
interface PrivacyAccount {
  makeIssuer(grantName: string, opts: {
    budgetCents: number;               // total across all cards, forever
    allowedTypes?: CardType[];         // default ['SINGLE_USE', 'MERCHANT_LOCKED']
    memoPrefix?: string;               // default `[${grantName}]`
    renewal?: {                        // root grants only; carryover accrual
      amountCents: number;
      periodMs: number;
    };
  }): { issuer: CardIssuer, control: IssuerControl };
  provideIssuer(grantName: string):    // idempotent; restart recovery
    { issuer: CardIssuer, control: IssuerControl };
  listGrants(): GrantSummary[];
  repair(): Promise<RepairReport>;     // adopt stranded cards, clear pendings
  listFundingSources(): Promise<unknown[]>;
  status(): Promise<true>;             // GET /status; throws when unreachable
  help(): string;
}

// Guest facet — the attenuated authority this design exists to mint.
interface CardIssuer {
  createCard(opts: {
    spendLimitCents: number;           // reserved from budget; FOREVER duration
    type?: CardType;                   // must be in allowedTypes
    memo?: string;                     // prefixed with the grant's memoPrefix
  }): Promise<IssuedCard>;             // includes pan, cvv — data, not capability
  listCards(): CardStatus[];           // only this grant's cards
  pauseCard(cardToken: string): Promise<void>;
  resumeCard(cardToken: string): Promise<void>;
  closeCard(cardToken: string): Promise<number>; // returns refunded cents
  remainingCents(): number;
  budgetCents(): number;
  makeSubIssuer(subName: string, opts: { budgetCents: number, ... }):
    { issuer: CardIssuer, control: IssuerControl };  // recursive attenuation
  help(): string;
}

// Caretaker facet — held by whoever granted the issuer.
interface IssuerControl {
  audit(): GrantAudit;                 // ledger snapshot
  reconcile(): Promise<GrantAudit>;    // + live approved spend per card
  makeAuditor(): GrantAuditor;         // read-only attenuation: audit +
                                       // reconcile only (for an accountant)
  deposit(amountCents: number): void;  // only way a budget grows
  startSpendMonitor(opts: { intervalMs: number }): void;  // poll live spend
  readSpendMonitor(): SpendReport;     // { active, polls, cards, lastError? }
  stopSpendMonitor(): void;
  revoke(): Promise<RevocationReport>; // pause all cards, brick issuer + subs
  help(): string;
}
```

The guest never sees: the API key, `UNLOCKED`/`DIGITAL_WALLET` card
types (unless the grant explicitly allows them), other grants' cards,
account-wide transaction queries, or any spend-limit-raising method
(Privacy.com's `PATCH` can raise `spend_limit`; the issuer facet
deliberately exposes only state transitions).

## Budget Ledger Semantics

**Reservation (escrow) model.**
A grant's invariant is
`Σ reserved(open cards) + Σ reserved(sub-grants) ≤ budget`,
maintained *before* any network call:

1. `createCard(spendLimitCents: S)` first reserves `S` against the
   grant's remaining budget (throwing if insufficient), then calls
   `POST /card` with `spend_limit: S, spend_limit_duration: 'FOREVER'`.
   If the API call fails, the reservation is rolled back.
2. Privacy.com then enforces that the card can never draw more than
   `S`, so the account's total exposure under the grant is bounded by
   the budget **even if the daemon dies mid-flight** — the worst
   in-flight failure strands a reservation, which is conservative
   (under-spends, never over-spends).
3. `closeCard` transitions the card to `CLOSED` (irreversible), then
   reconciles: approved spend = Σ |amount| of the card's transactions
   whose `result` is `APPROVED` and whose status is not `DECLINED` or
   `VOIDED`; refund = `max(0, S − approvedSpend)` is returned to the
   budget.
   Reconciliation is deliberately conservative: ambiguous transaction
   states count as spent, so refunds can only be too small, never too
   large.
4. Mutations within one grant are serialized through a promise-chain
   mutex, so concurrent `createCard` calls cannot double-reserve
   (the same discipline as `packages/daemon/src/serial-jobs.js`).

**Why not observed-spend accounting?**
The alternative — issue cards freely, watch transactions, and pause
everything when cumulative spend hits $1000 — was rejected for v1.
It requires either webhooks (inbound connectivity, delivery gaps) or
polling (a race window per polling interval, multiplied by however
many open cards exist).
The reservation model is enforceable with zero inbound connectivity
and remains sound while the daemon is offline, at the cost of some
capital efficiency (an open card "holds" its full limit until closed).
For the target stories — allowances, agent budgets, procurement —
sizing cards to intended purchases makes that cost small.

**`FOREVER` only.**
Budgeted issuers always create cards with
`spend_limit_duration: 'FOREVER'`.
`TRANSACTION` duration would cap each swipe but allow unbounded
repeats; `MONTHLY`/`ANNUALLY` renew per card and would leak budget
every period.

## Durability

The caplet is provisioned as a `make-unconfined` formula, so the
daemon re-runs `make(powers, context, { env })` with the same `env`
after a restart — but in-memory ledger state and live facets die with
the worker.
Two mitigations, one per concern:

- **Ledger state**: every mutation is persisted as JSON to
  `env.PRIVACY_STATE_FILE` (write-to-temp + rename).
  `make()` reloads it on startup.
  Reservations are recorded *before* the corresponding `POST /cards`
  is attempted and finalized after, so a crash between the two strands
  a reservation rather than losing a card.
  `E(account).repair()` heals strandings: it lists cards at the API,
  adopts any card whose memo carries a grant's tag but which the
  ledger does not know (recording real exposure even past the budget —
  reality wins, and an overdrawn grant simply cannot issue until
  reconciled), then rolls back whatever pending reservations remain.
- **Facet references**: sub-facets returned from methods are ephemeral
  CapTP objects.
  `provideIssuer(grantName)` re-derives a grant's facet pair from the
  ledger, so the host can re-grant after restart.
  Better: a **persistent eval formula** turns that recovery into a
  durable per-grant reference using only existing daemon machinery —

  ```
  endo eval "E(account).provideIssuer('bob').then(kit => kit.issuer)" \
    account:privacy-account --name bob-issuer
  ```

  The daemon persists the *formula*, not the live object; after a
  restart, looking up `bob-issuer` re-evaluates it, which re-runs the
  account caplet (reloading the ledger from `PRIVACY_STATE_FILE`) and
  re-derives the same grant's issuer.
  The integration test proves the chain: card issued before a daemon
  restart, budget arithmetic intact after it, through the re-derived
  facet.
  SturdyRefs (per
  [sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md)) can later
  replace this recipe with first-class handles.

The API key itself lives in the formula record's `env` (host-visible
only), exactly like existing caplet secrets
(e.g. `packages/floot/voice/audio-server-caplet.js` wiring).

## Threat Notes

- **Key exfiltration**: no facet method returns the key; the caplet
  closes over it.
  Error messages quote paths and amounts with `q()` but never the
  Authorization header.
- **Budget escalation**: `deposit` exists only on `IssuerControl`;
  `makeSubIssuer` can only *reserve from* (never add to) the parent.
- **Cross-grant reach**: card operations take a `cardToken` but are
  checked against the grant's own ledger entry before any API call —
  a guessed or leaked foreign token is rejected without touching the
  network.
- **Memo-prefix forgery**: `repair()` attributes stranded cards by
  memo prefix, so the prefix is security-relevant.
  Sub-grants therefore cannot choose theirs (fixed to
  `[parent/subName]`), and the ledger rejects empty or multiline
  prefixes outright; the bracketed defaults cannot collide.
  An owner who sets custom overlapping root prefixes (e.g. `[a]` and
  `[a] x`) can still confuse attribution among their *own* grants —
  both ends of that mistake sit in the owner's trust domain.
- **Type escalation**: `allowedTypes` defaults deny `UNLOCKED`
  (any-merchant) and `DIGITAL_WALLET`; a grant must opt in, and the
  account key must separately have the Privacy.com privilege.
- **The unconfined caplet runs with full Node authority** in its
  worker, like all `make-unconfined` caplets; its trust claim is about
  *guests*, not about its own confinement.
  The **confined variant** (`src/confined-caplet.js`) inverts this: it
  imports no Node builtins and holds **no key at all** — its powers
  are a mediated HTTP capability, already bound to the Privacy base
  URL, that injects `Authorization` on the host's side of the
  membrane ([endoclaw-oauth](endoclaw-oauth.md) idiom).
  A fully compromised confined caplet could not name the key, because
  no path from its capabilities reaches it.
  Both entry points share the same Node-free core
  (`src/account.js` + `src/client.js`'s transport-agnostic
  `makePrivacyProtocol`); what remains for a production confined
  deployment is `make-archive` packaging and standard storage/timer
  capabilities for persistence and spend monitors.

## Dependencies

| Design | Relationship |
|---|---|
| [endoclaw-oauth](endoclaw-oauth.md) | Sibling idiom: credential-injecting API proxy the agent can use but not extract. This design is a concrete, budget-bearing instance. |
| [daemon-capability-bank](daemon-capability-bank.md) | Umbrella patterns: caretaker pairs, recursive attenuation, `help()`, guarded exos. |
| [endoclaw-network-fetch](endoclaw-network-fetch.md) | Would enable a confined variant of this caplet (Phase 4). |
| [sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) | Would give grants durable references (Phase 4). |

## Phased Implementation

1. **Package `packages/privacy-cards`** *(shipped)* —
   API client, budget ledger with reservation/reconcile/sub-grant
   semantics, unconfined caplet with `PrivacyAccount` / `CardIssuer` /
   `IssuerControl` facets, JSON state file, package-local AVA tests
   against a mock Privacy API HTTP server.
2. **Hardening** *(shipped)* — daemon integration tests
   (`test/daemon.test.js`; they live in this package with
   `@endo/daemon` as a dev dependency rather than in the daemon's own
   suite, keeping the daemon package free of a privacy-cards edge),
   stranded-reservation repair from `GET /cards` by memo prefix
   (`E(account).repair()`), audit-only facet
   (`E(control).makeAuditor()`), provisioning recipes in the package
   README.
3. **Liveness** *(shipped, polling flavor)* — renewing budgets by lazy
   carryover accrual against an injected clock (root grants only);
   spend-monitor polling on the control facet.
   Webhooks deliberately not pursued (inbound connectivity; no gain to
   the safety argument).
4. **Durability & confinement** *(shipped, recipe + seam)* — durable
   per-grant references as persistent eval formulas over
   `provideIssuer` (restart-tested); portable core split
   (`account.js`) and a key-less confined entry point
   (`confined-caplet.js`) over a mediated HTTP capability.
   Remaining for a production confined deployment: `make-archive`
   packaging, and storage/timer capabilities to restore persistence
   and monitors inside confinement; SturdyRefs when they land.

## Design Decisions

1. **Reservation over observation** — budgets are enforced by
   escrowing per-card limits up front, not by watching spend.
   Sound with no inbound connectivity, no polling race, and bounded
   exposure even while the daemon is down.
   (See "Budget Ledger Semantics".)
2. **One caplet per account, grants as sub-facets** — not one formula
   per grant.
   Grants are cheap, numerous, and need a shared ledger; a single
   formula keeps the invariant in one place.
   Durable per-grant refs are deferred to Phase 4.
3. **Key via formula `env`** — matches the existing caplet-secret
   idiom, keeps the key in the daemon's formula store, and keeps the
   caplet parameterizable for the sandbox base URL in tests.
4. **Integer cents everywhere** — amounts are validated as safe
   non-negative integers at every facet boundary; no floats, no
   currency strings.
5. **Conservative reconciliation** — ambiguous transaction states
   count as spent; refunds round down.
   An owner can always deposit to correct an under-refund; code can
   never claw back an over-refund.
6. **Card details are data, not capability** — `createCard` returns a
   hardened record (PAN, CVV, expiry) because the number must cross
   the wire to be usable at checkout anyway; pretending it is a
   capability would be security theater.
   Management operations (pause/resume/close) stay on the issuer,
   scoped to grant-owned tokens.
7. **Memo tagging** — every card's memo is prefixed with its grant
   name, making grants legible in the Privacy.com dashboard and
   enabling stranding repair, at the cost of leaking grant names to
   Privacy.com (acceptable: the owner names the grants).
   Because repair keys on the prefix, it is not delegatee-choosable:
   sub-grant prefixes are fixed, and the ledger validates overrides
   (see Threat Notes).
8. **Carryover accrual over resetting budgets** — renewal credits
   accumulate rather than expire, because a reset must decide what
   happens to escrow spanning the period boundary; accrual is lazy
   (computed on access from an injected clock) so it needs no timers
   and is deterministic under test.
9. **Repair adopts rather than rejects** — a stranded card found at
   the API is recorded at its live spend limit even if that overdraws
   the grant; recording less than real exposure would let the sum of
   limits exceed the budget. Overdrawn grants cannot issue until
   closed cards reclaim headroom or the owner deposits.
10. **Durable grant references via eval formulas** — the daemon
    already persists and re-derives eval formulas across restarts, so
    `E(account).provideIssuer(name)` under an eval formula is a
    durable reference today, without waiting for SturdyRefs.
11. **Protocol/transport split** — `makePrivacyProtocol(call)` keeps
    the endpoint surface pure; the unconfined client supplies a
    key-injecting `call` over ambient fetch, the confined caplet a
    `call` over a mediated fetch capability. One protocol, two trust
    postures.

## Known Gaps and TODOs

- [x] Daemon integration test via `makeUnconfined` (Phase 2).
- [x] Stranded-reservation repair (`repair()`, Phase 2).
- [x] Audit-only facet (Phase 2).
- [x] Renewing budgets (carryover accrual, Phase 3).
- [x] Polling spend telemetry (Phase 3).
- [x] Durable per-grant references (eval-formula recipe, Phase 4).
- [x] Confined entry point over a mediated fetch capability (Phase 4).
- [ ] `make-archive` packaging of the confined variant, once a
      standard mediated-fetch caplet ships to grant as its powers.
- [ ] Storage and timer capabilities for the confined variant
      (persistence and spend monitors inside confinement).
- [ ] Non-carryover (resetting) renewal semantics.
- [ ] Transaction webhooks, if inbound connectivity ever becomes
      standard for daemon deployments.

## Prompt

> privacy.com API as endo daemon formula
> allow others to create cards without revealing your API key. may need
> some custom balance limit code in order to allow someone to spend up
> to $1000 across any number of cards. explore different user stories
> here before implementing
> see developers.privacy.com/llms.txt
