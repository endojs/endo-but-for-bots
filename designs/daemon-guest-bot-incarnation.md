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

This primitive is intended to support a Claude-backed guest, but its daemon
surface does not embed Claude-specific credential, model, or minion.town policy.
Those belong to the bot's caplet and its deployment. There are two exceptions,
each called out where it arises. First, a single load-bearing quota assumption
this design places on the composing minion.town design (see § Retention and
quotas). Second, a single burden this design places on the consumer's
credential handling: a Claude-backed bot must map a recognized shared-upstream
provider outage onto the `needs-auth`-shaped seam rather than letting it reach
the daemon as a crash (see § Failure, backoff, and credential expiry). In
particular, the daemon primitive composes with the
[`@endo/claude` design](endo-claude.md)
and minion.town's
[`@claude-agents` design](https://github.com/kriscendobot/minion.town/blob/main/designs/claude-agents-capability.md)
without embedding either one's policy in `@endo/daemon`.

## Background

Endo's persistent state is an immutable **formula graph**. A *formula* is
an immutable construction recipe named by a formula identifier. Most formulas,
caplets and guests among them, mint a fresh `randomHex256` identifier at
formulation time rather than hashing their recipe bytes, so the graph is not
content-addressed: two formulations of the same recipe yield two distinct
identifiers, and a formula's stability comes from that immutability plus the
get-or-create discipline below, not from any hash of its contents. A *caplet* is Endo's
existing formula for a program, capturing its worker, module sources, powers,
environment, and cancellation policy. An *incarnation* is the live running
process (or facet) produced from a formula by providing it: the formula is the
durable recipe, the incarnation is the ephemeral thing that runs. A `guest`
formula names a durable authority boundary and mailbox; its incarnation is the
`EndoGuest` facet. A *bot* is the program that consumes a guest's mailbox and
acts on that guest's behalf; this design binds a guest to a bot and makes mail
arrival keep one bot incarnation alive. The daemon *manager* is the per-daemon
component that owns the formula graph and the *provide* operation that turns a
formula identifier into a live incarnation; `provide` is memoized per identifier
(`controllerForId`), so repeated `provide` of one identifier returns one shared
incarnation until that incarnation's context is cancelled, at which point the
next `provide` builds a fresh one. The *incarnation supervisor* introduced below
is the in-memory, per-daemon component that decides when to bring a bot
incarnation to life for a guest and keeps at most one alive per guest. These
terms (formula, caplet, incarnation, bot, provide, manager, and supervisor)
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
  help(): Promise<string>;
  start(
    guest: EndoGuest,
    options: { cancelled: Promise<never> },
  ): Promise<
    | { type: 'running'; stopped: Promise<BotStop> }
    | { type: 'blocked'; reason: BotBlockedReason; retryWhen?: Promise<void> }
  >;
}
```

`help()` is the conventional capability-introspection method (per AGENTS.md, it
returns a descriptive string); it lets an operator discover a bot capability the
same way as every other daemon interface that carries it. `start` resolves with
`running` only after the bot has subscribed to the guest's mailbox and is ready
to service it. `stopped` settles when that incarnation
exits. Unexpected rejection before readiness or from `stopped` is a crash. The
daemon creates `cancelled` and retains its rejector; rejecting it is the normal
way to stop an incarnation when the guest dies or the daemon shuts down.

The bot formula must not depend on the guest formula. At runtime the supervisor
passes the already-incarnated `EndoGuest` facet to `start`. This one-way formula
edge (`guest -> bot`) keeps the persistent formula graph acyclic while giving
the bot the guest facet as its runtime authority. That guest facet is the
authority this edge grants; it is not the bot's *only* authority. A bot is an
ordinary caplet, and `formulateCapletDependencies` gives every caplet its own
`powers` edge (a fresh guest by default, or any caller-specified identifier,
including the provisioning host's). The daemon does not constrain those powers,
so containing the bot to exactly the guest's authority is an unenforced
deployment obligation, not a daemon-level guarantee: a deployment that wants the
bot's authority to be the guest and nothing more must formulate the bot with the
guest as its `powers`. The daemon guarantees only that the guest facet is passed
in and that the `guest -> bot` edge stays one-way.

**One incarnation per guest.** Each bot-bound guest binds its own bot formula
identifier, and the daemon runs exactly one bot incarnation per guest. Because
`provide` is memoized per formula identifier (`controllerForId`), it is a
*distinct* `bot` identifier per guest that yields a distinct incarnation, in its
own worker, for each guest. A deployment may reuse the same bot *recipe* (module
source, powers, worker kind) across many guests, but each guest resolves `bot`
to its own formula identifier; the daemon does not co-tenant several guests'
authority in one shared incarnation. This one-per-guest rule is what lets
collection cancel exactly that guest's incarnation (see § Retention and quotas), keeps
worker cost proportional to active guests (see § Restart behavior), and lets the
existing per-worker force-reap timeout bound a hung `stopped` (see
§ Incarnation supervisor). Sharing a single incarnation across guests (one worker receiving
many `start` calls) is out of scope for this increment; a design that wants it
must rework those three properties. The supervisor, not the bot, enforces the
one-live-call-per-guest invariant.

That per-guest single-flight covers repeated deliveries to *one* guest, but it
cannot by itself keep two *different* guests from co-tenanting one incarnation.
Because `provide` is memoized by formula identifier, two guests that resolved
`bot` to the *same* formula identifier would share one `controllerForId`
incarnation, and their two supervisor entries (keyed by guest identifier) would
each call `start` on that shared instance, handing one bot process two guests'
authority and breaking the retention, worker-cost, and one-live-call invariants
above. Distinctness is therefore a *checked* precondition, not an assumption
about caller hygiene: `provideGuest(name, { bot })` whose resolved `bot`
identifier is already recorded as another guest's `bot` edge in the formula graph
is rejected with an error naming the conflicting guest, rather than silently
sharing the incarnation. Because two guests each formulated with a *freshly
minted* bot recipe get distinct `randomHex256` identifiers, they never collide;
the only way to reach this rejection is to pass the *same existing* bot name or
identifier to two different guests. That is exactly the collision the check
exists to catch. To make the check a function of durable state rather than of
in-memory supervisor timing, "conflict" is defined against formula-graph
reachability (an identifier recorded as a live, reachable guest's `bot` edge),
and the check runs inside the same `withFormulaGraphLock` critical section that
`formulateGuest` already holds. Running it under that lock is required: without
it, two concurrent `provideGuest` calls binding the same identifier could both
observe no prior binding and both pass, admitting the co-tenancy the check
exists to prevent. (A guest may re-request its *own* existing `bot` identifier
under the get-or-create rule; only a collision with a *different* guest's
binding is rejected.)

`provideGuest(name, { bot })` accepts `bot` as a pet name or name path in the
creating host's namespace, resolves it once to a local formula identifier, and
persists that identifier. `bot` must be a guest-only option, so that
`provideHost(name, { bot })` is both a type error and a runtime error rather than
a silent no-op. This is a change this increment introduces, not existing
behavior: today `provideHost` and `provideGuest` funnel their options through one
shared `normalizeHostOrGuestOptions` helper (`host.js`) that destructures only
`introducedNames` and `agentName` and silently drops every other key, so a stray
`bot` on either method is currently ignored without error. The increment splits
that shared helper (a guest-specific option type that recognizes and resolves
`bot`, and a host path that rejects an unrecognized `bot` key), so the
authority-boundary guarantee this paragraph states is actually enforced rather
than assumed (see Affected Packages, `host.js`).

An absent `bot` option preserves today's serialized guest formula exactly. The
field is *omitted* from the record, not stored as `null` or `undefined`, so an
unbound guest's persisted formula and its load path are byte-for-byte unchanged.
Because guest identifiers are minted rather than derived from recipe bytes, this
is a serialization-compatibility guarantee, not an identity one. Retrieval is
symmetric: a bare `provideGuest(name)` with the option omitted matches an
existing guest whatever its stored `bot`, so existing callers keep working; only
a *supplied* `bot` that disagrees with the stored one is a mismatch (below). A
supplied identifier is transiently pinned until the new guest formula records
the dependency. `extractLabeledDeps`, formula inspection, and formula-record
rendering expose the edge as `bot`.

The binding belongs only on `GuestFormula`, not `HostFormula`:

- A guest is the authority boundary the bot receives and the mailbox whose mail
  activates it. Keeping the binding there makes the relationship unambiguous.
- Hosts already have explicit daemon-start roots and `@pins` (the host's durable
  pinned-service directory) for services. Automatically passing the full host
  facet to arbitrary bot code would create a materially broader authority
  surface.
- A later host-bot design can reuse `EndoBot` after specifying root-bootstrap
  ordering. It need not be coupled to this guest increment.

The `bot` identifier is part of the guest's construction recipe. A guest formula
is immutable once formulated, and guest identity is a minted random identifier
plus keypair rather than a hash of the recipe, so the stability here comes from
formulation discipline and the get-or-create rule, not from content addressing.
Changing or removing the binding therefore does not edit an existing guest in
place: it formulates a different guest, with a different identifier and agent
identity, and then requires an explicit name migration by its owner.
`provideGuest` remains get-or-create; asking for an existing name with a
*different* `bot` is an error that reports the binding mismatch rather than
silently ignoring or rewriting it (an omitted `bot` on retrieval is not a
mismatch, per above). In-place bot rebinding, including any mailbox-transfer
semantics, is deferred.

Because the persisted `bot` value pins one formulated *instance* of a bot recipe
by its minted identifier, not a stable "this guest's bot" role, this snapshot has
a consequence worth stating plainly: an ordinary bot code upgrade (new module
source, hence a new formulation with a new identifier) is a guest
re-identification. It discards the guest's keypair and the retained conversation
history the restart and quota sections depend on, and forces the explicit name
migration above. For a long-lived Claude-backed guest, whose bot code is expected
to change routinely, that upgrade path is the dominant operational case rather
than the edge case the deferral above frames it as. A middle alternative that
separates guest identity from bot value (binding to a stable indirection the
guest owns, resolved per incarnation) is weighed and rejected under Alternatives
Considered; this increment accepts the re-identification cost.

### Incarnation supervisor

The manager owns a bot-incarnation supervisor keyed by guest formula identifier.
An entry has one of these in-memory states:

| State | Meaning |
|---|---|
| `dormant` | No message in this daemon incarnation has demanded the bot. |
| `starting` | Exactly one `provide(botId)` / `start(guest)` operation is in flight. |
| `running` | `start` reported ready and its `stopped` promise is pending. |
| `stopping` | A canceled incarnation's `stopped` promise has not yet settled. |
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
starts a fresh attempt only once the prior `stopped` promise settles *and* only
if no breaker is open at that point, so a new delivery cannot open a second
consumer while the old one is still winding down, and a `stopBot`-initiated
teardown that passes through `stopping` (below) settles into `blocked`/`operator`
rather than reincarnating on the recorded demand. In `dormant` it starts an
attempt. In `blocked`, ordinary mail does not reset the breaker.

Each attempt is a *fresh incarnation*, and the supervisor is responsible for
making it one. Because `provide(botId)` is memoized by identifier
(`controllerForId`, see Background), a second `provide(botId)` returns the same,
already-exited controller unless that incarnation's context has been cancelled
first. So before it re-provides for any retry (whether from `backoff`, from a
`retryWhen` fulfillment, or from `retryBot`), the supervisor cancels the prior
incarnation's context, dropping the memoized controller, so the next
`provide(botId)` builds a new worker rather than handing back a dead one. A clean
`{ type: 'stopped' }` idle exit and a guest-context cancellation both already
cancel that context; the retry paths make the same cancellation explicit so no
attempt re-invokes `start` on a spent incarnation.

The supervisor calls `provide(botId)`, then invokes the guarded `EndoBot.start`
with the guest facet and its cancellation promise, and verifies the returned
object. A `running` result transitions the entry to `running`; the supervisor
then observes the `stopped` promise. How that promise settles determines the
next state:

- A clean `{ type: 'stopped' }` result means the bot drained its mailbox and
  exited on its own. This is not a failure: the entry returns to `dormant`, its
  failure count is untouched, and the next delivery (or one that arrived while
  the clean exit was settling) wakes a fresh incarnation. This is the ordinary
  idle-exit lifecycle for a bot with nothing left to do.
- A `{ type: 'blocked'; reason }` result moves the entry to `blocked` under that
  reason with the same treatment as a `blocked` result from `start` (Failure,
  backoff, and credential expiry).
- A rejection, or an untyped result, is a transient failure and enters `backoff`
  (see § Failure, backoff, and credential expiry).

Teardown cancels the bot incarnation's *own* context, not merely the `cancelled`
promise passed to `start`. Cancelling that context cancels the bot's controller
and runs the worker's `gracefulCancel` grace period, which is what the daemon's
existing force-reap timeout bounds. Rejecting only the `cancelled` promise would
leave a bot that ignores it parked forever, so the supervisor must cancel the
context to get the bound. This applies uniformly to guest-context cancellation
(the guest dies) and to `stopBot` (an operator pause), which both take this path.
Cancellation rejects `cancelled` (as a courtesy to a cooperating bot) and moves
the entry to `stopping`; the entry is not cleared (and no re-entry is permitted)
until the incarnation's `stopped` promise actually settles, so a bot that is slow
to honor `cancelled` cannot overlap with its successor. Cancellation does not
count as a failure. A `stopped` promise that never settles is bounded by that
same force-reap timeout, after which the entry clears. The supervisor's entry
table must not itself retain a guest after that guest's formula is collected.

### The mailbox commit hook

`makeMailbox` gains an optional daemon-internal `onMessageCommitted` callback.
`makeGuest` supplies it only when its formula has a `bot` binding. Hosts and
unbound guests omit it.

For every path that creates a new mailbox item, `deliver` performs these steps:

1. Validate the envelope.
2. Persist the message formula under the next mailbox number.
3. Persist the incremented next-number value.
4. Add the stamped message to the in-memory mailbox and publish it to
   `followMessages()` subscribers.
5. After the mailbox's serialized job has released its lock, synchronously ask
   the supervisor to ensure the bot, without awaiting bot startup.

The hook fires for local delivery, remote delivery, and the sender-side copy
(`post` delivers a copy of every outgoing `send`/`reply` into the sender's own
mailbox) because all three converge on `deliver`. It does not fire for edits,
reads, dismissal, or replay during mailbox construction. The sender-side copy has
a consequence the consumer must handle: a bot's own outgoing messages wake its
own bot and, left undismissed, satisfy the retained-mail restart predicate below,
so a bot that idle-exits after replying is re-woken by its own echo on the next
restart scan. This is not a daemon defect (the copy is the mailbox's existing
self-delivery behavior); it is a consumer obligation. A correct bot dismisses (or
covers with its dedupe cursor) its own outgoing copies so they neither drive a
spurious wake nor re-trip the restart scan.

This ordering makes mail acceptance independent of bot health. If persistence
fails, no wake is issued, and the sender sees the existing delivery failure. If
the wake fails, `receive` still succeeds because the message is already durable.
(`receive` is the mailbox entry point that runs `deliver` inside
`mailboxStoreJobs`; the wake fires after that job releases its lock, so a wake
failure cannot roll back the already-committed message.) Calling the supervisor
outside `mailboxStoreJobs` also prevents a startup path that calls
`followMessages()` from waiting on the mailbox lock it must hold to observe new
messages.

Messages arriving while the state is `starting` are persisted and published in
the same way, then coalesce onto the one in-flight attempt. No second bot is
started, and no second copy of a message is written to the mailbox.

`followMessages()` subscribes to later messages before it yields the current
snapshot, so a bot that subscribes after becoming ready observes the complete
retained backlog and then every later message with no gap. It can, however,
observe a *duplicate*: a message committed while the bot is still draining the
backlog snapshot is both visited by the in-progress snapshot iteration and
replayed from the subscription. The durable mailbox holds exactly one copy; the
*stream* can present that one entry twice during the drain interleave. The
consumer contract is therefore at-least-once with a stable dedupe key: every
message carries a stable mailbox number and message identifier, and a correct
bot deduplicates by mailbox number before acting. This is the same key that
makes crash replay safe, so the drain race needs no additional machinery.

The daemon treats the bot's `running` self-report as authoritative. A bot that
reports `running` but never actually drains its mailbox is a bot defect this
increment does not detect, because the daemon has no read-side signal for
consumption; the future mailbox-acknowledgment protocol noted under Restart
behavior would also close this gap. Scoping it out here keeps the daemon from
inventing a liveness probe over opaque bot behavior.

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
before the in-memory wake leaves a committed message with no wake; the startup
scan repairs that missed wake. A guest with no retained mail remains cold until
its next delivery, avoiding a restart stampede across every provisioned bot and
avoiding worker cost for guests with nothing to do.

A mailbox can intentionally retain conversation history. Such a mailbox causes
one start attempt after each daemon restart even if the bot has already handled
every retained item. The bot's durable cursor or idempotency record distinguishes
handled mail. This bounded extra attempt is preferable to a separate mutable
"unread" truth that could disagree with the mailbox and strand work. A future
mailbox acknowledgment protocol may make the startup predicate narrower.

### Failure, backoff, and credential expiry

An unexpected start rejection, a `stopped` rejection, or an untyped `stopped`
result is a transient failure. The supervisor retries with full-jitter
exponential backoff: a one-second base, doubling per consecutive failure, capped
at five minutes. One timer exists per guest. New messages during backoff do not
bypass it. The backoff *delay* still tracks a consecutive-failure count that a
sustained `running` stretch resets, so a bot that recovers gets a short delay
again; but the `crash-loop` *breaker* is governed by restart *rate*, not that
consecutive count. The supervisor retains the timestamps of recent failures in a
sliding window and opens the `crash-loop` breaker once eight failures fall within
a fifteen-minute window, after which it does not automatically retry until a host
operator explicitly requests a retry or the guest is replaced with a different
bot binding.

A rolling window rather than a reset-on-any-success count is deliberate. A bot
that runs just long enough to look healthy (say about sixty seconds) and then crashes
on every cycle would never accumulate eight *consecutive* failures under a hard
reset, so the daemon would restart it forever: exactly the in-process hot loop
this breaker exists to prevent, and one invisible to `getBotStatus` because such
an entry only ever cycles `starting -> running -> backoff` and never reaches
`blocked`. Bounding failures per unit time trips the breaker on that flapping bot
while still letting a genuinely recovered bot (whose earlier failures age out of
the window) resume without operator intervention. A clean `{ type: 'stopped' }`
idle exit adds no failure timestamp, so the ordinary idle-exit lifecycle never
advances the breaker.

The breaker states divide along three independent axes: whether the failure
counts toward the crash-loop rate, whether the open state persists across a
daemon restart, and what clears it. Rather than argue each in prose, the table
gives one row per reason; the prose that follows only justifies the two cells
that are non-obvious (why `crash-loop` persists and why `operator` does not).

| reason | counts as failure? | persists across restart? | cleared by |
|---|---|---|---|
| transient (`backoff`) | yes (crash-loop window) | no | a successful `start`, or backoff timer elapsing |
| `crash-loop` | n/a (it *is* the rate breaker) | yes (single boolean per guest) | `retryBot`, or a bot rebinding |
| `needs-auth` | no | no (re-probed on restart) | `retryWhen` fulfilling, or `retryBot` |
| `admission-denied` | no | no (re-probed on restart) | `retryWhen` fulfilling, or `retryBot` |
| `operator` | no | no (scope decision, see below) | `retryBot` |

Unlike the process-local backoff timer and typed-policy breakers, the open state
of the `crash-loop` breaker is persisted, so that a routine daemon restart
(deploy, reboot, upgrade rollout) does not silently hand a crash-looping bot the
one-immediate-attempt described under § Restart behavior. It is stored as a single
boolean per guest in the guest's own daemon-side store, alongside the mailbox
indexes the restart scan already reads, and is written under that store's
serialized job so its set is atomic with respect to `retryBot`'s clear. It is
this design's only durable mutable per-guest state. The § Restart behavior
section rejects an
"unread" cursor for being a separate mutable truth that could disagree with the
mailbox and strand work; this flag escapes that objection on three counts. It is
derived state the supervisor can always rebuild by resuming attempts (clearing it
is never wrong, only possibly premature). It is keyed by, and collected with, the
guest formula, so it is never a new persistence root (see § Retention and quotas). And
it disagrees with nothing: it records only "do not auto-retry," which a single
`retryBot` or a rebinding overrides. It is removed when the guest is collected. A
guest whose crash-loop breaker is open on restart stays `blocked` (reason
`crash-loop`) and is not scanned for a fresh attempt; only `retryBot` or a bot
rebinding clears it.

The credential and `admission-denied` breakers deliberately
do not persist, because a restart is exactly the moment to re-probe a possibly
repaired credential or quota: those two blockers gate on *external* state that may
have changed on its own while the daemon was down, so an unconditional re-probe is
the right default. The `operator` breaker is different in kind, and its
non-persistence is a scope decision rather than a re-probe, argued separately
under the host methods below.

Expected blockers use the tagged result rather than rejection:

- `needs-auth` means the credential was absent, revoked, or expired. It opens a
  credential breaker immediately and does not consume the crash count.
- `admission-denied` covers a deployment quota or policy decision. It likewise
  does not consume the crash count and does not masquerade as a crash.
- `operator` covers an intentional pause, entered either by the host through
  `stopBot` or self-reported by a bot standing itself down. Like the other
  blockers it does not consume the crash count; its breaker is cleared only by
  `retryBot`.

The `BotBlockedReason` union is deliberately closed to this daemon-only
vocabulary, which has a consequence the companion `@endo/claude` design must work
around: a *shared-upstream* outage (an Anthropic-side rate limit,
`overloaded_error`, or 5xx) is not a fault of the individual bot, but none of the
three typed reasons names it, so a bot that surfaces it as an ordinary rejection
falls through to the transient-failure path and consumes the crash count. During a
real provider outage that means every affected bot-bound guest independently races
its own eight-in-fifteen-minutes count into an open `crash-loop` breaker, each
then requiring a per-guest `retryBot` once the outage clears. This is the
fleet-scale form of the very hot-loop-versus-recoverable-failure distinction this
section draws on the single-guest axis. Rather than widen the union here, this
increment places the burden on the consumer: a Claude-backed bot must map a recognized
shared-upstream unavailability onto the `needs-auth`-shaped seam (a non-crash
blocker with a `retryWhen` that fulfills when the provider recovers) rather than
letting it reach the daemon as an untyped transient failure. Widening the union
with a first-class `upstream-unavailable` reason, so the daemon itself can treat
provider outages as non-crash-counting without relying on consumer discipline, is
noted as deferred work (see § First Increment and Deferred Work).

If a blocked result includes `retryWhen`, the supervisor observes that promise
and performs one new attempt when it fulfills, provided the guest still exists.
The credential-recovery design can therefore send a deduplicated reauthentication
message to the designated operator and use credential rotation to fulfill
`retryWhen`. The daemon neither sends credential material nor invents a retry
cadence for expired credentials. If the daemon restarts while blocked, the
pending-mail startup scan performs one fresh attempt; a still-expired credential
returns to `needs-auth` without entering the crash-loop counter.

The host gains three privileged methods, `getBotStatus`, `stopBot`, and
`retryBot`.

`getBotStatus` returns a discriminated union with one record shape per state, so
each variant carries only the fields meaningful for it. The two states that carry
a count report *different* counts under distinct names, because they answer
different questions: `backoff` carries `consecutiveFailures`, the reset-on-success
count that sets the current backoff delay, plus its next retry time; the
`crash-loop` breaker carries `windowFailures`, the count of failures inside the
rolling fifteen-minute window that opened it. Naming both `failures` would let an
operator read one number believing it was the other, so the surface never spells
them the same. The policy blockers (`needs-auth`, `admission-denied`, `operator`)
carry only their reason, because none has a crash count or a timed retry. The
`reason` values reuse the `BotBlockedReason` union
widened by the daemon-only `crash-loop` value (named `BotStatusReason`), keeping
this surface and `EndoBot.start`/`BotStop` legible siblings:

```ts
type BotStatusReason = BotBlockedReason | 'crash-loop';

