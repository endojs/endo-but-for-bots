# CLI Scheduled Send via Reactor + Schedule

| | |
|---|---|
| **Created** | 2026-05-08 |
| **Updated** | 2026-05-08 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [PR #145](https://github.com/endojs/endo-but-for-bots/pull/145) review (CHANGES_REQUESTED) and [inline comment id 3212495724](https://github.com/endojs/endo-but-for-bots/pull/145#discussion_r3212495724) |
| **Supersedes (in part)** | [endoclaw-timer](endoclaw-timer.md): the daemon-side `IntervalScheduler` shape proposed there is replaced by the two-piece composition below; the genie prototype stays as a Phase-1 reference. |

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
   The cleanest factoring is two formulas: a *reactor*
   (an `evaluate` formula that produces an exo with a `tick(...)`
   method) and a *schedule* (a daemon-managed periodic prodder that
   calls the reactor's `tick`).
3. The schedule table belongs in sqlite, not on disk as JSON files,
   to match the daemon's existing `endo.sqlite` storage and to get
   indexed queries on `next_tick_at`.
   PR #145 stored entries as one JSON file per interval under
   `state/interval-scheduler/<prefix>/<rest>/intervals/`; the
   maintainer asked to do sqlite now rather than defer.
4. When a reactor falls behind the schedule (the daemon was offline,
   the worker is slow, the reactor reschedules), the schedule needs
   a documented catch-up policy rather than the implicit
   "auto-resolve and advance" of the PR #145 prototype.

This design replaces the single-formula `IntervalScheduler` with a
two-piece composition and documents the catch-up vocabulary.

## Scope

In scope:

- A `schedule` formula type, persisted in `endo.sqlite`, that ticks
  a configurable verb on a configurable target at configurable
  cadences.
- A reactor pattern that uses the existing `evaluate` formula type
  to produce an exo whose interface exposes the verb the schedule
  prods.
- A `endo schedule` family of CLI commands to create, list, pause,
  resume, and cancel schedules, plus a `endo scheduled-send`
  composite that creates the matched reactor and schedule together.
- A documented catch-up policy with one default and three named
  alternatives, drawn from CloudFlare Queues' consumer-concurrency
  and batching vocabulary.

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
  A schedule is owned by one node; cross-node ticking is a
  follow-up that depends on
  [daemon-cross-peer-gc](daemon-cross-peer-gc.md) being settled.

## Two-Piece Composition: Reactor + Schedule

A scheduled send is the composite creation of two formulas:

```
+-----------+              +----------+
| Schedule  |  E(reactor)  | Reactor  |
| (daemon)  |------tick--->| (eval)   |
+-----------+              +----------+
                                 |
                                 | E(agent).send(handle, ...)
                                 v
                            +----------+
                            | Recipient|
                            +----------+
```

The schedule is a daemon-managed formula whose only authority is to
prod the reactor on a cadence; the reactor is an `evaluate` formula
whose endowments include the agent and handle it sends from / to,
plus whatever canned content the send carries.

### Reactor shape

A reactor is an `evaluate` formula whose source produces an exo with
a `tick(batch)` method (and, by convention, `help()` and any
operational methods the reactor wants to expose).
The reactor's authority is whatever its endowments grant; the
schedule has no special authority over the reactor beyond the right
to call its `tick` verb.

```js
// reactor source, evaluated under endowments
//   { agent, handle, message } provided by `endo scheduled-send`
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const ReactorInterface = M.interface('ScheduledSendReactor', {
  tick: M.callWhen(M.arrayOf(M.record())).returns(M.undefined()),
  help: M.call().returns(M.string()),
});

const reactor = makeExo('ScheduledSendReactor', ReactorInterface, {
  tick: async batch => {
    // batch is a list of tick records the schedule has accumulated
    // since the reactor last acked.  Default policy is "Backfill":
    // length 1 in steady state, length > 1 only after a daemon
    // restart or a slow tick.
    for (const tick of batch) {
      await E(agent).send(handle, message);
    }
  },
  help: () => 'Sends a canned message on each schedule tick.',
});

reactor;
```

The reactor is `makeExo`-shaped by default so that
`__getMethodNames__()` introspection works (per
[`../CLAUDE.md`](../CLAUDE.md) "CapTP introspection") and so that
the `M.interface()` guard checks the schedule's call at the
boundary.
A bare exo function alternative is discussed under
"Alternatives Considered."

### Schedule formula

A schedule is a new daemon formula type, stored in sqlite.
Its fields:

| Field            | Meaning                                              |
|------------------|------------------------------------------------------|
| `id`             | Formula id of the schedule (256-bit hex).            |
| `reactor`        | Formula id of the reactor exo to prod.               |
| `verb`           | Method name to call on the reactor (default `tick`). |
| `cadence`        | `{ kind: 'rate', periodMs }` or `{ kind: 'one-shot', tickAt }`. |
| `firstTickAt`    | Wall-clock ms; for `rate`, the first scheduled tick; for `one-shot`, the only tick. |
| `nextTickAt`     | Wall-clock ms; the next scheduled tick (advances on ack). |
| `lastTickAt`     | Wall-clock ms; the wall-clock at which the most recent tick was queued. Null until first tick. |
| `lastAckAt`      | Wall-clock ms; the wall-clock at which the reactor most recently acked. Null until first ack. |
| `pendingTicks`   | Integer; ticks queued but not yet acked (the catch-up backlog). |
| `catchUpPolicy`  | `backfill` (default) / `batch` / `skip` / `suspend`. |
| `maxBatch`       | Maximum batch size when `catchUpPolicy === 'batch'` (default 10, mirrors CloudFlare Queues' `max_batch_size`). |
| `status`         | `active` / `paused` / `cancelled` / `suspended`.     |
| `createdAt`      | Wall-clock ms.                                       |

The schedule's only behavior, on each tick, is to call
`E(reactor)[verb](batch)` where `batch` is shaped by the
`catchUpPolicy` (see next section).

The schedule formula declares its dependency on the reactor via
`extractDeps`, so reactor liveness drives schedule liveness:
revoking the reactor cancels the schedule.

## Catch-Up Policy

The CloudFlare Queues docs describe four behaviors a queue offers
when a consumer falls behind: batching, concurrency scale-out,
delayed retry, and (eventually) message expiry under retention
limits.
The schedule formula adapts that vocabulary to the
schedule-prods-reactor pattern, where "behind" means the wall-clock
has advanced past `nextTickAt` while the reactor still has an
outstanding `tick`.
Four named policies cover the design space:

- **`backfill` (default).**
  `tick(batch)` is called once per missed tick, in order, with
  `batch.length === 1` each time.
  In steady state this degenerates to one tick per period.
  After a daemon restart that missed N ticks, the schedule ticks
  back-to-back N times.
  Recommended when the reactor's effect is per-tick and not
  idempotent (a sent message must arrive once per missed period).
- **`batch`.**
  `tick(batch)` is called once with `batch.length` up to
  `maxBatch`, accumulating missed ticks into a single call.
  Recommended when the reactor's effect aggregates well (a metrics
  flush, a poll, a digest send).
- **`skip`.**
  Missed ticks are dropped; only the most recent `nextTickAt` is
  delivered, with `batch.length === 1`.
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

The reactor's `tick` resolution is the ack: on `tick`'s promise
settling (resolve or reject), the schedule recomputes
`nextTickAt`, decrements `pendingTicks` by `batch.length`, and
arms the next tick.
A `tick` that rejects increments a `consecutiveFailures` counter
(not in the table above; tracked in memory) but does not by itself
suspend the schedule.
A future revision can add a `maxConsecutiveFailures` field that
flips the schedule to `suspended` after N rejects, mirroring
CloudFlare Queues' DLQ semantics.

The default of `backfill` is the most conservative: every tick
shows up at the reactor exactly once, in order, and the operator
can change the policy with one CLI flag once the workload's
shape is known.
This mirrors CloudFlare Queues' default behavior of "treat the
batch as all-or-nothing for retry purposes": the reactor sees
each tick and decides what to do with it, rather than the
scheduler making the policy decision implicitly.

## Sqlite Schema

The schedule table joins the existing `formula` table on
`reactor`'s formula id; the schedule's own row in `formula`
carries the formula body (the cadence configuration), and the
`schedule_runtime` table below carries the mutable state that
advances on every tick.

```sql
CREATE TABLE IF NOT EXISTS schedule_runtime (
  -- Formula id of the schedule (256-bit hex).
  schedule_number TEXT PRIMARY KEY,

  -- Formula id of the reactor exo (256-bit hex), redundantly
  -- mirrored from the formula body for index-only lookups.
  reactor_id TEXT NOT NULL,

  -- Cadence in serialized form (JSON of the discriminated union
  -- in the field table above).
  cadence TEXT NOT NULL,

  -- Wall-clock ms.  Null lastTickAt / lastAckAt mean "never ticked".
  first_tick_at INTEGER NOT NULL,
  next_tick_at INTEGER NOT NULL,
  last_tick_at INTEGER,
  last_ack_at INTEGER,

  -- Catch-up bookkeeping.
  pending_ticks INTEGER NOT NULL DEFAULT 0,
  catch_up_policy TEXT NOT NULL DEFAULT 'backfill',
  max_batch INTEGER NOT NULL DEFAULT 10,

  status TEXT NOT NULL DEFAULT 'active',
  verb TEXT NOT NULL DEFAULT 'tick',
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
writeSchedule(scheduleNumber, reactorId, cadence, firstTickAt,
              nextTickAt, catchUpPolicy, maxBatch, verb)
updateScheduleAfterTick(scheduleNumber, lastTickAt, pendingTicks)
updateScheduleAfterAck(scheduleNumber, lastAckAt, nextTickAt,
                       pendingTicks)
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

## CLI Surface

Two-piece composition deserves two-piece commands, plus one
composite for the most common case:

- `endo schedule mk --reactor <petname> --cadence rate=<ms>`
  `[--verb tick] [--catch-up backfill|batch|skip|suspend]`
  `[--max-batch 10] [--name <petname>]`

  Creates a schedule that prods the reactor.
  The reactor must already exist; the operator (or a higher-level
  command) is responsible for evaluating it.

- `endo schedule list`, `endo schedule pause <name>`,
  `endo schedule resume <name>`, `endo schedule cancel <name>`,
  `endo schedule tick <name>`
  (manual one-shot prod, useful for testing).

- `endo scheduled-send <recipient> --message <text>`
  `--cadence rate=<ms> [--name <petname>]`

  The composite verb the maintainer named in the review.
  Internally, this:

  1. Evaluates a reactor formula whose source is the canned-send
     reactor template above, with `agent`, `handle`, and `message`
     endowments resolved from the caller's pet store and the
     `<recipient>` argument.
  2. Calls `endo schedule mk` against the resulting reactor with
     the supplied `--cadence`.
  3. Stores the schedule under `<petname>` so the operator can
     manage it with the `endo schedule` family later.

  The `<recipient>` argument follows the same pet-name-path
  conventions as `endo send`.
  Message types beyond plain text (the existing `Package` shapes
  with `strings`, `names`, `ids`) follow the same flag conventions
  as `endo send`; the design does not enumerate them here because
  the canned-send reactor's source can carry whichever shape `endo
  send` itself supports.

## Verb Naming

The default verb name on the reactor's exo is `tick`, matching the
maintainer's suggestion in the inline comment.
The schedule formula's `verb` field is configurable, defaulting to
`tick`, so a reactor that already has a domain-natural method
(`flush`, `poll`, `digest`, `prune`) can be prodded directly
without an adapter exo.

The verb's contract is:

- It accepts one argument, `batch`, an array of tick records.
  Each tick record has `{ scheduledTickAt, tickSequenceNumber }`
  at minimum; future revisions may add fields without breaking
  reactors that ignore them.
- It returns a promise.
  Resolution is the ack; rejection is logged as a tick failure but
  does not by itself suspend the schedule.
- It is allowed to take longer than one period; the schedule does
  not arm the next tick until the previous `tick` has settled (the
  catch-up backlog accumulates in `pending_ticks`).

## Cap Surface

The schedule has authority to call `E(reactor)[verb](batch)`.
That is the entire cap.
It does not hold the agent, the handle, or the message contents;
those endowments live inside the reactor.
A compromised schedule (say, an operator confused two
similar-looking pet names) can prod the wrong reactor at the wrong
times, but cannot send a different message or send to a different
recipient.

The reactor has whatever authority its endowments grant.
For the canned-send reactor produced by `endo scheduled-send`,
that is `E(agent).send(handle, message)` and nothing else.
A reactor that needs richer authority is just an `evaluate`
formula with richer endowments, evaluated by the operator outside
the `endo scheduled-send` composite.

## Comparison Against PR #145's `IntervalScheduler`

PR #145's single-formula `IntervalScheduler` couples four
responsibilities into one exo:

1. Periodic timer arming (`setTimeout` / `clearTimeout`).
2. Persistence of the entry list (one JSON file per interval).
3. Tick delivery (a fixed canned tick into the agent's inbox).
4. The control facet (pause / resume / setMaxActive /
   setMinPeriodMs / revoke).

The two-piece composition keeps responsibilities (1), (2), and the
schedule-side of (4) on the schedule, and pushes (3) into the
reactor.
The reactor's behavior is now operator-configurable via the
reactor's source; the canned tick is the schedule's caller's
choice, not the schedule's hardcoded effect.

The composition aligns with Endo's existing
"`evaluate` formula as the extension point" pattern: anywhere the
daemon needs configurable behavior at a stable interface, an
`evaluate` formula carries the customization and the daemon-side
formula carries the lifecycle.

## Phased Implementation

1. Sqlite schema and the `DaemonDatabase` prepared statements;
   schema-version bump and migration.
2. The `schedule` formula type, `formulateSchedule`,
   `extractDeps`, and the `case 'schedule'` handler with
   sqlite-backed startup recovery.
3. `endo schedule` CLI commands.
4. The canned-send reactor template plus the `endo scheduled-send`
   composite that evaluates the reactor and invokes `schedule mk`.
5. The four catch-up policies; the default (`backfill`) is enough
   for Phase 1, and `batch` / `skip` / `suspend` can land
   together in Phase 5 once the basic shape is reviewed.

Each phase is independently reviewable and ships its own tests.
Treat each phase as one PR.

## Alternatives Considered

### Bare exo function reactor

Instead of an exo with a `tick` method, the reactor could be a
bare callable exo function (`makeExo('Reactor', ..., () => ...)`
or a `Far` callable).
The schedule would then call `E(reactor)(batch)` directly.

Pros: simpler reactor source; no method-name dispatch.

Cons: no `__getMethodNames__()` introspection; no separate `help`
method; the schedule has no way to call a richer reactor's
`pause` or `flush` operations through the same handle.

Recommendation: support both via the `verb` field.
A schedule with `verb === undefined` calls the reactor as a bare
function; a schedule with `verb === 'tick'` (the default) calls
the named method.
The CLI default is the named method; bare-function reactors are an
escape hatch for one-line `evaluate` prototypes.

### Schedule the agent directly, no reactor

The PR #145 shape; rejected per the maintainer review.
The shape is too specialized: it can only send canned ticks to
one agent / handle pair, and growing it to handle other reactions
means accreting flags onto the schedule formula.

### Cron expressions in Phase 1

Rejected.
The two-piece composition makes cron a separable add-on: a new
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

## Open Questions

1. Should the reactor's `tick(batch)` method see the
   `pending_ticks` count, or only the batch it is being handed?
   Recommendation: only the batch; if the reactor wants to know
   the backlog it can call back to the schedule's exo.
2. When a reactor is revoked while a schedule still points at it,
   does the schedule transition to `cancelled` or `suspended`?
   Recommendation: `cancelled`.
   The schedule's `extractDeps` already encodes the dependency, so
   the daemon's GC will collect the schedule on reactor death; the
   `cancelled` transition is the user-visible signal.
3. Should `endo scheduled-send` accept an existing reactor by pet
   name, or always evaluate a fresh canned-send reactor?
   Recommendation: always evaluate a fresh reactor for the
   composite; users who want to reuse a reactor use
   `endo schedule mk` directly.
4. Does the schedule need a `consecutiveFailures` column in
   sqlite, or is in-memory tracking sufficient?
   Recommendation: in-memory for Phase 1; promote to a column when
   `maxConsecutiveFailures` lands.
5. Should the `batch` catch-up policy split a backlog larger than
   `maxBatch` into multiple back-to-back tick calls, or call once
   with `batch.length === maxBatch` and re-arm immediately so the
   next call picks up the rest?
   Recommendation: call once with up to `maxBatch`, re-arm
   immediately; this matches CloudFlare Queues' batching shape
   and keeps each `tick` call bounded.

## Test Plan

- Unit tests in `packages/daemon/test/schedule.test.js`:
  - Each catch-up policy in isolation, with a clock-injected
    fake timer ticking N missed ticks while a tick is in flight.
  - Schedule lifecycle: pause / resume / cancel / suspend
    transitions.
  - Sqlite round-trip: write a schedule, restart the daemon's
    in-process database, recover the active schedule, observe
    that the next tick arms at the correct wall-clock.
- Integration tests in
  `packages/daemon/test/scheduled-send.test.js`:
  - End-to-end `endo scheduled-send` against a fake recipient
    agent; observe that N ticks deliver N messages over the
    expected wall-clock window.
  - Daemon restart mid-schedule: kill the daemon between ticks,
    relaunch, observe that the missed ticks are delivered per
    the configured policy.
- AVA test discipline per
  [`../CLAUDE.md`](../CLAUDE.md) "Testing with AVA":
  schedule tests are `test.serial` (they share filesystem state
  with the daemon) and carry explicit `t.timeout` so a stuck
  schedule fails fast.

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
