# HTTP Adapter Pipeline: Metering, Fees, Rate Limiting, Retries, and Circuit Breaking as Pass-Style Stages

| | |
|---|---|
| **Created** | 2026-08-15 |
| **Updated** | 2026-08-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | PR [#286](https://github.com/endojs/endo-but-for-bots/pull/286#pullrequestreview-4943057191) review (approval of `endo http mk` Phase 1) |
| **Elaborates** | [cli-http-client](cli-http-client.md), [http-confine](http-confine.md) |

## What is the problem being solved?

Phase 1 of the `endo http` controller/client pair
([cli-http-client](cli-http-client.md)) shipped its defenses (origin
allowlist, per-request timeout, sliding-window rate limit, response
byte-cap) as a **fixed pipeline with a flat set of policy knobs** on the
controller. `@endo/http-confine`'s `makeHttpConfinement` realizes those
same defenses (together with the method/header normalization and
redirect handling every safe `fetch` needs) as six hard-coded
implementation steps in one fixed order: rate `take()`, then
method/header normalization, then origin check, then `fetch`, then
redirect, then byte-cap. (The four-knob list and this six-step list
enumerate the *same* Phase 1 behavior at different granularities: the
per-request timeout is carried on the transport's abort signal rather
than being a distinct step, and method/header normalization and redirect
handling are implementation steps with no separate policy knob.)

The maintainer's approval of Phase 1 asked for a follow-up that
elaborates the controller/client system to support **metering, fees,
rate limiting, retries, and circuit breaking (error-based)**. This
design answers that request, mining the substantial prior art on HTTP
adapter pipelines (Koa/Express middleware, axios interceptors, undici
`Dispatcher.compose`) for design precedents, per the maintainer's
instruction to recall "that these are pass-style interfaces" (*pass-style*:
built from hardened, interface-guarded **exo facets** that can be shared by
reference across a vat/CapTP boundary and called with eventual-send, rather
than from plain closures bound to one vat -- the property observation 5 below
develops in full).

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
   independently insertable: the definition of an adapter.
4. **They carry state with different scopes.** Rate windows are
   per-client; circuit-breaker state is per-origin; the fee purse is
   per-controller. A flat struct cannot express these scopes.
5. **They must remain pass-style.** An **exo facet** is a hardened,
   interface-guarded object with its own encapsulated state that is
   *passable*: it can be shared across a CapTP (vat) boundary by
   reference and called with eventual-send (`E(ref).method(...)`), unlike
   a plain closure, which is bound to the vat that created it. The
   controller holds the policy and the guest merely exercises it, across
   a CapTP boundary. In-process function adapters
   (`(ctx, next) => ...`) cannot cross a vat boundary; the pipeline must
   be built from exo facets, not closures.

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
| [gateway-package](gateway-package.md) | Supplies the `ResourceLedger` (`getBalance`, `chargeBalance`, `purchaseTokens`, `setQuota`) that the meter stage (fee-side) draws against; the gateway is "the layer where HTTP/WS traffic accrues ... the natural place to meter and gate." Its § Feature 1 (Chat-hosting) **surfaces but does not answer** the per-request billing granularity ("the granularity of the resource counters ... Surfaced rather than answered"): the exact gap the minion.town direction below fills. |
| minion.town gateway metering direction (`weblet-usage-metering.md`, `ertp-credits.md`; sibling garden repo, not in this tree) | The concrete ground rules cited in the maintainer's request: bill HTTP egress on **delivered bytes + wall-clock capped at a per-request deadline**; **reserve worst-case before headers**, refuse when funds are insufficient in the **pessimal case**, settle on **actual**; measurement happens at the **resource boundary** (a caller cannot report its own byte count); the reserve/perform/settle state machine and the attenuated **charge-account** purse primitive. This design transposes those rules onto the pass-style pipeline. |
| [trust-on-first-bind](trust-on-first-bind.md) | A future TOFU stage slots between origin pre-flight and transport; out of scope here. |

## Prior art: HTTP adapter pipelines as pass-style facets

This design calls our composable pipeline elements **adapters** (or
**stages**, interchangeably, for their position in the chain); "middleware"
is reserved for the in-process prior art below (Koa/Express and friends),
never for our pass-style construct. Every mainstream HTTP client factors
cross-cutting concerns into an ordered, composable adapter chain:

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

| Prior-art idiom | Pass-style expression |
|---|---|
| Koa `(ctx, next)` closure | An **exo adapter facet** implementing `HttpStageInterface` whose `request` method calls `E(next).request(...)`. |
| `next` continuation | A **remotable** (`M.remotable('HttpStage')`) captured at composition time, not passed per-call. |
| `ctx` mutable context | An **immutable `StageContext` record** threaded by value (`origin`, `requestId`, `attempt`, optional `deadline`). No stage mutates another's fields; each hop forwards a freshly hardened record. Effectful shared state (the meter's live reservation) stays in the originating stage's own closure, captured at composition like `next`: it is never threaded through the shared context. |
| `app.use(mw)` ordering | The **controller** composes the chain inner-to-outer at configuration time; order is controller policy, not caller input. |
| The base adapter (undici `Agent`) | The **terminal transport stage** over the injected `fetch` seam (`@endo/fetch`), which performs `redirect: 'manual'` + bounded read. |

The crucial adaptation: Koa passes `next` as a per-call argument;
pass-style **captures `next` at construction**. Each stage exo is built
endowed with the far-ref to the stage beneath it, so its interface is the
uniform `request(request, cancellation, context)` (identical to the client's
own `request`) and a stage is indistinguishable from the whole client to the
stage above it. This is what lets the chain be **arbitrarily deep and
partly remote**: a stage can live in the daemon vat (the common case,
where `E(next)` is a cheap same-vat eventual-send) or in another vat
entirely (for example, a fee purse held by the gateway), because every hop is a
CapTP call, not a synchronous function call.

### The stage interface

```js
import { M } from '@endo/patterns';

// A caller- or config-supplied numeric budget must be finite and
// non-negative. Bare `M.number()` admits NaN, Infinity, and -Infinity
// (they are valid passable numbers), and every downstream clamp/`min` and
// `<` admission comparison fails open on them: `available < NaN` is always
// `false` (silently admitting an unbounded-cost request), and a `NaN`
// deadline disables both the retry-stop and timeout-stop checks (a
// `remaining <= 0` test against NaN is always false). So deadlines, prices,
// and reservation amounts are guarded with this, never bare `M.number()`. It
// excludes NaN, +Infinity, and -Infinity (the three passable numbers a
// bare number guard would let through).
const FiniteNonNegative = M.and(
  M.number(),
  M.gte(0),          // rejects -Infinity
  M.not(Infinity),   // rejects +Infinity
  M.not(NaN),        // rejects NaN (which rank-orders above +Infinity)
);

// A DISCRETE count, not a continuous budget: the per-request MEASURES
// (`contentLength`, `bytesRead`, `elapsedMs`) and the byte-cap policy fields
// (`maxRequestBytes`, `maxResponseBytes`). These are the *distinct shape* the
// count domain needs, kept separate from the continuous `FiniteNonNegative`
// (deadlines, prices-as-ratios) because they feed the `bigint` cost
// arithmetic (§ Numeric domain) and so must be non-negative INTEGERS: the
// formula widens each with `BigInt(...)`, and `BigInt(0.5)` throws
// `RangeError` while `FiniteNonNegative` admits `0.5`. @endo/patterns has no
// integer-number matcher, so integrality is the one constraint carried as an
// Exo-boundary assertion rather than a pattern combinator: the shape guards
// finite-and-non-negative, and the meter's boundary additionally rejects a
// non-integer with a structured error before the `BigInt(...)` widening. (Per
// this repo's AGENTS.md § Numeric domain these stay `number`, not `bigint`:
// each is a single-request quantity whose range genuinely fits four bytes,
// unlike the monetary terms accumulated over the daemon's whole lifetime.)
const IntegerNonNegative = FiniteNonNegative; // + Number.isInteger() at the boundary

// RequestShape / ResponseShape are the Phase 1 shapes from
// cli-http-client.md (bodies are ReadableBlob remotables). This design
// adds one optional field to RequestShape -- `contentLength:
// IntegerNonNegative`, the request-body byte length the meter needs up
// front (see § 1); an integer count, not a continuous budget. A metered
// client supplies it; an unmetered one ignores it.

// What a client/guest may propose at the client boundary: only a
// deadline. Split from the internal stage context so the client boundary
// cannot smuggle stage state (a reservation, an attempt count, a forged
// origin, or a request id) into the pipeline.
const CallerContextShape = M.splitRecord(
  {},
  { deadline: FiniteNonNegative }, // absolute ms; the wall-clock budget proposal
);

