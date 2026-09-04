# Account oracle

A capability that answers *what plan is this credential on, how much of the rate
limit is left, and what do these tokens cost?* — without holding, or being able
to hand out, the credential itself.

## Why this is a separate capability

The daemon secret manager makes the provider token a `SecretBlob`: durable,
rotatable, revocable, audited.
That is the credential.
Plan and quota are facts about the **account behind** the credential, and they
behave differently: they change while the capability stays the same, they are
worth remembering across a restart, and they are exactly the thing you want to
show a user or a model — which is exactly what must never be given the token.

So they are a third capability, distinct from both the credential and the
backend that spends it:

```text
SecretBlob        the bytes                     — read authority over the token
HostedAccount     plan, quota, prices           — read-only, no path to the token
HostedTurnBackend runs turns                    — spends against the account
```

`HostedAccount` is safe to delegate where the factory is not.

## The interface

```ts
interface HostedAccount {
  getPlan(): Promise<PlanSnapshot>;
  getRateLimits(): Promise<RateLimitSnapshot>;
  getRateCard(): Promise<RateCard>;
  estimateCost(usage: {
    modelId: string;
    inputTokens?: bigint;
    outputTokens?: bigint;
    cachedInputTokens?: bigint;
  }): Promise<CostEstimate>;
  refresh(): Promise<void>;
  help(methodName?: string): string;
}
```

Everything crossing the seam is capability-free data, validated by the same kind
of exact projector the hosted backend descriptors use.

### Provenance is part of every answer

Each section carries `observedAt` and a `source`:

| source | meaning |
|---|---|
| `observed` | read from the provider or a hosted backend just now |
| `declared` | the operator's configured profile; true by assertion only |
| `remembered` | the last durable observation, replayed because the provider could not be reached or the daemon restarted |
| `unavailable` | nothing is known |

Nothing is ever fabricated.
No provider publishes all of plan, quota, and price through an API, and
`unavailable` is a more useful answer than an invented one — which is why the
`accountStatus` tool's description tells the model to pass the provenance on
rather than presenting a declared figure as a measured one.

### Numbers

Quotas and token counts are `bigint`: a published quota is a natural number
whose range is the provider's to choose, and monthly token allowances already
run past what four bytes hold.
`null` means "the provider does not publish this figure", which is not the same
as zero — so `remaining` and `usedFraction` are derived only when the figures
they need are actually present.

Prices are integers of **micro-units** of an ISO 4217 currency per million
tokens: USD 3.00 per million input tokens is `3_000_000n`.
List prices run to fractions of a cent, and money in floating point is a defect
waiting for a large enough bill.
`estimateCost` is integer arithmetic throughout and reports in `missing`
whatever the rate card could not price, so a caller can tell a floor from a
total.

## Durability, in Endo terms

The oracle is a `make-unconfined` **formula**, not an object minted inside a
factory: `revivePins()` brings it back with the same identity, so a reference
stored under a pet name keeps working across a restart.

Its namespace holds:

- `account-profile` — an ordinary stored **value** carrying the operator's
  declared plan, quota, and price list. Data, not a capability: an operator
  corrects the answer by rewriting the value, and no capability changes hands.
- `account-source` — optional; a capability whose `observe()` returns a live
  reading in the same shape. A provider that publishes none of this simply has
  no source.

Observations are journalled into the oracle's **own pet store**, append-only
with a unique name per version — the same recipe as Floot's session registry, so
a crash leaves either the previous complete snapshot or the next one and can
never erase the sole record.
After a restart the oracle answers immediately from the last real reading,
marked `remembered` with the instant it was taken.

Only a live reading is written back.
Journalling a declared or remembered view would launder an assertion into an
observation and overwrite a real measurement with it.

## Wiring in Floot

`floot-factory-setup.js` provisions the oracle when `FLOOT_ACCOUNT_PROFILE`
names a JSON file, and hands the factory a locator under `account-oracle`.
Re-running setup with an edited file keeps the oracle's identity — and its
journal — and re-points its namespace at the new value.

The factory then exposes:

- `getAccount(refresh?)` — the snapshot as data, for a UI.
- `getAccountOracle()` — the capability itself, for a holder that should be able
  to check quota without reaching the credential.

and each session facet exposes `getAccount(refresh?)`, which adds that session's
own token usage and its cost at the current list price.
A provider-backed session whose factory has an oracle also gets an
`accountStatus` tool, so the model can answer "how much quota is left?" and
"what is this costing?" in the conversation where the user asked.

Its presence changes `toolSetId`, so a hosted thread pinned without it cannot
silently resume with it.

A session on a *hosted backend* does not get it.
Such a session runs the backend's own tool loop over a tool set projected once,
in `getAgent`, before the session agent exists — so it carries the Endo tools
and neither `accountStatus` nor the subagent tools.
`getAccount(refresh?)` on the session facet answers the same questions to a UI
either way.
Closing that gap is part of exposing a hosted backend through the Floot factory,
which `packages/codex-sandbox/MERGE-BLOCKERS.md` records as unreviewed.

### Profile file

```json
{
  "plan": {
    "planId": "max-20x",
    "title": "Max",
    "state": "active",
    "renewsAt": "2026-10-01T00:00:00.000Z",
    "seats": 1
  },
  "rateLimits": {
    "windows": [
      { "windowId": "weekly", "title": "Weekly tokens", "limit": "90000000000" }
    ]
  },
  "rateCard": {
    "rates": [
      {
        "modelId": "claude-sonnet-4-6",
        "currency": "USD",
        "inputPerMillion": 3000000,
        "outputPerMillion": 15000000
      }
    ]
  }
}
```

JSON has no `bigint`, so a quota may be written as a number or as a decimal
string; a number that is not an exact integer is rejected rather than rounded.
The file is parsed and range-checked in the setup script, where a mistake is an
error the operator sees, rather than inside the caplet where it would surface as
a failed answer much later.

## What this is not

It is not the provider credential broker that
[`@endo/codex-sandbox`](../codex-sandbox/MERGE-BLOCKERS.md) still requires.
An oracle reports; a broker enforces.
Binding a credential to a provider origin, a model allowlist, a quota, and an
expiry — and refreshing OAuth state outside the sandbox — remains that separate
component's job.
