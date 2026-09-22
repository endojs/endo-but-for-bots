# Guest Bot Incarnation on Mailbox Delivery

| | |
|---|---|
| **Created** | 2026-09-08 |
| **Updated** | 2026-09-22 |
| **Author** | kriscendobot (prompted) |
| **Status** | **Implemented** |

## Status

The daemon primitive this design needs has landed in
[PR #1306](https://github.com/endojs/endo-but-for-bots/pull/1306) (merge commit
`60802d3df`, implementation commit `9e16e50b1`). It is more general and smaller
than the guest-specific `EndoBot` protocol originally proposed here:

- `provideGuest(..., { pins })` installs a caller-elected directory as the
  guest's `@pins` directory.
- Every mailbox delivery best-effort reincarnates the values in that directory
  before publishing the message-received notification.
- The same delivery also reincarnates a second, host-only pin directory retained
  by the guest formula.

Consequently, a deployment provisions its mailbox consumer as an ordinary
agent-side responder and stores that responder in the guest's pin directory.
There is no need for a `GuestFormula.bot` edge, an `EndoBot.start` protocol, a
guest-specific incarnation supervisor, or a second mailbox wake hook.

## What is the Problem Being Solved?

An Endo guest can own durable names and a durable mailbox, while the program
servicing that mailbox runs in an ephemeral worker. After a daemon restart or a
mid-life worker cancellation, the durable guest and its mail remain, but the
program may no longer be live.

The daemon therefore needs a deployment-independent way to retain an agent-side
responder with a guest and to reincarnate it when mail arrives. Message
acceptance must remain durable even when the responder cannot start.

The landed pin mechanism provides exactly that primitive. Claude-specific
credentials, models, admission policy, retry policy, and retained-child quotas
remain concerns of the responder and its deployment, not `@endo/daemon`.

## Background

Endo's persistent state is an append-only **formula graph**. A formula, once
written, cannot be modified. The graph itself can grow as formulas are added,
and unreachable formulas can be collected, so describing the graph as immutable
would be too strong.

Most formulas, including guests and caplets, receive a fresh `randomHex256`
identifier at formulation time. A formula is the durable recipe; providing its
identifier produces an ephemeral incarnation. `provide` memoizes live
incarnations by formula identifier through `controllerForId`. Re-providing an
already-live responder is therefore cheap and does not start a duplicate. After
its worker is canceled and the prior controller is gone, providing the same
formula identifier creates a fresh incarnation.

A guest formula now refers to two pin directories:

```ts
export type GuestFormula = {
  type: 'guest';
  // existing fields
  guestPins?: FormulaIdentifier;
  hostPins?: FormulaIdentifier;
};
```

`guestPins` is exposed to the guest as `@pins`; `hostPins` is deliberately not
installed as a special name. Older guest formulas may omit both fields and
continue to load.

## Design

### Provision a pinned responder

The provisioning host creates a directory, supplies it as the new guest's pin
directory, formulates the responder with the guest as its powers, and retains
the responder in that directory:

```js
const pins = await E(host).makeDirectory('responder-pins');
const guest = await E(host).provideGuest('responder', {
  agentName: 'responder-agent',
  pins,
});

await E(host).makeUnconfined('responder-worker', responderLocation, {
  powersName: 'responder-agent',
  resultName: 'auto-responder',
});

const responderId = await E(host).identify('auto-responder');
await E(pins).storeIdentifier(['auto-responder'], responderId);
```

The responder is an ordinary caplet or agent program. It consumes
`E(guest).followMessages()`, performs its work with the guest powers it was
given, and dismisses handled messages. The daemon does not require or inspect a
bot-specific method such as `start`.

`provideHost` and `provideGuest` both accept the shared `MakeAgentOptions`
surface:

```ts
export type MakeAgentOptions = {
  agentName?: string | string[];
  introducedNames?: Record<string, string>;
  pins?: EndoDirectory;
  networks?: EndoDirectory;
};
```

The supplied `pins` value must be a daemon-minted directory. If omitted, a new
directory is formulated. For a guest, this selected directory becomes
`guestPins` and is visible as `@pins`. The guest may therefore add or remove its
own durable services without receiving the host's root `@pins` authority.

Each guest should pin its own responder formula. Reusing one responder formula
identifier across guests would reuse one memoized incarnation and combine their
authority in one process. The generic pin mechanism deliberately does not add a
guest-specific distinctness rule; deployments that want one process per guest
formulate and pin one responder per guest.

### Wake on every mailbox delivery

All message paths converge on `mail.js` `deliver`. Within the serialized mailbox
job, delivery:

1. validates and persists the message formula;
2. persists the next mailbox number;
3. adds the stamped message to the in-memory mailbox;
4. calls `reincarnateMailboxPins`; and
5. publishes the message-received notification.

`reincarnateMailboxPins` follows the mailbox handle to its agent formula. For a
guest, it opens both `guestPins` and `hostPins`, takes an atomic snapshot of each
directory's immediate values with `NameHub.listValues()`, and provides every
value. Nested `Promise.allSettled` calls isolate failures at both the directory
and retained-value levels.

The wake runs on every delivery, not once per daemon process. That distinction
is load-bearing: a responder's worker may be canceled while the daemon remains
up. The next message then re-provides the pinned formula before the notification
is published. When the responder is already live, `controllerForId` returns the
memoized incarnation.

Local delivery, remote delivery, and the sender-side copy of outgoing mail all
use this path. A responder must therefore tolerate its own outgoing copies and
dismiss or deduplicate them according to its application protocol.

### Restart and replay behavior