// The internal stage-to-stage accumulator: the pre-flight-computed
// `origin`, the `requestId` the client's thin forwarder mints once per
// request, the `attempt` counter the retry stage threads, and the optional
// caller `deadline`. Immutable and passed by value; each hop forwards a
// freshly hardened record ({ ...context, attempt: context.attempt + 1 }),
// never mutating the record it received. It carries NO capability: the
// meter's live reservation lives in the meter stage's own closure
// (captured at composition, like `next`), never in this shared record, so
// no downstream or mistakenly-inserted stage can reach it. `requestId` is a
// value, not a capability -- it is the request's idempotency root (see
// § 1), minted before the onion so a Phase-3.5 meter reaches it even when
// no retry stage is composed.
const StageContextShape = M.splitRecord(
  { origin: M.string(), requestId: M.string(), attempt: M.number() },
  { deadline: FiniteNonNegative },
);

// The CLIENT boundary a guest holds. Its `request`/`estimateCost` take
// only the narrow CallerContextShape, so a guest cannot supply `origin`,
// `attempt`, `requestId`, or any capability. The client is a thin
// forwarder: it runs the pure pre-flight (which computes `origin`) and
// mints the `requestId`, then calls the outermost stage with a synthesized
// StageContext (`{ origin, requestId, attempt: 0 }`).
export const HttpClientInterface = M.interface('EndoHttpClient', {
  request: M.call(RequestShape, M.promise())
    .optional(CallerContextShape)
    .returns(M.promise()),
  // Pure affordability probe: resolves to costMax, reserves nothing. It
  // bounds a SINGLE attempt's worst case, not the whole retried call (see
  // § 2), so it await-returns a guarded FiniteNonNegative -- the `help`
  // case: a bare primitive with no downstream shape to guard it. The client
  // is the sole CONSUMER of the specialized cost-quote contract: the
  // composer wires this forwarder directly to the meter adapter's CostQuote
  // facet (§ Specialized adapter-pair contracts), so the answer does not
  // travel the request onion and no intervening adapter is involved.
  estimateCost: M.callWhen(RequestShape)
    .optional(CallerContextShape)
    .returns(FiniteNonNegative),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(HttpClientInterface);

// Every internal ADAPTER speaks this UNIFORM interface. It differs from
// the client boundary in exactly one way: the third argument is the wider
// StageContextShape (origin + attempt already synthesized), so an adapter
// is substitutable for the whole client to the adapter above it. Note what
// is DELIBERATELY ABSENT: `estimateCost` is NOT a method here. Only the
// meter adapter can answer a cost quote; threading `estimateCost` through
// this uniform interface would force retry, breaker, and rate to each
// implement a pass-through they have no stake in -- a cross-cutting concern
// smeared across an interface that must stay `request`-only. Cost quoting
// is instead a SPECIALIZED ADAPTER-PAIR CONTRACT (CostQuoteInterface below,
// wired at composition between exactly the two constructors that share it;
// see § Specialized adapter-pair contracts), the same shape `next` uses.
export const HttpStageInterface = M.interface('EndoHttpStage', {
  request: M.call(RequestShape, M.promise())
    .optional(StageContextShape)
    .returns(M.promise()),
  help: M.call().optional(M.string()).returns(M.string()),
});
harden(HttpStageInterface);

// The SPECIALIZED cost-quote contract -- NOT part of the uniform adapter
// interface above. Exactly one adapter (the meter) PROVIDES it; exactly one
// party (the client's thin forwarder) CONSUMES it. The composer wires the
// consumer directly to the provider's cost facet at construction (§
// Specialized adapter-pair contracts), so no intervening adapter (retry,
// breaker, rate) sees or forwards it. It answers `costMax` from the meter's
// private PriceSchedule and reserves nothing -- the pure probe. A chain
// composed with no meter has no provider, so the composer wires the
// consumer to a null quote that answers 0 (the same "answers 0" behavior
// the old forward-through-the-onion shape had, now a named composition
// choice, not a silent fallthrough). It resolves to a bare `costMax`, so it
// guards its own resolved value (the `help`/`estimateCost` guard rule
// below), never an unguarded promise.
export const CostQuoteInterface = M.interface('EndoHttpCostQuote', {
  estimateCost: M.callWhen(RequestShape)
    .optional(StageContextShape)
    .returns(FiniteNonNegative),
});
harden(CostQuoteInterface);
```

**The client-to-stage seam.** The client's thin forwarder is exactly
where a `CallerContextShape` becomes the first `StageContextShape`. The
pure pre-flight (§ Canonical stage order) runs *before* the onion: it
parses `request.url`, computes `origin`, and validates method/headers. The
client then invokes the outermost stage with the synthesized initial
context
`harden({ origin, requestId, attempt: 0, ...(deadline === undefined ? {} : { deadline }) })`.
The guest never constructs this record (it only proposes `deadline`), so it
cannot forge an `origin`, pre-set `attempt`, or supply its own `requestId`.
This is the seam the capability claim rests on: `origin`, `requestId`, and
`attempt` enter the pipeline from trusted controller-side code, never from
the caller, and the `CallerContextShape` guard on the client boundary
structurally rejects a guest that tries to supply them.

**Minting `requestId`.** The thin forwarder mints one `requestId` per
`request` call from the daemon's unforgeable-id source (the same
collision-resistant generator the daemon uses for formula/capability ids,
not a per-restart counter), so two logically distinct requests, whether
concurrent or issued across a restart, never share an id, and a CapTP
redelivery of the *same* call carries the *same* id. This uniqueness is
what the per-attempt `operationId` (§ 1) rests on: minting it in the client
(before the onion) rather than in the retry stage means the meter has a
stable idempotency root even in a Phase-3.5 deployment that ships the meter
without the retry stage (§ Staging into the Phase plan).

`request` declares `.returns(M.promise())` without a resolved-value guard
on purpose: it resolves to a `Response` record already shaped by
`ResponseShape`, so a second return-shape check would be redundant. The
sibling `help` guards its resolved value (`M.string()`) because that is a
bare primitive with no downstream shape to guard it. `estimateCost`
resolves to a bare `costMax` number, exactly the `help` case, so it
await-returns a guarded `FiniteNonNegative` (`M.callWhen(...).returns(...)`)
rather than an unguarded promise: by the rule above, a bare primitive with
no downstream shape guards its own resolved value. The `reserve` verb
(below) stays unguarded because its resolved `MeterReservation` is already
shaped by `MeterReservationInterface`, the `request` case; the sibling
`getBalance` guards its bare number, the `help`/`estimateCost` case.

A stage's `request` body is the onion:

```js
// Sketch -- a generic stage. `next` and the policy slice are captured
// in the exo's state at make time by the controller's composer.
request: async (request, cancellation, context) => {
  // ...before: consult/update this stage's own scoped state...
  const response = await E(this.state.next).request(request, cancellation, context);
  // ...after: observe the outcome...
  return response;
},
```

The terminal stage's `next` is the injected `fetch` transport, not
another `HttpStage`; it is the only stage that touches the platform.

### Specialized adapter-pair contracts: `estimateCost` off the uniform interface

`estimateCost` is deliberately **not** a method on `HttpStageInterface`. An
earlier shape put it there and had every adapter forward it down the onion
-- retry, breaker, and rate each passing a cost probe straight through to
`next` until it reached the meter. That is a cross-cutting concern smeared
across an interface that should stay `request`-only: three adapters carry a
pass-through they have no stake in, purely so one pair at the ends of the
chain can talk. And it would not be the last such need -- the next time one
adapter must consult a *specific* downstream adapter (a breaker asking the
meter whether a probe is free of charge, a future TOFU stage asking the
transport for a pin fingerprint), the same pressure would push another
method onto the uniform interface, and every non-participant adapter would
grow another inert pass-through. An interface that accretes one method per
inter-adapter conversation is not uniform for long.

The alternative is a **specialized adapter-pair contract**: a bilateral
interface wired at composition between exactly the two adapter *constructors*
that share it, never a method on the interface every adapter implements. It
is the same mechanism `next` already uses -- a far-ref captured at
construction, not a per-call argument -- generalized from "the adapter
directly beneath me" to "the specific downstream adapter I hold a named
contract with."

Concretely, cost quoting is `CostQuoteInterface` (§ The stage interface), a
one-method facet the **meter adapter provides** and the **client's thin
forwarder consumes**. The controller's composer -- which already builds the
onion inner-to-outer and knows every adapter's identity -- does one extra
wiring step: as it composes, it tracks each *provided* specialized facet,
and when it reaches an adapter (or the client boundary) that *consumes* one,
it endows that consumer with a far-ref to the nearest downstream provider's
facet. For `estimateCost` the consumer is the client forwarder and the sole
provider is the meter, so the composer wires the client's `estimateCost`
**directly to the meter's `CostQuote` facet**; the retry, breaker, and rate
adapters between them in the request onion are not parties to the contract
and never see it. Their `HttpStageInterface` stays exactly `request` +
`help`.

This is what "a contract between two adapter constructors, not the adapter
interface in general" buys:

- **The uniform interface stays minimal.** Adding a specialized contract
  never widens `HttpStageInterface`; a non-participant adapter is unchanged
  and implements no method it does not answer.
- **Participation is explicit and typed.** An adapter's constructor declares
  which specialized facets it *provides* and which it *consumes*; the
  composer matches each consumer to the nearest downstream provider and fails
  composition when a consumer's contract has no provider, rather than leaving
  a silent runtime pass-through to return a wrong default. The one sanctioned
  "no provider" case is spelled explicitly: a chain composed without a meter
  has no `CostQuote` provider, so the composer wires the client's
  `estimateCost` to a **null quote that answers 0** -- the same "answers 0"
  behavior the old forward-through-the-onion shape produced, now a named
  composition choice rather than an interface-wide fallthrough.
- **It preserves composition opacity.** The guest still holds only the
  client and never names the meter: the cost-quote far-ref lives in the
  client forwarder's own captured state (like `next`), so a guest reaches the
  interior price through `estimateCost` without gaining a reference to any
  adapter.
- **It generalizes.** The next inter-adapter need is one more `M.interface`
  plus one more provide/consume pair the composer wires the same way; it does
  not touch the uniform interface or any adapter that is not a party to it.

When a future contract has a *chain* of participants (adapter A quotes from
B's quote which quotes from C's), the composer threads each participant to
the *next participant's* facet -- an adapter calling forward to the next
adapter's specialized method, skipping non-participants -- so the multi-party
case is this same wiring rule applied transitively. The single-provider
`estimateCost` case is that rule with exactly two parties.

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

1. Parse `new URL(request.url)`; compute `origin`.
2. Origin allowlist (`checkOriginAllowed`).
3. Method normalization + closed-set check (`normalizeMethod`).
4. Header safety (`assertHeadersSafe`).
5. Deadline sanity: if the caller proposed a `deadline`, it must be finite
   and non-negative (the `FiniteNonNegative` guard already enforces that at
   the boundary) **and still in the future** against the injected `now`
   seam (the same clock the rate limiter reads; the pre-flight stays clock-
   pure by reading it through that seam, never an ambient `Date.now()`). An
   already-expired deadline is rejected here, before the effectful onion, so
   a request known-doomed at parse time never spends a rate token or a fund
   reservation on a call that the retry/meter machinery would only discover
   was unmeetable after admission.

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

This is a deliberate generalization of http-confine's fixed order -- two
substantive changes plus one low-impact reordering, each with its own caveat
tracked separately:

1. **Origin/method/header validation moves ahead of everything, into the
   pure pre-flight.** http-confine spends the rate token before it checks the
   origin; this pipeline validates structure first, so a structurally invalid
   request never consumes a rate token or a fund reservation.
2. **The breaker sits *just inside* the retry stage rather than strictly
   outermost.** This is the position that lets the breaker both gate before
   any resource-spending stage (an `open` breaker fast-rejects on the first
   attempt, before rate/meter/transport) **and** observe each individual
   attempt (retry calls the breaker once per attempt, so a retry storm
   against a dying origin trips the breaker, which then aborts the storm on
   the very next attempt).
3. **The pre-flight checks origin *before* method/header validation** (the
   low-impact reorder), where http-confine validates method and headers
   first; both still precede the effectful onion, so the reorder changes no
   side-effecting behavior, and it is named here rather than left implicit.
   *Behavior-change caveat (attaches to this item only):* one narrow
   observable does change -- a request that fails **both** origin and
   method/header validation now surfaces the origin rejection first where
   http-confine surfaced the method/header rejection first, so a caller that
   pattern-matches on the specific rejection reason (not merely "pre-flight
   rejected") sees a different error type for that both-invalid case. This is
   an accepted edge of the reorder, not a behavior a well-formed caller
   depends on.

Redirect resolution and byte-cap stay inside the transport stage exactly as
http-confine defines them. Where a deployment omits a concern (no fees, no
breaker), that stage is simply absent from the composed chain and the onion
collapses toward the Phase 1 behavior.

## The five concerns

The five concerns are detailed below in the order the maintainer's
request named them (metering, fees, rate, retries, breaking), which is
**not** the pipeline execution order of the table above. In particular,
**the fees concern is not a pipeline stage at all**: it is the funding
capability (the charge account) that the meter stage draws against, so
the onion has four non-transport stages (retry, breaker, rate, meter),
not five.

### 1. Metering: one mechanism with the byte-cap

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
stage it was composed with (a capability it was endowed with at composition
time), and the guest, which holds
only the outermost stage, never touches the tally. The minion.town
direction makes this explicit ("a caller cannot report its own byte
count") and the pipeline honors it by construction.

**The cost function.** Pricing is a versioned `PriceSchedule` the
*ledger* selects (never the caller), so a price change never reprices a
settled event or an already-open reservation. Here "the ledger selects"
names the **authority**: the host/integration that holds the purse and
endowed the charge account is the ledger authority, and it registers a
new schedule version through the `setMeterPrice` controller verb
(§ Exo and CLI surface additions); "never the caller" excludes the guest
holding the client, which has no price-setting verb. Registering a new
version does not disturb reservations already open against the prior
version, and the **mechanism** for that immunity is a **price snapshot
captured at `reserve()`**, not a live re-read at `settle()`: when the meter
stage opens a reservation it binds the current `PriceSchedule` version into
that reservation (the same "capture at construction, not re-read live"
discipline `StageContext` already applies to `next` and to the live
reservation), and `settle()` computes `costActual` from **that captured
snapshot**, never from whatever version is current when settlement runs. So
a `setMeterPrice` call racing an in-flight reservation reprices only
reservations opened *after* it lands; every open reservation settles at the
version that computed its `costMax`, which is what makes `costActual <=
costMax` hold across a mid-flight price change. A request's worst-case cost
is
```
costMax = price.perByteRequest  * BigInt(request.contentLength)        // declared up front (see below)
        + price.perByteResponse * BigInt(maxResponseBytes)            // the Phase 1 byte-cap = worst-case response (aggregate pool)
        + price.perMillisecond  * BigInt(Math.ceil(effectiveDeadlineMs)) // caller deadline clamped down by timeoutMs, rounded UP (pessimal)
        + price.perRequest                                            // fixed admission fee
```
where `effectiveDeadlineMs = min((deadline ?? (now + timeoutMs)) - now,
timeoutMs)`: `deadline` is an **absolute** wall-clock ms timestamp (§ The
stage interface; the same value pre-flight step 5 rejects when it is not
still in the future against the injected `now`), so the remaining budget it
proposes is `deadline - now`, and the time term is priced against the
controller's `timeoutMs` **clamped down by any shorter caller `deadline`**,
never up. The subtraction of `now` is what keeps an absolute-timestamp
`deadline` from dwarfing `timeoutMs` (which would make the `min` a no-op and
silently pin every request to the full `timeoutMs`). This is the deliberate
resolution of § Open questions ("Deadline as controller policy vs caller
proposal"): a caller that proposes a shorter `deadline` genuinely lowers
its own `costMax`, which is incentive-correct and cannot widen authority
(the clamp is a `min`, so the caller can only shave the time term, never
inflate it). A request with no caller `deadline` prices the full
`timeoutMs`.

**A worked pass (concrete numbers).** Take a price schedule of
`perByteRequest = 2n`, `perByteResponse = 1n`, `perMillisecond = 10n`,
`perRequest = 100n` (units of the metering token), a controller
`timeoutMs = 30_000`, `maxResponseBytes = 1_000_000`, and a POST declaring
`contentLength = 500` with no caller `deadline`. Reservation:
`costMax = 2n*500n + 1n*1_000_000n + 10n*30_000n + 100n = 1000n + 1_000_000n
+ 300_000n + 100n = 1_301_100n`. The account must hold at least `1_301_100n`
or `reserve` rejects with `InsufficientFundsError` before a byte is sent.
Say the response actually returns `40_000` bytes in `220` ms: settlement is
`costActual = 2n*500n + 1n*40_000n + 10n*220n + 100n = 1000n + 40_000n +
2_200n + 100n = 43_300n`, and `release()` returns `costMax - costActual =
1_257_800n` to `available`. Had the caller instead proposed
`deadline = now + 5_000` (an absolute timestamp 5_000 ms in the future), the
time term of `costMax` would price `min((now + 5_000) - now, 30_000) =
min(5_000, 30_000) = 5_000` ms -> `10n*5_000n = 50_000n` instead of
`300_000n`, lowering `costMax` to `1_051_100n`. Every quantity is an integer
widened with `BigInt(...)`, so no term is fractional and `costActual`
(`43_300n`) `<= costMax` (`1_301_100n`) holds by construction.

Every term is known **before headers are sent or a single response byte
is read**. But the request-body term needs the body's size up front, and
the `body` `ReadableBlob` does **not** expose it: its interface is
`streamBase64` / `text` / `json`, all *consuming* reads, so measuring the
body by reading it would defeat the very reserve-before-read guarantee
this mechanism rests on. So a metered request **declares** its size: this
design adds `contentLength: IntegerNonNegative` to `RequestShape`, the
request body's byte length (a discrete count, not a continuous budget --
see § Numeric domain and lines above), supplied alongside the `body`
remotable. The
transport stage **enforces** the declaration, but asymmetrically with the
response side. `maxResponseBytes` *truncates* an over-long response,
because a response is untrusted inbound data the caller already expects
may arrive partial; the request body is **caller-authored outbound** data,
so silently truncating it (cutting a POST body mid-JSON and forwarding the
mangled request to the origin) would corrupt data the caller authored. So
the transport instead **rejects** a request whose body overruns its
declared `contentLength` with a structured error, before the overrun
leaves the process. Rejection protects the meter's `costActual <= costMax`
invariant exactly as truncation would (an under-declaration still cannot
cheat the meter) without ever shipping a corrupted request.

`maxRequestBytes` is the outbound-byte ceiling in **both** branches, not
only the omitted-`contentLength` one: a **declared** `contentLength` that
itself exceeds `maxRequestBytes` is rejected at pre-flight with the same
structured over-run error, before any body is streamed or any reservation
is priced against the inflated declaration. Without this, a guest could
declare an arbitrarily large `contentLength` and (in a metered deployment,
by paying for it; in an unmetered one, for free) ship an unbounded request
body -- exactly the outbound flood `maxRequestBytes` exists to bound, and
falsifying the "a guest's authority only shrinks" claim of § SSRF/DoS
posture for the declared path. So the effective declared ceiling is
`min(contentLength, maxRequestBytes)` enforced as a rejection: the meter
reserves against the declared `contentLength` only once it is known to be
within `maxRequestBytes`, symmetric with how `maxResponseBytes` bounds the
inbound side regardless of any declared `Content-Length`.

The mirror
case, a body that **under-delivers** (its stream ends before reaching the
declared `contentLength`), does not hang the transport waiting for bytes
that never arrive: end-of-stream is treated as completion and the
request-body term settles at the **declared** `contentLength` (the value
the caller declared and the reservation already held), so a short body can
neither lower its bill below its declaration nor hold the reservation and
rate slot open past the deadline.

A request that omits `contentLength` is charged the controller's
configured `maxRequestBytes` worst case for the request-body term (the
pessimal-case default). `maxRequestBytes` is a **new controller policy
field this design introduces** (Phase 3.5), the request-side sibling of the
Phase 1 `maxResponseBytes`, with the same default-constant + policy-field +
setter shape http-confine already uses for the response cap
(`policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES`); it is set
through the new `setMaxRequestBytes` verb (§ Exo and CLI surface
additions) and, like `maxResponseBytes` and `timeoutMs`, comes from the
controller's immutable policy, never from the caller. This is precisely
why refusal-in-the-pessimal-case is possible without touching the network.
When `contentLength` is omitted, `maxRequestBytes` is not only the billed
worst case but also an **enforced cap**: the transport rejects an
omitted-`contentLength` body the moment its streamed length exceeds
`maxRequestBytes`, with the same structured over-run error as the declared
case, before the overrun leaves the process. Without this, an omitted
declaration would be an unbounded outbound stream that bills only the
pessimal reservation while shipping arbitrarily more bytes; enforcing the
fallback as a ceiling keeps the `costActual <= costMax` invariant intact
for the omitted case exactly as the declared case preserves it.

**Numeric domain.** The monetary and reservation quantities (`costMax`,
`costActual`, the `price.*` schedule terms, the `reserve` amount, and a
charge account's balance) are naturals accumulated over the daemon's whole
lifetime (settle/release/top-up without an a-priori four-byte bound), so
per this repo's `AGENTS.md` § Numeric domain they are `bigint`, not
`number`; the interface sketches below spell them `M.bigint()`. The
per-request *measures* (`contentLength`, `bytesRead`, `elapsedMs`) and the
byte-cap policy fields (`maxRequestBytes`, `maxResponseBytes`) are bounded
single-request counts whose range genuinely fits four bytes, so they stay
`number` -- but the discrete `IntegerNonNegative`, not the continuous
`FiniteNonNegative` (§ The stage interface), because they feed the cost
arithmetic and must be integers.

**How the two domains multiply (the mixing rule).** `bigint * number` throws
a `TypeError` in JavaScript for *any* number operand, integer or not
(`5n * 3` throws), so the cost formulas below never write a bare
`price.* * quantity`. Each integer count is **widened to `bigint` with
`BigInt(...)` at the multiplication** (`price.perByteRequest *
BigInt(request.contentLength)`); this is safe precisely because
`IntegerNonNegative` guarantees a non-negative integer, so the `BigInt(...)`
never hits the `RangeError` a fractional argument would raise. The one
genuinely continuous input, the caller-proposed `deadline` (a wall-clock ms
value `FiniteNonNegative` may leave fractional), is the sole place a
**rounding rule** is needed, and its direction is load-bearing: the time
term's millisecond budget is rounded **up** (`ceil`) for `costMax`, the
pessimal direction that preserves the refuse-before-headers invariant (a
reservation never under-counts the time it might bill), and `costActual`
prices `min(elapsedMs, ceil(effectiveDeadlineMs))` where `elapsedMs` is
already an integer measure; since `ceil(effectiveDeadlineMs) >=` the exact
budget and every other quantity is an exact integer, `costActual <= costMax`
holds term by term -- the reservation invariant every downstream
refuse-before-read guarantee rests on.

**Reserve, perform, settle.** The meter stage runs the ledger's
reserve/settle state machine:

1. **Reserve.** Compute `costMax` against the **current `PriceSchedule`
   version and snapshot that version into the reservation** (§ The cost
   function); call `reserve(operationId, costMax)` on the endowed charge
   account. The reservation atomically moves
   `available` to `reserved` and returns a `MeterReservation` capability,
   or, if the balance cannot cover the pessimal case, **rejects now** with
   `InsufficientFunds`, before `fetch` is invoked, so no header is sent
   and no upstream byte is read. The reservation is a hold, not a charge.
   The `perRequest` fixed admission fee is **committed at reserve time**
   (non-refundable, the price of admission); the byte and time terms are
   held and later settled or released. The `operationId` is derived
   **per attempt** as `` `${requestId}:${context.attempt}` ``: the
   client's thin forwarder mints one `requestId` for the whole request
   (§ The client-to-stage seam, from the daemon's unforgeable-id source),
   threads it on the `StageContext`, and each attempt appends its
   `context.attempt` index. This makes the idempotency key per-attempt: a
   CapTP redelivery of the *same* attempt returns the *same* hold (no
   double-reserve), while the three attempts of a 3-attempt retry carry
   three distinct ids and open three distinct holds, reconciling "keyed by
   operationId for idempotency" here with "reserves and settles three
   times" in § 4. One field, one identity job: replay-dedup *within* an
   attempt; the `requestId`/`attempt` split supplies the per-attempt
   billing distinctness separately. Minting `requestId` in the client
   rather than the retry stage is deliberate: a Phase-3.5 deployment ships
   the meter before the retry stage (§ Staging into the Phase plan), so the
   meter must reach a stable `requestId` even with no retry stage composed;
   the client always supplies it, and a chain with no retry stage simply
   carries `attempt: 0`.
2. **Perform.** Call `E(next).request(...)` (the transport). The bounded
   read (`limitResponseBytes`, ceiling `maxResponseBytes`) guarantees the
   actual response never exceeds the reserved worst case; a lying
   `Content-Length` cannot overrun the reservation because truncation is
   at read time (unchanged from Phase 1 / http-confine).
3. **Settle.** After the body is fully read (or truncated, or the
   deadline fires), the transport reports the trusted `measurementId` (the
   transport stage mints it per completed measurement, derived as
   `` `${operationId}:measure` `` so a retried `settle` of the same attempt
   collides on the same key -- see the idempotency note below) + the actual
   measure, and the stage calls `settle(reservation, measurementId,
   { bytesRead, elapsedMs })`, which computes (the `price.*` terms are the
   reservation's **captured snapshot**, not live policy -- § The cost function)
   ```
   costActual = price.perByteRequest  * BigInt(request.contentLength)
               + price.perByteResponse * BigInt(bytesRead)                                  // measured at the boundary
               + price.perMillisecond  * BigInt(Math.min(elapsedMs, Math.ceil(effectiveDeadlineMs)))
               + price.perRequest
   ```
   atomically moving `costActual` from `reserved` to revenue and
   **releasing** `costMax - costActual` back to available, appending one
   settlement event with an idempotent receipt. An aborted response
   (transport error before any read, or a caller cancellation) pays only
   the non-refundable `perRequest` admission fee committed at reserve;
   `release()` returns the **entire remaining hold** (the byte and time
   terms) to available. `release()` and `settle()` are therefore the same
   rule (retain what was actually incurred, refund the rest) at
   different points on the wire: `settle` after a real response bills the
   measured byte/time terms; `release` after an abort bills nothing beyond
   the admission already committed. Consistent with the direction's
   *consistency over availability* stance, a subsystem that crashes
   mid-flight may leave the hold reserved for a reconciler rather than
   guess zero and release it.

**This is where metering and the Phase 1 byte-cap become one mechanism,
not two.** `maxResponseBytes` was, in Phase 1, purely a DoS defense
(truncate a flood). Here it plays a second role with no new machinery:
it is the **worst-case response term of the reservation**. The bounded
read that enforces the cap is exactly what bounds `costActual <=
costMax`, which is exactly what makes the up-front reservation safe. A
deployment with no fees still sets `maxResponseBytes`; a metered
deployment reuses it as the reservation ceiling. The `truncated: true`
flag Phase 1 returns doubles as "billed at the cap." The response record
gains one optional field, `cost: M.bigint()` (the settled charge, a
monetary quantity per § 1 Numeric domain); absent when no meter stage is
composed.

Because the meter reserves the worst case and settles actual, the
`ReadableBlob` response body must be **fully drained or released** for
settlement to complete, the same lifetime the Phase 1 rate-limiter slot
already has ("the rate-limiter slot is held until the body remotable is
released"). Settlement and slot-release are the same event; an unread
body bills at the reserved worst case when the daemon deadline fires,
which is the incentive-correct outcome (holding a slot open costs the
reserved maximum).

### 2. Fees: the purse capability

The meter stage (fee-side) draws against an **attenuated charge
account**, not a raw purse: the `ertp-credits.md` primitive `makeChargeAccount(purse, {
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
// The trusted, boundary-measured actual usage the transport reports to
// settle(). The per-request byte and time COUNTS are bounded single-request
// measures, so they stay `number` (the discrete `IntegerNonNegative`, not the
// continuous `FiniteNonNegative`), not the `bigint` the monetary terms use
// (see § 1 Numeric domain). Integer, so the settlement arithmetic widens each
// with `BigInt(...)` without a RangeError; the transport reports integer
// byte and millisecond counts by construction.
const MeasureShape = M.splitRecord(
  { bytesRead: IntegerNonNegative, elapsedMs: IntegerNonNegative },
);

export const MeterReservationInterface = M.interface('EndoMeterReservation', {
  // Settle to the trusted, boundary-measured actual; release the rest.
  // Idempotent on measurementId -- a retried settle returns the receipt.
  // settle and release are mutually exclusive terminal transitions:
  // whichever runs first wins, and the other is thereafter a no-op that
  // returns the same receipt (a settle after a prior release, or a release
  // after a prior settle, never moves funds a second time). This closes the
  // deadline-vs-late-completion race where the shared cancellation fires and
  // release() refunds the byte/time terms to available while a late transport
  // completion still reports its measures and calls settle() on the same
  // reservation -- the first-wins rule keeps the already-refunded terms from
  // being double-counted back out of available.
  settle: M.call(M.string(), MeasureShape).returns(M.promise()),
  // Abort: refund the whole REMAINING hold -- the byte and time terms.
  // The perRequest admission fee committed at reserve() is non-refundable
  // and is retained; everything still held returns to available. (Same
  // rule as settle: retain what was incurred, refund the rest. An abort
  // incurred only the admission, so release refunds all the byte/time
  // terms.) Idempotent and retry-safe like settle: a release after a prior
  // settle or release is a no-op that returns the same receipt, so a
  // retried abort path cannot double-refund.
  release: M.call().returns(M.promise()),
});
harden(MeterReservationInterface);

export const ChargeAccountInterface = M.interface('EndoChargeAccount', {
  // Reserve a hold for costMax, keyed by operationId. Rejects with
  // InsufficientFunds BEFORE returning when the balance cannot cover the
  // pessimal case -- the refuse-before-headers gate. Admission rule:
  // reserve SUCCEEDS when `available >= costMax` (an exact balance,
  // `available === costMax`, is admitted, draining the account to zero) and
  // rejects only when `available < costMax`, so the comparison is `>=`,
  // never a strict `>`.
  //
  // Idempotent on operationId: a CapTP redelivery of the SAME reserve call
  // returns the SAME hold rather than opening a second one (the no-double-
  // reserve property § 1 rests on), stated here on the guard itself, as
  // settle/release state their own idempotency below.
  //
  // The allowance decrement and the hold are ONE synchronous move: an
  // implementation MUST perform the balance check and the draw with NO
  // intervening `await` (no check-then-draw window), so concurrent
  // reservations serialize and cannot jointly exceed `limit`. This is a
  // load-bearing MUST, not incidental: the account may be a thin adapter
  // over a ledger in another vat (see the Cross-boundary test), where a
  // naive `reserve` that awaits a remote balance read before mutating would
  // reopen exactly the TOCTOU window two concurrent guests (or a retry
  // storm) could exploit to overdraw.
  //
  // Returns Promise<MeterReservation> unguarded for the same reason
  // `request` above is: the resolved MeterReservation is already guarded by
  // MeterReservationInterface, so a return-shape check would be redundant;
  // the sibling getBalance guards its bare bigint. `costMax` and the
  // balance are `bigint` (§ 1 Numeric domain).
  reserve: M.call(M.string(), M.bigint()).returns(M.promise()),
  getBalance: M.call().returns(M.bigint()),
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

**The structured errors (one discriminant, spelled shapes).** This design
introduces three rejection types a caller is explicitly told to
*distinguish*, so all three get the same shape treatment rather than one
being spelled and the others left as free-floating names. They share a
**common discriminant** -- each is a hardened `makeError` carrying a
`name` field (`'InsufficientFundsError'` / `'RateLimitError'` /
`'CircuitOpenError'`), so a caller pattern-matches on `error.name` without an
`instanceof` contract across a vat boundary -- and each carries a spelled
payload:

| Error | Shape | Meaning |
|---|---|---|
| `InsufficientFundsError` | `{ name, required: bigint, available: bigint }` | funds cannot cover the pessimal `costMax`; never admissible until topped up. |
| `RateLimitError` | `{ name, retryAfterMs: IntegerNonNegative }` | a window (per-client or per-controller) is exhausted; `retryAfterMs` is when it next admits. Funds are fine; retry later. |
| `CircuitOpenError` | `{ name, origin: string, retryAfterMs: IntegerNonNegative }` | the per-origin breaker is `open`; `retryAfterMs` is the cooldown remainder. The origin, not the request, is at fault. |

`required`/`available` are monetary `bigint` (§ 1 Numeric domain);
`retryAfterMs` is a discrete millisecond count (`IntegerNonNegative`).

**How refusal-before-read surfaces to the caller.** `request` rejects
with a structured `InsufficientFundsError` (shape above)
**synchronously with respect to the network**: the promise rejects
before the transport stage runs, so no request body is streamed and no
response byte is read. This is distinguishable -- by the `name` discriminant
above -- from a `RateLimitError`
(retry later, funds fine) and from an origin/method rejection (never
admissible). A guest can call the client's inspection method
(`estimateCost(request)`, a new pure, side-effect-free client method that
returns `costMax` without reserving) to pre-check affordability, which
is the pass-style analogue of undici's "does this request fit the
budget" probe. **Scope of the probe (a known limitation).** `estimateCost`
answers only the **funds** axis: it reflects the meter stage's price, not
the admission state of the stages above the meter. A guest can get an
affordable `costMax` for an origin whose breaker is currently `open`, or
whose per-minute rate window is exhausted mid-burst, and then have the
matching `request` reject with `CircuitOpenError` or `RateLimitError`. The
probe is "does this request fit the *budget*," never "would this request be
*admitted right now*" -- it deliberately does not fold in the breaker or
rate gates, whose state is time-varying controller policy the single-attempt
price quote does not model. A guest that needs to distinguish an
unaffordable request from a temporarily-gated one must read the rejection
reason of an actual `request`, not the probe.

**What `estimateCost` bounds.** `estimateCost` returns the `costMax` of a
**single attempt**, the same worst case one `reserve` would compute, not
the worst case of a whole retried `request()` call. For an idempotent
method that the retry stage may attempt up to `maxAttempts` times, and
that reserves and settles once per attempt (§ 4), the true worst-case
exposure of the full call is up to `maxAttempts * estimateCost(request)`. The
probe deliberately does not fold `maxAttempts` in, because retry count is
controller policy the guest does not set and a single-attempt quote is the
composable, stage-local number the meter actually reserves against. Sizing
a full-call budget therefore belongs to the **controller-holder**, not the
guest: `maxAttempts` is readable only via `inspectPipeline()`, which the
facet table (§ Exo and CLI surface additions) keys to the **controller**
facet, so a guest holding only the client cannot reach it. The host that
mints the client already knows its own retry policy and passes the
attempt-multiplied ceiling to the guest out of band (or provisions the
client with a budget already sized for `maxAttempts` retries); the guest's
in-band `estimateCost(request)` remains the honest single-attempt number.

### 3. Rate limiting: position and scope

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

### 4. Retries: idempotency, backoff, cancellation

The retry stage re-invokes the inner chain on a **retryable failure**,
bounded by attempt count and the overall deadline.

- **Idempotency constraint.** Retry is enabled **only for methods on the
  retry stage's own idempotent-method set**, a new closed set stored **on
  the retry stage's policy** -- `setRetry({ maxAttempts, baseMs, capMs,
  idempotentMethods })`, where `idempotentMethods` **defaults to
  `['GET', 'HEAD']`**. This names where the marking lives: it is *not* an
  annotation on `http-confine`'s `allowedMethods`/`CONFINED_ALLOWED_METHODS`
  (a flat `Set<string>` that carries no per-method idempotency bit and that
  this design does not extend), but a distinct retry-stage set. The two sets
  compose: a method is retried only if it is **both** admitted by the
  confinement policy **and** present in `idempotentMethods`. Phase 1's
  `CONFINED_ALLOWED_METHODS` is the full seven-method set -- `GET`, `HEAD`,
  `POST`, `PUT`, `DELETE`, `OPTIONS`, `PATCH` -- so idempotency-safety is an
  *independent* gate the retry stage applies on top of whatever methods the
  confinement policy admits, not something the Phase 1 default already
  narrows. **PUT and DELETE** sit exactly in the gap the flat set could not
  express: they are canonically idempotent under HTTP semantics, but whether
  a *given origin* honors that is origin behavior the pipeline cannot verify,
  so the default set **omits them** and retries them only when a controller
  explicitly adds them to `idempotentMethods` (an informed opt-in that the
  origin treats them idempotently). A method absent from the set (POST/PATCH
  by default, PUT/DELETE unless opted in) is **never** retried automatically;
  the stage passes it through with `maxAttempts = 1`. The default is a hard
  GET/HEAD floor, not a free-for-all knob, because the pipeline cannot know a
  POST is safe to repeat.
- **Retryable classes.** Retry fires on connection errors, timeouts, and
  5xx / 429 responses. A `429` with a `Retry-After` honors that hint as
  the backoff floor. It does **not** retry 4xx other than 429 (client
  error, deterministic) or an origin/method/header rejection (never
  admissible) or an `InsufficientFunds` (funds do not improve by
  retrying). It also does **not** auto-retry a `RateLimitError` or a
  `CircuitOpenError` bubbling up from the pipeline's own inner stages: both
  are **terminal** to the retry stage and surface straight to the caller
  carrying their `retryAfterMs` (§ 2). This is the deliberate counterpart
  to the origin-429 case: an origin's HTTP `429` response is the *origin*
  throttling us and is worth an automatic, `Retry-After`-floored resend,
  but a `RateLimitError` is *our own* rate stage refusing because a
  per-client or per-controller window is already exhausted -- immediately
  re-sending it would spend the whole `maxAttempts` budget hammering a
  window that cannot move within a backoff, the tight retry burst the rate
  stage's below-retry position (§ 3) exists to prevent from touching funds
  but that an auto-retry here would inflict on the window itself. The caller
  honors the returned `retryAfterMs` out of band instead. (`RateLimitError`
  is thus classified exactly like its sibling `CircuitOpenError`: terminal,
  not retried, `retryAfterMs`-bearing.) Note the deliberate asymmetry with
  the breaker below: 429
  **is** retryable here (backing off and re-sending is the correct response
  when a caller is throttling itself), but 429 is **not** breaker
  evidence, because it reflects request volume rather than origin health,
  and counting it would let one greedy guest trip the shared breaker for
  every co-guest.
- **Backoff.** Exponential with full jitter, `base * 2^attempt` capped at
  a ceiling, all controller policy (`setRetry({ maxAttempts, baseMs,
  capMs, idempotentMethods })`). The backoff **sleep is itself abortable**: it waits on
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
  attempt. Each attempt forwards a fresh `context` with `attempt:
  context.attempt + 1` (a new hardened record, not a mutation), visible to
  the meter, which bills every attempt, and to the breaker, which records
  every attempt.

Because each attempt is separately metered and rate-limited, the cost of
a retry is honestly billed: a 3-attempt request reserves and settles
three times (each with its own worst case). This **attributes the real
resource cost** of each attempt rather than functioning as an *incentive*:
`maxAttempts`/backoff is controller policy the guest neither sets nor sees
(`inspectPipeline()` is controller-only -- § Exo and CLI surface additions),
so the guest cannot act on a price it does not control. The accurate framing
is that **the guest bears origin-flakiness cost as the price of automatic
retry** (including attempts that fail purely on origin-side 5xx/timeout), not
that the billing incentivizes the guest toward any behavior.

### 5. Circuit breaking: error-based, per-origin

The breaker sits just inside the retry stage: a per-origin state machine
that trips on error classes to stop hammering a failing upstream.

- **States.** `closed` (pass through, count failures), then `open`
  (fast-reject every request with `CircuitOpenError` for a cooldown
  window), then `half-open` (admit a bounded burst of probes and decide by
  their outcome, exactly as § Trip policy defines below, which is the single
  canonical statement of the half-open transition). Standard three-state
  breaker.
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
- **Trip policy (the canonical half-open definition).** Trip `open` when
  failures reach `failureThreshold` within a rolling `windowMs` window
  (`setBreaker({ failureThreshold, windowMs, cooldownMs, halfOpenProbes })`,
  all controller policy). After `cooldownMs` the breaker goes `half-open`
  and admits exactly `halfOpenProbes` probe requests (all other requests
  keep fast-rejecting while the probes are in flight); once those probes
  resolve, a **majority-success closes** the breaker (back to `closed`) and
  otherwise it **re-opens** for another `cooldownMs`. `halfOpenProbes: 1`
  degenerates to the single-probe binary gate (one success closes, one
  failure re-opens); larger values take a quorum vote, damping a single
  flaky probe. Every other mention of the half-open transition in this
  document refers back to this definition rather than restating it.
- **Scope: per-origin within a controller.** A controller may allowlist
  several origins; one failing origin must **not** trip requests to a
  healthy sibling. So breaker state is keyed by `context.origin`, held in
  the controller's shared state as a small map. This is intentionally *not*
  per-client (two guests of the same controller hitting the same dead
  origin share the evidence and the protection) and *not*
  per-controller-global (a healthy origin stays open). A single origin
  serving many controllers is *not* shared across controllers: the
  controller is the trust boundary; cross-controller sharing would leak
  one host's traffic pattern to another.
- **Accepted risk: co-tenant griefing of shared breaker state.** Sharing
  per-origin breaker evidence across every guest of one controller is the
  same coin as the protection above: a malicious or buggy co-guest can
  deliberately provoke 5xx/timeout responses against an otherwise-*healthy*
  origin to trip the shared breaker and deny that origin to every sibling
  guest of the controller for a `cooldownMs`. This is an **accepted risk of
  the trust boundary**: the controller is the blast radius, and a host that
  fans one controller out to mutually-distrusting guests accepts that they
  share breaker fate on a shared origin, exactly as they already share the
  per-controller rate window. A deployment that cannot accept it gives the
  distrusting guests **separate controllers** (separate breaker maps), the
  same isolation lever the design already uses across the controller trust
  boundary. A per-`(client, origin)` pre-count before contributing to the
  shared trip is a possible future refinement but is deliberately not in
  this design, which keeps origin health a single shared signal.
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
| `setMaxRequestBytes(n)` | controller | metering (the request-side worst-case byte cap; sibling of Phase 1's `maxResponseBytes`, the pessimal default for a request that omits `contentLength`) -- **rejects an over-run, does not truncate** (unlike `maxResponseBytes`, which truncates untrusted inbound data; the request body is caller-authored outbound data, so an over-run is a structured error, not a silent cut -- see § 1) |
| `attachChargeAccount(account)` | controller | fees (integration-only endowment of an attenuated charge account; the attach is gated on **controller-holder access**, not on inspecting the account ref -- the guest never holds the controller, and the client facet has no verb that returns or accepts an account, so a client-reachable ref can never arrive here in the first place; see the "structural, not a provenance test" note below) |
| `setControllerMaxRequestsPerMinute(n)` | controller | rate (aggregate) |
| `setRetry({ maxAttempts, baseMs, capMs, idempotentMethods })` | controller | retries (`idempotentMethods` is the retry-eligible closed set, default `['GET', 'HEAD']`; see § 4) |
| `setBreaker({ failureThreshold, windowMs, cooldownMs, halfOpenProbes })` | controller | circuit breaking |
| `inspectPipeline()` | controller | read the composed stage list + each stage's live state (breaker states, window, balance); distinct from Phase 1's `inspect()` (static `PolicyShape`) |
| `estimateCost(request)` | client | pure `costMax` probe; no reservation, no side effect |

The two introspection methods are **deliberately two operations, not one
with a mode**: Phase 1's `inspect()` returns the static `PolicyShape`, and
the new `inspectPipeline()` returns the live composed-stage state. The CLI
below maps its `--pipeline` flag onto the split rather than collapsing it:
bare `endo http inspect <name>` calls `inspect()`; `--pipeline` selects
`inspectPipeline()`. So the API split and the CLI flag agree: the flag is
the method selector, not a mode of one call.

CLI verbs extend the `endo http` tree, each operating on the named
controller:

```text
endo http set-price   <name> --per-byte-request <n> --per-byte-response <n> --per-ms <n> --per-request <n>
endo http set-request-bytes <name> <max-bytes>   # setMaxRequestBytes(): request-side cap; rejects an over-run, does not truncate (cf. set-bytes)
endo http set-retry   <name> --max-attempts <n> --base-ms <n> --cap-ms <n> [--idempotent-methods GET,HEAD]
endo http set-breaker <name> --threshold <n> --window-ms <n> --cooldown-ms <n>
endo http set-rate    <name> <max-per-minute> [--controller-per-minute <n>]
endo http inspect     <name>                  # inspect(): static PolicyShape
endo http inspect     <name> --pipeline        # inspectPipeline(): live stage state
```

Two CLI-coherence choices keep these verbs predictable from the Phase 1
surface (`cli-http-client.md` § `endo http` subcommand tree):

- **`set-request-bytes` mirrors `set-bytes`.** Phase 1's response-side cap
  is the positional `endo http set-bytes <name> <max-bytes>`; the new
  request-side cap takes the **same positional single-argument shape**
  (`set-request-bytes <name> <max-bytes>`), not a `--max` flag, so a user
  who has learned `set-bytes` can predict its request-side sibling. The
  verb is spelled `set-request-bytes` (rather than renaming the shipped
  `set-bytes` to `set-response-bytes`, which would break a landed surface);
  the pairing is `set-bytes` = response cap, `set-request-bytes` = request
  cap. **The positional shape is symmetric but the enforcement is not**, and
  that asymmetry is surfaced where a user reads it (the verb table above and
  the CLI help line), not left to prose: `set-bytes`/`maxResponseBytes`
  **truncates** an over-long response (a DoS defense over untrusted inbound
  data the caller already expects may arrive partial), while
  `set-request-bytes`/`maxRequestBytes` **rejects** an over-run with a
  structured error (silently truncating caller-authored outbound data would
  corrupt it -- § 1). A user who learned "byte caps truncate" from `set-bytes`
  is told, at the surface, that its sibling instead throws.
- **`set-rate` keeps its Phase 1 positional argument.** Phase 1 ships
  `endo http set-rate <name> <max-per-minute>` (positional). The aggregate
  per-controller window is added as an **optional flag** on top of that
  unchanged positional argument (`set-rate <name> <max-per-minute>
  [--controller-per-minute <n>]`), so the already-approved call shape is
  preserved -- no silent breaking change to a shipped verb, and `set-rate`
  stays positional-argument-coherent with its `set-bytes` / `set-time`
  siblings.

The request-byte and response-byte price flags are spelled out in full
(`--per-byte-request` / `--per-byte-response`, not `--per-byte-req` /
`--per-byte-res`) so the two cannot be transposed at the terminal: since
request bodies are typically tiny and responses large, a one-suffix swap
would silently install a wildly wrong price schedule with no runtime
signal. The fixed admission-fee flag is likewise `--per-request` in full.

(`attachChargeAccount` has no CLI verb: a charge account is a capability,
endowed programmatically by the provisioning integration, not named on a
shell line.)

The meter adapter additionally **provides** the internal `CostQuote` facet
(§ Specialized adapter-pair contracts) that answers the client's
`estimateCost`. It is not a surface verb -- no controller mutator, no CLI
verb -- but an intra-pipeline capability the composer wires from the meter
to the client forwarder; it is invisible to both the shell and the guest,
which reaches it only through the client's `estimateCost` probe. It is
listed here so the surface inventory records why `estimateCost` needs no
per-adapter method on `HttpStageInterface`.

The "rejects a client-reachable ref" guarantee is **structural, not a
provenance test**: passability alone does not encode where a capability has
been (a `ChargeAccount` a guest already holds is exactly as passable as one
that never left the integration), so the verb does not try to detect a
client-reachable account. Instead `attachChargeAccount` is a **controller
verb**, callable only by the holder of the controller (the integration),
which the guest never holds; the integration passes the account it *itself*
minted at endowment, and the client facet has no verb that returns or
accepts an account. The account is unreachable through the client boundary
because no client method exposes it, which is the same controller-holds /
client-exercises split the whole design rests on, not a runtime check on
the argument.

## Staging into the Phase plan

The phase numbering below (Phase 3 substrate, 3.5 metering/fees, 3.6
rate-aggregate/retries, 4 streaming/breaker) is **introduced here**,
derived from the roadmap in the PR
[#286](https://github.com/endojs/endo-but-for-bots/pull/286#pullrequestreview-4943057191)
review that requested this follow-up; cli-http-client does not yet enumerate
a Phase 3/4 breakdown of its own (its "Phase 3 (rate/byte/timeout)" and
"Phase 4 (streaming/methods)" are the coarse buckets this design refines
into the substrate/metering/rate/breaker sequence). Read the references
below as "the rate/byte/timeout work cli-http-client scopes as its Phase 3",
not as an already-enumerated sub-plan in that document. The five concerns
slot in without disturbing Phase 1/2:

- **Phase 3 (cli-http-client's rate/byte/timeout scope)** becomes **the
  pipeline substrate**: introduce `HttpStageInterface`, the pre-flight /
  onion split, and re-express the Phase 1 rate limiter, byte-cap, and
  timeout as the first composed stages (rate stage + transport stage).
  Behavior-preserving refactor; no new external concern yet.
- **Phase 3.5, Metering + Fees.** Add the meter stage, the
  `ChargeAccount` / `MeterReservation` interfaces, `setMeterPrice` /
  `setMaxRequestBytes` / `attachChargeAccount`, the
  `RequestShape.contentLength` field, `estimateCost`, and the `cost`
  response field. Reconcile the byte-cap as the reservation ceiling. This is
  the phase that lands the minion.town metering ground rules
  (reserve-before-headers, boundary measurement, settle actual).
- **Phase 3.6, Rate aggregate + Retries.** Add the per-controller
  aggregate window and the retry stage (idempotent-only, jittered
  backoff, deadline-shared).
- **Phase 4 (cli-http-client's streaming/methods scope)** absorbs the
  **circuit breaker** stage and the `inspectPipeline` surface, alongside the
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

## Alternatives considered

### Alt A: In-process function adapters (Koa closures) instead of exo stages

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
- **Client-boundary context is narrow (the capability claim):** a client
  `request` (and `estimateCost`) call that tries to supply `origin`,
  `requestId`, `attempt`, or a `reservation` in its context argument is
  **rejected by the `CallerContextShape` guard** (assert the guarded method
  throws), so a guest cannot forge the pre-flight `origin`, supply its own
  `requestId`, pre-set the retry counter, or smuggle a reservation into the
  pipeline; a well-formed call supplying only `deadline` is accepted and the
  synthesized stage context the outermost stage receives carries the trusted
  `origin`, a minted `requestId`, and `attempt: 0`.
- **Charge account is structurally unreachable through the client (the
  capability claim, part two):** assert `HttpClientInterface` and
  `HttpStageInterface` expose **no** method that returns or accepts an
  account-shaped argument, so a client- or guest-held ref can never reach
  `attachChargeAccount` (which is a controller verb the guest never holds).
  This pins the design's explicit "structural, not a provenance test" claim
  (§ Exo and CLI surface additions) with a listed test: a static assertion
  over the two client-reachable interfaces, not a runtime provenance check on
  the argument.
- **Numeric budgets reject non-finite values (fail-closed admission):** a
  caller `deadline` of `NaN`, `Infinity`, or `-Infinity`, and a
  `contentLength` of the same, are **rejected by the boundary guard**
  (`FiniteNonNegative` for the continuous `deadline`, `IntegerNonNegative`
  for the discrete `contentLength`) at the boundary (assert the guarded
  method throws), so a `<`/`min` admission comparison downstream can never
  silently fail open on a non-finite value; likewise a `reserve` amount or a
  price term that is non-finite is rejected before it reaches an admission
  comparison.
- **Count fields reject fractional values (integer-domain guard):** a
  `contentLength` (or `maxRequestBytes`/`maxResponseBytes`) of `0.5` is
  **rejected at the boundary** (the `IntegerNonNegative` integrality
  assertion), so the cost formula's `BigInt(...)` widening can never raise a
  `RangeError` on a fractional count; a well-formed integer is accepted and
  widened.
- **Deadline sanity in pre-flight:** a caller `deadline` already in the past
  (against the injected `now`) is rejected in the **pure pre-flight**, before
  any rate token is spent or funds reserved (assert neither the rate limiter
  nor the charge account's `reserve` is called).
- **Metering reserve/settle:** a request whose `costMax` exceeds the
  purse balance rejects with `InsufficientFunds` **before** the injected
  transport seam is called (assert the seam's call count is 0); a request
  that succeeds settles to `costActual < costMax` and the purse is
  refunded the difference; a truncated response bills at exactly the
  `maxResponseBytes` term; a transport error before read charges only
  `perRequest`.
- **Deadline lowers `costMax`:** a request with a caller `deadline` shorter
  than the controller `timeoutMs` reserves a strictly smaller time term than
  the same request with no `deadline` (assert `costMax` uses
  `min(deadline, timeoutMs)`), and a `deadline` *longer* than `timeoutMs`
  does not raise it (the clamp is down-only).
- **Concurrent reservations serialize:** two `reserve` calls that would
  jointly exceed `limit` cannot both succeed (assert the atomic
  allowance-draw claim: one wins, one rejects with `InsufficientFunds`,
  and the account balance never goes negative). **Exact-balance boundary:**
  a `reserve` for exactly `available === costMax` **succeeds** (draining the
  account to zero), and a `reserve` for `costMax = available + 1` rejects, so
  admission is `>=`, not strict `>`.
- **Reserve idempotency:** a CapTP redelivery of the *same* `reserve`
  (same `operationId`) returns the *same* hold and does **not** open a
  second one or draw the allowance twice (assert the account balance moves
  once).
- **`estimateCost`:** the pure probe returns `costMax` for a **single
  attempt**, reserves nothing (assert the charge account's `reserve` is
  never called and the balance is unchanged), and matches the `costMax` a
  real reservation would compute; for a retryable request the full-call
  worst case is `maxAttempts * estimateCost(request)` (assert the probe does
  **not** silently fold in `maxAttempts`).
- **`estimateCost` is a wired adapter-pair contract, not a uniform-interface
  method:** assert `HttpStageInterface` exposes **no** `estimateCost` method
  (the uniform request onion stays `request` + `help`, and the retry,
  breaker, and rate adapters implement no cost method); a client whose chain
  includes a meter quotes the meter's `costMax` (the composer wired the
  client forwarder to the meter's `CostQuote` facet), and a client whose
  chain has **no** meter answers `0` through the composer's null quote.
- **Byte-cap = reservation ceiling:** a response with a lying large
  `Content-Length` still bills at `bytesActuallyRead`, and
  `bytesActuallyRead <= maxResponseBytes` always.
- **Request `contentLength` is declared and enforced:** the reservation's
  request-body term uses the declared `request.contentLength` (never a
  read of the body); a request whose body tries to **exceed** its declared
  `contentLength` is **rejected** by the transport with a structured error
  (never silently truncated, since the body is caller-authored outbound
  data), and no corrupted request reaches the origin seam (assert the seam
  is not called for the over-long body); a body that **under-delivers**
  (ends before `contentLength`) does not hang the transport and settles the
  request-body term at the **declared** `contentLength` (assert the
  reservation is released/settled and the slot freed, not held open); an
  omitted `contentLength` bills the `maxRequestBytes` worst case for the
  request-body term, **and** an omitted-`contentLength` body whose streamed
  length exceeds `maxRequestBytes` is **rejected** by the transport with the
  same structured over-run error as the declared-exceeds case (assert the
  origin seam is not called), so the omitted case is a bounded cap, not an
  unbounded outbound stream; a **declared** `contentLength` that itself
  exceeds `maxRequestBytes` is **rejected at pre-flight** with the same
  structured over-run error before any body is streamed or any reservation
  is priced (assert the origin seam and `reserve` are both un-called), so
  `maxRequestBytes` is the outbound ceiling in the declared branch too, not
  only the omitted one.
- **Rate position:** a rate refusal never calls `reserve` on the purse;
  each retried attempt spends its own token; the per-controller aggregate
  binds when tighter than the per-client window.
- **Retries:** GET retries on 5xx/timeout/connection error up to
  `maxAttempts`; POST/PATCH never retry; PUT/DELETE do **not** retry under
  the default `idempotentMethods` (`['GET', 'HEAD']`) but **do** once a
  controller adds them to the set (assert the retry gate reads the
  retry-stage set, not `CONFINED_ALLOWED_METHODS`); a `Retry-After` sets the
  backoff floor; a `cancellation` rejection mid-backoff aborts the sleep and the
  loop; the shared deadline stops a doomed final attempt; 4xx and
  `InsufficientFunds` are not retried; a 429 **is** retried (backoff floor
  from `Retry-After`) yet does **not** advance the breaker's failure
  count; a `RateLimitError` or `CircuitOpenError` raised by the pipeline's
  own inner stages is **terminal** and surfaces to the caller **without**
  an automatic retry (assert the transport seam is called exactly once and
  the rejection carries its `retryAfterMs`), distinguishing the origin's
  HTTP-429 resend from our own rate/breaker refusal.
- **Reservation terminal transitions are mutually exclusive and idempotent
  across both methods:** a `settle` after a prior `release` is a no-op
  returning the same receipt, and a `release` after a prior `settle` is a
  no-op returning the same receipt (assert `available`/`reserved` move
  exactly once across the pair, so the deadline-fires-then-late-completion
  race -- `release()` refunds, then a late `settle()` arrives -- cannot
  double-count the already-refunded byte/time terms back out of
  `available`).
- **Cost invariant holds under property-based fuzzing:** a `fast-check`
  property asserts `costActual <= costMax` for arbitrary non-negative price
  schedules, `contentLength`, `bytesRead`, `deadline`, and `elapsedMs`, with
  the `bytesRead`/`elapsedMs`/`deadline` arbitraries derived to also hit the
  boundaries `bytesRead === maxResponseBytes` and
  `elapsedMs === ceil(effectiveDeadlineMs)`, so a rounding-direction
  regression (the exact class of bug an earlier fix round had to correct)
  fails the property with a minimal counterexample rather than surviving a
  hand-picked worked example.
- **Circuit breaker:** N failures within the window trip `open`; an open
  origin fast-rejects without spending a rate token or reserving funds; a
  sibling allowlisted origin stays `closed`; half-open admits exactly
  `halfOpenProbes` probes and a **majority-success closes** it while a
  majority-failure re-opens it (with `halfOpenProbes: 1` degenerating to
  single-probe: one success closes, one failure re-opens); a mid-retry-loop
  trip halts the loop (assert the breaker sees each attempt, and the attempt
  after the trip fast-rejects with `CircuitOpenError`); neither 4xx nor 429
  counts toward the threshold.
- **Structured error discriminant:** `InsufficientFundsError`,
  `RateLimitError`, and `CircuitOpenError` each reject with the spelled shape
  (§ 2) and a distinct `name` field, so a caller pattern-matching on
  `error.name` can tell the three apart (assert each rejection's `name` and
  payload fields: `{ required, available }`, `{ retryAfterMs }`,
  `{ origin, retryAfterMs }`).
- **Cross-boundary:** a `ChargeAccount` (over a `ResourceLedger`/purse) held
  in a *different* vat participates
  in reserve/settle over CapTP (the pass-style claim), exercised with a
  two-vat test harness; the atomic check-and-draw holds with no intervening
  `await` even when the ledger is remote (two concurrent cross-vat
  reservations cannot jointly overdraw).

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
  release, bill worst case if never released.
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
- **Deadline as controller policy vs caller proposal (resolved in this
  design).** The caller may propose a `deadline` in the caller context; the
  meter/timeout stages clamp it **down** to the controller's `timeoutMs`
  (never up), and § 1's cost formula prices the time term against
  `effectiveDeadlineMs = min((deadline ?? (now + timeoutMs)) - now,
  timeoutMs)` (the absolute-timestamp `deadline` becomes a remaining budget
  by subtracting `now`), so a shorter caller `deadline` genuinely lowers
  `costMax`. This is no longer
  open: the design adopts "a shorter caller deadline lowers `costMax`"
  (incentive-correct, cannot widen authority) as the specified behavior, not
  a deferred proposal. What remains a deployment choice is only whether a
  host wishes to disable the caller-`deadline` proposal entirely (pin the
  time term to `timeoutMs`), which is a policy toggle, not a semantic
  question.

## Dependencies

| Design | Relationship |
|---|---|
| [cli-http-client](cli-http-client.md) | Parent; this elaborates its Phase 3/4 into the pipeline. |
| [http-confine](http-confine.md) | Pure primitives become stage bodies; its fixed order generalizes here. |
| [endo-fetch](endo-fetch.md) | The confined-fetch integration composes and persists the pipeline. |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Admission-control / budget-as-pre-payment model, transposed to bytes+time. |
| [gateway-package](gateway-package.md) | `ResourceLedger` / purse the meter stage (fee-side) draws against. |
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