interface EndoHost {
  getBotStatus(guestNameOrPath): Promise<
    | { type: 'unbound' }
    | { type: 'dormant' }
    | { type: 'starting' }
    | { type: 'running' }
    | { type: 'stopping' }
    | { type: 'backoff'; consecutiveFailures: number; retryAt: string }
    | { type: 'blocked'; reason: 'crash-loop'; windowFailures: number }
    | { type: 'blocked'; reason: BotBlockedReason }
  >;

  stopBot(guestNameOrPath): Promise<void>;

  retryBot(guestNameOrPath): Promise<void>;
}
```

`retryBot` closes whichever breaker is open (crash-loop, credential
`needs-auth`, `admission-denied`, or `operator`) and makes one attempt; it does
not disable subsequent backoff. `stopBot` cancels any live incarnation and opens
the `operator` breaker, so ordinary mail no longer reincarnates the bot until
`retryBot`; the two together give the `operator` state both of its directions.
`retryBot` is deliberately not spelled as `stopBot`'s inverse (for instance
`resumeBot`): it is the single clear-and-attempt lever for *every* blocked
reason, including the daemon-originated `crash-loop` breaker that `stopBot` never
sets, so a pause/resume pairing would misdescribe the wider role it plays. There
is no separate `startBot`, because ordinary mail is what starts a `dormant` bot;
`retryBot` is only for the blocked states that mail cannot clear.
This operator pause is process-local, like the other typed-policy breakers: it
holds against ordinary mail within a daemon incarnation but, because only the
`crash-loop` bit is persisted, does not survive a routine restart. A deploy,
reboot, or upgrade rollout gives an `operator`-blocked guest with retained mail
the same one-immediate-attempt the restart scan gives a backoff-blocked one, so
an explicit `stopBot` does not outlast a restart in this increment. This is *not*
the re-probe rationale that justifies dropping the credential and
`admission-denied` breakers across a restart: `operator` is not external state
that a restart might find repaired, but a deliberate administrative decision that
nothing "repairs" by the daemon restarting, so re-probing it on restart is not a
feature. Its non-persistence is instead a first-increment scope decision, and the
increment accepts the resulting risk on a narrow ground: `stopBot` in this
increment is an *operational* pause (quiet a noisy or misconfigured bot, hold it
during maintenance), not a security boundary, so an un-pause bounded to the next
routine restart is tolerable for the guest population this ships to. An operator
who needs a pause with security or safety weight (one that must not lapse on the
next deploy) has a durable lever today: rebinding or collecting the guest removes
the `bot` binding outright, which no restart reincarnates. Persisting the
`operator` reason itself (a small enum alongside the existing `crash-loop` bit,
the same mechanism) is a natural next increment and is deferred to it
(see § First Increment and Deferred Work); until then the rebind/collect lever is the
supported way to make a pause survive a restart.

Both `stopBot` and `retryBot` resolve once the supervisor has recorded the state
change and scheduled (`retryBot`) or completed (`stopBot`) the cancellation, not
once the resulting
attempt reaches a terminal state; a caller learns that outcome from
`getBotStatus` or the diagnostic stream. Called on a guest that exists but has no
`bot` binding, both throw a `TypeError` naming the target rather than silently
no-opping; `getBotStatus` reports the same case non-fatally as
`{ type: 'unbound' }`.

`getBotStatus` is a per-guest query and this increment ships no `listBots()`
enumeration alongside it; the supported way to go from "some bot is
crash-looping" to a guest name is the daemon's existing formula-graph inspection
(`diagnostics()` and formula-record rendering, which expose the `bot` edge per
§ Formula shape), so an operator enumerates bot-bound guests there. A dedicated
`listBots()` catalog is deferred (see § First Increment and Deferred Work).

Every transition also emits the existing lifecycle diagnostic with the guest
identifier, bot identifier, state, both counts (the `consecutiveFailures` backoff
count and the `windowFailures` rolling-window count), normalized reason, and
retry time. Diagnostics never include message bodies, prompts, credentials, or
raw error objects. Guest code receives no new lifecycle-control authority.

Backoff timers and the typed-policy breakers are intentionally process-local in
the first increment; only the `crash-loop` breaker's open bit is persisted (see
above). A restart permits one immediate attempt for guests that are not in an
open crash-loop breaker, which is necessary to notice a credential repaired while
the daemon was down. A failed attempt returns to the same bounded policy, so a
bot failure cannot turn into an in-process hot loop. Persisting full retry
schedules and operator pauses is deferred.

### Retention and quotas

The `bot` edge is a *retention* dependency but not a symmetric cancellation one,
and the asymmetry is load-bearing. For retention it behaves ordinarily: retaining
the guest retains the bot formula. For cancellation it is deliberately one-way.
The usual guest dependency is wired `thisDiesIfThatDies(dep)`, so the dependent
dies when the dependency does; wiring `bot` that way would make a *crashed bot
worker cancel its guest* (a caplet dies with its worker), destroying the mailbox
and authority boundary this design exists to keep alive. So the `bot` edge is
wired the other direction only: collecting or cancelling the guest cancels its
live bot incarnation (one incarnation per guest, so exactly that guest's, per
§ Formula shape), but a bot incarnation crashing or being reaped never cancels
the guest, it only returns the supervisor entry to `backoff` or `blocked`. The
supervisor scans only reachable guests at startup and must not become a new
persistence root.

Incarnation is not provisioning. It re-provides the already-bound bot formula
and invokes `start` for the already-retained guest. It never calls
`provideGuest`, adds a name to a parent directory, or increments a retained-child
ledger. Single-flight supervision also prevents two incarnations from occupying
two runtime slots for one retained child.

Minion.town's per-`iss+sub` (issuer plus subject) quota remains authoritative at
child creation: a bot-bound child consumes exactly one retained-child slot when
its guest is first retained, releases it when that retention is dismissed, and
consumes no additional retained-child slots on any number of reincarnations. This
slot-once accounting is an assumption this design places on the composing
minion.town
[`@claude-agents` design](https://github.com/kriscendobot/minion.town/blob/main/designs/claude-agents-capability.md);
it is load-bearing here and must be confirmed against that design's admission
check. If minion.town instead charged a slot per `start` invocation rather than
per retention, the quota-safety conclusion below would not hold, and this section
would need revision. A bot that needs a separate runtime admission slot must
perform its normal atomic admission check in `start`; rejection appears as
`admission-denied`, and the daemon must not bypass it or silently create
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
rejected during provisioning where discoverable (the supervisor uses the
CapTP-conventional `__getMethodNames__()` introspection to check for `start`
rather than duck-typing by invocation), and otherwise fails the first guarded
start without affecting mailbox durability.

## First Increment and Deferred Work

The first increment includes:

- the optional `GuestFormula.bot` edge and `provideGuest(..., { bot })` option;
- the guarded `EndoBot` start/result protocol and single-flight supervisor;
- the post-commit mailbox wake hook for new messages;
- lazy restart recovery for reachable bot-bound guests with retained mail;
- transient backoff, the crash-loop and typed-policy breakers, the
  `getBotStatus`/`stopBot`/`retryBot` host methods and lifecycle diagnostics,
  and cancellation on guest collection; and
- deterministic tests with a fake bot caplet, including restart and race cases.

It deliberately defers:

- a `HostFormula.bot` binding and host-bootstrap ordering;
- changing the bot on an existing guest or migrating its identity/mailbox;
- a `followBotStatus()` subscription over the status union; this increment ships
  only the poll-based `getBotStatus` and the lifecycle diagnostic;
- a durable unread/processed cursor and transactional exactly-once external
  effects;
- persisted backoff schedules and operator pauses;
- a first-class `upstream-unavailable` blocked reason that lets the daemon treat a
  shared-provider outage as non-crash-counting on its own, rather than relying on
  the consumer to map it onto the `needs-auth`/`retryWhen` seam;
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
   `provideGuest` fails while a bare retrieval with `bot` omitted succeeds.
3. Deliver one message and block fake-bot startup. Verify delivery returns after
   durable commit, then deliver several more messages. Release startup and verify
   one `start` call and that the durable mailbox holds one copy of every mailbox
   number in order. Then, with the bot still draining the backlog, commit a
   further message and verify the bot deduplicates the stream by mailbox number,
   acting on each number exactly once even though the drain interleave presents
   one entry twice.
4. Crash after the message commit but before the wake request. Restart and verify
   the retained-mail scan makes one start attempt. Verify an empty bot-bound
   guest starts no worker.
5. Make the bot reject repeatedly. Verify exponential delays, one timer, no
   message-triggered bypass, and one operator-directed retry. Verify the
   crash-loop breaker's rolling-window semantics with a controllable clock:
   eight failures inside the fifteen-minute window open the breaker, while a bot
   that reports `running` for about sixty seconds and then crashes on every cycle (the
   flapping case that never accumulates eight *consecutive* failures) still trips
   the breaker once eight of its failures fall within the window, and failures
   spread beyond the window do not open it.
6. Return `needs-auth` with a controllable `retryWhen`. Verify that no crash
   count or timed retry occurs, that status reports the credential blocker, and
   that fulfilling the signal makes exactly one new attempt while the original
   mail remains present.
7. Return `admission-denied` and, separately, `operator`. Verify that each shares
   the `needs-auth` treatment (no crash count, no timed retry, status reports the
   respective reason) and that a `retryWhen` (when supplied) drives exactly one
   fresh attempt, exercising all three `blocked` reasons rather than only the
   first. Verify that `stopBot` moves a running bot to `blocked`/`operator`
   without collecting the guest and that `retryBot` resumes it.
8. Cancel or collect the guest while it is starting and while it is running,
   including a fake bot that ignores `cancelled` until a controllable signal.
   Verify that `cancelled` rejects, that the entry sits in `stopping` and admits
   no second consumer until `stopped` settles (or the force-reap timeout fires),
   that no later timer resurrects it, and that the supervisor retains neither
   guest nor bot. Verify separately that a clean `{ type: 'stopped' }` result
   returns the entry to `dormant` without a failure and that a later delivery
   wakes a fresh incarnation.
9. Drive eight consecutive failures to open the `crash-loop` breaker, then
   restart the daemon. Verify that the persisted breaker keeps the guest
   `blocked` (reason `crash-loop`), that the retained-mail scan makes no fresh
   attempt, and that only `retryBot` clears it, distinguishing this from the
   credential case, where a restart does re-probe.
10. Model the retained-child ledger around repeated restart/incarnation. Verify
    that its count changes only on guest retention/dismissal and that a
    bot's `admission-denied` result never causes the daemon to create another
    guest.
11. Provision two guests that resolve `bot` to the same recipe but to distinct
    formula identifiers. Deliver to each and verify two independent incarnations
    in two workers, that collecting one guest cancels only its incarnation and
    reaps only its worker, and that neither guest ever receives the other's
    `start` call. Then, separately, attempt to provision a second guest whose
    `bot` resolves to the *same* formula identifier already bound to a live guest
    and verify it is rejected with an error naming the conflicting guest rather
    than co-tenanting one incarnation across both. Also verify `provideHost(name,
    { bot })` is rejected rather than silently dropping the `bot` key.
12. Verify the query/command asymmetry directly on a guest that exists but has
    no `bot` binding: `getBotStatus` reports `{ type: 'unbound' }` non-fatally,
    while `stopBot` and `retryBot` each reject with a `TypeError` naming the
    target rather than silently no-opping.
13. Exercise the `ensureBot` "never rejects" linchpin directly, one case per
    failure path: `provide(botId)` itself throwing, `start` returning a malformed
    object (missing or unknown `type`), `start` throwing synchronously, and a
    bound formula that is a raw worker or a caplet without `start`. Verify each
    folds into `backoff` (or `blocked` where typed) without rejecting the
    delivery that triggered it and without surfacing as an unhandled rejection,
    and that the committed mailbox message is unaffected in every case.

## Affected Packages

- `packages/daemon/src/types.d.ts`: declare the formula, option, bot protocol,
  status, and daemon-core types.
- `packages/daemon/src/interfaces.js`: guard the host diagnostics and the
  `EndoBot` method/result shapes.
- `packages/daemon/src/host.js`: split the shared `normalizeHostOrGuestOptions`
  helper (which today silently drops unknown keys) so the guest path resolves and
  validates the `bot` provisioning option while the host path rejects an
  unrecognized `bot`; expose host-only status, stop, and retry methods.
- `packages/daemon/src/manager.js`: persist the formula edge, reject a `bot`
  identifier already bound to another live guest, manage incarnations (including
  the rolling-window crash-loop breaker), scan retained mail after formula-graph
  seeding, persist the crash-loop bit, and report lifecycle transitions.
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
- **Associate the bot out of band, in a durable guest-to-bot table keyed by
  guest identifier.** This is the one alternative that leaves guest identity
  untouched, so a rebind would not re-formulate the guest. Rejected for this
  increment because it reintroduces exactly the second mutable truth the
  crash-loop discussion works to avoid: a table that can disagree with the
  formula graph about which bot a guest runs, with its own collection and
  consistency story, and because binding in the recipe is what makes the
  `guest -> bot` authority edge visible to formula inspection and retention. The
  accepted cost is that rebinding is a new guest identity, which is deferred.
- **Bind to a stable indirection the guest owns, resolved per incarnation.** The
  middle primitive between the fully mutable out-of-band table above and the
  identifier snapshot this design chose: rather than pin the resolved `bot`
  identifier into the guest recipe at `provideGuest` time, pin a stable *name
  path in the guest's own namespace* and resolve it to a formula identifier on
  each incarnation. This separates "which guest this is" from "which build of the
  bot services it," so an ordinary bot code upgrade would rebind the name without
  re-identifying the guest (the re-identification consequence stated under
  § Compatibility and Migration). Rejected for this increment on the same ground
  as the out-of-band table (the resolved target becomes a mutable truth separate
  from the immutable recipe, with its own consistency story) and because
  per-incarnation resolution reopens the distinctness and cancellation-direction
  invariants that the pinned identifier makes static; the accepted cost is that a
  routine upgrade is a guest re-identification. Recorded here because that upgrade
  path is the dominant operational case for a long-lived Claude-backed guest, so
  the trade is deliberate rather than overlooked.
- **Reuse `followMessages()` for the wake instead of a new `onMessageCommitted`
  hook.** Rejected because a standing daemon-side subscription would have to
  incarnate every bot-bound guest just to watch for its first message, defeating
  the lazy start this design turns on; the hook wakes only on an actual commit
  and only for guests that carry a `bot`.
- **Start every bound bot at daemon startup.** Rejected because it makes restart
  cost proportional to provisioned guests and can stampede runtime admission
  limits even when all mailboxes are empty.
- **Await bot readiness in `receive`.** Rejected because a crashed, throttled, or
  unauthenticated bot would turn a durable mail send into a delivery failure and
  invite sender retries that duplicate intent.

## Dependencies

No *build* dependency: the daemon increment is testable with a fake `EndoBot`,
and `@endo/claude`, credential recovery, and minion.town provisioning consume
this primitive rather than block it.

One *assumption* dependency, recorded here because § Retention and quotas calls it
load-bearing: minion.town's per-`iss+sub` quota must charge a retained-child slot
per guest *retention*, not per bot `start` invocation. If that design instead
charged per `start`, the quota-safety conclusion in § Retention and quotas would
not hold. Owner: the minion.town
[`@claude-agents` design](https://github.com/kriscendobot/minion.town/blob/main/designs/claude-agents-capability.md);
this design's slot-once claim must be confirmed against that design's admission
check before either ships.

## Prompt

> Design (in designs/) a general daemon primitive that binds an Endo guest to a
> bot capability so that accepting a message for that guest makes a best effort
> to keep exactly one bot incarnation running, without letting the message's
> durable acceptance depend on whether the bot starts. It should support a future
> Claude-backed guest but must not mention Claude, credentials, models, or
> minion.town policy in the daemon surface. Cover the formula shape, the
> `EndoBot` start/result protocol, single-flight incarnation on mailbox commit,
> lazy restart recovery, crash backoff with a credential-aware circuit breaker,
> retained-child quota invariants, compatibility, and a deliberately bounded
> first increment with a deterministic fake-bot test plan.
