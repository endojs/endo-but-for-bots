# @endo/reminder

An unconfined Endo plugin that **schedules messages**. A reminder service
produces messages on various schedules — start-to-start periods — and nothing
else. Policy about *what to do* on a schedule belongs to the recipient; this is a
message scheduler, not a general cron facility.

It carries the scheduling mechanism of the superseded
[`endoclaw-timer`](../../designs/endoclaw-timer.md) /
[`endo-reminder`](../../designs/endo-reminder.md) design — start-to-start timing,
a one-shot per-message response, resolve/reschedule with jittered exponential
backoff, per-message timeout auto-resolve, host-controlled limits,
pause/resume/revoke, and startup recovery with missed-message coalescing —
repackaged as an unconfined plugin whose durable tracking lives on the platform
**virtual file system** rather than a host file system.

## What it is

- **An unconfined plugin, not a daemon formula.** The module exports the standard
  unconfined-caplet maker `make(powers, context, { env })`, provisioned through
  the daemon's generic pathway. There is no new formula type.
- **Persistence is a virtual-file-system capability, backing-agnostic.** The
  plugin depends only on the reconciled writable-tree verbs of
  [`@endo/platform/fs/extended`](../platform) (`lookup`, `list`, `write`,
  `makeDirectory`, `remove`, `move`), so the backing may be a host directory, an
  in-memory tree, a daemon mount, or a database — a backend swap, not a plugin
  change. There is no `node:fs` and no daemon `filePowers`.
- **Delivery is ordinary guest package mail addressed to `@self`.** Each firing
  is sent through the tenant guest's existing `send` method as a self-addressed
  package message carrying a single **capability-free JSON string** (the
  `minion-reminder/v1` schema) and no attached values. The plugin drives the
  one-shot response from the send outcome — `resolve()` only after the send
  fulfills, `reschedule()` after a send failure — so the ephemeral response
  never enters the mailbox. It retains no durable capability, adds no
  `reminder-recipient` formula, and does not modify `EndoHandle`. The consumer
  reads a filtered, deduplicated **projection** of its own mailbox, keyed by
  `{ reminderId, messageNumber }`.

## Provisioning

`make` resolves everything it needs by name through the agent-shaped `powers`
granted at provisioning; it holds no ambient authority beyond the Node worker it
runs in.

- `E(powers).lookup('reminder-store')` -> a writable virtual-file-system
  **directory** backing the durable store.
- `E(powers).send('@self', [payload], [], [])` -> ordinary guest package mail.
  Each reminder message is delivered as a self-addressed package message carrying
  a single capability-free JSON string and no attached values. The guest is its
  own recipient; the plugin holds the one-shot `ReminderResponse` internally and
  never serializes it. No `reminder-recipient` name is looked up.

Initial `maxActive` / `minPeriodMs` (and an optional initial `paused: 'true'`)
arrive via the `env` option of `makeUnconfined`; thereafter `ReminderControl`
adjusts them and the durable store persists them, so the **store — not `env` — is
authoritative** across restarts.

```
E(host).makeUnconfined(workerName, '@endo/reminder', {
  powersName,                       // a guest granting reminder-store + self-addressed mail
  resultName: ['@pins', 'reminder'], // pin it so it wakes on restart (see below)
})
```

## The `@pins` recipe (wake-on-restart)

A plugin caplet wakes on daemon restart **if and only if something retains its
identifier in a reviving collection.** The daemon eagerly revives exactly one
collection at boot — the `@pins` directory (`revivePins()`) — and everything else
revives lazily on demand. So retention is integration-owned and, for now,
user-driven:

1. **Pin the reminder service** when you provision it: pass
   `resultName: ['@pins', 'reminder']` to `makeUnconfined` (or `storeIdentifier`
   the result into `@pins` afterward).
