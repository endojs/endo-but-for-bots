# Guest Bot Incarnation on Mailbox Delivery

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Updated** | 2026-09-08 |
| **Author** | kriscendobot (prompted) |
| **Status** | Not Started |

## What is the Problem Being Solved?

An Endo guest can own durable names and a durable mailbox, but nothing connects
mail arrival to the liveness of the program that services that guest. A bot may
be running before a daemon restart and remain absent afterward. Mail continues
to accumulate, but no component is responsible for bringing the bot back.

The daemon needs a general, deployment-independent binding between a guest and
a bot capability. Once bound, accepting a message for that guest must make a
best effort to ensure one bot incarnation is running. The message's durable
acceptance must not depend on whether the bot starts successfully.

This primitive is intended to support a Claude-backed guest, but it does not
mention Claude, credentials, models, or minion.town policy. Those belong to the
bot caplet and its deployment. In particular, the daemon primitive composes with
the [`@endo/claude` design](https://github.com/endojs/endo-but-for-bots/blob/endo-claude-package/designs/endo-claude.md)
and minion.town's
[`@claude-agents` design](https://github.com/kriscendobot/minion.town/blob/main/designs/claude-agents-capability.md)
without embedding either one's policy in `@endo/daemon`.

## Background

Endo's persistent state is a content-addressed **formula graph**. A *formula* is
an immutable construction recipe named by a formula identifier; identical recipes
share an identifier, and changing a recipe yields a different identifier rather
than editing state in place. An *incarnation* is the live running process (or
facet) produced from a formula by providing it: the formula is the durable
recipe, the incarnation is the ephemeral thing that runs. A `guest` formula names
a durable authority boundary and mailbox; its incarnation is the `EndoGuest`
facet. The *incarnation supervisor* introduced below is the in-memory, per-daemon
component that decides when to bring a bot incarnation to life for a guest and
keeps at most one alive. These three terms (formula, incarnation, and supervisor)
recur throughout this document.

## Design

### Formula shape

Add one optional field to `GuestFormula`:

```ts
export type GuestFormula = {
  type: 'guest';
  // existing fields
  bot?: FormulaIdentifier;
};
```

`bot` identifies a formula whose incarnation implements the `EndoBot` protocol.
It does not identify a bare `worker` formula. A worker only selects and hosts an
execution engine; providing one does not say which program to run or when that
program is ready. The field also does not embed a spawn descriptor. Existing
caplet formulas already capture workers, module sources, powers, environment,
and cancellation policy, and copying that descriptor into `GuestFormula` would
create a second execution protocol.

The referenced capability has this daemon-facing interface:

```ts
type BotBlockedReason = 'needs-auth' | 'admission-denied' | 'operator';

type BotStop =
  | { type: 'stopped' }
  | { type: 'blocked'; reason: BotBlockedReason; retryWhen?: Promise<void> };

interface EndoBot {
  start(
    guest: EndoGuest,
    options: { cancelled: Promise<never> },
  ): Promise<
    | { type: 'running'; stopped: Promise<BotStop> }
    | { type: 'blocked'; reason: BotBlockedReason; retryWhen?: Promise<void> }
  >;
}
```

`start` resolves with `running` only after the bot has subscribed to the guest's
mailbox and is ready to service it. `stopped` settles when that incarnation
exits. Unexpected rejection before readiness or from `stopped` is a crash. The
daemon creates `cancelled` and retains its rejector; rejecting it is the normal
way to stop an incarnation when the guest dies or the daemon shuts down.

The bot formula must not depend on the guest formula. At runtime the supervisor
passes the already-incarnated `EndoGuest` facet to `start`. This one-way formula
edge (`guest -> bot`) keeps the persistent formula graph acyclic while giving
the bot exactly the authority of the guest it services. A launcher formula may
be shared by many guests; each `start` receives only its particular guest facet.
The supervisor, rather than the launcher, enforces one live call per guest.

`provideGuest(name, { bot })` accepts `bot` as a pet name or name path in the
creating host's namespace, resolves it once to a local formula identifier, and
persists that identifier. An absent option preserves today's formula byte shape
and behavior; preserving that byte shape requires the field to be *omitted* from
the serialized formula, not present with a `null` or `undefined` value, so the
content-addressed identifier of an unbound guest is unchanged. A supplied
identifier is transiently pinned until the new guest formula records the
dependency. `extractLabeledDeps`, formula inspection, and
formula-record rendering expose the edge as `bot`.

The binding belongs only on `GuestFormula`, not `HostFormula`:

- A guest is the authority boundary the bot receives and the mailbox whose mail
  activates it. Keeping the binding there makes the relationship unambiguous.
- Hosts already have explicit daemon-start roots and `@pins` for services.
  Automatically passing the full host facet to arbitrary bot code would create
  a materially broader authority surface.
- A later host-bot design can reuse `EndoBot` after specifying root-bootstrap
  ordering. It need not be coupled to this guest increment.

The persistent formula graph is content-addressed by formula identifiers that
name immutable construction recipes. The `bot` identifier participates in the
guest recipe and therefore in its formula identity. Changing or removing the
binding does not edit an existing guest in place: it formulates a different
guest with a different identifier and agent identity, then requires an explicit
name migration by its owner. `provideGuest` remains get-or-create; asking for an
existing name with a different `bot` is an error that reports the binding
mismatch rather than silently ignoring or rewriting it. In-place bot rebinding,
including any mailbox transfer semantics, is deferred.

### Incarnation supervisor

The manager owns a bot-incarnation supervisor keyed by guest formula identifier.
An entry has one of these in-memory states:

| State | Meaning |
|---|---|
| `dormant` | No message in this daemon incarnation has demanded the bot. |
| `starting` | Exactly one `provide(botId)` / `start(guest)` operation is in flight. |
| `running` | `start` reported ready and its `stopped` promise is pending. |
| `stopping` | A cancelled incarnation's `stopped` promise has not yet settled. |
| `backoff` | A transient start or runtime failure is waiting for its retry time. |
| `blocked` | A typed policy failure or the crash-loop breaker requires another signal. |

`ensureBot(guestId, botId, guest)` is single-flight and, as the linchpin of the
"acceptance is independent of bot health" guarantee, **never rejects**: every
failure path (including `provide(botId)` itself throwing, a malformed returned
object, or a synchronous throw from the guarded `start`) is caught inside the
supervisor and folded into the backoff or blocked state rather than propagating
to `deliver`'s caller or surfacing as an unhandled rejection that could fault the
daemon process. In `starting` or `running` it is a no-op. In `backoff` it records
demand but does not move the timer forward. In `stopping` it records demand and
starts a fresh attempt only once the prior `stopped` promise settles, so a new
delivery cannot open a second consumer while the old one is still winding down.
In `dormant` it starts an attempt. In `blocked`, ordinary mail does not reset the
breaker.

The supervisor calls `provide(botId)`, then invokes the guarded `EndoBot.start`
with the guest facet and its cancellation promise, and verifies the returned
object. A `running` result transitions the entry to `running`; the supervisor
then observes `stopped`. Guest-context cancellation rejects `cancelled` and moves
the entry to `stopping`; the entry is not cleared to `dormant` (nor a re-entry
permitted) until the incarnation's `stopped` promise actually settles, so a bot
that is slow to honor `cancelled` cannot overlap with its successor. Cancellation
does not count as a failure. A `stopped` promise that never settles is bounded by
the same force-reap timeout the daemon already applies to cancelled workers,
after which the entry clears. This map must not itself retain a guest after its
formula is collected.

### The mailbox commit hook

`makeMailbox` gains an optional daemon-internal `onMessageCommitted` callback.
`makeGuest` supplies it only when its formula has a `bot` binding. Hosts and
legacy guests omit it.

For every path that creates a new mailbox item, `deliver` performs these steps:

1. Validate the envelope.
2. Persist the message formula under the next mailbox number.
3. Persist the incremented next-number value.
4. Add the stamped message to the in-memory mailbox and publish it to
   `followMessages()` subscribers.
5. After the mailbox's serialized job has released its lock, synchronously ask
   the supervisor to ensure the bot, without awaiting bot startup.

The hook fires for local, remote, and self-delivery because all three converge
on `deliver`. It does not fire for edits, reads, dismissal, or replay during
mailbox construction.

This ordering makes mail acceptance independent of bot health. If persistence
fails, no wake is issued and the sender sees the existing delivery failure. If
the wake fails, `receive` still succeeds because the message is already durable.
Calling the supervisor outside `mailboxStoreJobs` also prevents a startup path
that calls `followMessages()` from waiting on the same mailbox lock it needs to
observe.

Messages arriving while the state is `starting` are persisted and published in
the same way, then coalesce onto the one in-flight attempt. No second bot is
started and no second copy of a message is inserted. `followMessages()` already
subscribes to subsequent messages before it yields the current snapshot, so a
bot that subscribes after becoming ready observes the complete retained backlog
and then every later message without a snapshot/subscription gap.

The wake hook does not introduce a second message-delivery channel. It only
starts the consumer; the mailbox remains the sole source of messages. A bot
reincarnated after a crash may see an undismissed message again. Endo preserves
that message's stable mailbox number and message identifier so the bot can
checkpoint or make its effects idempotent before dismissal. Exactly-once effects
that survive a crash and touch an arbitrary external system are not promised by
this increment; claiming that would require a transaction spanning the mailbox
and the external system. The concrete guarantee here is that a concurrent start
neither loses nor duplicates the durable mailbox entry and never creates two
concurrent consumers for one guest.

### Restart behavior

Startup is lazy, not an eager incarnation of every bot-bound guest. After
`seedFormulaGraphFromPersistence` has reconstructed reachability, the manager
examines reachable `guest` formulas with `bot` fields. It schedules
`ensureBot` only for a guest whose mailbox store contains at least one numeric
message entry. The scan reads store indexes; it does not provide the guest, bot,
or worker for empty mailboxes. Startup of the daemon itself does not await these
attempts.

This gives pending mail the same wake semantics whether it was committed before
or after the restart. A crash in the small interval after mailbox commit but
before the in-memory wake is therefore repaired by the startup scan. A guest
with no retained mail remains cold until its next delivery, avoiding a restart
stampede across every provisioned bot and avoiding worker cost for guests with
nothing to do.

A mailbox can intentionally retain conversation history. Such a mailbox causes
one start attempt after each daemon restart even if the bot has already handled
every retained item. The bot's durable cursor or idempotency record distinguishes
handled mail. This bounded extra attempt is preferable to a separate mutable
"unread" truth that could disagree with the mailbox and strand work. A future
mailbox acknowledgment protocol may make the startup predicate narrower.

### Failure, backoff, and credential expiry

Unexpected start rejection, a `stopped` rejection, or an untyped `stopped`
result is a transient failure. The supervisor retries with full-jitter
exponential backoff: a one-second base, doubling per consecutive failure, capped
at five minutes. One timer exists per guest. New messages during backoff do not
bypass it. After eight consecutive failures the entry opens a `crash-loop`
breaker and does not automatically retry until a host operator explicitly
requests a retry or the guest is replaced with a different bot binding. Remaining
`running` for sixty seconds resets the failure count.

Unlike the process-local backoff timer and typed-policy breakers, the open state
of the `crash-loop` breaker is persisted as a single durable per-guest flag, so
that a routine daemon restart (deploy, reboot, upgrade rollout) does not silently
hand a crash-looping bot the one-immediate-attempt described under Restart
behavior. A guest whose crash-loop breaker is open on restart stays `blocked` and
is not scanned for a fresh attempt; only `retryBot` (or a bot rebinding) clears
it. This preserves the "does not automatically retry until a host operator
explicitly requests a retry" guarantee across restarts. The credential and
`admission-denied` breakers deliberately do not persist, because a restart is
exactly the moment to re-probe a possibly-repaired credential or quota.

Expected blockers use the tagged result rather than rejection:

- `needs-auth` means the credential was absent, revoked, or expired. It opens a
  credential breaker immediately and does not consume the crash count.
- `admission-denied` covers a deployment quota or policy decision. It likewise
  does not masquerade as a crash.
- `operator` covers an intentional pause.

If a blocked result includes `retryWhen`, the supervisor observes that promise
and performs one new attempt when it fulfills, provided the guest still exists.
The credential-recovery design can therefore send a deduplicated reauthentication
message to the designated operator and use credential rotation to fulfill
`retryWhen`. The daemon neither sends credential material nor invents a retry
cadence for expired credentials. If the daemon restarts while blocked, the
pending-mail startup scan performs one fresh attempt; a still-expired credential
returns to `needs-auth` without entering the crash-loop counter.

The host gains two privileged methods:

`getBotStatus` returns a discriminated union with one record shape per `type`,
so each variant carries only the fields meaningful for that state rather than a
shared bag of optionals. Its `reason` reuses the `BotBlockedReason` union widened
by the daemon-only `crash-loop` value; naming the widened type keeps the two
`reason` surfaces (this one and `EndoBot.start`/`BotStop`) legible siblings:

```ts
type BotStatusReason = BotBlockedReason | 'crash-loop';

getBotStatus(guestNameOrPath): Promise<
  | { type: 'unbound' }
  | { type: 'dormant' }
  | { type: 'starting' }
  | { type: 'running' }
  | { type: 'stopping' }
  | { type: 'backoff'; failures: number; retryAt: string }
  | { type: 'blocked'; reason: BotStatusReason; failures: number; retryAt?: string }
>;

retryBot(guestNameOrPath): Promise<void>;
```

`retryBot` closes either breaker and makes one attempt; it does not disable
subsequent backoff. Called on a guest that exists but has no `bot` binding, it
throws a `TypeError` naming the target, matching `cancel`'s behavior for an
inapplicable target rather than silently no-opping; `getBotStatus` reports the
same case non-fatally as `{ type: 'unbound' }`. Every transition also emits the existing lifecycle diagnostic
with the guest id, bot id, state, failure count, normalized reason, and retry
time. Diagnostics never include message bodies, prompts, credentials, or raw
error objects. Guest code receives no new lifecycle-control authority.

Backoff timers and the typed-policy breakers are intentionally process-local in
the first increment; only the `crash-loop` breaker's open bit is persisted (see
above). A restart permits one immediate attempt for guests that are not in an
open crash-loop breaker, which is necessary to notice a credential repaired while
the daemon was down. A failed attempt returns to the same bounded policy, so a
bot failure cannot turn into an in-process hot loop. Persisting full retry
schedules and operator pauses is deferred.

### Retention and quotas

The `bot` edge is an ordinary formula dependency: retaining the guest retains
the bot formula, and collecting the guest cancels its live bot incarnation. The
supervisor scans only reachable guests at startup and must not become a new
persistence root.

Incarnation is not provisioning. It re-provides the already-bound bot formula
and invokes `start` for the already-retained guest. It never calls
`provideGuest`, adds a name to a parent directory, or increments a retained-child
ledger. Single-flight supervision also prevents two incarnations from occupying
two runtime slots for one retained child.

Minion.town's per-`iss+sub` quota remains authoritative at child creation: a
bot-bound child consumes exactly one retained-child slot when its guest is first
retained, releases it when that retention is dismissed, and consumes no
additional retained-child slots on any number of reincarnations. This slot-once
accounting is an assumption this design places on the composing minion.town
[`@claude-agents` design](https://github.com/kriscendobot/minion.town/blob/main/designs/claude-agents-capability.md);
it is load-bearing here and must be confirmed against that design's admission
check. If minion.town instead charged a slot per `start` invocation rather than
per retention, the quota-safety conclusion below would not hold and this section
would need revision. A launcher that needs a separate runtime admission slot must
perform its normal atomic admission check in `start`; rejection appears as
`admission-denied` and the daemon must not bypass it or silently create
replacement children. Thus automatic liveness cannot turn an eight-child retained
quota into an unbounded number of replacement guests or concurrent bot
processes.

## Compatibility and Migration

The field is optional, so existing guest formulas load with no new behavior.
Only guests created with the new `provideGuest` option are bot-bound. Existing
named guests are not retrofitted, because their immutable formula identity and
the desired bot authority are both security-sensitive. A deployment that wants
to migrate them must explicitly provision replacement guests and decide how to
move names and mailbox history.

The `EndoBot` protocol is additive. A raw worker, a caplet without `start`, a
remote formula identifier, or a bot formula that depends on the guest is
rejected during provisioning where discoverable, and otherwise fails the first
guarded start without affecting mailbox durability.

## First Increment and Deferred Work

The first increment includes:

- the optional `GuestFormula.bot` edge and `provideGuest(..., { bot })` option;
- the guarded `EndoBot` start/result protocol and single-flight supervisor;
- the post-commit mailbox wake hook for new messages;
- lazy restart recovery for reachable bot-bound guests with retained mail;
- transient backoff, the crash-loop and typed-policy breakers, host diagnostics,
  and cancellation on guest collection; and
- deterministic tests with a fake bot caplet, including restart and race cases.

It deliberately defers:

- a `HostFormula.bot` binding and host-bootstrap ordering;
- changing the bot on an existing guest or migrating its identity/mailbox;
- a durable unread/processed cursor and transactional exactly-once external
  effects;
- persisted backoff schedules and operator pauses;
- idle suspension, snapshots, and resource-pressure scheduling (covered
  separately by [XS worker heap snapshots](daemon-xs-worker-snapshot.md));
- the Claude launcher, credential storage, reauthentication capability, model
  policy, and subscription quotas; and
- minion.town configuration and end-to-end Claude validation.

The credential-recovery work is a companion, not an implementation detail of
this design. This increment defines the `needs-auth`/`retryWhen` seam it needs,
but that companion must specify the designated operator, the capability carried
in the reauthentication message, and notification deduplication.

## Test Plan

1. Load an old guest formula with no `bot`; delivery and restart behavior are
   unchanged.
2. Provision a guest with a fake `EndoBot`; verify that the persisted formula and
   formula graph contain one labeled `bot` edge and that a repeated mismatched
   `provideGuest` fails.
3. Deliver one message and block fake-bot startup. Verify delivery returns after
   durable commit, then deliver several more messages. Release startup and
   verify one `start` call and one copy of every mailbox number in order.
4. Crash after the message commit but before the wake request. Restart and verify
   the retained-mail scan makes one start attempt. Verify an empty bot-bound
   guest starts no worker.
5. Make the bot reject repeatedly. Verify exponential delays, one timer, no
   message-triggered bypass, the eighth-failure breaker, status output, and one
   operator-directed retry.
6. Return `needs-auth` with a controllable `retryWhen`. Verify that no crash
   count or timed retry occurs, that status reports the credential blocker, and
   that fulfilling the signal makes exactly one new attempt while the original
   mail remains present.
7. Return `admission-denied` and, separately, `operator`. Verify that each shares
   the `needs-auth` treatment (no crash count, no timed retry, status reports the
   respective reason) and that a `retryWhen` (when supplied) drives exactly one
   fresh attempt, exercising all three `blocked` reasons rather than only the
   first.
8. Cancel or collect the guest while it is starting and while it is running,
   including a fake bot that ignores `cancelled` until a controllable signal.
   Verify that `cancelled` rejects, that the entry sits in `stopping` and admits
   no second consumer until `stopped` settles (or the force-reap timeout fires),
   that no later timer resurrects it, and that the supervisor retains neither
   guest nor bot.
9. Drive eight consecutive failures to open the `crash-loop` breaker, then
   restart the daemon. Verify that the persisted breaker keeps the guest
   `blocked` (reason `crash-loop`), that the retained-mail scan makes no fresh
   attempt, and that only `retryBot` clears it, distinguishing this from the
   credential case, where a restart does re-probe.
10. Model the retained-child ledger around repeated restart/incarnation. Verify
    that its count changes only on guest retention/dismissal and that a
    launcher's `admission-denied` result never causes the daemon to create
    another guest.

## Affected Packages

- `packages/daemon/src/types.d.ts`: formula, option, bot protocol, status, and
  daemon-core types.
- `packages/daemon/src/interfaces.js`: guarded host diagnostics and `EndoBot`
  method/result shapes.
- `packages/daemon/src/host.js`: resolve and validate the provisioning option;
  expose host-only status and retry methods.
- `packages/daemon/src/manager.js`: persist the formula edge, manage
  incarnations, scan retained mail after formula-graph seeding, and report
  lifecycle transitions.
- `packages/daemon/src/guest.js`: connect the bound guest to the mailbox wake
  hook and cancellation context.
- `packages/daemon/src/mail.js`: invoke the optional hook after durable
  delivery and outside the mailbox serialization lock.
- `packages/daemon/src/formula-record.js`: render the optional dependency for
  inspection.
- `packages/daemon/test/endo.test.js` and focused supervisor tests: exercise
  compatibility, ordering, restart, failure, cancellation, and quota invariants.

## Alternatives Considered

- **Store a worker formula identifier.** Rejected because worker incarnation does
  not identify or start a bot program and has no readiness/failure protocol.
- **Embed a spawn descriptor in the guest formula.** Rejected because it
  duplicates caplet formulation, couples the daemon to execution-specific
  fields, and makes future bot kinds require guest-formula changes.
- **Store the binding on the host.** Rejected for this increment because it
  separates the activation policy from the mailbox and authority boundary it
  governs, while risking automatic grant of the broader host facet.
- **Start every bound bot at daemon startup.** Rejected because it makes restart
  cost proportional to provisioned guests and can stampede runtime admission
  limits even when all mailboxes are empty.
- **Await bot readiness in `receive`.** Rejected because a crashed, throttled, or
  unauthenticated bot would turn a durable mail send into a delivery failure and
  invite sender retries that duplicate intent.

## Dependencies

None. The daemon increment is testable with a fake `EndoBot`. `@endo/claude`,
credential recovery, and minion.town provisioning consume this primitive rather
than block it.
