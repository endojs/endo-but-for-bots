# HTTP Adapter Pipeline: Metering, Fees, Rate Limiting, Retries, and Circuit Breaking as Pass-Style Stages

| | |
|---|---|
| **Created** | 2026-08-15 |
| **Updated** | 2026-08-15 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | PR [#286](https://github.com/endojs/endo-but-for-bots/pull/286#pullrequestreview-4943057191) review (approval of `endo http mk` Phase 1) |
| **Elaborates** | [cli-http-client](cli-http-client.md), [http-confine](http-confine.md) |

## What is the Problem Being Solved?

Phase 1 of the `endo http` controller/client pair
([cli-http-client](cli-http-client.md)) shipped its defenses (origin
allowlist, per-request timeout, sliding-window rate limit, response
byte-cap) as a **fixed pipeline with a flat set of policy knobs** on the
controller. `@endo/http-confine`'s `makeHttpConfinement` bakes the same
six steps into one hard-coded implementation order: rate `take()`, then
method/header normalization, then origin check, then `fetch`, then
redirect, then byte-cap.

The maintainer's approval of Phase 1 asked for a follow-up that
elaborates the controller/client system to support **metering, fees,
rate limiting, retries, and circuit breaking (error-based)**, mining the
substantial prior art on HTTP adapter pipelines (Koa/Express middleware,
axios interceptors, undici `Dispatcher.compose`) for design precedents,
"recalling that these are pass-style interfaces."

Five observations make a flat knob-set the wrong shape for these five
concerns:

1. **They are cross-cutting and ordered.** A retry re-runs the transport;
   a circuit breaker gates the retry; metering must reserve funds before
   the transport reads a byte; rate limiting must decide before metering
   spends. Ordering is a design decision, not an implementation detail.
2. **They are optional and per-deployment.** A host may want a metered,
   fee-bearing client for an untrusted guest and a plain allowlisted
   client for a trusted one, from the same controller vocabulary.
3. **They compose.** Each concern is independently testable and
   independently insertable: the definition of middleware.
4. **They carry state with different scopes.** Rate windows are
   per-client; circuit-breaker state is per-origin; the fee purse is
   per-controller. A flat struct cannot express these scopes.
5. **They must remain pass-style.** The controller holds the policy and
   the guest merely exercises it, across a CapTP boundary. In-process
   function middleware (`(ctx, next) => ...`) cannot cross a vat boundary;
   the pipeline must be built from **exo facets**, not closures.

This design elaborates the Phase 1 pair into a **pass-style adapter
pipeline** over the existing `request({ url, method?, headers? },
cancellation)` surface, staging the five concerns as composable exo
stages configured on the controller side. It does not change the Phase 1
cap split, the SSRF posture, or the CLI verb tree; it extends them.

## Scope

In scope:

- The pass-style stage interface and how a Koa/axios/undici adapter
  pipeline maps onto exo facets.
- The canonical stage order and the pure pre-flight that precedes it.
- Each of the five concerns as a stage: metering, fees, rate limiting,
  retries, circuit breaking, with interface sketches.
- The reconciliation that makes **metering and the Phase 1 byte-cap one
  mechanism**, aligned to the minion.town gateway metering ground rules
  (a sibling garden repo's direction for metering web-service egress,
  summarized in the Relationship table below): reserve worst-case,
  refuse-before-read, bill actual.
- How stages thread onto the controller's immutable policy and the
  `endo http` verb tree, and where they land in the Phase 3/4 plan.

Out of scope:

- Production implementation beyond illustrative interface sketches (this
  is a design task).
- The external payment-processor choice behind a fee purse (deferred by
  [gateway-package](gateway-package.md) § Open Questions to a later
  design; this design consumes an abstract `ResourceLedger`/purse
  capability).
- Trust-on-first-bind policy mode (owned by
  [trust-on-first-bind](trust-on-first-bind.md)); a TOFU pin is one more
  stage but its policy machine is that design's.
- Final identifier names (a namer dispatch owns the concrete names for
  the Phase 1 exos and verbs; this document uses placeholders
  consistently with cli-http-client).

## Relationship to existing designs

| Design | Relationship |
|---|---|
| [cli-http-client](cli-http-client.md) | Parent. Its controller-holds-policy / client-exercises invariant, method placement, cancellation model, and SSRF defenses are preserved verbatim. Its Phase 3 (rate/byte/timeout) and Phase 4 (streaming/methods) knobs become the first stages of this pipeline. |
| [http-confine](http-confine.md) | The pure confinement primitives (`checkOriginAllowed`, `normalizeMethod`, `assertHeadersSafe`, `makeRateLimiter`, `limitResponseBytes`, `resolveRedirect`, `makeRequestSignal`) become the **bodies** of the pre-flight and the transport stage. Its `makeHttpConfinement` fixed order generalizes into the composable order below. |
| [endo-fetch](endo-fetch.md) | The pipeline is configured by the **integration** that provisions `@endo/confined-fetch`: the base `@endo/fetch` transport is the terminal stage; the confined plugin composes the outer stages and persists their durable policy in `fetch-store/config.json`. |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | The **budget-as-pre-payment / admission-control** model is lifted directly: "only admit when the balance covers the worst case; bill actual after; no rollback." The HTTP meter is that model applied to bytes-and-deadline instead of computrons. |
| [gateway-package](gateway-package.md) | Supplies the `ResourceLedger` (`getBalance`, `chargeBalance`, `purchaseTokens`, `setQuota`) that a fee stage draws against; the gateway is "the layer where HTTP/WS traffic accrues ... the natural place to meter and gate." Its § Open Questions **surfaces but does not answer** the per-request billing granularity: the exact gap the minion.town direction below fills. |
| minion.town gateway metering direction (`weblet-usage-metering.md`, `ertp-credits.md`; sibling garden repo, not in this tree) | The concrete ground rules cited in the maintainer's request: bill HTTP egress on **delivered bytes + wall-clock capped at a per-request deadline**; **reserve worst-case before headers**, refuse when funds are insufficient in the **pessimal case**, settle on **actual**; measurement happens at the **resource boundary** (a caller cannot report its own byte count); the reserve/perform/settle state machine and the attenuated **charge-account** purse primitive. This design transposes those rules onto the pass-style pipeline. |
| [trust-on-first-bind](trust-on-first-bind.md) | A future TOFU stage slots between origin pre-flight and transport; out of scope here. |

## Prior art: HTTP adapter pipelines as pass-style facets

Every mainstream HTTP client factors cross-cutting concerns into an
ordered, composable middleware chain:

- **Koa / Express**, the "onion": `async (ctx, next) => { /* before */
  await next(); /* after */ }`. Each layer wraps the next; control
  descends through `next()` and unwinds back out.
- **axios interceptors**: separate request and response interceptor
  arrays, run as a promise chain around the adapter.
- **undici `Dispatcher.compose(...interceptors)`**: an interceptor is
  `dispatch => (opts, handler) => ...`, wrapping the base dispatcher;
  `RetryAgent`, `RedirectHandler`, and cache interceptors ship this way.

All three share one shape: a stage receives the request, may act before
and after, and delegates the middle to a **downstream handle** it does
not own. That downstream handle is the pass-style seam.

The mapping onto Endo:

| Middleware idiom | Pass-style expression |
|---|---|
| Koa `(ctx, next)` closure | An **exo facet** implementing `HttpStageInterface` whose `request` method calls `E(next).request(...)`. |
| `next` continuation | A **remotable** (`M.remotable('HttpStage')`) captured at composition time, not passed per-call. |
| `ctx` mutable context | An **immutable `RequestContext` record** threaded by value plus a far-ref for effectful shared state (the meter's reservation). No stage mutates another's fields; each hop forwards a freshly hardened record. |
| `app.use(mw)` ordering | The **controller** composes the chain inner-to-outer at configuration time; order is controller policy, not caller input. |
| The base adapter (undici `Agent`) | The **terminal transport stage** over the injected `fetch` seam (`@endo/fetch`), which performs `redirect: 'manual'` + bounded read. |

The crucial adaptation: Koa passes `next` as a per-call argument;
pass-style **captures `next` at construction**. Each stage exo is built
endowed with the far-ref to the stage beneath it, so its interface is the
uniform `request(req, cancellation, ctx)` (identical to the client's own
`request`) and a stage is indistinguishable from the whole client to the
stage above it. This is what lets the chain be **arbitrarily deep and
partly remote**: a stage can live in the daemon vat (the common case,
where `E(next)` is a cheap same-vat eventual-send) or in another vat
entirely (e.g. a fee purse held by the gateway), because every hop is a
CapTP call, not a synchronous function call.

### The stage interface

```js
import { M } from '@endo/patterns';
// RequestShape / ResponseShape are the Phase 1 shapes from
// cli-http-client.md (bodies are ReadableBlob remotables).

// What a client/guest may propose: only a deadline. Split from the
// internal stage context so the client boundary cannot smuggle stage
// state (a reservation, an attempt count) into the pipeline.
const CallerContextShape = M.splitRecord(
  {},
  { deadline: M.number() },        // absolute ms; the wall-clock budget proposal
);

// The internal stage-to-stage accumulator: the caller context plus the
// fields each hop threads. Immutable and passed by value; each hop
// forwards a freshly hardened record ({ ...ctx, attempt: ctx.attempt + 1 }),
// never mutating the record it received. The reservation far-ref carries
// the meter stage's effectful shared state to the stages below it.
const StageContextShape = M.splitRecord(
  { origin: M.string(), attempt: M.number() },
  {
    deadline: M.number(),
    reservation: M.remotable('MeterReservation'), // carried after the meter stage reserves
  },
);

// Every stage -- and the client's own request path -- speaks this.
export const HttpStageInterface = M.interface('EndoHttpStage', {
  // Same signature as HttpClientInterface.request, so a stage is
  // substitutable for the whole client to the stage above it. Internal
  // stages thread a StageContextShape; the client boundary accepts only
  // the narrower CallerContextShape, so a guest cannot supply `attempt`
  // or `reservation`.
  request: M.call(RequestShape, M.promise())
    .optional(StageContextShape)
    .returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(HttpStageInterface);
```

`request` declares `.returns(M.promise())` without a resolved-value guard
on purpose: it resolves to a `Response` record already shaped by
`ResponseShape`, so a second return-shape check would be redundant. The
sibling `help` guards its resolved value (`M.string()`) because that is a
bare primitive with no downstream shape to guard it. The
`reserve`/`getBalance` pair below follows the same rule for the same
reason.

A stage's `request` body is the onion:

```js
// Sketch -- a generic stage. `next` and the policy slice are captured
// in the exo's state at make time by the controller's composer.
request: async (req, cancellation, ctx) => {
  // ...before: consult/update this stage's own scoped state...
  const res = await E(this.state.next).request(req, cancellation, ctx);
  // ...after: observe the outcome...
  return res;
},
```

The terminal stage's `next` is the injected `fetch` transport, not
another `HttpStage`; it is the only stage that touches the platform.

### Composition authority stays on the controller

The Phase 1 invariant, **the controller holds the immutable policy; the
client only exercises it**, extends cleanly. The controller's policy
gains an **ordered stage list**. The controller's composer builds the
chain inner-to-outer (transport first, then meter, rate, breaker, retry
around it) and hands the client a reference to the **outermost** stage.
The client's `request` is a thin forwarder to that outermost stage.

- A guest holding the client cannot insert, remove, reorder, or
  reconfigure a stage; it cannot even enumerate them beyond what
  `allowedOrigins()`-style inspection exposes.
- A host holding the controller reconfigures stages through new
  controller verbs (below); reconfiguration re-composes the chain and the
  client observes the change on its next `request`, exactly as Phase 1's
  `setMaxRequestsPerMinute` already works.
- Stages are **never smuggled in by the client**. The context the client
  may pass is a `CallerContextShape` carrying only a caller-supplied
  `deadline` proposal (clamped down, never up, by the meter/timeout
  stages); it cannot carry a stage or a purse.

This preserves the Alt-B rejection from cli-http-client: attenuation is
expressed as disjoint facets and a controller-owned composition, not as
hand-maintained forwarders.

## Canonical stage order

The pipeline is a **pure pre-flight** followed by an **effectful onion**.
Separating them keeps http-confine's "pure primitives vs aggregate"
distinction: the pre-flight can reject with **zero side effects** (no
rate token spent, no funds reserved, no breaker state touched), and only
requests that are structurally admissible reach the effectful stages.

**Pre-flight (pure, no cost, runs once, never re-run on retry):**

1. Parse `new URL(req.url)`; compute `origin`.
2. Origin allowlist (`checkOriginAllowed`).
3. Method normalization + closed-set check (`normalizeMethod`).
4. Header safety (`assertHeadersSafe`).

A failure here rejects the caller's `request` immediately with the Phase
1 structured error. Nothing downstream is consulted.

**Onion (effectful, outer to inner):**

| # | Stage | Why here |
|---|---|---|
| 1 | **Retry** | Outermost. Re-invokes the inner chain up to N times for idempotent methods. Its `next` is the breaker, so when the breaker opens, retry's next `request` fast-rejects with `CircuitOpenError`, which retry treats as terminal and stops the loop. It sits *above* the breaker, rate, and meter so every attempt is separately gated, throttled, and billed. |
| 2 | **Circuit breaker** | Second, wrapped by retry. A per-origin gate: an `open` breaker fast-rejects before any resource is spent (rate token, funds, transport). Because retry invokes `E(breaker).request` once *per attempt*, the breaker observes **every attempt** and can trip **mid-loop**; the outer retry sees the trip on its next attempt as a terminal `CircuitOpenError`. |
| 3 | **Rate limiter** | Spend a window token per attempt. Above the meter so a rate refusal costs no fund reservation; below retry so each retried attempt is independently throttled; below the breaker so a tripped origin drains no token. |
| 4 | **Meter (reserve, then settle)** | Reserve the worst-case cost up front and **refuse before reading any bytes** if the purse cannot cover it; after the read, settle to actual usage and refund the remainder. |
| 5 | **Transport** | Terminal. `fetch` with `redirect: 'manual'`, the timeout/cancellation `AbortSignal`, and the bounded read whose ceiling *is* the meter's reserved worst-case response size. |

This is a deliberate generalization of http-confine's fixed order. Two
substantive changes. First, http-confine spends the rate token before it
checks the origin; this pipeline moves origin/method/header validation
into the pure **pre-flight ahead of everything**, so a structurally
invalid request never consumes a rate token or a fund reservation.
Second, the breaker sits **just inside** the retry stage rather than
strictly outermost: this is the position that lets the breaker both gate
before any resource-spending stage (an `open` breaker fast-rejects on the
first attempt, before rate/meter/transport) **and** observe each
individual attempt (retry calls the breaker once per attempt, so a retry
storm against a dying origin trips the breaker, which then aborts the
storm on the very next attempt). Redirect resolution and byte-cap stay
inside the transport stage exactly as http-confine defines them. Where a
deployment omits a concern (no fees, no breaker), that stage is simply
absent from the composed chain and the onion collapses toward the Phase 1
behavior.

## The five concerns

The five concerns are detailed below in the order the maintainer's
request named them (metering, fees, rate, retries, breaking), which is
**not** the pipeline execution order of the table above. In particular,
**fees is not a pipeline stage at all**: it is the funding capability
(the charge account) that the meter stage draws against, so the onion has
four non-transport stages (retry, breaker, rate, meter), not five.

### 1. Metering -- one mechanism with the byte-cap

The metering stage aligns with the minion.town gateway metering ground
rules cited in the maintainer's request:

> bill on both **deadline** and **request + response payload length**;
> refuse a request up front if funds are inadequate for the **worst-case**
> payload and **reject before reading any bytes**; otherwise bill on
> **actual** usage.

This is the [daemon-xs-worker-metering](daemon-xs-worker-metering.md)
**admission-control** model transposed from computrons to bytes+time:
"only admit when the balance covers the worst case; the actual cost of a
crank may be much less than the hard limit; bill actual after; no
rollback." There, the worst case is the per-crank `hard_limit`; here it is
the worst-case payload. The minion.town rule states it directly for HTTP
egress: *draw on a pool sized for the configured maximum request and
response size in aggregate, refuse when funds are insufficient in the
pessimal case, reserve before headers, then settle delivered bytes plus
wall-clock duration (capped at a per-request deadline); an aborted
response pays only the admitted amount.*

**Measurement happens at the resource boundary, not at the caller.** The
byte count that settlement bills is the count the **transport stage**
observed while draining the response, never a number the guest reports.
This is a security property, and it falls out of pass-style for free: the
meter stage trusts the `bytesRead` reported by the far-ref transport
stage it composed (a capability it endowed), and the guest, which holds
only the outermost stage, never touches the tally. The minion.town
direction makes this explicit ("a caller cannot report its own byte
count") and the pipeline honors it by construction.

**The cost function.** Pricing is a versioned `PriceSchedule` the
*ledger* selects (never the caller), so a price change never reprices a
settled event or an already-open reservation. A request's worst-case cost
is
```
cost_max = price.perByteRequest  * len(request.body)      // known exactly up front
         + price.perByteResponse * maxResponseBytes        // the Phase 1 byte-cap = worst case (aggregate pool)
         + price.perMillisecond  * timeoutMs               // the Phase 1 timeout = the per-request deadline
         + price.perRequest                                // fixed admission fee
```
Every term is known **before headers are sent or a single response byte
is read**: `len(request.body)` from the request `ReadableBlob`'s length,
`maxResponseBytes` and `timeoutMs` from the controller's immutable
policy. This is precisely why refusal-in-the-pessimal-case is possible
without touching the network.

**Reserve, perform, settle.** The meter stage runs the ledger's
reserve/settle state machine:

1. **Reserve.** Compute `cost_max`; call `reserve(operationId, cost_max)`
   on the endowed charge account. The reservation atomically moves
   `available` to `reserved` and returns a `MeterReservation` capability,
   or, if the balance cannot cover the pessimal case, **rejects now** with
   `InsufficientFunds`, before `fetch` is invoked, so no header is sent
   and no upstream byte is read. The reservation is a hold, not a charge,
   keyed by `operationId` for idempotency.
2. **Perform.** Call `E(next).request(...)` (the transport). The bounded
   read (`limitResponseBytes`, ceiling `maxResponseBytes`) guarantees the
   actual response never exceeds the reserved worst case; a lying
   `Content-Length` cannot overrun the reservation because truncation is
   at read time (unchanged from Phase 1 / http-confine).
3. **Settle.** After the body is fully read (or truncated, or the
   deadline fires), the transport reports the trusted `measurementId` +
   actual measure and the stage calls `settle(reservation, measurementId,
   { bytesRead, elapsedMs })`, which computes
   ```
   cost_actual = price.perByteRequest  * len(request.body)
               + price.perByteResponse * bytesRead          // measured at the boundary
               + price.perMillisecond  * min(elapsedMs, timeoutMs)
               + price.perRequest
   ```
   atomically moving `cost_actual` from `reserved` to revenue and
   **releasing** `cost_max - cost_actual` back to available, appending one
   settlement event with an idempotent receipt. An aborted response
   (transport error before any read, or a caller cancellation) pays only
   the admitted amount (`perRequest` plus any request bytes already sent)
   via `release()`. Consistent with the direction's *consistency over
   availability* stance, a subsystem that crashes mid-flight may leave the
   hold reserved for a reconciler rather than guess zero and release it.

**This is where metering and the Phase 1 byte-cap become one mechanism,
not two.** `maxResponseBytes` was, in Phase 1, purely a DoS defense
(truncate a flood). Here it plays a second role with no new machinery:
it is the **worst-case response term of the reservation**. The bounded
read that enforces the cap is exactly what bounds `cost_actual <=
cost_max`, which is exactly what makes the up-front reservation safe. A
deployment with no fees still sets `maxResponseBytes`; a metered
deployment reuses it as the reservation ceiling. The `truncated: true`
flag Phase 1 returns doubles as "billed at the cap." The response record
gains one optional field, `cost: M.number()`, the settled charge; absent
when no meter stage is composed.

Because the meter reserves the worst case and settles actual, the
`ReadableBlob` response body must be **fully drained or released** for
settlement to complete, the same lifetime the Phase 1 rate-limiter slot
already has ("the rate-limiter slot is held until the body remotable is
released"). Settlement and slot-release are the same event; an unread
body bills at the reserved worst case when the daemon deadline fires,
which is the incentive-correct outcome (holding a slot open costs the
reserved maximum).

### 2. Fees -- the purse capability

The fee stage draws against an **attenuated charge account**, not a raw
purse: the `ertp-credits.md` primitive `makeChargeAccount(purse, {
limit, expiresAt, singleUse, ratePerPeriod, ... })`. The charge account is
a **controller-side endowment**, never client-facing, the direct
analogue of "the base `Fetch` is never guest-facing" in
[endo-fetch](endo-fetch.md). The integration that provisions the client
(the confined-fetch plugin, or the gateway) holds the underlying purse,
mints a spend-limited, optionally-expiring charge account bound to the
account, and endows the meter stage with **that** at composition time. A
compromised meter stage can therefore drain at most the charge account's
`limit`, not the whole purse, and only until `expiresAt`.

```js
export const MeterReservationInterface = M.interface('MeterReservation', {
  // Settle to the trusted, boundary-measured actual; release the rest.
  // Idempotent on measurementId -- a retried settle returns the receipt.
  settle: M.call(M.string(), MeasureShape).returns(M.promise()),
  // Abort: refund the whole hold. Idempotent and retry-safe like settle:
  // a release after a prior settle or release is a no-op that returns the
  // same receipt, so a retried abort path cannot double-refund.
  release: M.call().returns(M.promise()),
});

export const ChargeAccountInterface = M.interface('EndoChargeAccount', {
  // Reserve a hold for cost_max, keyed by operationId. Rejects with
  // InsufficientFunds BEFORE returning when the balance cannot cover the
  // pessimal case -- the refuse-before-headers gate. The allowance
  // decrement and the hold are one synchronous move: no check-then-draw
  // window, so concurrent reservations serialize and cannot jointly
  // exceed `limit`. Returns Promise<MeterReservation> unguarded for the
  // same reason `request` above is: the resolved MeterReservation is
  // already guarded by MeterReservationInterface, so a return-shape check
  // would be redundant; the sibling getBalance guards its bare number.
  reserve: M.call(M.string(), M.number()).returns(M.promise()),
  getBalance: M.call().returns(M.number()),
});
harden(ChargeAccountInterface);
```

The charge account is a thin adapter over the gateway's `ResourceLedger`
(`getBalance` / `chargeBalance`, `purchaseTokens` / `setQuota` for top-up
and admin) or over an ERTP `credits` purse where the metering unit is a
local resource token (`ertp-credits.md`). The metering unit itself is a
`UsageMeasure`-style integer vector (`bytes`, `byte-seconds`,
`requests`); this design does not pin the token or the payment processor
(deferred by [gateway-package](gateway-package.md) § Open Questions); it
pins the **shape**: reserve-hold-settle, refuse-in-the-pessimal-case,
atomic allowance draw, boundary measurement.

**Who holds what.**

- The **integration** holds the raw purse and the controller; it mints
  the charge account and never hands out account ids (resource APIs do not
  accept a caller-supplied account: the account is bound at endowment).
- The **meter stage** holds a far-ref to the **charge account**, captured
  at composition; it can `reserve`/`settle`/`release` within the account's
  `limit` but cannot inspect the underlying purse, widen the limit, or
  mint funds.
- The **client/guest** holds neither the purse nor the account. It
  observes fees only as the optional `cost` field on a `Response` and as
  the `InsufficientFunds` rejection.

**How refusal-before-read surfaces to the caller.** `request` rejects
with a structured `InsufficientFundsError { required, available }`
**synchronously with respect to the network**: the promise rejects
before the transport stage runs, so no request body is streamed and no
response byte is read. This is distinguishable from a `RateLimitError`
(retry later, funds fine) and from an origin/method rejection (never
admissible). A guest can call the client's inspection method
(`estimateCost(req)`, a new pure, side-effect-free client method that
returns `cost_max` without reserving) to pre-check affordability, which
is the pass-style analogue of undici's "does this request fit the
budget" probe.

### 3. Rate limiting -- position and scope

Rate limiting is Phase 1's sliding window (`makeRateLimiter`,
`setMaxRequestsPerMinute`), lifted into a stage. Two design points the
pipeline settles:

- **Position.** The limiter sits **above the meter and below retry**
  (stage 3). Above the meter: a throttled request costs no fund
  reservation, so a rate refusal is cheap and never touches the purse.
  Below retry: each retried attempt spends its own token, so a retry
  storm cannot bypass the window. It sits **below the circuit breaker**:
  an `open` origin fast-rejects without spending a token, so a tripped
  origin does not drain the window.
- **Scope.** The window is **per-client** by default (Phase 1's shape:
  the window lives in the client's shared state). A second, optional
  **per-controller** aggregate window can cap the sum across every client
  a controller minted, for a host that fans one policy out to many
  guests. Precedence: a request must pass **both** the per-client and the
  per-controller window; the tighter one binds. `setMaxRequestsPerMinute`
  keeps its Phase 1 meaning (per-client); a new
  `setControllerMaxRequestsPerMinute` sets the aggregate. Per-origin rate
  limiting is deliberately *not* added here: origin fairness is the
  circuit breaker's job (error-based), not the throttle's.

The limiter stays a pure `makeRateLimiter` over an injected `now` seam
(http-confine's contract: "it never reads an ambient clock"), so it is
deterministically testable.

### 4. Retries -- idempotency, backoff, cancellation

The retry stage re-invokes the inner chain on a **retryable failure**,
bounded by attempt count and the overall deadline.

- **Idempotency constraint.** Retry is enabled **only for GET-class
  (idempotent) methods**: GET, HEAD, and any method the controller's
  closed set marks idempotent (per Phase 1, the default method set is
  GET/HEAD anyway). A non-idempotent method (POST/PATCH) is **never**
  retried automatically; the stage passes it through with `maxAttempts =
  1`. This is a hard rule, not a knob, because the pipeline cannot know a
  POST is safe to repeat.
- **Retryable classes.** Retry fires on connection errors, timeouts, and
  5xx / 429 responses. A `429` with a `Retry-After` honors that hint as
  the backoff floor. It does **not** retry 4xx other than 429 (client
  error, deterministic) or an origin/method/header rejection (never
  admissible) or an `InsufficientFunds` (funds do not improve by
  retrying). Note the deliberate asymmetry with the breaker below: 429
  **is** retryable here (backing off and re-sending your own request is
  the correct response to your own throttle), but 429 is **not** breaker
  evidence, because it reflects request volume rather than origin health,
  and counting it would let one greedy guest trip the shared breaker for
  every co-guest.
- **Backoff.** Exponential with full jitter, `base * 2^attempt` capped at
  a ceiling, all controller policy (`setRetry({ maxAttempts, baseMs,
  capMs })`). The backoff **sleep is itself abortable**: it waits on
  `Promise.race([sleep(delay), cancellation])`, so a caller-side
  cancellation or the overall deadline cuts a pending backoff short
  rather than burning wall-clock the caller no longer wants.
- **Interaction with cancellation/timeout.** There is **one**
  `cancellation: Promise<never>` and **one** overall `deadline` for the
  whole `request`, shared across every attempt: retries do **not** each
  get a fresh timeout budget. The per-attempt transport timeout
  (`timeoutMs`) bounds a single attempt; the deadline bounds the sum. If
  the next backoff + minimum attempt would exceed the deadline, the stage
  stops and rejects with the last error rather than starting a doomed
  attempt. Each attempt forwards a fresh `ctx` with `attempt: ctx.attempt
  + 1` (a new hardened record, not a mutation), visible to the meter,
  which bills every attempt, and to the breaker, which records every
  attempt.

Because each attempt is separately metered and rate-limited, the cost of
a retry is honestly billed: a 3-attempt request reserves and settles
three times (each with its own worst case), which is the correct
incentive (retries are not free).

### 5. Circuit breaking -- error-based, per-origin

The breaker sits just inside the retry stage: a per-origin state machine
that trips on error classes to stop hammering a failing upstream.

- **States.** `closed` (pass through, count failures), then `open`
  (fast-reject every request with `CircuitOpenError` for a cooldown
  window), then `half-open` (admit a single probe; success closes it,
  failure re-opens). Standard three-state breaker.
- **Keyed on error classes, not all failures.** The breaker counts
  **server-side and transport failures** (5xx, connection refused, DNS
  failure, TLS failure, timeout) as evidence the *origin* is unhealthy. It
  does **not** count 4xx (the request was wrong, the origin is fine),
  **including 429** (a 429 reflects request volume against a per-guest or
  per-origin quota, not origin health), nor origin/method/header
  rejections, `InsufficientFunds`, or a caller-side cancellation. Counting
  client-fault errors, or a volume signal like 429, would let one guest
  trip the shared breaker for every other guest of that controller on that
  origin, precisely the cross-guest failure mode the per-origin scope is
  meant to avoid. (Retry treats 429 differently, and deliberately; see the
  asymmetry note in § 4.)
- **Trip policy.** Trip when failures reach a threshold within a rolling
  window (`setBreaker({ failureThreshold, windowMs, cooldownMs,
  halfOpenProbes })`), all controller policy. Half-open admits
  `halfOpenProbes` requests; a majority-success closes it.
- **Scope: per-origin within a controller.** A controller may allowlist
  several origins; one failing origin must **not** trip requests to a
  healthy sibling. So breaker state is keyed by `ctx.origin`, held in the
  controller's shared state as a small map. This is intentionally *not*
  per-client (two guests of the same controller hitting the same dead
  origin share the evidence and the protection) and *not*
  per-controller-global (a healthy origin stays open). A single origin
  serving many controllers is *not* shared across controllers: the
  controller is the trust boundary; cross-controller sharing would leak
  one host's traffic pattern to another.
- **Position and interaction with retry.** Retry wraps the breaker, so
  the breaker is retry's `next` and is therefore invoked **once per
  attempt**. It thus observes **every attempt** (each retried failure is
  fresh evidence) and can trip **mid-retry-loop**: once the breaker opens,
  the retry stage's next `E(next).request` fast-rejects with
  `CircuitOpenError`, which retry treats as terminal (an open circuit is
  not itself retryable), ending the loop immediately. This is the desired
  coupling: a retry storm against a dying origin trips the breaker, which
  then halts the storm on the very next attempt. (This per-attempt
  visibility is exactly why the breaker sits *inside* retry rather than
  strictly outermost; an outermost breaker, called once for the whole
  request, would see only the aggregate outcome of the entire loop.)

## Exo and CLI surface additions

The stages are configured through **new controller verbs**, mirroring the
Phase 1 mutators; the client facet gains nothing but the pure
`estimateCost`. Placeholder names, per the namer dispatch:

| Method | Facet | Concern |
|---|---|---|
| `setMeterPrice(price)` | controller | metering (per-byte / per-ms / per-request rates) |
| `attachChargeAccount(account)` | controller | fees (integration-only endowment of an attenuated charge account; rejects a client-reachable ref) |
| `setControllerMaxRequestsPerMinute(n)` | controller | rate (aggregate) |
| `setRetry({ maxAttempts, baseMs, capMs })` | controller | retries |
| `setBreaker({ failureThreshold, windowMs, cooldownMs, halfOpenProbes })` | controller | circuit breaking |
| `inspectPipeline()` | controller | read the composed stage list + each stage's live state (breaker states, window, balance) |
| `estimateCost(req)` | client | pure `cost_max` probe; no reservation, no side effect |

CLI verbs extend the `endo http` tree, each operating on the named
controller:

```text
endo http set-price   <name> --per-byte-req <n> --per-byte-res <n> --per-ms <n> --per-req <n>
endo http set-retry   <name> --max-attempts <n> --base-ms <n> --cap-ms <n>
endo http set-breaker <name> --threshold <n> --window-ms <n> --cooldown-ms <n>
endo http set-rate    <name> --per-minute <n> [--controller-per-minute <n>]
endo http inspect     <name> [--pipeline]     # shows composed stages + live state
```

(`attachChargeAccount` has no CLI verb: a charge account is a capability,
endowed programmatically by the provisioning integration, not named on a
shell line.)

## Staging into the Phase plan

This design slots the five concerns into cli-http-client's existing phase
numbering without disturbing Phase 1/2:

- **Phase 3 (already planned: rate/byte/timeout knobs)** becomes **the
  pipeline substrate**: introduce `HttpStageInterface`, the pre-flight /
  onion split, and re-express the Phase 1 rate limiter, byte-cap, and
  timeout as the first composed stages (rate stage + transport stage).
  Behavior-preserving refactor; no new external concern yet.
- **Phase 3.5, Metering + Fees.** Add the meter stage, the
  `ChargeAccount` / `MeterReservation` interfaces, `setMeterPrice` /
  `attachChargeAccount`, `estimateCost`, and the `cost` response field.
  Reconcile the byte-cap as the reservation ceiling. This is the phase
  that lands the minion.town metering ground rules (reserve-before-headers,
  boundary measurement, settle actual).
- **Phase 3.6, Rate aggregate + Retries.** Add the per-controller
  aggregate window and the retry stage (idempotent-only, jittered
  backoff, deadline-shared).
- **Phase 4 (already planned: streaming/methods)** absorbs the **circuit
  breaker** stage and the `inspectPipeline` surface, alongside the
  streaming-body and additional-method work, since the breaker's evidence
  (5xx/timeout classes) is richest once non-GET methods and streaming
  exist.

Each phase is independently shippable and leaves the client surface
Phase-1-compatible (a caller that never reads `cost` and never hits
`InsufficientFunds` sees the Phase 1 behavior).

## SSRF / DoS posture is preserved

Nothing in the pipeline relaxes the Phase 1 defenses:

- `redirect: 'manual'` and the host-curated origin allowlist remain in
  the pre-flight and transport stages, unchanged (`checkOriginAllowed`,
  `resolveRedirect`).
- The byte-cap is *strengthened* into double duty (DoS truncation **and**
  reservation ceiling); truncation still runs at read time, so a lying
  `Content-Length` is still defeated.
- The timeout is *strengthened* into the deadline term of the cost and
  the retry budget.
- New stages **add** gates (a metered client refuses on funds; a breaker
  refuses on a sick origin); none remove a gate. A guest's authority only
  shrinks.
- The fee purse and stage composition are controller-side endowments a
  guest cannot reach, so the pipeline introduces no new capability leak.

## Alternatives Considered

### Alt A: In-process function middleware (Koa closures) instead of exo stages

Compose the concerns as ordinary `(ctx, next) => ...` functions inside the
daemon's http-client module.

Rejected: closures cannot cross the CapTP boundary, so a fee purse held by
the gateway (a different vat) or a metering authority in another daemon
could not participate. The maintainer's request is explicit that these
are pass-style interfaces. The exo-stage shape costs one eventual-send per
hop (cheap same-vat) and buys cross-vat composition for free.

### Alt B: One monolithic `makeHttpConfinement` with more knobs

Keep http-confine's single aggregate and add `retry`, `breaker`, `meter`
fields to the policy struct.

Rejected: it re-creates exactly the flat-knob problem this design solves.
Ordering becomes implicit and unconfigurable, the concerns cannot be
independently omitted, and the per-scope state (per-origin breaker,
per-controller window, per-controller purse) has no natural home in one
struct. The pure primitives of http-confine are still reused, as **stage
bodies**, not as one aggregate.

### Alt C: Client presents a payment per request (payment-with-request)

Thread a `payment` capability through each `request` call, ERTP-style.

Rejected: it violates the Phase 1 invariant that the client only
exercises policy. A client that carries payment authority can choose to
spend or not, which is a policy decision. Binding the purse on the
controller keeps the guest unable to affect its own budget; the host
tops up the purse out-of-band (`purchaseTokens` / `setQuota`). The
`estimateCost` probe gives the guest visibility without authority.

### Alt D: Per-request rate limiting keyed on origin

Add an origin-keyed throttle alongside the per-client window.

Deferred: origin fairness under failure is the **circuit breaker's**
error-based job; a healthy origin needs no per-origin throttle beyond the
per-client and per-controller windows. If a concrete need surfaces
(a shared upstream with a published per-origin quota), it is a
non-breaking addition of one more window scope.

## Test plan

The builder's plan should cover, in addition to porting the Phase 1
suite unchanged through the refactored pipeline:

- **Stage composition:** a controller composing `[transport]`,
  `[rate, transport]`, and the full four-stage onion each yields a client
  whose `request` behaves as the union of the composed stages; a client
  cannot enumerate or reorder stages.
- **Metering reserve/settle:** a request whose `cost_max` exceeds the
  purse balance rejects with `InsufficientFunds` **before** the injected
  transport seam is called (assert the seam's call count is 0); a request
  that succeeds settles to `cost_actual < cost_max` and the purse is
  refunded the difference; a truncated response bills at exactly the
  `maxResponseBytes` term; a transport error before read charges only
  `perRequest`.
- **Concurrent reservations serialize:** two `reserve` calls that would
  jointly exceed `limit` cannot both succeed (assert the atomic
  allowance-draw claim: one wins, one rejects with `InsufficientFunds`,
  and the account balance never goes negative).
- **`estimateCost`:** the pure probe returns `cost_max` for a request,
  reserves nothing (assert the charge account's `reserve` is never
  called and the balance is unchanged), and matches the `cost_max` a real
  reservation would compute.
- **Byte-cap = reservation ceiling:** a response with a lying large
  `Content-Length` still bills at `bytesActuallyRead`, and
  `bytesActuallyRead <= maxResponseBytes` always.
- **Rate position:** a rate refusal never calls `reserve` on the purse;
  each retried attempt spends its own token; the per-controller aggregate
  binds when tighter than the per-client window.
- **Retries:** GET retries on 5xx/timeout/connection error up to
  `maxAttempts`; POST never retries; a `Retry-After` sets the backoff
  floor; a `cancellation` rejection mid-backoff aborts the sleep and the
  loop; the shared deadline stops a doomed final attempt; 4xx and
  `InsufficientFunds` are not retried; a 429 **is** retried (backoff floor
  from `Retry-After`) yet does **not** advance the breaker's failure
  count.
- **Circuit breaker:** N failures within the window trip `open`; an open
  origin fast-rejects without spending a rate token or reserving funds; a
  sibling allowlisted origin stays `closed`; half-open admits exactly
  `halfOpenProbes`; a probe success closes; a mid-retry-loop trip halts
  the loop (assert the breaker sees each attempt, and the attempt after
  the trip fast-rejects with `CircuitOpenError`); neither 4xx nor 429
  counts toward the threshold.
- **Cross-boundary:** a `FeePurse` held in a *different* vat participates
  in reserve/settle over CapTP (the pass-style claim), exercised with a
  two-vat test harness.

## Open questions

- **Metering unit.** Is the billed unit an ERTP token (mintable, per
  [gateway-package](gateway-package.md)), an abstract integer against a
  `ResourceLedger`, or a computron-equivalent unified with
  [daemon-xs-worker-metering](daemon-xs-worker-metering.md)? This design
  is unit-agnostic; the gateway's later payment design pins it. Unifying
  the HTTP meter and the XS-worker meter into one `ResourceLedger`
  currency is attractive (an agent's total resource spend, compute plus
  network, draws from one purse) and worth a dedicated reconciliation.
- **Reservation granularity for streaming bodies.** When the response
  body is consumed lazily as a `ReadableBlob`, settlement is deferred
  until drain/release. Should the meter charge incrementally as chunks are
  read (finer accounting, more purse round-trips) or once at
  drain/release (coarser, cheaper)? Default proposed: settle once at
  release, bill worst-case if never released.
- **Breaker state persistence.** Is per-origin breaker state ephemeral
  (like the rate window, reset on daemon restart) or durable in
  `fetch-store` alongside policy? Proposed: ephemeral. A restart is a
  natural half-open, and persisting failure counts risks a restart-loop
  staying wedged `open`.
- **Crash recovery between reserve and settle.** The minion.town
  direction keeps a durable outbox at the measurement source and a
  reconciler that, after a crash between reservation and settlement, asks
  the source for the operation outcome, settling the trusted measure,
  cancelling a provably-unstarted operation, or leaving the hold reserved
  for operator review; "it never guesses zero and releases funds merely
  because a lease expired." How much of that durability the daemon HTTP
  meter needs (versus treating a mid-flight crash as a forfeited hold) is
  a deployment question keyed to the value of the metering unit.
- **Deadline as controller policy vs caller proposal.** The caller may
  propose a `deadline` in the caller context; the meter/timeout stages
  clamp it **down** to the controller's `timeoutMs` (never up). Should a
  caller be allowed to request a *shorter* deadline to lower its own
  worst-case cost? Proposed: yes. A shorter caller deadline lowers
  `cost_max`, which is incentive-correct and cannot widen authority.

## Dependencies

| Design | Relationship |
|---|---|
| [cli-http-client](cli-http-client.md) | Parent; this elaborates its Phase 3/4 into the pipeline. |
| [http-confine](http-confine.md) | Pure primitives become stage bodies; its fixed order generalizes here. |
| [endo-fetch](endo-fetch.md) | The confined-fetch integration composes and persists the pipeline. |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Admission-control / budget-as-pre-payment model, transposed to bytes+time. |
| [gateway-package](gateway-package.md) | `ResourceLedger` / purse the fee stage draws against. |
| [trust-on-first-bind](trust-on-first-bind.md) | A future TOFU stage; out of scope here. |

## Prompt

Follow-up requested by kriskowal on the approval of `endo http mk`
Phase 1, PR
[#286](https://github.com/endojs/endo-but-for-bots/pull/286#pullrequestreview-4943057191):

> Please post a follow-up job to elaborate on this HTTP client and
> controller system to allow for metering, fees, rate limiting, retries,
> and circuit breaking (based on errors). There's a great deal of prior
> art on HTTP adapter pipelines (middleware) to mine for design
> precedents, recalling that these are pass-style interfaces. Note also
> the recent design direction for metering the minion.town gateway web
> services, which establishes ground rules for metering based both on
> deadline and request and response payload length, where a request will
> be refused if there are inadequate funds to process the worst-case
> payload and reject before reading any bytes, but otherwise bill based on
> actual usage.