2. On the next boot, `revivePins()` provides the identifier, the worker
   incarnates the plugin, and `make()` runs recovery: it reads `config.json` and
   `reminders/`, coalesces or skips the messages missed while the daemon was
   down (per each reminder's `catchUpPolicy`), re-arms the timers, and resumes
   delivery.
3. **Unpinning decommissions.** Remove the pin and the scheduler does not wake
   next boot; its durable store remains until you delete it.

The Familiar app and the online Gateway may each own this retention automatically
for their deployments later; daemon core gains no reminder-specific revival logic
either way.

## Facets

`make()` returns a `ReminderService` exo that hands out the two caretaker facets:

- **`ReminderScheduler`** (agent-facing), via `E(service).scheduler()`:
  - `makeReminder(label, periodMs, opts?)` -> `Reminder`
  - `list()` -> reminder entries
  - `help()`
- **`ReminderControl`** (integration-facing), via `E(service).control()`:
  - `setMaxActive(n)`, `setMinPeriodMs(ms)`, `pause()`, `resume()`, `revoke()`,
    `listAll()`, `help()`

Each `Reminder` exposes `label` / `period` / `setPeriod` / `cancel` / `info` /
`help`.

`makeReminder` options:

| Option | Default | Meaning |
|---|---|---|
| `firstDelayMs` | `0` | Delay before the first message. |
| `messageTimeoutMs` | `periodMs / 2` | Per-message response deadline; on no response the message auto-resolves and the schedule continues. |
| `catchUpPolicy` | `'coalesce'` | How messages missed while down are treated on recovery: `coalesce` (one catch-up message spanning the gap) or `skip` (drop stale messages — right for a "still alive?" heartbeat). |
| `annotation` | `'count'` | What a coalesced message conveys: a `count` (`{ kind: 'count', count }`) or the `timestamps` it stands in for (`{ kind: 'timestamps', scheduledTimes }`). |
| `backoff` | see below | Reschedule backoff `{ initialMs, maxMs, multiplier, jitterFraction }`. |

## Reschedule backoff

When the delivery callback calls `reschedule()` after a send failure, the service
re-delivers the *same* message after a jittered exponential backoff and holds the
give-up deadline fixed at the original scheduled time + `messageTimeoutMs`, so a
retry budget cannot drift the schedule forward. The backoff parameters are named
and **persisted per reminder** (with `consecutiveFailures`), so backoff state
survives a restart. The defaults reproduce
`min(1000, periodMs / 10) * 2 ** n`, clamped to `messageTimeoutMs`, with a 10%
full-jitter band that de-synchronises retries when several reminders co-fail
against one downstream ("Exponential Backoff and Jitter", AWS).

## The delivered message

The in-memory message the scheduler core hands the delivery callback carries the
ephemeral one-shot response:

```js
{
  type: 'reminder-message',
  reminderId, label, periodMs,
  messageNumber,       // 1-based count of deliveries
  scheduledAt,         // absolute epoch ms this message was scheduled for
  actualAt,            // absolute epoch ms it actually fired
  missedMessages,      // messages coalesced into this one (0 for a normal firing)
  annotation,          // { kind: 'count', count } | { kind: 'timestamps', scheduledTimes }
  reminderResponse,    // one-shot exo: resolve() | reschedule() — never serialized
}
```

`resolve()` arms the next period; `reschedule()` retries the same message after
the backoff. Both are one-shot — whichever fires first consumes the delivery, and
any later call (including after the timeout auto-resolved) is inert.

### The package-mail payload

Only the capability-free `minion-reminder/v1` fields are serialized into the
self-addressed package message; `type` and `reminderResponse` are dropped
(`encodeReminderMessage`, `src/mail.js`):

```json
{
  "schema": "minion-reminder/v1",
  "reminderId": "…", "label": "…", "periodMs": 30000,
  "messageNumber": 1, "scheduledAt": 0, "actualAt": 0,
  "missedMessages": 0, "annotation": { "kind": "count", "count": 1 }
}
```

The consumer reads its own mailbox and calls `projectReminderEvents(messages)` to
get a deduplicated event list keyed by `{ reminderId, messageNumber }`, so a
retry after an ambiguous send outcome — which can leave two identical package
messages in the mailbox — projects to exactly one event. `decodeReminderPackage`
rejects any message that carries attached values, so only capability-free
reminder mail is ever projected.

## Durable store layout

```
reminder-store/
  config.json          # { maxActive, minPeriodMs, paused }
  reminders/
    <id>.json          # one document per reminder; nextTickAt is absolute epoch ms
```

Atomic replacement is **write-then-`move`** within one directory: a value is
written to a `.tmp.<id>` sibling and then `move`d onto the final name. The plugin
**requires atomic within-directory `move`** of the backing as a store contract;
it does not rely on a direct `write` being atomic, since that varies by backing.

## Status

The package and scheduler core, delivery and response over ordinary guest
package mail addressed to `@self`, the `minion-reminder/v1` package-message
encoding with its deduplicated mailbox projection, and integration/revival via
the `@pins` recipe. This is the delivery contract the minion.town, Chat, and
Familiar consumers build on (design decisions 1–2, kriskowal 2026-08-13); it
needs no `reminder-recipient` formula, no `EndoHandle` change, and no SturdyRef
modelling.
