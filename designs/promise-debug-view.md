# Promise Debug View

| | |
|---|---|
| **Created** | 2026-07-12 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Not Started |
| **Source** | [endojs/endo-but-for-bots#169 review](https://github.com/endojs/endo-but-for-bots/pull/169#pullrequestreview-4680376639) (inline comment on `designs/pass-style-promise.md`); tracked by [#716](https://github.com/endojs/endo-but-for-bots/issues/716) |

## What is the Problem Being Solved?

The [pass-style-promise](pass-style-promise.md) design establishes a
rejection-retention principle: when a producer rejects a pass-style
promise that no listener has attached to yet, the rejection is
**retained on the producer's record** and delivered to the first
listener that arrives, rather than either eagerly thrown to the
host's unhandled-rejection path or silently swallowed. Both of the
obvious answers are wrong: eager surfacing produces spurious noise for
a promise still in transit, and swallowing produces silent failures.

Borrowed vocabulary, from the parent design and used unchanged here: a
**carrier** is a pass-style promise; the **producer** is the party that
holds the carrier's private `resolver` and alone may settle it; a
**listener** attaches to the carrier through `HandledPromise.listen`,
`HandledPromise.settle`, or `E.when` to receive the settlement; and
**retention** is the parent's rule that a rejection with no listener yet
is held on the producer's record until the first listener arrives. This
recap is a reader's aid only; the [pass-style-promise](pass-style-promise.md)
design is the authority for each term.

Retention is the right runtime behavior, but it opens an observability
gap. A rejection that is retained and then **never delivered** (because
a listener never arrives, or the carrier is dropped in transit) is
now invisible: by design there is no production log line, so a real bug
that would previously have shown up as an unhandled rejection leaves no
trace. The same gap covers two neighboring conditions that retention
does not address at all:

- **Long-pending** promises: a carrier that has stayed unsettled far
  longer than expected (a producer that forgot to resolve, a chain
  waiting on a hop that will not come).
- **Forever-pending** promises: a carrier that is garbage-collected
  while still unsettled, so it provably can never settle. This is the
  same never-settles idiom as `new Promise(() => {})` used as a token,
  now expressed as a dropped pass-style carrier.

A debugger needs to see all three conditions **in transit**, without
reintroducing the per-hop noise the retention principle exists to
avoid. This design specifies a bounded, opt-in **debug-view ring
buffer** that makes the "neither swallow nor eagerly throw" state
observable to a debugger while staying invisible and near-zero-cost in
production.

This is the forward-looking follow-up recorded under "Out of Scope,
Future Work -> Debug view for long-pending and unlistened-rejection
promises" in [pass-style-promise](pass-style-promise.md), promoted to
its own design per the maintainer's request on the PR #169 review
("And we should post a plan to create that design"). It **layers on**
the retention contract specified there; it does not restate or modify
it.

## Design

### What the debug view observes

The debug view is a bounded, in-memory record of carriers that entered
one of three diagnostic conditions:

| Category | Condition | Signal source |
|---|---|---|
| `unlistened-rejection` | `resolver.reject(reason)` was called while the carrier had no listener. | The retention path already records this on the producer record; the debug view mirrors it. |
| `long-pending` | The carrier is still unsettled at inspection time and older than a threshold age. | Classified lazily at inspection time from a creation timestamp, not from a background timer. |
| `forever-pending` | The carrier was finalized (garbage-collected) while still unsettled. | A `FinalizationRegistry` callback, GC-driven, no timer. |

The design deliberately introduces **no periodic sweep and no timer**.
Each category is fed by an event that already happens (a reject call, a
GC finalization) or is computed on demand when a debugger asks. Nothing
wakes the process up on the debug view's behalf, so an idle production
process pays nothing for it beyond the disabled-path guard below.

### Entry shape

Each ring-buffer entry is a plain record:

| Field | Value |
|---|---|
| `id` | A monotonic serial identifier assigned at `makePromise()` time. It is the entry's correlation key and survives the carrier's collection (see below). |
| `category` | One of the three categories above. |
| `createdAt` | Turn counter or wall-clock stamp captured at `makePromise()` time. |
| `recordedAt` | When the entry entered the buffer (reject time, or finalization time). |
| `label` | An optional producer-supplied diagnostic string. Absent when the producer supplied none — never back-filled with a generated value, so a reader can always tell producer text from the system `id`. |
| `reason` | For `unlistened-rejection`: the retained rejection reason, held by value. Absent for the other categories. |
| `delivered` | For `unlistened-rejection`: set true once the first listener arrives and the reason is delivered. |
| `carrierRef` | A `WeakRef` to the carrier, so the buffer never keeps a carrier alive. Present only for correlation while the carrier is still alive; it dereferences to `undefined` after collection, which is why `id`, not `carrierRef`, is the correlation key. |

`id` is the stable identity the view correlates on across a carrier's
whole lifetime. `carrierRef` is a *reference* to the carrier, useful for
liveness checks while the carrier exists, but its referent is exactly
what has become unreachable when the `FinalizationRegistry` callback
fires — the one site where cross-event correlation matters most (a
`forever-pending` finalization that must find that carrier's earlier
`unlistened-rejection` entry). The serial `id` is therefore threaded as
the `FinalizationRegistry` heldValue and stored on every entry, so the
callback can look up the prior entry by `id` without dereferencing a
`WeakRef` that no longer resolves.

The buffer holds the carrier **weakly** (`carrierRef`) so that the
debug view cannot itself keep a promise alive, which would both leak
memory and mask the `forever-pending` signal it is trying to surface.
The one value it holds **strongly** is the retained `reason` for an
`unlistened-rejection` entry, because that reason is exactly what the
debugger wants to read. Strong retention of reasons is bounded by the
ring capacity: at most `N` reasons are held, and an evicted entry
releases its reason.

### Ring-buffer semantics

The buffer is a fixed-capacity FIFO of the most recent `N` entries
(default `N` chosen small, on the order of a few dozen to a few
hundred; configurable per the env-option below). When full, adding an
entry evicts the oldest. A `forever-pending` entry may replace a
`long-pending` view of the same carrier — correlated by `id`, since the
carrier itself is gone (the carrier settled the question by being
collected); the two are the same carrier at different lifecycle points,
not two independent findings.

### When entries are recorded

```mermaid
flowchart TD
  MK["makePromise() with<br/>debug view enabled"] --> REG["assign serial id;<br/>stamp createdAt;<br/>register carrier in weak live-set<br/>+ FinalizationRegistry (heldValue = id)"]
  REG --> RJ{"resolver.reject(reason)?"}
  RJ -->|"no listener yet"| UR["record unlistened-rejection entry<br/>(hold reason by value)"]
  RJ -->|"listener present"| DONE["ordinary delivery,<br/>no debug entry"]
  UR --> FS{"first listener arrives?"}
  FS -->|"yes"| MARK["mark entry delivered<br/>(runtime's own listener-arrival hook)"]
  FS -->|"never, then GC"| FP1["FinalizationRegistry:<br/>reason never delivered<br/>(find prior entry by id)"]
  REG --> GC{"carrier finalized<br/>while unsettled?"}
  GC -->|"yes"| FP["record forever-pending entry"]
  INSPECT["debugView() called"] --> LP["walk weak live-set;<br/>bucket unsettled carriers<br/>older than threshold as long-pending"]
```

- **At `makePromise()`** (only when the flag is enabled): assign a
  serial `id`, stamp `createdAt`, add the carrier to a weakly held
  live-set, and register it with a `FinalizationRegistry` whose
  heldValue is the `id`. No visible entry yet.
- **At `resolver.reject(reason)` with no listener**: the retention
  logic (already specified in the parent design) records the reason on
  the producer record; the debug view additionally appends an
  `unlistened-rejection` entry keyed by the carrier's `id`.
- **At first-listener arrival**: the entry is marked `delivered`. This
  correlation is not free — see "First-listener arrival plumbing"
  below.
- **At finalization** of an unsettled carrier: the
  `FinalizationRegistry` callback (which receives the carrier's `id` as
  its heldValue) appends a `forever-pending` entry and looks up any
  prior `unlistened-rejection` entry for that same `id`. If one exists
  and is not `delivered`, that neighboring fact is the highest-signal
  bug the view can report: a rejection that was retained and can now
  never be delivered.
- **At inspection time**: `long-pending` is computed by walking the
  weak live-set and bucketing still-unsettled carriers whose
  `createdAt` is older than the threshold. Nothing is recorded eagerly
  for this category.

### First-listener arrival plumbing

Marking an `unlistened-rejection` entry `delivered` requires the debug
view to learn when the *first* listener attaches to a carrier. The
parent design's `onFirstListen` is **not** an always-on runtime signal
the view can pick up for free: it is an **optional, single callback the
producer supplies in `makePromise()`'s options bag**, invoked only if
the producer registered one, and the options bag has room for exactly
one. Relying on it would mark `delivered` on only the subset of entries
whose producer happened to pass `onFirstListen`, missing every other
unlistened-rejection entry.

So when the debug view is enabled, the runtime registers **its own**
first-listener hook per carrier at `makePromise()` time, alongside (and
independent of) any producer-supplied `onFirstListen`. Both fire on the
same first-listener transition the resolver already tracks internally;
the debug view's hook is additional plumbing the runtime owns, not a
free ride on the producer's optional callback, and it must compose with
a producer-supplied `onFirstListen` rather than displace it (the
producer's callback still fires with its documented fire-once,
producer-scoped contract). This added hook is why Phase 2 below is
sized **M**, not **S**.

### Inspection surface

A debugger reads the buffer through a diagnostic accessor that returns
a **frozen snapshot** — a hardened record carrying both the enabled
state and a hardened array of plain entry records, never the live
buffer and never the resolvers:

```js
/**
 * Returns a hardened snapshot { enabled, entries }. `entries` is an
 * array of the current debug-view records, most recent last, plus
 * lazily classified long-pending entries; each is a plain copy (id,
 * category, createdAt, recordedAt, label?, reason?, delivered?); no
 * carrier, resolver, or listener handle escapes. When the debug view
 * is disabled, `enabled` is false and `entries` is empty, so a caller
 * can distinguish "turned off" from "on and nothing to report".
 */
HandledPromise.debugView = () => { /* ... */ };
```

The `{ enabled, entries }` shape exists so a debugger who forgot to set
`ENDO_PROMISE_DEBUG_VIEW=enabled` sees `enabled: false` rather than an
empty array indistinguishable from a healthy, enabled process with
nothing to report.

The accessor is a **host-side diagnostic power**, not a passable
capability. It is not marshaled, does not cross a cap boundary, and
exposes only copies and labels. It is reachable by whoever holds the
`HandledPromise` intrinsic in the debugging realm, the same audience
that holds `listen`/`settle`. Exposing it (its home, and whether it
is gated behind the same permit machinery as the parent design's new
`HandledPromise` methods) is Open Question 1.

The producer may attach a `label` when it constructs the carrier so
that entries are legible in the snapshot:

```js
const { promise, resolver } = makePromise({ label: 'kref:p-42' });
```

The option is named `label` — the same name it reads back as in the
snapshot, so the round trip through `debugView()` is consistent. It is
inert when the debug view is disabled and is the only addition this
design makes to the `makePromise()` options bag.

### Production cost and gating

The debug view is **opt-in and off by default**, following the same
`@endo/env-options` pattern the parent design uses for
`ENDO_PROMISE_DELEGATES` (and that `TRACK_TURNS`, `DEBUG`, and the
marshal message-breakpoints options use):

```js
import { getEnvironmentOption } from '@endo/env-options';

const PROMISE_DEBUG_VIEW =
  /** @type {'disabled' | 'enabled'} */
  (getEnvironmentOption(
    'ENDO_PROMISE_DEBUG_VIEW',
    'disabled',
    ['enabled'],
  )) === 'enabled';
```

When `PROMISE_DEBUG_VIEW` is `disabled`:

- `makePromise()` does not assign a serial id, does not stamp a
  timestamp, does not register a `FinalizationRegistry` entry, does not
  register the first-listener hook, and does not touch the live-set or
  the buffer.
- The reject path's **retention behavior is unchanged** (that is the
  parent design's always-on contract); only the *extra* ring-buffer
  append is skipped.
- `HandledPromise.debugView()` returns `{ enabled: false, entries: [] }`.

The guard is a single boolean read on the hot paths, so the disabled
cost is a branch, not an allocation. This is what "inspectable while
debugging without producing noise in production" means concretely: the
signal goes into a bounded in-memory ring a debugger reads on demand,
never onto the host's console or unhandled-rejection path, and the ring
is not even populated unless the flag is set.

### Native promises

Full fidelity is available only for **pass-style promises**, because
the three signals depend on producer-side machinery the platform does
not expose for native promises: there is no producer-side
listener-arrival hook on a native `Promise`, and its resolver is
closed over at construction. Native promises are covered
**opportunistically**: a native promise (or `HandledPromise`) that
flows through `HandledPromise.listen` / `HandledPromise.settle` is
visible at that point and MAY be registered for `long-pending` /
`forever-pending` tracking there. Native rejections that are eagerly
thrown are already covered by the host's own unhandled-rejection
tooling and are out of scope here. The precise extent of native-promise
coverage is Open Question 3.

## Reconciliation with the Pass-Style-Promise Contract

This design **layers on** [pass-style-promise](pass-style-promise.md);
it re-specifies none of that contract. The load-bearing reuses:

- **Rejection retention** (parent's "do not surface rejections to
  unlistened promises"): the debug view is the *observability* layer
  over the retention state that already exists. It reads the same
  retained-reason record and does not change the rule that a rejection
  with no listener is held, not thrown and not swallowed. The debug
  view never causes an eager throw and never suppresses a delivery.
- **First-listener transition** (parent's "Producer-side first-listen
  notification"): the debug view marks an `unlistened-rejection` entry
  `delivered` on the same once-per-carrier first-listener transition
  the resolver already tracks internally. It does **not** ride the
  producer's optional `onFirstListen` callback — that hook is
  producer-supplied and may be absent — but registers its own
  runtime-owned listener-arrival hook (see "First-listener arrival
  plumbing"), composing with rather than displacing any
  producer-supplied `onFirstListen` and leaving that callback's
  fire-once, producer-scoped contract unchanged.
- **Fire-once settlement** (parent's Open Question 3 resolution):
  because settlement is final, an entry's lifecycle is monotonic
  (pending -> settled/delivered, or pending -> finalized); the buffer
  never has to reconcile a resettled carrier.

## Dependencies

| Design or issue | Relationship |
|---|---|
| [pass-style-promise](pass-style-promise.md) | Parent design. This one implements the "Debug view" future-work item and layers on its rejection-retention and first-listener (`onFirstListen`) contracts. Not blocked-by in the build sense: the debug view can only land after the retention path exists, so it sequences **after** the parent's Phase 3. |
| [endojs/endo#1312](https://github.com/endojs/endo/issues/1312) | The `new Promise(() => {})` never-settling token idiom the `forever-pending` category makes visible once expressed as a dropped pass-style carrier. |
| [endojs/endo#1652](https://github.com/endojs/endo/issues/1652) | Source of the `listen`/`settle` primitives whose first-listener transition the `delivered` marking rides. |
| [endojs/endo-but-for-bots#172](https://github.com/endojs/endo-but-for-bots/issues/172) | The `Promise[Symbol.for('delegate')]` follow-up; if the debug view is exposed as a delegate-adjacent op, it should compose with that surface rather than duplicate it (Open Question 1). |

## Phased Implementation

The debug view sequences after the parent design's Phase 3
(eventual-send integration), because the retention path and the
`listen`/first-listener transition it reads must exist first.

1. **Ring buffer and env-option (S).** The bounded FIFO, the
   `ENDO_PROMISE_DEBUG_VIEW` gate, the disabled-path guards, the serial
   id allocator, and `HandledPromise.debugView()` returning a frozen
   `{ enabled, entries }` snapshot. Unit tests for capacity, eviction,
   the disabled no-op, and the `enabled` flag.
2. **Unlistened-rejection recording (M).** Append on `resolver.reject`
   with no listener; register the runtime's own first-listener hook per
   carrier (composing with any producer-supplied `onFirstListen`) and
   mark `delivered` on first-listener arrival. Test the retained-reason
   mirror, the delivered transition against the parent's retention
   tests, and that `delivered` is marked even when the producer supplied
   no `onFirstListen`.
3. **Long-pending classification (XS).** Weak live-set walk at
   inspection time with a configurable threshold. No timer.
4. **Forever-pending via FinalizationRegistry (S).** Register at
   `makePromise()` with the serial `id` as heldValue, append on
   finalization of an unsettled carrier. Test the composite headline
   case explicitly: an `unlistened-rejection` entry whose carrier is
   GC'd before any listener arrives must, on finalization, be
   correlated by `id` to a `forever-pending` entry flagged as a
   never-delivered retained rejection — the highest-signal bug the view
   exists to report. GC-driven tests are inherently non-deterministic;
   gate them behind an explicit-`gc()` harness where available, else
   document as best-effort.
5. **SES permit (XS).** If `HandledPromise.debugView` lands on the
   `HandledPromise` intrinsic, add it to the `HandledPromise` permit
   entry in `packages/ses/src/permits.js`, the same two-line shape the
   parent design's Phase 3.5 uses for `listen`/`settle`. Resolving
   Open Question 1 decides whether this phase applies.
6. **Docs (XS).** A `NEWS.md` note and a short "debugging retained
   rejections" section cross-linked from the parent design.

## Design Decisions

1. **No background timer or sweep.** Every category is either
   event-driven (reject, finalization) or computed on demand
   (long-pending at inspection). This is what keeps an idle production
   process at zero incremental cost and honors "without producing noise
   in production" literally: nothing periodic runs.
2. **Weak carrier references, stable serial id for correlation.** The
   buffer must not keep carriers alive (it would mask `forever-pending`
   and leak memory), so carriers are held via `WeakRef`. Because a
   `WeakRef` cannot be dereferenced once the carrier is collected —
   exactly when the finalization callback needs to find that carrier's
   earlier entry — correlation across a carrier's lifetime is keyed on a
   monotonic serial `id` (threaded as the `FinalizationRegistry`
   heldValue), not on the reference. Retained reasons are held strongly
   because they are the payload the debugger needs, and the ring
   capacity bounds how many are retained.
3. **Producer `label` and system `id` are separate fields.** A
   producer-supplied diagnostic string (`label`) and the
   system-generated correlation identifier (`id`) never share one field
   or value space, so a snapshot reader always knows whether a value is
   free-form producer text or a generated id. A carrier with no `label`
   simply omits it rather than borrowing the `id`.
4. **Snapshot, not live buffer.** The inspection surface returns
   hardened copies so a debugger cannot mutate runtime state or reach a
   resolver, listener, or carrier through the debug view.
5. **Diagnostic power, not passable capability.** `debugView()` is
   host-side and never marshaled; it exposes labels and copied reasons,
   never handles that would leak authority across a cap boundary.
6. **Off by default, opt-in via env-option.** Reuses the parent
   design's `@endo/env-options` idiom for consistency and for a
   diagnosable on/off toggle.

## Open Questions

1. **Where does the inspection surface live?** `HandledPromise.debugView`
   (paired with `listen`/`settle`, and permit-gated the same way),
   a separate `@endo/pass-style` debug export, or a devtools-only
   global installed at a registered symbol adjacent to the
   `Promise[Symbol.for('delegate')]` direction in
   [#172](https://github.com/endojs/endo-but-for-bots/issues/172)?
   The parent design put `listen`/`settle` on `HandledPromise`; the
   symmetry argues for `HandledPromise.debugView`, but a purely
   diagnostic accessor arguably does not belong on the same intrinsic
   as the operational primitives.
2. **Default capacity and long-pending threshold.** What is a sensible
   default `N` for the ring, and what age (turns or milliseconds)
   counts as `long-pending`? Both are env-configurable, but the
   defaults should be chosen so the buffer is useful without being a
   memory concern when enabled.
3. **How far does native-promise coverage go?** Opportunistic tracking
   when a native promise passes through `listen`/`settle` is cheap;
   registering every native promise the process creates is not
   feasible and is the host tooling's job. Where exactly is the line,
   and does the design need a `HandledPromise.debugTrack(nativePromise,
   label)` opt-in for native promises a debugger cares about? If such an
   op lands, its name should follow the same convention as `debugView`
   (both read as `debug<Noun>`, or both recast to `debug<Verb>`) rather
   than pairing a noun-styled query with a verb-styled command.
4. **Should `forever-pending` entries fan out to a host hook?** The
   `FinalizationRegistry` signal for "a rejection was retained and can
   now never be delivered" is the highest-value bug the view surfaces.
   Is a ring-buffer entry sufficient, or should an *enabled* debug view
   also offer an opt-in callback (still off in production) so a test
   harness can fail loudly on a provably undeliverable retained
   rejection? This must not become the eager-throw the retention
   principle rejects; it would be a debug-only, explicitly armed hook.
5. **Turn counter vs. wall-clock for `createdAt`.** A turn counter is
   deterministic and reproducible across replays; wall-clock is more
   legible to a human reading a snapshot. The buffer could carry both.

## Prompt

Requested by kriskowal in the PR #169 review
([pullrequestreview-4680376639](https://github.com/endojs/endo-but-for-bots/pull/169#pullrequestreview-4680376639)),
as an inline comment on `designs/pass-style-promise.md` at the
future-directions paragraph:

> And we should post a plan to create that design.

The "that design" is the future-work item recorded in
[pass-style-promise](pass-style-promise.md) under "Out of Scope, Future
Work -> Debug view for long-pending and unlistened-rejection
promises":

> Per the rejection-retention principle in the Listening section, the
> right answer to "rejections in transit before any listener" is
> neither swallow nor eagerly throw. A future debug-view direction is a
> ring buffer of recent long-pending, forever-pending, and
> unlistened-rejection promises, inspectable while debugging without
> producing noise in production. This is its own design and is not
> blocked by the present one.
