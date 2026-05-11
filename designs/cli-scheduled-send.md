# CLI Scheduled Send via Reactor + Schedule

| | |
|---|---|
| **Created** | 2026-05-08 |
| **Updated** | 2026-05-10 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [PR #145](https://github.com/endojs/endo-but-for-bots/pull/145) review (CHANGES_REQUESTED) and [inline comment id 3212495724](https://github.com/endojs/endo-but-for-bots/pull/145#discussion_r3212495724) |
| **Supersedes (in part)** | [endoclaw-timer](endoclaw-timer.md): the daemon-side `IntervalScheduler` shape proposed there is replaced by the four-layer composition below; the genie prototype stays as a Phase-1 reference. |

## What Is The Problem Being Solved?

PR #145 lands an `IntervalScheduler` formula whose only built-in
reaction is "deliver an inbox tick to one fixed agent / handle pair."
The maintainer review on the PR (review id 4256878617) asked to take
the surface back to design with two specific moves:

1. The user-facing verb wants to be a `scheduled-send`, not a
   `make-interval-scheduler`.
   The end-user need is a canned message of one of several message
   types whose only difference from a regular `endo send` is that
   delivery is delayed and may repeat.
2. The reaction should be configurable, so the schedule formula is
   not coupled to one canned tick payload.
   The cleanest factoring is two formulas: a *reactor* (any formula
   whose value implements the `tick(count, timestamps)` *Tickable*
   contract) and a *schedule* (a daemon-managed periodic prodder
   that calls the reactor's `tick`).
3. The schedule table belongs in sqlite, not on disk as JSON files,
   to match the daemon's existing `endo.sqlite` storage and to get
   indexed queries on `next_tick_at`.
   PR #145 stored entries as one JSON file per interval under
   `state/interval-scheduler/<prefix>/<rest>/intervals/`; this
   design MUST land sqlite-backed storage in the same change rather
   than ship a JSON-on-disk stage first.
4. When a reactor falls behind the schedule (the daemon was offline,
   the worker is slow, the reactor reschedules), the schedule needs
   a documented catch-up policy rather than the implicit
   "auto-resolve and advance" of the PR #145 prototype.

This design replaces the single-formula `IntervalScheduler` with a
four-layer composition and documents the catch-up vocabulary.

## Implementation Order: Four Layers

Per maintainer review (review id 4260084811, 2026-05-10), the design
is organized by the four layers in the order they would need to be
implemented.
Each layer depends only on the layers below it; each can be reviewed
and landed as its own PR.

1. **Scheduler subsystem.**
   The foundational layer: the `schedule` daemon formula type, its
   sqlite-backed persisted state, the timer-arming loop that fires
   `next_tick_at`, and the catch-up / retry / lifecycle bookkeeping.
   Inputs: the daemon's existing `DaemonDatabase`, `setTimeout` /
   `clearTimeout`, `Date.now`, and a generic CapTP-reachable
   reference (no contract assumed).
   Outputs: a daemon-managed periodic prodder that calls a method on
   a referenced formula on a cadence, with persisted catch-up and
   retry state.
   Lands first because every layer above depends on its formula
   type, sqlite schema, and lifecycle state machine.
2. **Reactor (the *Tickable* contract).**
   The shape any formula must satisfy to be schedulable.
   Inputs: the scheduler subsystem's call shape from layer 1.
   Outputs: a documented `tick(count, timestamps)` interface plus
   the convention that any formula whose resolved value implements
   *Tickable* qualifies as a reactor.
   Lands second because it is what the scheduler subsystem dispatches
   into; defining the contract is what makes the scheduler subsystem
   useful for anything more than a single hardcoded effect.
3. **Message-sending reactor (the canned-send reactor).**
   The first concrete *Tickable* implementation: an exo evaluated
   under endowments `{ agent, handle, message }` whose `tick`
   invokes `E(agent).send(handle, message)` once per accumulated
   tick.
   Inputs: the *Tickable* contract from layer 2; the daemon's
   existing `evaluate` formula type and `E(agent).send` surface.
   Outputs: a reactor source template the CLI can evaluate with
   caller-supplied endowments.
   Lands third because it is the first reactor the system needs and
   the one the CLI surface is built around; later reactors (digest,
   poll, prune) reuse the *Tickable* contract from layer 2 without
   touching layers 1 or 3.
4. **CLI changes (`endo send` scheduling flags).**
   The user-facing surface that bundles the three layers below into
   one composite creation.
   Inputs: the scheduler subsystem (layer 1), the *Tickable*
   contract (layer 2), and the canned-send reactor template
   (layer 3).
   Outputs: scheduling flags on the existing `endo send` command
   (`--every`, `--at`, `--on`) plus the `endo schedule` family of
   management commands.
   Lands last because it is the integration that makes the prior
   three layers reachable for end users; nothing below it depends on
   the CLI shape.

The Chat-UI surface is a separate dispatch chain after layer 4
lands; it shares the schedule formula type and the *Tickable*
contract but introduces no new daemon-side primitives.

## Scope

In scope:

- A `schedule` formula type, persisted in `endo.sqlite`, that calls
  a hardcoded `tick(count, timestamps)` method on a *Tickable*
  reference at configurable cadences.
- The *Tickable* contract: any formula whose value implements
  `tick(count, asyncIterator<scheduledTickAt>)` qualifies as a
  reactor.
  The standard CLI production path is an `evaluate` formula, but
  any formula type that produces a Tickable value is acceptable.
- Scheduling flags on the existing `endo send` command:
  `--every <interval>` and `--at <iso-timestamp>` for the
  convenience case (synthesize a fresh schedule on the fly), and
  `--on <schedule-name>` for the flexibility case (reuse a
  pre-defined named schedule's cadence and policy).
  Plus an `endo schedule` family of commands to list, pause,
  resume, and cancel schedules.
- A documented catch-up policy with one default and three named
  alternatives, drawn from CloudFlare Queues' consumer-concurrency
  and batching vocabulary.
- Retry semantics for failed ticks: exponential backoff with full
  jitter, with the backoff parameters captured in the schedule
  formula's persisted state.

Out of scope:

- The `IntervalScheduler` formula introduced in PR #145.
  This design supersedes that formula's role; the PR is to be
  rebuilt against this design or closed in favor of a fresh
  implementation PR.
- Cron expressions.
  The first cut supports rate (every N ms) and one-shot (at a
  specific timestamp) cadences.
  Cron is a follow-up that adds a `cron` cadence kind without
  changing the schedule formula's other fields.
- Distributed coordination across multiple daemons.
  Schedule-per-node is the end state.
  It is possible for the schedule and the reactor to live on
  different peers (ordinary CapTP reachability and retention rules
  apply), but no cross-peer coordination is performed by the
  schedule itself.
- All telemetry surfaces (textual message-handle events, structured
  meter).
  The M1 design ships the core schedule mechanism (reactor, tick,
  retry, catch-up) without an outbound telemetry channel.
  See "Follow-up Work" below for the message-handle and meter
  shapes that are deferred.
- A Chat-UI surface for scheduling.
  The Chat UI will eventually want analogous controls (a
  "schedule this message" affordance on the send composer) but
  that surface is designed separately; this document is the CLI
  side only.

## Architecture Overview

The four layers compose into a small dataflow:

```
+-----------+              +----------+
| Schedule  |  E(reactor)  | Reactor  |
| (daemon)  |-----tick---->| (eval,   |
+-----------+              |  default)|
                           +----------+
                                 |
                                 | E(agent).send(handle, ...)
                                 v
                            +----------+
                            | Recipient|
                            +----------+
```

Layer 1 (the schedule, daemon-side) holds a CapTP reference to a
formula that implements layer 2 (the *Tickable* contract).
Layer 3 (the canned-send reactor) is the standard *Tickable*
implementation the CLI evaluates.
Layer 4 (the CLI) creates the composite by evaluating a layer-3
reactor and then creating a layer-1 schedule that points at it.

The remainder of this document walks through the four layers in
implementation order.

---

## Layer 1: Scheduler Subsystem

The foundational layer.
A `schedule` daemon formula type with sqlite-backed persisted
state, a timer-arming loop, and catch-up / retry / lifecycle
bookkeeping.

### Inputs (from the daemon)

- The existing `DaemonDatabase` and `endo.sqlite` storage
  ([`packages/daemon/src/daemon-database.js`](../packages/daemon/src/daemon-database.js)).
- `setTimeout`, `clearTimeout`, and `Date.now`.
- The existing formula-creation infrastructure (`extractDeps`,
  `case 'schedule'` handler, formula GC).
- A generic CapTP-reachable reference; layer 1 makes no assumption
  about the reference's interface beyond "callable via `E()`".

### Outputs (to layer 2 and above)

A daemon-managed periodic prodder that calls
`E(reference).method(...)` on a cadence, with persisted catch-up
and retry state observable via `endo schedule list` for operators
and via formula introspection for upper layers.

### Schedule formula

A schedule is a new daemon formula type, stored in sqlite.
Its fields:

| Field            | Meaning                                              |
|------------------|------------------------------------------------------|
| `id`             | Formula id of the schedule (256-bit hex).            |
| `reactor`        | Formula id of the Tickable reactor to call.          |
| `cadence`        | `{ kind: 'rate', periodMs }` or `{ kind: 'one-shot', tickAt }`. |
| `firstTickAt`    | Wall-clock ms; for `rate`, the first scheduled tick; for `one-shot`, the only tick. |
| `nextTickAt`     | Wall-clock ms; the next scheduled tick.  Advances on successful ack; for a tick currently in retry backoff, this is `lastTickAt + currentBackoffMs`. |
| `lastTickAt`     | Wall-clock ms; the wall-clock at which the most recent tick was queued. Null until first tick. |
| `lastAckAt`      | Wall-clock ms; the wall-clock at which the reactor most recently acked successfully. Null until first successful ack. |
| `pendingTicks`   | Integer; ticks queued but not yet acked (the catch-up backlog). |
| `catchUpPolicy`  | `backfill` (default) / `batch` / `skip` / `suspend`. |
| `maxBatch`       | Maximum batch size when `catchUpPolicy === 'batch'` (default 10, mirrors CloudFlare Queues' `max_batch_size`). |
| `consecutiveTickFailures` | Integer; count of consecutive `tick` rejections.  Reset to 0 on a successful ack.  Used to compute the current backoff delay. |
| `backoffInitialDelayMs`   | Initial retry delay (default 1_000). |
| `backoffMaxDelayMs`       | Cap on retry delay (default 300_000, i.e. 5 min). |
| `backoffMultiplier`       | Exponential growth factor per consecutive failure (default 2.0). |
| `backoffJitterFraction`   | Full-jitter fraction in `[0, 1]` (default 1.0, i.e. AWS-style "full jitter"). |
| `status`         | `active` / `paused` / `cancelled` / `suspended`.     |
| `createdAt`      | Wall-clock ms.                                       |

The schedule's only behavior, on each tick, is to call
`E(reactor).tick(count, timestamps)` where `count` and the lazy
`timestamps` async iterator are shaped by the `catchUpPolicy` (see
"Catch-Up Policy" below).

The schedule formula declares its dependency on the reactor via
`extractDeps`, so reactor liveness drives schedule liveness:
revoking the reactor cancels the schedule.

### Sqlite schema

The schedule table joins the existing `formula` table on
`reactor`'s formula id; the schedule's own row in `formula`
carries the formula body (the cadence configuration), and the
`schedule_runtime` table below carries the mutable state that
advances on every tick.

```sql
CREATE TABLE IF NOT EXISTS schedule_runtime (
  -- Formula id of the schedule (256-bit hex).
  schedule_number TEXT PRIMARY KEY,

  -- Formula id of the reactor (256-bit hex), redundantly
  -- mirrored from the formula body for index-only lookups.
  reactor_id TEXT NOT NULL,

  -- Cadence in serialized form (JSON of the discriminated union
  -- in the field table above).
  cadence TEXT NOT NULL,

  -- Wall-clock ms.  Null last_tick_at / last_ack_at mean
  -- "never ticked" / "never acked".
  first_tick_at INTEGER NOT NULL,
  next_tick_at INTEGER NOT NULL,
  last_tick_at INTEGER,
  last_ack_at INTEGER,

  -- Catch-up bookkeeping.
  pending_ticks INTEGER NOT NULL DEFAULT 0,
  catch_up_policy TEXT NOT NULL DEFAULT 'backfill',
  max_batch INTEGER NOT NULL DEFAULT 10,

  -- Retry / backoff bookkeeping.  consecutive_tick_failures is
  -- reset to 0 on the next successful ack.  next_tick_at
  -- incorporates the current backoff delay when the schedule is
  -- in retry (consecutive_tick_failures > 0).
  consecutive_tick_failures INTEGER NOT NULL DEFAULT 0,
  backoff_initial_delay_ms INTEGER NOT NULL DEFAULT 1000,
  backoff_max_delay_ms INTEGER NOT NULL DEFAULT 300000,
  backoff_multiplier REAL NOT NULL DEFAULT 2.0,
  backoff_jitter_fraction REAL NOT NULL DEFAULT 1.0,

  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

-- Startup recovery scans active schedules ordered by next_tick_at
-- so the daemon can re-arm timers in tick order.
CREATE INDEX IF NOT EXISTS idx_schedule_runtime_active_next_tick
  ON schedule_runtime(status, next_tick_at)
  WHERE status = 'active';
```

The `schedule_runtime` table sits alongside the existing tables in
[`packages/daemon/src/daemon-database.js`](../packages/daemon/src/daemon-database.js)
(formula, agent_key, pet_store_entry, retention,
synced_store_entry, synced_store_meta).
The schema migration bumps `SCHEMA_VERSION` from 2 to 3 and adds
the `CREATE TABLE` and `CREATE INDEX` to `SCHEMA_SQL`.

Prepared-statement methods on the `DaemonDatabase` interface
(matching the existing pattern):

```js
writeSchedule(scheduleNumber, reactorId, cadence,
              firstTickAt, nextTickAt, catchUpPolicy, maxBatch,
              backoffInitialDelayMs, backoffMaxDelayMs,
              backoffMultiplier, backoffJitterFraction)
updateScheduleAfterTick(scheduleNumber, lastTickAt, pendingTicks)
updateScheduleAfterAck(scheduleNumber, lastAckAt, nextTickAt,
                       pendingTicks)
updateScheduleAfterTickFailure(scheduleNumber, nextTickAt,
                               consecutiveTickFailures)
setScheduleStatus(scheduleNumber, status)
deleteSchedule(scheduleNumber)
listActiveSchedules()         // for startup recovery
listSchedules()               // for `endo schedule list`
readSchedule(scheduleNumber)  // for debug / introspection
```

Startup recovery (the analog of PR #145's
`schedulerDir` directory scan) loads `listActiveSchedules()` and
re-arms each via `setTimeout` against `next_tick_at - Date.now()`,
catching up any `next_tick_at` already in the past per the row's
`catch_up_policy`.
For schedules in retry (`consecutive_tick_failures > 0`), the
persisted `next_tick_at` already incorporates the current backoff
delay, so recovery does not need to recompute the backoff from
scratch.

### Catch-up policy

The CloudFlare Queues docs describe four behaviors a queue offers
when a consumer falls behind: batching, concurrency scale-out,
delayed retry, and (eventually) message expiry under retention
limits.
The schedule formula adapts that vocabulary to the
schedule-calls-reactor pattern, where "behind" means the wall-clock
has advanced past `nextTickAt` while the reactor still has an
outstanding `tick`.
Four named policies cover the design space:

- **`backfill` (default).**
  `tick(count, timestamps)` is called once per missed tick, in
  order, with `count === 1` each time.
  In steady state this degenerates to one tick per period.
  After a daemon restart that missed N ticks, the schedule ticks
  back-to-back N times.
  Recommended when the reactor's effect is per-tick and not
  idempotent (a sent message must arrive once per missed period).
- **`batch`.**
  `tick(count, timestamps)` is called once with `count` up to
  `maxBatch`, accumulating missed ticks into a single call.
  The `timestamps` iterator yields the scheduled wall-clock for
  each accumulated tick in order.
  Recommended when the reactor's effect aggregates well (a metrics
  flush, a poll, a digest send).
- **`skip`.**
  Missed ticks are dropped; only the most recent `nextTickAt` is
  delivered, with `count === 1`.
  `pendingTicks` is reset to 0 on the next tick.
  Recommended for "is it still alive" heartbeats where stale ticks
  carry no information.
- **`suspend`.**
  When `pendingTicks` exceeds a threshold (default `maxBatch`),
  the schedule transitions to `status === 'suspended'` and stops
  arming new ticks until an operator (or the reactor itself, via a
  control-facet method) resumes it.
  Recommended when an unbounded backlog implies a real fault and
  silently accumulating ticks would mask it.

The default of `backfill` is the most conservative: every tick
shows up at the reactor exactly once, in order, and the operator
can change the policy with one CLI flag once the workload's
shape is known.
This mirrors CloudFlare Queues' default behavior of "treat the
batch as all-or-nothing for retry purposes": the reactor sees
each tick and decides what to do with it, rather than the
scheduler making the policy decision implicitly.

### Failure semantics: reactor rejection vs tick rejection

The schedule distinguishes two failure modes with different
responses.

**Reactor reference rejected (cancel).**
If the schedule's `reactor` formula reference rejects (the formula
itself failed to resolve, the underlying value is no longer
reachable, the reactor was revoked) the schedule transitions to
`status === 'cancelled'`.
A schedule whose reactor cannot resolve has no path to make
progress, and accumulating pending ticks against an unreachable
reactor would silently grow the backlog.
The cancellation also flows through `extractDeps`-driven GC: the
reactor's death triggers the schedule's GC.
(An outbound textual notification of the cancellation is captured
under "Follow-up Work" below; the M1 design transitions the
schedule's persisted `status` field but does not emit a message.)

**Tick rejected (retry with exponential backoff).**
If the reactor resolves and `tick(count, timestamps)` returns a
promise that *rejects*, the schedule treats the tick as failed and
schedules a retry with exponential backoff and full jitter:

```
delay = min(
  backoffInitialDelayMs * (backoffMultiplier ** consecutiveTickFailures),
  backoffMaxDelayMs,
)
jitter = random() * delay * backoffJitterFraction
nextRetryAt = now + (delay - jitter)
```

The default parameters (1s initial, 5min max, 2.0 multiplier, 1.0
jitter fraction) come from the AWS "exponential backoff with full
jitter" recommendation: full jitter avoids retry-thundering-herd
when many schedules co-fail (e.g. a reactor's downstream service
is unavailable for all of them).

`consecutiveTickFailures` is persisted in sqlite (so it survives
daemon restart) and reset to 0 on the next successful ack.
The retry's `tick` call carries the *same* `count` and
`timestamps` as the failed call: a retry is a re-attempt, not a
new tick.

A schedule whose `consecutiveTickFailures` exceeds a future
`maxConsecutiveTickFailures` field could transition to `suspended`
to surface persistent failure to an operator; that field is not
in scope for the first cut and is logged as a follow-up.
Outbound notification of tick failure is also a follow-up; see
"Follow-up Work" below.

### Cap surface (layer 1)

The schedule has authority to call `E(reactor).tick(count,
timestamps)`.
That is the entire cap.
It does not hold the agent, the handle, or the message contents;
those endowments live inside the reactor.
A compromised schedule (say, an operator confused two
similar-looking pet names) can call the wrong reactor's `tick` at
the wrong times, but cannot send a different message or send to a
different recipient.

### Implementation order within layer 1

1. The sqlite schema, schema-version bump from 2 to 3, and
   migration.
2. The `DaemonDatabase` prepared statements for schedule rows.
3. The `schedule` formula type, `formulateSchedule`,
   `extractDeps`, and the `case 'schedule'` handler.
4. Sqlite-backed startup recovery and the timer-arming loop.
5. The four catch-up policies; `backfill` is the default and the
   minimum needed for a first end-to-end pass; `batch` / `skip` /
   `suspend` can land alongside or in a follow-up PR within this
   layer.
6. The failure semantics (cancel-on-reactor-rejection and
   retry-on-tick-rejection with exponential-backoff and
   full-jitter).

### Test strategy (layer 1)

Unit tests in `packages/daemon/test/schedule.test.js`:

- Each catch-up policy in isolation, with a clock-injected fake
  timer ticking N missed ticks while a tick is in flight.
- Tick failure retry: a reactor stub whose `tick` rejects K times
  in a row triggers backoff with the documented schedule
  (`min(initial * multiplier^K, max) - jitter`), and a subsequent
  successful tick resets `consecutive_tick_failures` to 0.
- Reactor reference rejection: a schedule whose reactor formula
  rejects transitions to `cancelled`.
- Schedule lifecycle: pause / resume / cancel / suspend
  transitions.
- Sqlite round-trip: write a schedule, restart the daemon's
  in-process database, recover the active schedule, observe that
  the next tick arms at the correct wall-clock.
  For a schedule mid-retry, the recovered `next_tick_at` already
  incorporates the persisted backoff delay.

A stub Tickable (a hand-written exo with a recording `tick`)
suffices for layer-1 tests; layer-3's canned-send reactor is not
required.

### Migration risk (layer 1)

PR #145's `IntervalScheduler` formula and its
`state/interval-scheduler/<prefix>/<rest>/intervals/` JSON files
are superseded.
PR #145 is to be rebuilt against this design or closed in favor of
a fresh implementation PR; no in-place migration of PR #145's
on-disk state is provided because the format has not yet shipped
to any real deployment.

---

## Layer 2: Reactor (the *Tickable* contract)

The shape any formula must satisfy to be schedulable.
Layer 1's scheduler subsystem dispatches into this contract.

### Inputs (from layer 1)

The scheduler subsystem's call shape: a CapTP reference and the
ability to dispatch a method call on a cadence.

### Outputs (to layer 3 and above)

A documented interface:

```js
const TickableInterface = M.interface('Tickable', {
  tick: M.callWhen(M.number(), M.any()).returns(M.undefined()),
  help: M.call().returns(M.string()),
});
```

Plus the convention that any formula whose resolved value
implements *Tickable* qualifies as a reactor.

### Reactor shape

The schedule calls a hardcoded `tick(count, timestamps)` method.
A reactor that wants a different verb name MUST provide an adapter
exo whose `tick` forwards to its native verb.
Hardcoding the verb keeps the schedule's interface shape minimal
and removes a per-schedule configuration knob; reactors that need a
different name pay the adapter cost once.

The *Tickable* interface:

| Position | Type | Meaning |
|----------|------|---------|
| `count`  | `number` | Reliable count of ticks accumulated since the last successful tick.  In steady state, `1`.  After a slow tick or daemon restart, the number of missed ticks per the catch-up policy. |
| `timestamps` | `AsyncIterator<number>` | Lazy stream that yields each backed-up tick's scheduled wall-clock time (ms), in order, on demand.  The reactor MAY ignore this argument; iterating is opt-in. |

The `count` is the reliable signal.
The `timestamps` async iterator is constructed lazily because
materializing N timestamp records eagerly would be wasted work for
the common case (a reactor that only cares "how many ticks").
Reactors that surface per-tick timing (digest emails, audit logs)
iterate the stream; reactors that only want to act once iterate
zero times.

This is not a queue system.
The only datum currently associated with each backed-up tick is
its scheduled time.
The shape leaves room to grow into a per-tick payload queue (each
iterator yield could become a `{ scheduledTickAt, payload }`
record) without changing the schedule's outer call shape; that
growth is a follow-up, not part of this design.

The reactor is `makeExo`-shaped by default so that
`__getMethodNames__()` introspection works (per
[`../CLAUDE.md`](../CLAUDE.md) "CapTP introspection") and so that
the `M.interface()` guard checks the schedule's call at the
boundary.
A bare exo function alternative is discussed under
"Alternatives Considered."

### Reactor source

The reactor reference is the value produced by *any* formula
capable of producing a *Tickable* value.
The standard CLI production path is an `evaluate` formula, because
`endo send --every <interval>` (and equivalents) constructs the
canned-send reactor by evaluating the layer-3 template with the
caller-supplied endowments.
Other producers are explicitly allowed:

- A formula that imports a worker module exporting a Tickable
  exo.
- A formula that resolves to a Tickable received from a peer over
  CapTP.
- A future formula type whose dedicated purpose is to produce a
  particular shape of Tickable.

What matters is that the formula's resolved value implements
`tick(count, timestamps)`; the schedule does not inspect how that
value was produced.

### Verb contract

The reactor's verb is hardcoded to `tick`.
The schedule's call shape is exactly:

```js
E(reactor).tick(count, timestamps)
```

A reactor whose domain-natural method is `flush`, `poll`,
`digest`, or `prune` MUST provide an adapter exo whose `tick`
forwards.
Hardcoding the verb keeps the schedule formula's persisted shape
minimal (no `verb` column), removes a configuration knob from the
schedule's interface, and concentrates the naming concern in the
reactor's source where it belongs.

The verb's contract is:

- It accepts two arguments: a reliable `count` (integer >= 1) and
  a lazy `timestamps` async iterator yielding the scheduled
  wall-clock for each backed-up tick in order.
  The reactor MAY ignore `timestamps`.
- It returns a promise.
  Resolution is the ack and resets `consecutive_tick_failures`;
  rejection schedules an exponential-backoff retry per layer 1's
  "Failure semantics" above.
- It is allowed to take longer than one period; the schedule does
  not arm the next tick until the previous `tick` has settled (the
  catch-up backlog accumulates in `pending_ticks`).

### Cap surface (layer 2)

The reactor has whatever authority its endowments grant.
Layer 2 itself confers no authority; the contract is the shape
only.

### Implementation order within layer 2

1. Publish the *Tickable* `M.interface()` definition in a place
   reactor sources can import (a daemon-side or `@endo/scheduler`
   module).
2. Document the contract (this section becomes the source of
   truth).
3. Provide a stub Tickable for layer-1 tests if not already
   present.

### Test strategy (layer 2)

The contract itself has no runtime to test; layers 1 and 3
exercise it.
The `M.interface()` guard's behavior (rejecting calls with the
wrong shape) is exercised by layer 1's tick-rejection tests,
which can include a reactor whose `tick` violates the guard.

### Migration risk (layer 2)

None.
The contract is new.

---

## Layer 3: Message-Sending Reactor (the canned-send reactor)

The first concrete *Tickable* implementation: an exo whose `tick`
invokes `E(agent).send(handle, message)` once per accumulated
tick.

### Inputs

- The *Tickable* contract from layer 2.
- The daemon's existing `evaluate` formula type and the
  `E(agent).send(handle, message)` surface.

### Outputs

A reactor source template the CLI evaluates with caller-supplied
endowments `{ agent, handle, message }`.

### Reactor source template

```js
// reactor source, evaluated under endowments
//   { agent, handle, message } provided by `endo send --every`
import { E } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const TickableInterface = M.interface('Tickable', {
  tick: M.callWhen(M.number(), M.any()).returns(M.undefined()),
  help: M.call().returns(M.string()),
});

const reactor = makeExo('CannedSendReactor', TickableInterface, {
  tick: async (count, _timestamps) => {
    // The canned-send reactor only cares about `count`; it ignores
    // the timestamps iterator.  Default policy is "Backfill": one
    // call per missed tick in steady state, count > 1 only after a
    // daemon restart or a slow tick.
    for (let i = 0; i < count; i += 1) {
      await E(agent).send(handle, message);
    }
  },
  help: () => 'Sends a canned message on each schedule tick.',
});

reactor;
```

### Cap surface (layer 3)

The canned-send reactor produced by `endo send --every` holds
exactly `E(agent).send(handle, message)` and nothing else.
A reactor that needs richer authority is any formula type that
produces a *Tickable* with richer endowments, created by the
operator outside the `endo send --every` composite.

### Implementation order within layer 3

1. The reactor source template (a string literal or a small file
   the CLI loads and passes to `evaluate`).
2. The endowment plumbing from CLI argument shapes (handle name
   path, message Package shape) to the reactor source's
   `{ agent, handle, message }`.
3. Verify the reactor source produces a Tickable that passes
   layer 1's stub-reactor tests.

### Test strategy (layer 3)

A unit test that evaluates the reactor source under fake
endowments (a mock agent that records `send` calls) and confirms:

- A `tick(1)` call invokes one `send`.
- A `tick(N)` call invokes N `send`s in order.
- The `timestamps` iterator argument is ignored without error.
- The reactor implements `__getMethodNames__()` and `help()` per
  the *Tickable* contract.

### Migration risk (layer 3)

PR #145's hardcoded inbox-tick effect is replaced by this
configurable reactor.
The user-visible effect (a periodic `send`) is preserved; the
internal shape (a separate reactor exo rather than a baked-in
scheduler effect) is what changes.

---

## Layer 4: CLI Changes (`endo send` scheduling flags)

The user-facing surface that bundles layers 1, 2, and 3 into one
composite creation.

### Inputs

- Layer 1 (the schedule formula type and its lifecycle).
- Layer 2 (the *Tickable* contract that the reactor source must
  satisfy).
- Layer 3 (the canned-send reactor source template).
- The existing `endo send` command surface and its `<handle>` /
  `<message>` argument parsers.

### Outputs

Scheduling flags on `endo send` plus the `endo schedule` family of
management commands.

### Surface design

Scheduling is folded into the existing `endo send` command via
flags rather than introduced as a standalone verb.
This keeps the user model coherent: "send this message, but on a
schedule" is one mental act, not two.

#### Scheduling flags on `endo send`

```
endo send <handle> <message>
  [ --every <interval>            # convenience: synthesize a new
                                  #   schedule with this rate cadence
  | --at <iso-timestamp>          # convenience: synthesize a new
                                  #   one-shot schedule
  | --on <schedule-name> ]        # flexibility: reuse an existing
                                  #   named schedule's cadence
  [ --catch-up backfill|batch|skip|suspend ]
  [ --max-batch 10 ]
  [ --name <petname> ]            # schedule pet name
  [ --backoff-initial 1s ]
  [ --backoff-max 5m ]
  [ --backoff-multiplier 2.0 ]
  [ --backoff-jitter 1.0 ]
```

Without `--every`, `--at`, or `--on`, `endo send` retains its
existing synchronous behavior: send the message once, immediately,
no schedule formula is created.

`--every`, `--at`, and `--on` are mutually exclusive.
`--every` and `--at` are convenience flags that synthesize a fresh
schedule formula on the fly.
`--on` is the flexibility flag that references a pre-defined
schedule by pet name.

#### Convenience: `--every <interval>` and `--at <iso-timestamp>`

These flags synthesize a new schedule formula in one call.
The CLI performs the composite creation:

1. Evaluates a layer-3 reactor formula whose source is the
   canned-send template, with `agent`, `handle`, and `message`
   endowments resolved from the caller's pet store and the
   `<handle>` and `<message>` arguments.
   The eval formula is the standard production path for the CLI
   surface; other formula types may also produce Tickable values
   per layer 2's "Reactor source" section, but the CLI itself
   uses an eval formula.
2. Creates a layer-1 schedule formula against the resulting
   reactor with the supplied cadence (`{ kind: 'rate', periodMs }`
   for `--every`, `{ kind: 'one-shot', tickAt }` for `--at`),
   catch-up policy, and backoff parameters.
3. Stores the schedule under `<petname>` (or a generated name) so
   the operator can manage it with the `endo schedule` family
   later.

Worked example:

```sh
# Send the canned message once a minute starting now, default
# catch-up and backoff.
endo send chat-room "hourly status please" \
  --every 1m \
  --name status-prompt
```

#### Flexibility: `--on <schedule-name>`

This flag references a pre-defined schedule by pet name.
The named schedule already carries a cadence, catch-up policy, and
backoff configuration; the CLI reuses that configuration so the
caller does not have to repeat it on each `endo send` invocation.
The CLI performs the composite creation:

1. Looks up the schedule formula reference under `<schedule-name>`
   in the caller's pet store.
2. Evaluates a fresh canned-send reactor formula as in the
   convenience case above.
3. Creates a schedule formula against the new reactor whose
   cadence and policy fields are *cloned* from the named
   schedule.
   The new schedule is independent of the source schedule's
   lifecycle: pausing the source does not pause the derived
   schedule; cancelling the derived schedule does not affect the
   source.
   Cloning rather than aliasing keeps each schedule formula
   bound to exactly one reactor (the design's existing
   one-schedule-one-reactor invariant), which is what makes the
   schedule's `extractDeps`-driven cancel-on-reactor-rejection
   work.

Worked example:

```sh
# Operator pre-defines a "morning-cadence" schedule once.  The
# concrete CLI verb that creates a bare schedule is itself a
# follow-up (see "Schedule creation" under Follow-up Work below);
# for the present design, treat this step as a maintainer fixture
# or as direct `evaluate` of the schedule formula by an operator
# who already has the cadence configuration in hand.
#
# Conceptually:
#   morning-cadence := schedule with cadence
#     { kind: 'rate', periodMs: 24 * 60 * 60 * 1000 }
#     and catch-up policy `skip`.

# Subsequent sends ride the named schedule.
endo send chat-room "good morning standup" \
  --on morning-cadence \
  --name morning-standup
endo send ops-room "daily ops sync" \
  --on morning-cadence \
  --name ops-standup
```

The `<handle>` and `<message>` arguments follow the same
pet-name-path and message-shape conventions as the existing
`endo send`.
Message types beyond plain text (the existing `Package` shapes
with `strings`, `names`, `ids`) work unchanged because the
canned-send reactor's source carries whichever shape `endo send`
itself supports.

#### `endo schedule` management commands

`endo schedule list`, `endo schedule pause <name>`,
`endo schedule resume <name>`, `endo schedule cancel <name>`,
`endo schedule tick <name>` (manual one-shot prod, useful for
testing).

These commands operate on the schedule formula by pet name.
For the canned-send case, M1 has no standalone `endo schedule mk`
verb: schedule creation happens via `endo send --every` /
`endo send --at` (which synthesize a fresh schedule on the fly)
or via `endo send --on <schedule-name>` (which derives a fresh
schedule by cloning a pre-defined one).
The CLI verb that creates a bare named schedule for later reuse
via `--on` is captured under "Follow-up Work" below.

#### Future: Chat-UI surface

The Chat UI will eventually want analogous controls: a "schedule
this message" affordance on the send composer, plus a panel for
managing existing schedules.
That surface is a separate design; this document is the CLI side
only.
The shared substrate is the schedule formula's persisted state
(layer 1) and the *Tickable* contract (layer 2), both of which
are agnostic to the surface that drives them.

### Implementation order within layer 4

1. Argument parsing for the new flags and mutual-exclusion
   validation.
2. The `--every` / `--at` synthesis path: evaluate a layer-3
   reactor and create a layer-1 schedule.
3. The `--on` path: look up the named schedule, clone its cadence
   and policy, evaluate a fresh layer-3 reactor, create a layer-1
   schedule.
4. The `endo schedule list` / `pause` / `resume` / `cancel` /
   `tick` commands.

### Test strategy (layer 4)

Integration tests in `packages/daemon/test/scheduled-send.test.js`:

- End-to-end `endo send --every` against a fake recipient agent;
  observe that N ticks deliver N messages over the expected
  wall-clock window.
- End-to-end `endo send --on <named-schedule>` against a
  pre-defined schedule; observe that the derived schedule
  inherits the named schedule's cadence and policy and that its
  lifecycle is independent of the source schedule.
- Mutual exclusion: `endo send --every 1m --on foo` rejects at
  parse time with a clear error.
- Daemon restart mid-schedule: kill the daemon between ticks,
  relaunch, observe that the missed ticks are delivered per the
  configured policy.

AVA test discipline per
[`../CLAUDE.md`](../CLAUDE.md) "Testing with AVA":
schedule tests are `test.serial` (they share filesystem state
with the daemon) and carry explicit `t.timeout` so a stuck
schedule fails fast.

### Migration risk (layer 4)

`endo send` without scheduling flags is unchanged.
PR #145's `endo make-interval-scheduler` style verb (if it
shipped) is superseded by `endo send --every`.

---

## Comparison Against PR #145's `IntervalScheduler`

PR #145's single-formula `IntervalScheduler` couples four
responsibilities into one exo:

1. Periodic timer arming (`setTimeout` / `clearTimeout`).
2. Persistence of the entry list (one JSON file per interval).
3. Tick delivery (a fixed canned tick into the agent's inbox).
4. The control facet (pause / resume / setMaxActive /
   setMinPeriodMs / revoke).

The four-layer composition keeps responsibilities (1), (2), and the
schedule-side of (4) on layer 1 (the scheduler subsystem), pushes
(3) into layer 3 (the canned-send reactor) via the layer-2
*Tickable* contract, and exposes the composite to operators via
layer 4 (the CLI).
The reactor's behavior is now operator-configurable via the
reactor's source; the canned tick is the schedule's caller's
choice, not the schedule's hardcoded effect.

The composition aligns with Endo's existing
"`evaluate` formula as the extension point" pattern: anywhere the
daemon needs configurable behavior at a stable interface, an
`evaluate` formula carries the customization and the daemon-side
formula carries the lifecycle.

## Alternatives Considered

### Bare exo function reactor

Instead of an exo with a `tick` method, the reactor could be a
bare callable exo function (`makeExo('Reactor', ..., () => ...)`
or a `Far` callable).
The schedule would then call `E(reactor)(count, timestamps)`
directly.

Pros: simpler reactor source; no method-name dispatch.

Cons: no `__getMethodNames__()` introspection; no separate `help`
method; the schedule has no way to call a richer reactor's
`pause` or `flush` operations through the same handle.

Recommendation: rejected.
The schedule's call shape is hardcoded to `tick(count, timestamps)`.
A bare-function reactor that wants to be schedulable can be
wrapped in a one-line adapter exo whose `tick` forwards to the
function.

### Configurable verb name

The previous draft proposed a `verb` field on the schedule
formula, defaulting to `tick` but configurable per schedule.
This let a reactor with a domain-natural method (`flush`, `poll`,
`digest`, `prune`) be called directly without an adapter.

Rejected.
Hardcoding the verb keeps the schedule's interface shape minimal
(no `verb` column in sqlite, no per-call dispatch parameter, no
configuration knob in the CLI) and concentrates naming concerns
in the reactor source where they belong.
Reactors that want a different name pay the adapter cost once;
the schedule pays the simplification permanently.

### Schedule the agent directly, no reactor

The PR #145 shape; rejected per the maintainer review.
The shape is too specialized: it can only send canned ticks to
one agent / handle pair, and growing it to handle other reactions
means accreting flags onto the schedule formula.

### Cron expressions in Phase 1

Rejected.
The four-layer composition makes cron a separable add-on: a new
`cadence` kind `{ kind: 'cron', expr: '*/5 * * * *' }` slots in
without changing the schedule formula's other fields, the
`schedule_runtime` columns, or the catch-up policy.
Phase 1 ships rate and one-shot; cron lands when an actual user
needs it.

### Per-tick database round-trip

Each tick writes the new `next_tick_at` and decrements
`pending_ticks`.
At a one-second cadence with N schedules, that is N writes per
second, which is well within sqlite WAL-mode's throughput.
A schedule with sub-second cadence is out of scope for the first
cut and can use an in-memory advance with periodic checkpoint
writes if it ever lands.

### Single PR rather than four-layer staging

Rejected per maintainer review (review id 4260084811).
The four layers are independently reviewable and have a clear
bottom-up dependency direction; staging them as separate PRs
keeps each review focused on one concern (storage and timer
loop, contract, concrete reactor, user surface).

## Resolved Decisions

The following questions were raised in earlier drafts and have
been settled by maintainer review:

- **Reactor verb name.**
  The verb is hardcoded to `tick`.
  No `verb` field on the schedule, no `verb` column in sqlite.
  Reactors that want a different name provide an adapter.
- **Reactor source restriction.**
  Any formula whose value implements the *Tickable* contract
  qualifies, not only `evaluate` formulas.
  `evaluate` is the standard CLI production path because that is
  how `endo send --every` constructs the canned-send reactor;
  other producers are equally valid.
- **CLI surface shape.**
  Scheduling is folded into `endo send` via flags.
  Two parallel shapes: `--every <interval>` / `--at <iso-timestamp>`
  for the convenience case (synthesize a fresh schedule on the fly)
  and `--on <schedule-name>` for the flexibility case (reuse a
  pre-defined named schedule's cadence).
  The three flags are mutually exclusive.
  There is no standalone `endo schedule mk` verb for the canned-send
  case.
  An analogous Chat-UI surface is a future, separately-designed
  follow-up.
- **Batch shape.**
  The schedule calls `tick(count, timestamps)` where `count` is a
  reliable integer and `timestamps` is a lazy
  `AsyncIterator<number>` yielding scheduled wall-clock times on
  demand.
  This is not a queue system; the only datum per backed-up tick
  is its scheduled time.
  The shape leaves room to grow into a per-tick payload queue
  without changing the outer call.
- **Reactor rejection vs tick rejection.**
  A schedule whose reactor reference rejects (formula failed to
  resolve, value unreachable) cancels.
  A schedule whose `tick` call rejects retries with exponential
  backoff and full jitter; the backoff parameters
  (initial-delay, max-delay, multiplier, jitter-fraction) are
  persisted in the schedule formula's sqlite row.
- **Telemetry deferred.**
  All telemetry (textual message-handle events and a structured
  meter) is deferred to a follow-up.
  The M1 design ships the core schedule mechanism without an
  outbound telemetry channel.
  See "Follow-up Work" below.
- **Per-batch re-arm.**
  When `batch` catch-up policy hands a backlog larger than
  `maxBatch`, the schedule calls once with `count === maxBatch`
  and re-arms immediately so the next call picks up the rest.
  This matches CloudFlare Queues' batching shape and keeps each
  `tick` call bounded.
- **Layered implementation order.**
  The design implements bottom-up across four layers (scheduler
  subsystem, *Tickable* contract, canned-send reactor, CLI) per
  maintainer review id 4260084811 (2026-05-10).
  Each layer is one PR.

## Open Questions

1. When a reactor is revoked while a schedule still points at it,
   does the schedule transition to `cancelled` or `suspended`?
   Recommendation: `cancelled`.
   The schedule's `extractDeps` already encodes the dependency, so
   the daemon's GC will collect the schedule on reactor death; the
   `cancelled` transition is the user-visible signal.
   The "Failure semantics" section under layer 1 states
   `cancelled`; this question is captured here only as a place
   for future reconsideration if `suspended` proves more useful
   (e.g. if reactor revocation can be undone in a future
   revision).
2. (Resolved.)
   Whether `endo send --every` should accept an existing reactor
   by pet name was settled by maintainer review at 2026-05-10:
   keep `--every` as the convenience path that always evaluates a
   fresh reactor, and add a parallel `--on <schedule-name>` flag
   for the flexibility case.
   See "Resolved Decisions" above ("CLI surface shape").
3. (Resolved.)
   Whether the schedule should emit per-tick telemetry events was
   settled by maintainer review at 2026-05-10: defer all
   telemetry to a follow-up.
   See "Follow-up Work" below.
4. (Resolved.)
   The future `maxConsecutiveTickFailures` field that flips a
   perma-failing schedule to `suspended` is deferred to a
   follow-up per maintainer review at 2026-05-10.
   The current design's `consecutive_tick_failures` column is
   forward-compatible.
   See "Follow-up Work" below.

## Follow-up Work

The items below are intentionally out of scope for the M1 design.
The M1 critical path is the four layers above: layer 1's schedule
mechanism with its catch-up and backoff bookkeeping, layer 2's
*Tickable* contract, layer 3's canned-send reactor, and layer 4's
CLI surface.
Telemetry, persistent-failure suspension, and bare-schedule
creation are valuable but separable additions that can land once
the core mechanism is stable.

### Telemetry / message handle

The schedule will eventually accept a *messageHandle* capability
on construction, used for textual event surfacing.
Anticipated events:

- `tick.failed`: `{ scheduleId, reason, consecutiveTickFailures, retryDelayMs }`
- `tick.recovered`: `{ scheduleId, consecutiveTickFailures }` (the previous failure-streak length, just before reset)
- `reactor.cancelled`: `{ scheduleId, reason }` (terminal)
- `schedule.suspended` / `schedule.resumed`: `{ scheduleId, reason }`

A structured telemetry meter (counter / histogram / gauge) is a
further follow-up after the message handle.
The daemon does not yet have a meter facility; once one lands, the
schedule will route the same events through both the message
handle (for text logs) and the meter (for aggregation).

Why deferred: the layer-1 schedule mechanism (reactor + tick + retry
+ catch-up) is the load-bearing M1 surface and is independently
useful without an outbound diagnostic channel.
A schedule's persisted state (`status`, `consecutive_tick_failures`,
`next_tick_at`) is observable via `endo schedule list` for
operator-side debugging in the M1 design.
Adding the message-handle channel later requires extending
`schedule_runtime` with a `message_handle_id` column and adding a
handle field to `formulateSchedule`; both are additive and do not
disturb the M1 schema or the M1 reactor contract.

### Persistent-failure suspension

A `maxConsecutiveTickFailures` field that flips a schedule to
`status === 'suspended'` once the consecutive failure streak
exceeds the threshold.
The CLI gains a `--max-tick-failures <N>` flag.
The current design's `consecutive_tick_failures` column is
forward-compatible: the new field becomes one more
`schedule_runtime` column and the suspend transition becomes one
more case in the tick-failure handler.
The accompanying telemetry event (`schedule.suspended`) lands with
the message-handle work above.

### Schedule creation as a CLI verb

`endo send --on <schedule-name>` references a pre-defined schedule
by pet name, which presupposes that the schedule already exists in
the operator's pet store.
The CLI verb that *creates* a bare schedule (a schedule with a
cadence and catch-up policy but no reactor bound, suitable for
later reuse via `--on`) is itself a follow-up.
For the M1 design, named schedules are created either as
maintainer fixtures or by direct `evaluate` of the schedule
formula by an operator who already has the cadence configuration.

### Cron cadences

A `{ kind: 'cron', expr: '*/5 * * * *' }` cadence variant slots
into the schedule formula's existing cadence union without
disturbing other fields.
M1 ships rate (`--every`) and one-shot (`--at`) cadences; cron
follows when an actual user needs it.

## Prompt

> I would like to use sqlite for the interval schedule table.
> Let's do that now rather than defer.
>
> This is starting to sound more like a "scheduled send" verb, or
> a variation on the existing "send" command but a different
> backend. This would be a canned message, possibly of various
> message types, that differs only in that its delivery is
> delayed and possibly repeated.
>
> It still seems appropriate to have an underlying schedule
> formula, provided that the reaction is configurable. Consider
> using an evaluate formula to produce a reactor, such that
> scheduled send is a composite creation of a reactor (an
> evaluate formula that produces an exo, that can be invoked to
> send a canned message from the endowed agent and to the
> endowed handle) and a schedule that prods the reactor. The
> verb might be `tick`. The verb might be configurable on the
> formula. Alternately, it could expect a bare exo function.
>
> Consider researching the CloudFlare queue API for inspiration
> when dispatching to a reactor that has not kept up with the
> schedule and might need a number of events to catch up.
>
> Let's take this back to design. Dispatch a designer to propose
> a new design.

(PR #145 review wrap, plus inline comment id 3212495724 on
`.changeset/agent-tools-interval-scheduler.md:7`.)

## References

- PR #145, the IntervalScheduler implementation that this design
  supersedes (in part):
  https://github.com/endojs/endo-but-for-bots/pull/145
- CloudFlare Queues "Batching, Retries and Delays":
  https://developers.cloudflare.com/queues/configuration/batching-retries/
- CloudFlare Queues "Consumer concurrency":
  https://developers.cloudflare.com/queues/configuration/consumer-concurrency/
- CloudFlare Queues "How Queues Works":
  https://developers.cloudflare.com/queues/reference/how-queues-works/
- [endoclaw-timer](endoclaw-timer.md): the prior design this
  one supersedes in part.
- [daemon-endo-rust-sqlite](daemon-endo-rust-sqlite.md): the
  sqlite host-method surface the schedule table will use.