The daemon does not eagerly scan every retained mailbox at startup. A pinned
responder remains cold after restart until the guest receives another message
or some caller explicitly looks it up. On that delivery, the pin is provided
before the live notification, and the newly incarnated responder's
`followMessages()` subscription exposes the retained mailbox snapshot followed
by later messages.

This makes startup cost independent of the number of provisioned guests and
avoids a worker stampede after restart. It also means retained mail by itself is
not a startup trigger. A deployment that requires eager processing without a
new message needs a separate scheduler or explicit lookup.

Mailbox consumption remains at-least-once. A responder reincarnated after a
crash may observe retained work again, and snapshot/subscription interleavings
may expose the same durable entry more than once. Responders use the stable
mailbox number or message identifier for deduplication and make external effects
idempotent before dismissing the message. The daemon does not promise a
transaction spanning its mailbox and an arbitrary external service.

### Failure and policy

Pin reincarnation is best-effort. A stale pin, unavailable worker, or responder
construction failure does not reject the already-persisted delivery and does not
prevent other pins from being attempted. The message remains durable, and a
later delivery attempts the pins again.

The generic mechanism intentionally has no daemon-level bot state machine. In
particular, it adds no:

- `EndoBot` readiness or stopped-result protocol;
- timed retry or exponential backoff;
- crash-loop, credential, admission, or operator breaker;
- `getBotStatus`, `stopBot`, or `retryBot` host methods; or
- startup scan for mail retained before the current daemon process.

A responder or its deployment owns those policies. It can map credential or
provider failures to its own durable state, enforce admission before external
work, and choose whether to remain live, exit, or wait for another signal. Endo
provides only the durable formula, retention edge, mailbox, and message-triggered
reincarnation.

### Retention and decommissioning

The guest formula retains both pin directories. A pin directory in turn retains
the formula identifiers stored in it. This is ordinary formula-graph retention,
not guest provisioning: reincarnating a responder does not call `provideGuest`,
mint another guest, add a child name, or consume another retained-child quota
slot.

Removing the responder from `@pins` decommissions wake-on-message for that
responder. Once no other reachable path retains it, its formula can be
collected. Because the guest owns `@pins`, it can remove its own responder; a
deployment that requires a relationship the guest cannot remove needs a
host-controlled way to populate the guest's host-only pin directory, which is
not part of the caller-elected `pins` surface.

Formula records do not change in place when a pin is added or removed. The
directory's mutable name-to-identifier mapping changes, while the formulas that
constitute the append-only graph remain fixed.

## Compatibility and Migration

The `guestPins` and `hostPins` formula fields are optional, and mail delivery
treats their absence as an empty pin set. Existing guests therefore keep their
prior behavior.

Wake-on-message is selected when a new guest is provisioned with a pin directory
and a responder is retained in it. `provideGuest` remains get-or-create: passing
new options for an already-named guest does not rewrite that guest's formula.
Migrating an existing guest to caller-elected pins still requires explicit
reprovisioning or another future migration mechanism.

## Verification

The landed implementation carries focused and integration coverage:

1. `packages/daemon/test/mail-pins.test.js` verifies that delivery provides both
   guest pin directories, provides host pins, isolates a retained formula that
   rejects, and accepts old guests with no pin directories.
2. `packages/daemon/test/endo.test.js` provisions an auto-responder in a
   caller-elected guest pin directory and verifies that the next message revives
   it after worker cancellation.
3. The same integration suite restarts the daemon and verifies that a later
   message revives a fresh responder incarnation without an explicit lookup.
4. Both integration cases verify that the responder acknowledges and dismisses
   the triggering message.

## Affected Packages

- `packages/daemon/src/types.d.ts`: `guestPins`/`hostPins`, `MakeAgentOptions`,
  and `NameHub.listValues()`.
- `packages/daemon/src/host.js`: validation and selection of caller-provided
  `pins` and `networks` directories.
- `packages/daemon/src/manager.js`: guest pin-directory formulation and formula
  edges.
- `packages/daemon/src/guest.js`: the guest-visible `@pins` special name.
- `packages/daemon/src/mail.js`: `reincarnateMailboxPins` and the per-delivery
  wake.
- `packages/daemon/src/formula-record.js`: formula-inspector references.
- `packages/daemon/test/mail-pins.test.js` and
  `packages/daemon/test/endo.test.js`: focused and end-to-end coverage.

## Design Decisions

1. **Use generic pins instead of a `GuestFormula.bot` edge.** A pin directory
   already expresses durable retention and can contain any number of services.
   It avoids a second formula edge and a bot-only protocol.
2. **Wake pins before publishing every new-message notification.** This repairs
   both restart gaps and mid-life worker cancellation without an eager startup
   scan.
3. **Keep reincarnation best-effort.** Responder health must not turn durable
   message acceptance into an apparent send failure.
4. **Keep bot policy above the daemon.** Credential recovery, admission,
   backoff, status, and quotas vary by deployment and do not belong in the
   generic mailbox primitive.
5. **Expose a guest-owned pin directory and retain a distinct host-only one.**
   The guest can manage its own services without receiving the host's root pin
   authority, while the formula shape leaves room for daemon-owned relationships
   that the guest cannot remove.

## Deferred Work

- A host surface for populating a guest's host-only pin directory, if a
  deployment needs a non-removable responder relationship.
- An explicit migration path for attaching caller-elected pins to an existing
  guest without changing guest identity.
- Consumer-specific supervision, circuit breaking, credential recovery, and
  admission reporting.
- Durable mailbox acknowledgments or exactly-once integration protocols.

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
