# Worker Retention, Revocation, and the Batch-Flush Retention Root

| | |
|---|---|
| **Created** | 2026-08-16 |
| **Updated** | 2026-08-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

This is a **reassessment**, not a mandate to conclude. The daemon holds a
principled stance on retention and revocation. A design conversation (2026-08-16)
put that stance next to several adjacent systems (ocap-kernel / SwingSet, E,
Mathieu Hofman's no-orthogonal-persistence worker model) and surfaced one
concrete extension worth evaluating on its merits: a **batch-flush retention
root**. Each thread below either lands a recommendation or, where the
conversation left a genuine open question, lays out the alternatives precisely
enough for the maintainer to decide. "Not yet, because X" is an acceptable
outcome on any individual thread as long as the reasoning is explicit.

### Vocabulary and thread map

Three terms and a roadmap before the threads.

A **formula** is the daemon's durable, content-addressed recipe for a
capability: a small JSON record naming how to reconstruct one value from its
inputs (other formulas, referenced by identifier). **Incarnation** runs that
recipe to produce a live in-memory **value** (an exo seated in a worker). One
formula, incarnated, yields one value; drop the value and the formula can
reincarnate it from disk. The **formula graph** is the graph of formulas and the
labeled edges between them. A **formula identifier** is the cryptographic name of
a formula, and keeping it off guest-reachable surfaces is the load-bearing
confinement constraint of Thread 2.

A **host** facet is the trusted, fully authorized control surface. A **guest**
facet is the confined surface handed to less-trusted code: the host may
enumerate structure and resolve identifiers that the guest must never see.

The **batch-flush retention root** (Thread 5, the priority thread) is the one
concrete proposal under evaluation. While a batch of pipelined messages is in
flight, treat the batch's existence as a temporary garbage-collection root, so
the anonymous intermediate formulas minted to carry values through the pipeline
stay alive for exactly the batch's lifetime.

The five threads, in order:

1. **Kill-the-worker vs. surgical partition** (revocation): confirm
   kill-the-worker as the backstop for a direct reference already seated in a
   worker's heap.
2. **Ergonomic value-passing** (surface): pass a live value as a formula
   dependency without leaking a formula identifier. Achievable, and it needs
   Thread 5's liveness interval.
3. **Heap-pressure heterogeneity** (the test): a distributed liveness signal must
   be a protocol-level fact, never a local-GC-timing artifact.
4. **No-orthogonal-persistence worker model** (worker discipline): make the
   persistence and upgrade guarantee an explicit per-worker constraint; scope
   (do not solve) durable pending-promises.
5. **The batch-flush retention root** (priority): build it as a specialization of
   CapTP question/answer refcounting, bounded against crashed and adversarial
   peers.

Thread 4 precedes Thread 5 because the worker-discipline vocabulary it settles
(what "durable" means for a worker) is what Thread 5's liveness interval is
measured against.

### The recorded stance under reassessment

The daemon's current invariant: a value incarnated from a formula lives only as
long as some **name** keeps it reachable, whether a pet-store entry or transitive
reachability through other named formulas. Every daemon invocation sweeps
everything not reachable by name, and the sweep is enforced as **actual
revocation, not bookkeeping deletion**. If a worker process still holds a live
in-memory reference to a swept value, the sweep **kills the worker**, because
otherwise deleting the formula record would be cosmetic: the worker could keep
servicing calls on that capability regardless of what the daemon's graph says.

The two original defenses of this invariant:

- **(a)** It is the only way to get *real* revocation given a second,
  uncontrolled source of liveness truth: the worker's own heap. The daemon's
  formula graph is not authoritative over a reference a worker already holds
  directly in memory; killing the worker is the only lever that reaches it.
- **(b)** It is something a transcript-replay persistence model **cannot** give
  you at all: replay resurrects whatever the history contains, tracking past
  events rather than present reachability.

The mechanics already in the tree that this document builds on:

- **The formula graph** (`packages/daemon/src/graph.js`): formulas are nodes,
  static dependencies and pet-store entries are labeled edges, and union-find
  **groups** cluster mutually reachable formulas so that a root pins an entire
  dependency cluster, not a leaf ([daemon-retention-paths](daemon-retention-paths.md)).
- **Cross-peer retention edges** ([daemon-cross-peer-gc](daemon-cross-peer-gc.md),
  Complete): a one-way authoritative **retention set** per peer, streamed as
  microtask-consolidated `{ add, remove }` deltas
  (`retention-accumulator.js`, `EndoGateway.followRetentionSet`) and anchored on
  the peer's local agent ID via `retentionEdges: Map<agentId, Set<formulaId>>`.
  Remote-held formulas join union-find groups, so the local collector treats a
  peer's live handle as a GC root for the connection's lifetime. **Revocation is
  implicit**: the peer drops the handle, its collector emits a `remove`, the
  next delta carries it, the edge is removed, and the formula joins the next
  mark-and-sweep.
- **Disincarnation** (`cancelValue`, `manager.js`): drop the in-memory exo and
  abort ongoing work for an ID **without** removing the formula JSON; the next
  access reincarnates from disk. This is the *soft* form; the *hard* form is
  killing the worker whose heap holds a swept reference.
- **The name hub** ([ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md)):
  a durable `name -> (workerId, slot)` table that makes the durable unit of
  identity a *name binding* rather than a stateful code instance, so upgrade is
  succession plus rebinding rather than in-place code swap. `named` export
  descriptors resolve through the hub per-delivery; `worker-import` links pin the
  origin `(workerId, slot)` forever (EQ-stable). This is the same
  petname/edge-name distinction one layer down.
- **Admission control** ([daemon-xs-worker-metering](daemon-xs-worker-metering.md)):
  the supervisor delivers a message only when the worker's remaining budget
  exceeds the hard per-crank limit. *"Admission control eliminates embargo."*
  The relevant precedent for bounding an open retention root without buffering
  or rollback. (**Embargo** here means holding a message pending resolution
  before further delivery, as in three-party-handoff-style promise pipelining.)

## Thread 1: kill-the-worker vs. surgical partition

**Claim under test:** collapsing revocation to "kill the whole worker" is the
right trade against ocap-kernel / SwingSet-style surgical partition (dooming a
promise, or severing one importer's c-list edge to a presence while exporter and
other importers are unaffected), because partition imposes a
**pervasive-defensiveness tax** that is not practical to uphold across a real
program population.

### What the precedent actually says

SwingSet's kernel (and its MetaMask-lineage sibling `ocap-kernel`) does retain
heap references across vats and does get timely, fine-grained collection by
reference-counting over **c-lists** (the per-endpoint tables mapping local
slots to kernel objects). The GC is driven by explicit deliveries into each vat.
In `ocap-kernel`'s router the four GC delivery types are
**`deliverDropExports`** (a vat has no more in-heap references, so decrement the
kernel refcount), **`deliverRetireExports`** / **`deliverRetireImports`** (the
object is gone, so tombstone the slot so a later use fails *loudly* rather than
silently rebinding), and **`deliverBringOutYourDead`** (the vat-local finalizer
reap). This is a genuine **reference-counted distributed GC** at c-list
granularity, and it is what lets a kernel collect a cross-vat object precisely
when the last importer drops it. (The vocabulary is SwingSet/liveslots imported
verbatim, `VatOneResolution`, `bringOutYourDead`, and the discipline keeps three
GC domains strictly separate: kernel cross-vat refcount GC, per-vat liveslots GC,
and engine-level JS mark-and-sweep.)

But note *what* that machinery is for: it collects references that holders have
**voluntarily dropped** (`deliverDropExports` fires *because* the vat's own
finalizer observed the drop). Using the same c-list surgery to **involuntarily
sever** a still-held, still-working reference, revoking it out from under a
healthy holder, is a different act, and it is the act that imposes the tax. The
holder's vat is fine; its counterparty is fine; one previously working reference
just stopped. Nothing in ordinary distributed-object programming prepares a
program for that: every eventual-send already tolerates *"my counterparty died"*
(ordinary partial failure), but *"my counterparty is fine but this one edge went
bad"* is a failure class programs do not consistently defend against.

### Refinement: E does not sever single references at all

The decisive correction to the conversation's framing comes from E's actual
reference-state machine (Miller, Tribble & Shapiro, *Concurrency Among
Strangers* (2005), TGC/LNCS 3705, Fig. 5). A reference is UNRESOLVED or
RESOLVED{near, far, **broken**}, and the transition that breaks a remote
reference is **`partition`**, which is **collective, not per-reference**: *"once
a partition occurs, all references crossing in a given direction between two vats
break simultaneously,"* and stay broken even after the partition heals (the
*eventual-common-knowledge* mechanism; messages are fail-stop FIFO). **E has no
operation that severs one live inter-vat reference while its siblings survive.**
Revocation of a *single* authority in E is done not by breaking a reference but
by the **caretaker pattern** (first described by Redell (1974); formalized in
*Capability Myths Demolished* (2003), whose *forwarding facet* / *revoking facet*
coinages are the source of Endo's `Handle`/`HandleControl` facet split): the
holder is handed a forwarder, and dropping the forwarder makes the holder's
reference behave as an ordinary **broken reference**.

So the failure class the conversation worries about, *"a working reference just
went bad,"* is exactly the class that **neither E's partition (collective) nor
E's caretaker (holder sees a broken reference, so partition-shaped) ever
produces.** It is producible only by c-list surgery on a *direct* reference, and
it is un-prepared-for precisely because the mainstream ocap tradition never
exposes it.

Endo already has names for both of its own mechanisms here, and they are the
right lens. **Revocation-by-withdrawal** (the library's *"fourth revocation
mechanism,"* alongside inline caretakers, revocation lists, and expiry),
withdrawing a *formula* cascades into disincarnation of the live reference,
*"immediate, local, requires no distributed protocol,"* is the sweep; and
**cohort-destruction** is the kill-the-worker choice. The library frames
cohort-destruction as Endo's deliberate *position between two poles*: Waterken
(partition-blind, masks failure) and E (per-reference defensive). Endo lands at
**exposed per-cohort**: a *cohort* (a capability plus its transitive
live-reference dependencies) is destroyed collectively on partition, then
offered **reconstruction on demand** (the *"pass by construction"* property).
That is precisely kill-the-worker: collateral within the cohort,
partition-shaped failure at the boundary, reconstruction from formulas
afterward.

So the design axis is sharper than "kill-the-worker vs. partition." It is:

| Revocation mechanism | Failure the holder sees | Tax |
|---|---|---|
| Caretaker / revocable forwarder (E; Redell (1974); Endo `Handle`/`HandleControl`) | Broken reference, so **partition-shaped** | None beyond ordinary partial-failure handling, **but** requires the forwarder to have been interposed *at introduction time* |
| E `partition` (collective break of all refs between two vats) | Broken reference to **everything** across that boundary, so **partition-shaped** | None novel; it *is* ordinary partial failure |
| C-list surgery on a direct reference (involuntary single-reference sever) | *"A working reference just went bad,"* a **novel** failure class | Pervasive defensiveness, not upheld in practice |
| Kill the worker (Endo cohort-destruction) | Broken reference to **everything** that worker held, so **partition-shaped**; reconstruction on demand | Collateral damage to co-held capabilities |

### Conclusion (Thread 1): confirm, with a sharpened reason

The kill-the-worker choice is defensible, and the sharpened reason is stronger
than the original one. Both the caretaker and kill-the-worker collapse
revocation to partition-shaped failure; neither pays the pervasive-defensiveness
tax. The caretaker's precondition is that a forwarder was interposed **when the
reference was introduced**, which the daemon *cannot* guarantee for a reference
a worker **already holds directly in its own heap** (defense (a): the heap is a
second, uncontrolled source of liveness truth, and you cannot retroactively
interpose a caretaker on a slot already seated in someone else's memory). Given
that constraint, killing the worker is the only lever that reaches the direct
in-heap reference *without* introducing the novel failure class. Its distinctive
cost is **collateral** (everything else the worker legitimately held dies too),
and its distinctive benefit is that it needs no cooperation from the worker and
no forwarder to have been pre-positioned.

The honest residual: this argues for kill-the-worker **as the backstop for
already-seated direct references**, not as the *preferred* revocation path.
Where the daemon controls introduction, a caretaker/forwarder (revoke by
dropping a host-side forwarder, holder sees partition) is strictly better (no
collateral), and the daemon's own `named` edges through the name hub are already
this shape (rebinding a name reroutes without waking or killing a worker). The
recommendation is therefore: **prefer forwarder-mediated revocation wherever the
daemon mediates the introduction (named edges, host-side presences); keep
kill-the-worker as the only sound backstop for a direct reference already seated
in a worker's heap.** These are not in tension; they cover different reference
provenances. Design Decision 1 turns this into a fail-safe that records
provenance at grant time rather than rediscovering it at revocation time.

## Thread 2: ergonomic value-passing vs. hidden formula identifiers

**Want:** pass a live value directly as a dependency of a new formula and let it
stand for the formula identifier behind it, instead of first binding it to a pet
name only to satisfy the by-name construction API.

A worked example makes the ergonomic gap concrete. Today, to pass a live
`counter` value the guest already holds into a new `dashboard` formula, the guest
must name it first:

```js
// Today: bind-to-a-pet-name-first, only to satisfy by-name construction.
// `storeValue(value, petName)` is the host method that binds a live value to a
// pet name (arguments in that order; `types.d.ts:1556`).
await E(host).storeValue(counter, 'tmp-counter'); // mint a throwaway name
const dashboard = await E(host).makeRetainedValue({
  type: 'eval', // the RetainedValueSpec discriminant (chat-slot-slash-commands.md:242)
  source: dashboardSrc,
  codeNames: ['counter'], // the eval body's binding name for the endowment
  endowments: [['tmp-counter']], // a PetNamePath (`Name[]`), the name just minted
});
await E(host).remove('tmp-counter'); // NameHub.remove is variadic (types.d.ts:960)
```

```js
// Wanted: pass the live value directly, no throwaway name.
const dashboard = await E(host).makeRetainedValue({
  type: 'eval',
  source: dashboardSrc,
  codeNames: ['counter'],
  endowments: [counter], // the live presence stands for its formula dependency
});
```

**Hard constraint (Distributed Confinement; Miller & Shapiro, *Paradigm
Regained* (2003), §5; erights.org):** guests must **never** observe the daemon's
cryptographic formula identifiers. The object-capability model confines *because*
capabilities are **non-discretionary**: there are no principals and no ambient
namespace, so *"only connectivity begets connectivity"* (Miller, *An Ode to the
Granovetter Diagram* / the four ways to acquire a reference: Introduction,
Parenthood, Endowment, Initial Conditions). A formula identifier a guest could
serialize or print is an **ambient-authority channel** (the illicit "fifth way")
that lets authority be reconstituted without introduction, dissolving the formal
teeth confinement depends on. *Paradigm Regained*'s own resolution is that
**"behavior, not arrangement, does the confining"** (the Model-4
object-capability answer to the Lampson/Boebert confinement objection): the
confined subject's state holds *"only data and no capabilities,"* which is
exactly the property a leaked formula ID would break.

### The trusted-side seam exists, but the guest-facing rule is a tightening, not an already-uniform invariant

The resolution is that the value-to-formula-ID mapping is done **entirely on the
daemon's trusted side**, keyed off an object identity the guest's representation
cannot serialize. The daemon already has exactly this seam:

- Over the host-worker (and peer) CapTP boundary, a presence is seated in the
  **import/export tables** (`makeCapTPImportExportTables`,
  `packages/captp/src/captp.js`; `convertSlotToVal` / `convertValToSlot`). The
  guest holds an opaque **slot number scoped to its own c-list**, never the
  formula ID. The daemon side holds the export-table entry, and from it can
  resolve to the formula record.
- The daemon resolves *"which formula is this presence"* internally through the
  name hub / directory: `identify(...petNamePath)` returns the **formula
  identifier** (`packages/daemon/src/types.d.ts:943`; `packages/daemon/src/manager.js:2990`)
  and `locate(...petNamePath)` returns the **locator** (`types.d.ts:944`).
  `listRetentionPaths(locator)` *is* strictly **host-only, never on `EndoGuest`
  or the CapTP gateway** (`packages/daemon/src/interfaces.js:526`, inside
  `HostInterface`, which spans `:262-529`; absent from `GuestInterface` and from
  the separate `DiagnosticsInterface` at `:535-546`;
  [daemon-retention-paths](daemon-retention-paths.md) § *Why host-only*), so a
  guest cannot enumerate host structure that way.

**But be precise about what is *not* already withheld, and it is worse than a
softened invariant.** The general `GuestInterface` does not merely let a guest
*observe* a formula identifier; it lets the guest *redeem* one. `identify`
(`interfaces.js:101`) / `locate` (`:102`) are part of the shared
`nameHubMethodGuards` that `GuestInterface` spreads (`:160-163`) and
`packages/daemon/src/guest.js:343-364` wires (along with `reverseIdentify`,
`reverseLocate`, `listIdentifiers`, `listLocators`, `lookupByLocator`,
`storeLocator` — the full ten-method surface Q6 enumerates), so a general guest
can call `identify` and receive a formula-identifier string. And on the redemption
side, `lookupById` is `provide(id)` (`packages/daemon/src/guest.js:162`, guarded
at `interfaces.js:177`) and `storeIdentifier` (`interfaces.js:109`) is likewise
spread into `GuestInterface`, so a general guest can turn a formula-identifier
string back into the live capability without introduction. Only the
*least-authority* guest disallows these (`packages/daemon/src/manager.js:4081-4096`).
By this design's own Q3 discriminator (a formula identifier *is* the authority:
anyone who can serialize it can reconstitute the capability), the shipped general
guest **already carries the ambient-authority "fifth way."**

Two consequences follow, and the design must own both rather than assert an
absolute "no formula ID is guest-reachable" invariant it does not have:

1. **Retract the absolute framing.** "No formula ID is guest-reachable" is *not*
   an invariant the daemon uniformly proves today; it is a property the
   least-authority guest has and the general guest does not.
2. **The pre-existing exposure is a live Distributed Confinement question, not
   scope of this design.** That the general guest can `identify` /
   `lookupById` / `storeIdentifier` is an existing surface, tracked as an Open
   Question below (Q6), to be closed or justified on its own follow-up. This
   design's job is narrower and still meaningful: it must not *add* a new leak.

So the value-passing sugar must be specified to keep formula IDs off *its*
guest-reachable surface, on **both** directions of the call: the export-table
lookup stays daemon-side and the sugar returns only c-list slots (the output
side), and an inbound `endowments` entry from a guest is a **live presence, never
a formula-identifier string** (the input side). Design Decision 2 states that as
a **tightening the design commits to**, not a restatement of existing behavior,
and explicitly does not launder the pre-existing general-guest exposure. The
`endo paths` CLI already respects this on the host side: it resolves a pet name
to a locator on the *host* before calling the daemon, and the locator string
never crosses to a guest.

So the answer to *"is there a stable daemon-side identity for a live presence
that daemon-internal code can key off, across the eventual-send boundary?"* is
**yes: the export-table entry** (equivalently, the far-reference's slot on the
daemon's side of the c-list, which the daemon maps to a formula ID). The naive
implementation that would **leak** the identifier is any path that puts the
formula ID (or a locator string derived from it) into a *value the guest can
marshal*: a return value, an argument echoed back, an error message, or a
debug/inspect surface reachable from the guest facet. The design rule:

> **The value-to-formula-ID resolution is a lookup in a daemon-private
> identity-keyed map (the export table), performed only by host/daemon code.
> No formula ID and no locator derived from one may appear in any value, error,
> or method result reachable through the guest facet or the CapTP gateway, and no
> guest-supplied argument may carry a formula-identifier string in lieu of a live
> presence.**

This is the same rule the retention-paths design already enforces; the
value-passing sugar must inherit it. Any implementation that instead threads a
formula ID through guest-visible marshalling is a **Distributed Confinement
defect**, not merely an ergonomics wart.

### The surface, and its hand-off to Thread 5

The sugar extends the *Proposed* `makeRetainedValue(spec)` surface
([chat-slot-slash-commands](chat-slot-slash-commands.md), on both `EndoHost` and
`EndoGuest`), whose `spec.endowments` is today declared
`(PetNamePath | FormulaIdentifier)[]` on **both** facets
([chat-slot-slash-commands](chat-slot-slash-commands.md):246). The extension adds
a **live-presence variant** beside `PetNamePath`, so a guest passes the value
itself; the `FormulaIdentifier` arm becomes **host-only** and is not admissible
from a guest (the input-side half of the rule above). The facet asymmetry must be
carried **in the types, not a comment**: `FormulaIdentifier` is a branded string
(`types.d.ts:44`), so the two facets' admissible arms are statically
distinguishable, and Thread 4's own discipline ("invalid states should be
unrepresentable, not validated") says to split the type rather than reject a
formula-identifier string past a shared guard:

```ts
// The guest-usable arm set: a name path or a live presence, never a bearer
// formula-identifier string.
type GuestEndowment = PetNamePath | LivePresence;
// The host facet additionally admits the bearer FormulaIdentifier arm.
type HostEndowment = GuestEndowment | FormulaIdentifier;
```

The guest facet's `makeRetainedValue` guard shapes the presence arm as
`M.remotable()`, so a formula-identifier string is unrepresentable at the guard
rather than rejected past it. This narrows the `endowments` arm the sibling
*Proposed* design declares; that amendment to
[chat-slot-slash-commands](chat-slot-slash-commands.md):246 (splitting its single
`(PetNamePath | FormulaIdentifier)[]` union into the per-facet pair above) is
recorded in the Dependencies table, so two Proposed docs do not carry two guest
signatures for one method.

**Two further boundary rules the split does not by itself settle.** First, the
`LivePresence` arm must state *which* presences are admissible, or "no formula-ID
string" is only half a rule. A guest can pass a guest-minted remotable (seated in
the daemon's **import** table, an `o-N` slot), a presence imported from a third
peer, an unsettled promise, or a plain passable with no slot. The confinement
argument rests on the endowment resolving to a daemon **export-table** entry that
maps to a formula record, and direction is cheap to check (encoded in the slot,
`captp.js` `slot[1] === '+'`). **Rule:** admit only a slot **this daemon
exported** whose export-table entry maps to a formula record; reject everything
else with an error that carries **no identifier**. Second, the **return** side:
the surface being extended is specified as
`makeRetainedValue(spec) -> { id: FormulaIdentifier, release }` on `EndoGuest`
([chat-slot-slash-commands](chat-slot-slash-commands.md):158, :235-236), so its
declared return **hands a formula-identifier string back to the guest** — the very
output-side leak Design Decision 2 forbids. So the sugar must **amend the guest
arm's return** to a `release` capability / live presence, **not** an `id` string
(the host arm may keep `{ id, release }`); this is the output-side complement of
the input-side arm split, and it too is recorded as an amendment to the sibling
design rather than left as two contradicting return shapes.

The hand-off to Thread 5 is not merely "Thread 5 supplies a liveness interval."
When a passed live value becomes a static dependency of the new formula, the
**new formula's dependency edge is the durable edge that takes over** from the
transient `question` edge that carried the value through the pipeline. Naming is
not the mechanism (the point of the sugar is *not* minting a pet name); the
static dependency edge is. The atomicity that matters: that dependency edge must
be inserted **before** the `question` edge drops, or a **dependency-hand-off
zero-refcount window** opens in which the intermediate is momentarily rooted by
neither. This is the same *shape* as Q1's two intra-process hand-off gaps
(mint-to-first-edge and settle-before-next-hop), not the cross-peer window Q1 and
Q4 reserve the ordinal "fourth" for; naming it avoids reusing that ordinal for a
second, unrelated hazard. Thread 5's Q1 rule (mint-and-first-edge as one graph mutation)
generalizes to this hand-off: the dependency-edge insertion and the question-edge
removal are one graph mutation.

### Conclusion (Thread 2)

Ergonomic value-passing is achievable within the constraint, because the
trusted-side identity (export-table entry to formula record) already exists and
the guest already only ever sees an opaque per-c-list slot. What the sugar needs
is not a new identity mechanism but a **liveness interval** for the anonymous
formula it implies, which is exactly what Thread 5 supplies, with the durable
dependency edge above taking over at hand-off.

## Thread 3: heap-pressure heterogeneity forbids local-GC-timing liveness signals

**Principle to state explicitly:** a host's local garbage-collector timing (heap
size, generational behavior, when a major GC actually runs) is a property of
*that host*, not of the object graph. Keying a **distributed** liveness signal on
local GC / `FinalizationRegistry` timing lets **the laziest collector in the
network set retention policy for everyone downstream**: a large-heap host can
oblige a small-heap host to retain something the small host would have collected.
This is the standard argument for explicit refcounted import/export protocols
(SwingSet's `dropImports` / `retireExports`) over local-GC-driven distributed GC,
and it is the same reason the daemon's **sweep-by-name-reachability**
(deterministic, host-independent) is preferable to any scheme keyed on when a
particular process's GC happens to run.

`FinalizationRegistry` may act **only** as a *local optimization hint* ("this
local reference is provably gone, so it is safe to send the release/`dropImport`
message **now** rather than at the next sweep"), never as the authoritative
signal. The authoritative signal is always a **protocol-level fact** (a name
binding, a c-list refcount reaching zero via an explicit drop message, a question
settling), never a local-timing artifact.

**The discriminator, stated once, applied to every message this document names.**
Provenance does not decide admissibility. A message on the wire is a
protocol-level fact *whatever* prompted its sender to send it, including that
sender's own finalizer. What is forbidden is different: keying a liveness
decision on *your own* GC firing, or inferring a remote's state from *timing*
(how long since you last heard from it) rather than from a message it actually
sent. So a counterparty's `op:gc-exports` drop message is **admissible as an
authoritative fact once it arrives** (it is a wire message the counterparty
chose to send); what is inadmissible is treating the *absence* of such a message,
or your local finalizer, as the signal. The corollary Q4 and Design Decision 6
must honor: you may **not** release a directly imported intermediate on your own
question merely settling, because whether the counterparty still imports it is a
fact only the counterparty's drop message reports.

**The test every mechanism in this document must pass:**

> Is the liveness signal a *protocol-level fact* (a message some peer actually
> sent, or durable state, derivable identically by every peer), or a *local-timing
> artifact wearing a protocol-level costume* (derivable only from when *your own*
> GC, scheduler, or heap happened to reach a state, or from elapsed time rather
> than a received message)?

Applied here:

| Signal | Verdict |
|---|---|
| **Name reachability** | Protocol-level fact (host-independent, deterministic). PASS |
| **Cross-peer retention set** | Protocol-level fact: the publisher's authoritative set, streamed as explicit add/remove deltas, reconciled by re-send on reconnect ([daemon-cross-peer-gc](daemon-cross-peer-gc.md)). PASS |
| **A counterparty's `op:gc-exports` drop** | Protocol-level fact once it arrives (a message the counterparty sent), even though the counterparty's finalizer prompted it. Admissible; see the discriminator above. PASS |
| **Your own `FinalizationRegistry` firing / `op:gc-answers` you would emit** | Local-timing artifact. Admissible only as an optimization hint to release *earlier*, never as the release fact. Fails the test as an authority. |
| **Batch-flush root (Thread 5)** | **Must be** keyed on a protocol-level fact (a question settling *and* no outstanding cross-peer import edge; see Q4), never on "the pipeline's `FinalizationRegistry` fired." If "batch flushed" were derivable only from a local GC firing, it would fail this test and be rejected. |

## Thread 4: no-orthogonal-persistence worker model, and worker discipline as constraint

The worker discipline the conversation attributes to Mathieu Hofman (this is the
conversation's attribution; the garden library has no page for it, so it is cited
here as a *position*, not a library-backed fact): a worker retains **no heap or
stack between message deliveries**; all durable state is explicitly captured into
durable storage between deliveries. Zygote snapshots (pre-initialized worker
memory images used as a fast fork point) remain usable as a cold-start /
performance optimization at an arbitrary checkpoint, never as the definition of
durable truth. Motivation: on-chain vat **upgrade** needs new code to operate over
old durable state without depending on heap/bytecode-layout compatibility across
versions, which orthogonal persistence (heap snapshot as ground truth) cannot
give you.

The library *does* ground the underlying claim. The Endo exo taxonomy (Miller,
`@endo/exo` docs) already stratifies exactly this: **heap** state lives in the
JavaScript heap and occupies room in the vat's snapshot (so it dies with the
process that is not snapshotted); **virtual** state is externalized outside the
heap but, in the taxonomy's own words, virtual exos *"do not survive upgrade"*;
and only **durable** state, again verbatim, *"can also survive upgrade, and so
can be passed in baggage to a successor vat-incarnation."* And the *"why not orthogonal
persistence"* material (Kris Kowal, endojs/endo#3121, draft) states the sharp
edge directly: *"An upgrade may invalidate assumptions encoded in a heap
snapshot; the program must reconstruct its working state from durable inputs
afterward ... the orthogonal persistence machinery provides comfort during normal
operation but does not eliminate the need for reconstruction logic. Formula
Persistence accepts this reality as a starting point rather than discovering it
as a consequence."* This is precisely the coupling
[ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) § *Upgrade
without breaking orthogonality* refuses: it makes the durable unit of identity a
**name binding** and keeps vats pure, immortal-code, and disposable, so upgrade
is succession plus rebind rather than in-place code swap over stable memory
(ICP canisters) or baggage (Agoric vats).

### Is this the same defensiveness axis as Thread 1?

The conversation frames it as the **same defend-pervasively-vs-fail-cleanly
axis, one layer down** (within-worker instead of across-worker): missing durable
state fails **immediately and reproducibly** at the point of omission, whereas
insufficient partition-defense fails **intermittently**, timing/load-dependent,
and can stay latent a long time. That framing is *mostly* right and is a real
argument for the coherence of the direction, but it needs one honest
qualification.

**Where the framing holds:** *omission* is loud. A durable field that was never
written is absent on the next delivery, and the code that needed it faults at a
deterministic point regardless of timing or load. That is genuinely a better
failure mode than latent partition-defense debt.

**Where it does not:** *staleness / wrongness* is **not** loud. A durable write
that is **present but subtly wrong or stale** (written under an old invariant, or
written from a value that a since-upgraded code path would compute differently)
fails exactly like insufficient partition-defense: intermittently,
data-dependently, and latently. The no-orthogonal-persistence model converts
*"heap didn't survive"* (loud, at the checkpoint) into *"durable state is present
but semantically off"* (quiet, arbitrarily later). So the correct claim is
narrower: **the model makes the *dominant* failure (omission) loud and
reproducible, but it does not make *all* failures loud**; it relocates a class of
them (staleness) into the same quiet regime as the partition tax. The direction
is still coherent, because omission dominates in practice and the model at least
makes the *contract* explicit (every durable field is named and written on
purpose), but the design should not oversell it as strictly fail-clean.

### Worker discipline as an explicit constraint

**Proposal:** rather than one persistence/upgrade discipline daemon-wide, let a
worker's discipline be a **constraint expressed at request time** (what
upgrade/continuity guarantee does this workload actually need), analogous to
SwingSet already shipping more than one **vat manager** (local, xsnap,
node-subprocess) and to thixotrope already shipping **three engines** (journal
replay, snapshotting replay, XS snapshots;
[ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) § *The engine
seam*). The precedent is real and on both sides of the fence, so the shape is
right. The library states the exact separation this relies on: Formula
Persistence is the *user agent's* choice (fast convergence, user agency over
retention, timely revocation), while *"the Agoric chain uses Endo components with
orthogonal persistence to ensure all honest validators produce the same
deterministic computation,"* and, decisively, *"the Daemon can host a worker that
is itself constrained to determinism and keeps its own replay transcript."* That
last sentence is worker discipline as constraint already latent in the design
corpus: the daemon hosts a worker **without imposing its own persistence model on
the worker's internals**. Making that latent capability an explicit request-time
constraint is the whole of this proposal.

**Model the coherent shapes, do not validate a grid.** An earlier cut of this
proposal declared a `{ persistence, upgrade, identity }` product type and then a
request-time validator to reject the incoherent combinations. That is accidental
complexity introduced by the representation: invalid states should be
unrepresentable, not validated. The coherent worker disciplines are a small
discriminated union, and the union makes the rejection function unnecessary:

```ts
// The coherent worker disciplines, as a sum type, declared and exported from the
// daemon's canonical formula-type module (`packages/daemon/src/types.d.ts`,
// alongside `WorkerFormula`). Invalid combinations are unrepresentable, so there
// is no request-time "reject incoherent combos" step. The single tag is spelled
// `discipline` (not `kind`) precisely because the exported `WorkerFormula`
// already carries an unrelated `kind?: 'locked' | 'node'` (`types.d.ts:176-181`);
// two `kind`s on one durably-persisted formula type would collide.
type WorkerDiscipline =
  // Heap snapshot is ground truth; immortal code, disposable vat, no upgrade.
  | { discipline: 'orthogonal-persistence' } // thixotrope XS default
  // Hofman model: only named durable writes survive; new code succeeds old
  // durable state via an app-designed handoff at succession.
  | { discipline: 'durable-succession' }
  // Ephemeral: dies with the host, makes no durable claim.
  | { discipline: 'ephemeral' };
```

`WorkerDiscipline` rides the exported `WorkerFormula` as a **new, optional** field
`discipline?: WorkerDiscipline` with a documented default (absent means
`'orthogonal-persistence'`, thixotrope's current behavior), so existing formula
JSON stays readable and no migration is forced. The tag `'orthogonal-persistence'`
names its noun rather than the bare adjective `'orthogonal'`, matching the
complete sibling tags `'durable-succession'` / `'ephemeral'`.

This reuses concepts the reader already has rather than minting a third
persistence vocabulary: `orthogonal-persistence` is the heap-as-ground-truth
stratum, `durable-succession` is the `@endo/exo` **durable** stratum carried in
baggage to a successor, `ephemeral` is the **heap** stratum that *"dies with the
process."* The concept is named **worker discipline** throughout (the type, the
prose, and the README milestone row all use that one name).

**Identity is per-edge, not part of this descriptor.** Whether an inbound
reference resolves through the name hub (`named`, reroutable, upgradable) or pins
the origin `(workerId, slot)` forever (`worker-import`, EQ-stable) is a
**per-edge choice made at grant time**, exactly as the name-hub design already
forces it. It is deliberately *not* hoisted onto the worker descriptor: hoisting
it would make one worker unable to hold both edge kinds, which the name-hub
design depends on. The coherence an earlier cut tried to validate ("succession
needs `named` edges for the references that must survive it") is therefore a
property checked **per-edge at succession time**, when the inbound edges actually
exist, not a combination rejected at worker-request time (when no inbound edge
exists yet). `{ discipline: 'durable-succession' }` with an inbound `worker-import`
edge that cannot reroute is caught when that edge is asked to survive a
succession, and it is caught against the concrete edge, not a hypothetical.

### Durable promises are the sharp edge

A pending promise's continuation is a closure over arbitrary reachable state
**plus** a position in the engine's own microtask machinery. There is no obvious
durable-data representation for *"resume this `.then` chain"* without either (i)
restricting what a continuation may close over (an explicit
continuation-passing / named-handler vocabulary), or (ii) accepting that
unsettled promises are simply **lost** across a checkpoint (today's on-chain
vat-upgrade status quo, and thixotrope's explicit stance, "no upgrade, by design";
unsettled cross-session promises reject via tombstone descriptors on retirement).

**Recommendation:** treat general durable pending-promises as **not solvable**,
and instead **scope** what a durable pending-promise may represent under
`{ discipline: 'durable-succession' }`:

- A durable promise may resolve **only** to a value the durable-data vocabulary
  can already represent (a passable, a named presence resolvable through the name
  hub), never to an arbitrary in-heap continuation.
- Its pending continuation must be expressed as a **named durable handler** (an
  explicit reaction registered in durable storage), not an anonymous `.then`
  closure. Resolution re-dispatches to the named handler after restart.
- Anything that does not fit (a `.then` over transient heap state) is **transient
  by construction**: it lives only within a delivery and is lost at the
  checkpoint, and the model's own loudness (above) makes that omission fault at a
  deterministic point if the app wrongly relied on it.

Be explicit that this **relocates rather than removes** the defensiveness tax: it
becomes *"handle your pending promise not surviving upgrade,"* structurally the
same shape as Thread 1's partition-defense tax and Thread 5's stuck-batch abort.
That is acceptable (a relocated, *named*, statically visible tax is better than a
pervasive latent one), but it should be named as such, not hidden.

## Thread 5: the batch-flush retention root (priority thread)

**Proposal.** When a batch of pipelined messages between two peers is in flight
(embargoed, held pending resolution before further delivery, as in
three-party-handoff-style promise pipelining), the daemon treats the **batch's
existence as a temporary GC root**. Anonymous, unnamed intermediate formulas
minted to shepherd values through the pipeline stay alive for exactly the
batch's lifetime and become collectible the moment the batch fully flushes
(delivered and settled, no outstanding continuations), unless something durable
claimed a name for one of them along the way.

This is attractive because it gives Thread 2's *"implicit unnamed formula"* a
real, **protocol-defined interval** to exist in (long enough to be useful as
value-passing sugar, short enough not to require eager naming), and its liveness
clock is a **fact about message delivery** (protocol-visible, deterministic,
host-independent), exactly the property Thread 3 demands.

A note on vocabulary this thread leans on: a promise is **settled** when it is
fulfilled or broken (a local state predicate), and **resolution** is the wire
event that settles it (the `fulfill` / `break` message). The two are used
distinctly below: "settled" describes the local pin predicate; "resolution"
describes the message every peer derives identically.

### Reframing: this is not a new primitive, it is the CapTP question/answer refcount

The load-bearing insight is that **the daemon does not need a new "batch"
concept.** CapTP already mints and tracks exactly the anonymous, unnamed
intermediates in question: promise-pipelining introduces **questions** (outbound
calls whose results are unsettled promises) and **answers**, tracked in the
import/export tables (`makeCapTPImportExportTables`). A pipelined value flowing
through an intermediate is, mechanically, an **export referenced by an unsettled
question/answer**. So:

> An anonymous intermediate formula minted for value-passing is **rooted for
> exactly as long as it is the target or result of an unsettled CapTP question**,
> and becomes collectible when the last such question settles and no counterparty
> still imports it directly (Q4), which is observable in the import/export tables
> and the cross-peer retention set the daemon maintains.

Under this reframing the "batch-flush retention root" is not a novel embargo
primitive; it is a **specialization of the reference-counted import/export drop
protocol the kernel already runs at the c-list level** (SwingSet's
`deliverDropExports` / `deliverRetireExports`; CapTP's `op:gc-exports` /
`op:gc-answers`). The anonymous formula gets a graph edge from the question
table (a new labeled edge kind, `question:<session>:<answer-pos>`, alongside the
existing `pet:<name>`, field, `retention`, and `transient` labels in
[daemon-retention-paths](daemon-retention-paths.md); the label carries the
answer position so a host operator reading `listRetentionPaths` sees *which*
question roots it, not N identical rows). **The `<session>` component is
load-bearing, not cosmetic.** The answer position is a **peer-chosen, per-`makeCapTP`
identifier**: `lastQuestionID` is module-local to each `makeCapTP` and starts at 0
(`captp.js:482`, `:681`), instantiated once per connection
(`connection.js:166`), while the formula graph is **daemon-global**. Without a
session discriminator, two concurrent peers both mint answer-pos 3, the label
`question:3` names one edge for two questions, and peer B's resolution drops peer
A's root (and Q2 mechanism 1 cannot enumerate a single session's edges on
`op:abort`). Keying the edge on (session, answer-pos) makes it unique by
construction; the daemon must additionally **reject a duplicate answer-pos within
a live session** (the position is peer-chosen with no uniqueness check at
`answers.set`, `:852`, so a hostile questioner could otherwise reuse a live
position to alias two `question` edges and collect an intermediate the second
question still roots). Union-find pins its cluster while the question is open;
resolution (`fulfill` / `break`) removes the edge; the next mark-and-sweep
collects it if nothing durable claimed a name and no cross-peer import edge
survives.

**Two separable pieces; do not couple the buildable one to unlanded API.** The
daemon-internal mechanism is buildable today over landed machinery: the in-memory
**refcounted transient pin** (`graph.js` `transientRoots`, pinned and unpinned by
`pinTransient(id)` / `unpinTransient(id)`, `packages/daemon/src/graph.js:629,645`).
A pinned formula is held alive without granting persistence; the pin is in-memory
only and keyed on a formula id. The claim that *every* landed call site scopes it
to a single in-flight operation released in a `finally` does not hold: **some**
do (`packages/daemon/src/directory.js:506-510` is the clean form), but the
guest-handle pins at `host.js:2069`/`2090` and `manager.js:6737`/`6757` push the
pin through a deferred task and `await unpinTransient` only after three
intervening awaits (`formulateGuest`, `getFormulaForId`, `storeIdentifier`) with
**no** `try`/`finally`, so a throw on that path leaks the pin permanently. The
correct claim is "some, not every." So the substrate the batch-flush root
inherits already leaks on the error path, and the per-root lease below covers
only *question* roots, not these operation-scoped pins; closing that error-path
leak is a separate precondition, not something the per-question refinement
supplies. The batch-flush root refines that pin
**from a single-operation lifetime to a single-question lifetime** by giving the
anonymous formula a `question:<session>:<answer-pos>`-labeled edge, union-find-pinned while
the question is unsettled and unpinned when the question **resolves**. Its release
trigger is resolution (plus the cross-peer condition of Q4); it calls **no**
`release` handle, so it does **not** depend on any unlanded guest-facing surface.

The *guest-facing* retention handle is a **separate** surface and a separate
concern: `makeRetainedValue(spec) -> { id, release }`, whose `release` exo
deliberately *"carries no reference to the target value, the target's worker, or
the daemon's internal graph,"* with release ordering *"disk before graph,"* is
**not yet in the tree**. It is *Proposed* API on `EndoHost` / `EndoGuest` in
[chat-slot-slash-commands](chat-slot-slash-commands.md) (Status: Proposed), and
the quoted `release`-exo guarantees are that proposal's text, not shipped code.
Thread 2's ergonomic sugar consumes that handle; the daemon-internal batch-flush
edge does not. Keeping them separate means the mechanism is buildable now over
`pinTransient` without waiting on the handle, and the handle lands on its own
schedule. The no-persistence property the landed pin already has carries over
unchanged; the connection-bounded lifetime and partition-triggered release are
what this design adds.

Now the four questions.

#### Q1: what exactly delimits "the batch"

**Do not** scope it as *"the full causal cone of a top-level request"*: under
sustained or recursive pipelining that root never closes (a reply triggers
further pipelined sends, possibly a third party, and the cone grows without
bound). **Do** scope it per-question, at the granularity CapTP already tracks:

- An anonymous intermediate is rooted iff it is referenced by **at least one
  unsettled question/answer** in the export table. This is a refcount, not a
  span: fan-out (one reply triggers several pipelined sends) is *several
  questions*, each independently rooting what it references; a chain (A's answer
  pipelines into B) is B's question rooting the intermediate that A's settlement
  would otherwise have released. Nothing is collected while a *later hop of the
  same logical operation still holds a question against it*, because that hop's
  question is a live edge; nothing stays rooted once *no* question references it,
  however deep the original cone was.

This is the standard resolution: the "batch" is not a bounded time window, it is
the **transitive closure of unsettled questions** (a refcount over that closure,
not a set-shaped span), which closes exactly when the last one settles. The
set-shaped picture and the refcount picture describe the same live edges; the
refcount is the operative one because it is what the sweep reads.

**The refcount hand-off is not automatically clean. The enumeration below is
scoped to intra-process windows; a fourth, cross-peer window is enumerated in Q4,
and a fifth class — the release-path races between the two independent release
triggers (per-root lease expiry and question resolution) and the admission-cap
check-then-mint TOCTOU — is enumerated in Q2 where those triggers are defined.
The three intra-process windows must be closed by an explicit rule, not asserted
away:**

- *Mint to first question edge.* An intermediate is minted before the question
  that will root it is entered in the export table; a sweep landing in that gap
  would collect a live intermediate. **Rule:** the mint and the first
  `question`-edge insertion are a single graph mutation (the intermediate is
  born already pinned by the question that mints it), so no sweep observes it
  unrooted. This is the same atomicity the `pinTransient` refcount already
  requires between allocation and first pin, and the same atomicity Thread 2's
  dependency-edge hand-off requires.
- *Settle before the next hop's edge exists.* A client that awaits A's `fulfill`
  and only then pipelines B briefly drops the intermediate's refcount to zero
  between A's edge removal and B's edge insertion. Here collection is **correct**,
  not a bug: at that instant nothing references the intermediate, and if B never
  arrives it *should* be collected. The chain case where this document claims a
  clean hand-off is the one where B's question is already in flight *before* A
  settles; there the two edges coexist and the refcount never reaches zero.
- *Arrival after collection.* The remaining case is the adversarial or lagging
  one. A `fulfill`s, the `question` edge drops, the refcount hits zero, the sweep
  collects the intermediate **at the formula-graph layer**, and *then* an
  already-in-flight pipelined send against `<desc:answer answer-pos>` for a
  further hop arrives. A settled answer position is a spent wire fact (further
  pipelining against it is not well-formed), but that is a sender obligation a
  hostile or merely lagging peer need not honor, so it cannot be the exporter's
  defense. **Rule (desired end-state):** a message that arrives against an
  already-collected anonymous intermediate must fail **partition-shaped**
  (Thread 1) — the sender sees a broken reference, never a silent rebind to a
  different value and never an exporter crash. **But this partition-shape is a
  concrete prerequisite the mechanism must build, not a property today's code
  already provides — and the first reason is that formula-graph collection does
  not, by itself, free the answerer-side table entry the message actually
  resolves against.** Traced against the landed CapTP, `CTP_CALL` resolves an
  answer-position target from the module-local `answers` `Map` **first**
  (`packages/captp/src/captp.js:780-782`), and `answers` is written keyed by the
  peer-minted **question id** — `answers.set(questionID, …)` (`:743`, `:852`; the
  `:488` comment says "chosen by our peer"). The `answers` entry is **immortal for
  an unconditional reason, not a contingent one.** `CTP_DROP` deletes it via
  `answers.delete(reverseSlot(slotID))` (`:756-767`), guarded by
  `slotID[1] === '-'` — i.e. the deletion key is always a **reversed export slot**
  (`+`-direction), while every stored `answers` key is an **unreversed question
  id** (`-`-direction). The two key spaces **never intersect**, so
  `answers.delete` *can never match a stored answer entry* — the entry survives
  **even with `gcImports: true`**, and **even against a peer that faithfully emits
  `op:gc-answers`**. The earlier framing that attributed the survival to
  "`gcImports` defaults `false` (`:291`) so the `CTP_DROP` that would delete it is
  never emitted" named a *contingent* cause for an *unconditional* fact and is
  corrected here: no `CTP_DROP` deletes this entry on any configuration. So a late
  pipelined send is serviced from the **retained handled promise**: a **silent
  rebind to the resolved value**, not a hang and not partition-shaped, exactly the
  cosmetic-deletion hazard Thread 1's discriminator exists to forbid. Only once
  that `answers`/export-table entry is *also* gone does `convertSlotToVal` throw
  `` Unknown export ${slot} `` (`:710`) inside the handler, *before* any
  `CTP_RETURN` is constructed; the `dispatch` outer catch then calls
  `quietReject(e, false, PROTOCOL_REJECTION)` (`:1021-1022`), and because
  `returnIt` is `false`, `quietReject` reports the error only to the **local**
  `onReject` handler and returns `Promise.resolve()` (`:320-336`) — **no reply is
  sent back to the sender.** So the caller's question promise never settles: the
  observed failure is a **silent indefinite hang** (bounded only by session abort
  or the per-root lease). The batch-flush root therefore names **two** `@endo/captp`
  prerequisites, not one — and because no landed `CTP_DROP` path retires this
  entry, the first is a *new mutation seam*, not a coupling into an existing one:
  **(a)** the exporter's own `answers`/export-table entry for an anonymous
  intermediate is itself a retention root (a fifth root, the embedding library's
  own table — see Q4 and Design Decision 6's release conjunction), and because
  `@endo/captp` exposes **no** call site that retires an `answers` entry on
  anything but a namespace-mismatched `CTP_DROP`, the release condition needs a
  **new, bounded answer-retirement authority on `makeCapTP`** (distinct from, and
  in addition to, the question-*observation* seam) that the daemon invokes as part
  of the same graph mutation that finally releases the intermediate; otherwise
  formula-graph collection is the cosmetic deletion above and the late send
  silently rebinds against the retained handled promise. This retirement authority
  must be bounded: an unscoped `answers.delete` handed to an embedder reproduces
  the very hang/rebind pair this conjunct exists to prevent. **(b)** Once that
  entry is gone, the exporter must **reply with a genuine rejection (a `CTP_RETURN`
  carrying a protocol-level break) on `Unknown export`** rather than silently
  dropping the reply. Note the seam this needs: the throw originates in
  `convertSlotToVal` (`:710`) via the bare `unserialize` in `CTP_CALL`
  (`:783-789`), *outside* any local `try`; the only catch is `dispatch`'s
  (`:1019-1024`), which has no `questionID` in scope and structurally cannot
  construct a `CTP_RETURN`. So this prerequisite is specifically "wrap the
  `answers`-miss target resolution inside `CTP_CALL` so the failure reaches
  `processResult`", scoped to the `Unknown export` case (not a blanket change to
  `dispatch`'s generic `PROTOCOL_REJECTION` path, which today replies to no
  protocol rejection and whose contract is shared by all five `workspace:^`
  `@endo/captp` dependents and every external embedder — see the scoping note in
  Q4). Until both hold, the residual is a **silent rebind** (entry still present,
  the common case on every configuration) or a **silent hang** (entry gone), and
  the per-root lease / session abort are the only bounds that fire (Q2).

#### Q2: the stuck-batch / non-flushing case (the resource-exhaustion vector)

This is the hazard the whole reassessment must answer without hand-waving: a peer
that disappears mid-pipeline, or a permanently embargoed message, leaves the root
open indefinitely, reintroducing at the batch layer exactly the
unbounded-retention hazard kill-the-worker exists to foreclose at the worker
layer. Worse, a counterparty can **deliberately** force retention by keeping a
pipeline artificially open. Three complementary bounds, each already precedented
in the tree:

1. **Session-subordinate, not session-independent.** The anonymous root is
   scoped to the **CapTP session**, not global. When the session aborts (peer
   disconnect), the existing **at-most-once abort machinery**
   ([ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md): live holders
   reject via session abort, restarted holders via tombstone descriptors) rejects
   every outstanding question, every question-edge drops, and the anonymous roots
   release on the next sweep. The disappeared-peer case is thus handled by
   machinery that already exists: a dead session cannot hold a root open.

2. **Lease / expiry on the root** for the *live-but-stalled* peer (connected,
   but the question never settles) **and for the live peer that withholds its
   cross-peer drop after resolving** (Q4's adversarial fourth-window shape). This
   is the **same follow-up thixotrope already names** for edge staleness
   ("lease/expiry policy on names"). A question-rooted anonymous formula carries a
   lease that bounds the **whole** retention interval, not merely the
   pre-resolution wait: (i) if the question never settles, on expiry the daemon
   **rejects the question locally** (the holder sees a broken reference; because
   the thing rejected is an *unsettled question*, this is ordinary promise-level
   partial failure the program already handles, not the novel single-sever class)
   and drops the `question` edge; (ii) if
   the question *has* settled but a cross-peer import edge is still outstanding
   (Q4), the lease continues to run across resolution and, on expiry, **forcibly
   drops that cross-peer edge and collects the intermediate** (the withholding
   peer observes a broken reference on next use). Either way the lease turns
   "permanently embargoed" (or "permanently pinned by a withheld drop") into
   "bounded retention then partition." Case (i) is ordinary partial failure; case
   (ii) severs a *settled* import and is Thread 1's row-3 single-sever class,
   whose pervasive-defensiveness tax this design owns and confines to the
   withholding peer (Q4's discriminator subsection: a cooperative peer never
   triggers it). Note (see Design Decision 3):
   the lease is a **local policy bound**, not a wire fact. Its *expiry clock* is
   host-local; what it produces (a partition-shaped break) is the wire-visible
   event. It does not claim to be a protocol-level liveness fact, and it does not
   need to; it is a bound that emits a break. **The clock must be an injected
   platform power, not ambient `setTimeout`.** The daemon has a non-Node target:
   for the XS daemon, `packages/daemon/src/bus-xs-daemon-polyfills.js:54-60`
   polyfills `setTimeout` by **discarding the delay** and firing on the next
   microtask ("XS has no real event loop"), so a lease built over ambient
   `setTimeout` in daemon core would expire **immediately** on XS — and the Q4
   forcible cross-peer drop would then sever every anonymous intermediate's settled
   import on the first turn, falsifying the "a cooperative peer never sees the
   forcible drop" bound. So the lease timer is an **injected clock power supplied
   per target** (the house precedent is `retention-accumulator.js:31`, "Defaults to
   `queueMicrotask`. Injected for testing"; `manager-node-powers.js:545` supplies
   the real Node timer). A Dependencies row records that the XS daemon needs a real
   timer power before the Q2 bound holds there.

3. **Admission control on root creation** for the *adversarial* case. Borrow the
   metering insight directly ([daemon-xs-worker-metering](daemon-xs-worker-metering.md):
   *"admission control eliminates embargo"*): cap the number and/or aggregate size
   of outstanding anonymous roots **per session**, and when the cap is hit,
   **refuse the further pipelined send**. This is a partition-shaped failure, not
   backpressure: backpressure names work that is withheld and *later admitted*
   (as the metering precedent withholds a delivery until the budget refills),
   whereas a refused send here is never later admitted; the caller sees the send
   fail. What is refused is an *unsettled* pipelined send (a transient, not a
   settled reference), so like the pre-resolution lease this is ordinary
   promise-level partial failure, not Thread 1's row-3 single-sever class. The cap must be stated over the
   **transitively pinned closure**, not the count of question edges: a `question`
   edge is union-find-pinned, so one root pins its entire group, and `N` roots
   under a naive per-edge cap can retain arbitrarily more than `N` formulas. The
   bound is therefore on the aggregate size of the union-find groups the
   outstanding roots pin, so a counterparty cannot inflate retention by fanning a
   single root into a large cluster. Be honest about the cost: a cap over the
   transitively pinned closure makes admissibility depend on exporter-side
   union-find topology the peer **cannot predict**, so an honest deep-pipelining
   peer can have a send refused for reasons opaque to it. That is the price of
   bounding a hostile peer, and refusing an unsettled send is ordinary partial
   failure, but it is a real ergonomic edge, not free backpressure.
   **A check-at-mint over a quantity that only grows afterward is not sufficient
   on its own.** `union` merges but never splits (`graph.js`), so a root's pinned
   closure is **non-decreasing** after admission: a peer can mint `N` roots each
   just under the cap and *then* drive later edges/cycles that union their groups
   into one oversized cluster, defeating the cap without ever tripping it at mint.
   The check-and-mint atomicity rule (the fifth-window TOCTOU below) closes a
   concurrent-admission race, **not** this monotonic-growth one. So the cap needs
   one of two stated disciplines, and this design commits to the first: **(a)**
   scope the cap's denominator to the **question-rooted pins only** (count each
   outstanding `question:<session>:<answer-pos>` edge's *own* contribution, not the
   whole merged group it happens to land in), so post-mint merges with unrelated
   named roots do not retroactively push a session over cap; **(b)** *or*, if the
   denominator must be the full closure, **re-evaluate the cap on every union that
   grows a question-rooted group** and refuse/partition-shape the offending later
   edge. Option (a) is preferred because it keeps the check local to the roots the
   session actually minted; the closure-size framing of the "cannot fan a single
   root into a large cluster" claim is corrected to hold **at and after** mint
   under (a), not only pre-mint. A counterparty cannot force retention past the cap
   because the daemon stops minting roots (and, under (a), a later merge cannot
   inflate a session's counted total), exactly as the supervisor stops delivering
   messages when budget is exhausted. This is the piece that makes the root safe
   against a hostile peer rather than merely a crashed one.

   Two further per-session/per-peer notes: the cap is stated **per session**, so a
   peer opening `N` sessions gets `N` times the cap and `N` independent abort
   scopes; a **per-peer aggregate** bound over a peer's live sessions is required
   so session churn does not multiply the bound. And the degenerate cap values
   (cap `0`; `<` vs `<=` at exactly-cap; a single send whose own closure already
   exceeds the cap, which — since a refused send is "never later admitted" — wedges
   that session rather than bounding it) are enumerated in the Test Plan's boundary
   sweep.

With all three, the stuck-batch hazard is bounded by (1) session lifetime, (2) a
per-root lease, and (3) a per-session admission cap. No single one is
load-bearing alone, and none requires buffering outbound messages or rolling back
effects.

**The fifth window: release-path races (the two rules Q1 deferred here).**
Introducing the lease (mechanism 2) alongside resolution-as-trigger (Q4) creates
a **second, independent release path** for the very same question edge, and the
admission cap (mechanism 3) introduces a check that must be atomic with the mint
it guards. Both are same-resource races that Thread 5's own bar ("closed by an
explicit rule, not asserted away") requires stating:

- **Lease-expiry vs. resolution race.** The per-root lease and the resolution
  trigger are two paths that both drop the *same* `question` edge; a lease timer
  firing and a `fulfill` / `break` arriving in the same tick could otherwise both
  attempt the drop (a double free, or a released-then-referenced edge). **Rule:**
  the edge drop is **idempotent and single-owner** — the first of {lease expiry,
  resolution} to run performs the one graph mutation that removes the edge and
  marks the root released; the second observes the edge already gone and is a
  no-op. Because both outcomes are the same released edge, *which* wins is
  immaterial to the graph, but resolution is preferred to be observed as the
  cause when both are pending in one tick (it is the authoritative wire fact;
  the lease is a local bound, Design Decision 3), so the holder that sees a break
  sees the resolution's value/reason rather than a lease-timeout reason whenever
  the resolution is already in hand. The lease only *originates* the break when
  resolution has not arrived.

- **Admission-cap check-then-mint TOCTOU.** Mechanism 3's cap check ("is the
  aggregate pinned closure under the per-session bound?") must not be a separate
  step from the mint it authorizes: two concurrent pipelined sends could each
  observe "under cap," then each mint, jointly overshooting the bound. **Rule:**
  the cap check and the root mint (with its first `question` edge) are a **single
  graph mutation** — the same atomicity Q1 requires for mint-and-first-edge —
  evaluated against the live pinned-closure size at mint time, so two concurrent
  admissions serialize through the one mutation and the second sees the first's
  contribution already counted. A send that loses the race is refused
  partition-shaped, exactly as an over-cap send is.

Two further atomicity questions are real but narrower and are recorded as Open
Questions rather than resolved here: (a) **diamond / N-referrer simultaneous
settle** — when several questions reference one intermediate and their
resolutions land in one tick, the refcount must reach zero exactly once
(the same idempotent-drop discipline should cover it, but the N-way case wants
its own statement); and (b) **gift-id replay / double-redemption** in the
three-party case (Q3), where a redemption attempt racing a second attempt or a
lease expiry needs a single-use guard. Both are enumerated under Open Questions.

#### Q3: two-party vs. multi-party scope

The motivating cases (a live value standing in for a formula dependency)
plausibly arise as often from **three-party introductions** as direct exchanges,
and embargo semantics are already the hardest part of three-party handoff (a
*gift* held at the introducer, embargoed until the third party accepts). A root
scoped to a single peer **pair** may not cover them.

The right move is to **attach the root to the handoff's own gift lifetime**, not
to invent a pairwise-only construct. OCapN's three-party handoff (spec: CapTP
Specification.md, Jessica Tallon) is Gifter to Exporter to Receiver: the Gifter
`op:deliver`s a **`deposit-gift`** to the Exporter's bootstrap object carrying a
**32-byte random `gift-id`** and the reference, then hands the Receiver a signed
**`desc:handoff-give`** certificate, which the Receiver wraps as
**`desc:handoff-receive`** and presents to the Exporter to withdraw the gift.
The deposited gift held at the Exporter *is* an anonymous intermediate with a
well-defined lifetime: rooted from `deposit-gift` until the Receiver redeems it
(or the handoff aborts). That is the same "rooted by an outstanding obligation"
shape, with the obligation being the un-redeemed gift rather than an unsettled
question. So Q3 does not need a different mechanism; it needs the root to be
defined over the **gift's deposit-to-redeem interval**, of which the two-party
pipelined-question case is the degenerate (single-hop) instance.

Two honest caveats here:

- **Confinement note:** the 32-byte `gift-id` *is* observed by the Receiver
  guest, but that is legitimate, and does **not** violate Thread 2. The
  discriminator is **not** "freshly minted and unguessable": a formula identifier
  is *also* a freshly minted, unguessable cryptographic designator, and a
  deposited gift *is* a pre-existing capability (held at the Exporter), so the
  "names no pre-existing capability out of band" gloss does not actually separate
  the two. The real discriminator is **redemption-boundness**: the gift is
  withdrawable **only** by the Receiver named in the signed `desc:handoff-give` /
  `desc:handoff-receive` pair, is **single-use**, and is **scoped to one
  handoff**, so possession of the `gift-id` alone confers no authority (an
  eavesdropper cannot redeem it without being the certified Receiver). A **formula
  identifier**, by contrast, *is* the authority: anyone who can serialize it can
  reconstitute the capability without introduction (the ambient-authority "fifth
  way" Distributed Confinement forbids). The design must keep formula IDs off the
  wire *because they are bearer authority*; it need not (and cannot) keep the
  redemption-bound `gift-id` off the wire.
- **Dependency / gap:** the garden library documents the handoff's *descriptor*
  vocabulary but has **no CapTP promise-resolution / handoff *embargo* mechanism
  on record**; the classic "hold deliveries to a resolved promise until the
  three-party embargo lifts" is not in the ingested spec. So the multi-party
  scope of this thread is **blocked on whatever embargo discipline Endo's
  three-party handoff actually implements** once it lands, and should be deferred
  explicitly: build the two-party pipelined-question root first; extend to the
  gift interval when the handoff (and its embargo semantics) are observable
  protocol state. This is a legitimate "not yet, because X."

#### Q4: portability across CapTP implementations; does it motivate an OCapN change?

The decisive question. **Is "batch flushed" locally derivable by each peer from
resolve/settle traffic that already exists on the wire, or does it require a new
explicit boundary signal?**

**For the two-party pipelined-question case: no OCapN *wire* change, but a new
`@endo/captp` *observation seam* is a prerequisite.** Two distinct claims that an
earlier cut conflated:

- **No OCapN wire primitive is warranted.** The relevant wire fact already
  exists. A promise resolves via **`fulfill`** (a value) or **`break`** (an
  error); note there is no separate "settle" verb, that is the resolution event,
  and it is a **protocol-level fact** every peer derives identically from a
  message on the wire. **Resolution is therefore the authoritative trigger** that
  drops the `question` edge.
- **But the daemon cannot observe that fact today without a new `@endo/captp`
  seam.** CapTP tracks its in-flight questions in a module-local **`settlers`**
  `Map` (`packages/captp/src/captp.js:486`, keyed by the question's slot) and its
  answers in a module-local `answers` `Map` (`:488`) inside `makeCapTP` — there is
  **no** `questions` `Map`; the settlement machinery is the `settlers` map. The
  injectable `CapTPImportExportTables` seam (`captp.js:100-111`, whose default
  binding is the exported `makeDefaultCapTPImportExportTables`, `captp.js:121`,
  passed as the `makeCapTPImportExportTables` option to `makeCapTP`, `:292`)
  exposes import/export slots **only**, not question/answer settlement. So the
  daemon's formula graph cannot refcount over question resolution until
  `@endo/captp` grows a **new `makeCapTP` option** — a question/answer observation
  hook that lets the embedding daemon learn when a question settles, spelled
  beside `makeCapTPImportExportTables` in the options bag (`@endo/captp`'s
  `exports` map is a single `"."` re-exporting `./src/captp.js`, so the addition
  is an option on the public `makeCapTP`, not a new module export). The precedent
  for an additive, no-wire-change observation seam of this shape is the landed
  **`provideImport`** hook — but that seam lives in **`@endo/ocapn`**
  (`packages/ocapn/src/client/ocapn.js`, `client/index.js`; consumed by
  `packages/thixotrope/src/daemon.js`), **not** in `@endo/captp`; it is an
  import-*provisioning* hook of shape `({type, position}) => object`, cited here
  only as the *precedent for additivity*, not as an in-package `@endo/captp`
  identifier. That is an `@endo/captp` API addition, internal to the
  implementation, **not** an OCapN wire addition, and the README "S / research
  doc" sizing rests on building it. The Dependencies table records this
  prerequisite explicitly.

**The reference-counting GC operations must *not* be promoted to the
authoritative trigger, and here the design holds the Thread 3 discriminator
rather than assert it passes.** By the discriminator (Thread 3): a message a peer
*sends* is admissible whatever prompted it; what is inadmissible is keying on
*your own* finalizer or on *timing*. So the two GC operations split by *whose*
finalizer drives them:

- **A counterparty's `op:gc-exports`** (an `export-pos-list` with per-ref
  `wire-delta`s) is the counterparty telling *you* it dropped a **direct import**
  of your anonymous intermediate. It is a **wire message the counterparty sent**,
  so it is admissible as authoritative (once it arrives) for the one fact
  resolution cannot tell you: whether a counterparty that *directly imported* the
  intermediate still holds it. This is the **fourth (cross-peer) window**: the
  intermediate can be reachable not only through your unsettled question but
  through a counterparty's direct import, and *that* edge is dropped when the
  counterparty's daemon collects its handle — signalled to us by a **`remove` in
  the cross-peer retention set** (`accumulator.remove(...)`, `manager.js:1602`,
  driven by the peer daemon's own graph-change stream), which arrives
  asynchronously (a network round trip; `retention-accumulator.js` batches on
  `queueMicrotask` then streams). **Name the signal precisely: the cross-peer
  retention-set `remove`, not `op:gc-exports`.** The two are *not*
  interchangeable. `op:gc-exports` is emitted only through captp's weak-import GC
  (`releaseSlot`, reachable only when `gcImports: true`, `captp.js:135,291`), and
  `gcImports` defaults `false` with **no** daemon call site enabling it; even
  enabling it is engine-conditional (`finalize.js:56` silently falls back to a
  strong `Map` when `WeakRef`/`FinalizationRegistry` are absent, and XS-shaped
  workers reap only at forced points), so `op:gc-exports` is emitted nowhere in
  the stock daemon. The retention-set `remove`, by contrast, is the daemon's own
  graph-driven drop and is independent of `gcImports`. **So the release condition
  is not resolution alone**; it is a conjunction: the intermediate collects only
  when **(i)** the `question` edge is dropped (resolution), **and (ii)** no
  cross-peer import edge references it (the retention-set `remove` has arrived, or
  none was ever added — see the residual below), **and (iii)** the exporter's own
  answerer-side `answers`/export-table entry is retired via the new bounded
  `@endo/captp` answer-retirement authority (Q1's third window: no landed
  `CTP_DROP` path retires this namespace-mismatched entry, so absent that
  authority a late pipelined send silently rebinds against the retained handled
  promise rather than collecting). **Conjunct (iii) is bound to the *final
  release* mutation — the one that fires when (i) *and* (ii) both hold — not to
  the `question`-edge drop at resolution.** Binding it to resolution would retire
  the `answers`/export-table entry while conjunct (ii) is still false (a
  cooperative peer still directly imports the intermediate); that is `CTP_DROP`'s
  last-reference branch run early, and the peer's next direct use would then hit
  `Unknown export` → the silent hang this very window forbids, inflicted on the
  cooperative peer conjunct (ii) exists to protect. Conjunct (iii) is the fifth
  retention root — the embedding CapTP library's own table — that a release
  condition stated only over the daemon's formula graph would miss; it is lifted
  out of the resolution mutation and into the final-release mutation. Releasing on
  resolution alone would collect an intermediate a counterparty still holds,
  exactly the "a working reference just went bad" class Thread 1 rules out.
  - **Residual conjunct (ii) rests on, stated plainly.** The retention-set
    `remove` is a live signal **only if the anonymous, never-named
    question-rooted intermediate is published in the peer's retention set in the
    first place.** The retention set is anchored on formula IDs
    (`retentionEdges: Map<agentId, Set<formulaId>>`), and the anonymous
    intermediate does have one, but whether a *directly imported anonymous
    intermediate* joins the published set — versus only *named* retained formulas
    doing so — is the load-bearing open point. If it does **not**, conjunct (ii)
    has no live drop signal for such intermediates, every one of them falls
    through to lease expiry, and the row-3 forcible drop below becomes the
    **default release path against honest peers, not the adversarial exception**.
    The design commits to the affirmative requirement: an anonymous intermediate a
    peer directly imports **must** carry a cross-peer retention edge so its
    `remove` is observable; the batch-flush root's "cooperative peers do not pay
    the row-3 tax" claim is scoped to that requirement holding, and closing it is
    listed in the Test Plan and Dependencies. Absent it, the honest reading is that
    the whole-interval lease is the primary release path and the tax is universal —
    which the design would then own rather than deny.
  - **Adversarial-peer hole this fourth window opens, and how it is bounded.**
    Making release depend on *both* resolution *and* absence of a cross-peer
    import edge means an adversarial but **non-disconnecting** peer can pin an
    anonymous intermediate indefinitely by a shape the Q2 bounds as originally
    stated do **not** catch: it resolves its own question promptly (so the
    `question` edge drops) yet simply **never emits `op:gc-exports`** for its
    direct import (so the cross-peer edge never drops). Session-abort does not
    fire (the peer stays connected); the **per-root lease as stated in Q2 does
    not fire either** (its trigger was "the question never settles," and here the
    question *did* settle — there is nothing left to reject); and the admission
    cap bounds *new-root admission*, not the *release* of a root whose question
    already settled. So the Q2 conclusion's unqualified "bounded against both
    crashed and adversarial peers" is **falsified by this one input shape** unless
    the lease is extended. **Rule (the extension this design commits to):** the
    per-root lease bounds the **whole** retention interval, not merely the
    pre-resolution wait — it continues to run across resolution and bounds the
    **post-resolution wait on the cross-peer import edge**. On expiry with the
    question already settled but a cross-peer edge still outstanding, the daemon
    **forcibly drops the cross-peer edge for this anonymous intermediate and
    collects it**, which the still-importing peer then observes as a broken
    reference on its next use, rather than retaining unboundedly. This keeps the
    cross-peer correctness rule (never collect an intermediate a *cooperative*
    peer still holds) while restoring the bound against a peer that *withholds* its
    `op:gc-exports`.
    - **What failure class this is, applying Thread 1's discriminator rather than
      name-dropping it.** Thread 1's taxonomy table (§ *So the design axis is
      sharper*, rows 3–4) is not collective-versus-single alone; its operative
      axis is *what is severed*. A
      forcible post-resolution drop severs a **settled import** the peer holds on
      a still-live session with every sibling reference intact — that is Thread 1's
      **row 3** (involuntary single-reference sever, the "a working reference just
      went bad" novel class), **not** row 4 (kill-the-worker's collective break)
      nor row 2 (E `partition`). This design does **not** claim the collective
      distinction excuses it; it **owns the row-3 tax** and bounds *who pays it*:
      the forcible drop fires only against a peer that has withheld `op:gc-exports`
      past the whole-interval lease, so a **cooperative** peer (which emits
      `op:gc-exports`, dropping the edge before the lease expires) never sees it,
      and the pervasive-defensiveness tax is levied only on a peer already
      misbehaving — never on an honest program's working references. That is the
      justification, not "the program already tolerates it": it is a bounded
      backstop that trades a single sever *of a misbehaving peer's* import for
      unbounded retention, chosen with eyes open. The pre-resolution lease
      rejection (mechanism (i) above) and the admission-cap refusal are a *weaker*
      class still: they break or refuse an **unsettled question / pipeline
      transient** — a promise, whose breaking or refusal is ordinary partial
      failure the program already handles everywhere — so they never sever a
      settled reference at all and do not incur the row-3 tax.
    - The honest residual: the lease's expiry clock is host-local
    (Design Decision 3), so this is a bounded-retention-then-partition guarantee,
    not a zero-retention one; the alternative — dropping the unqualified "bounded"
    claim and scoping post-resolution cross-peer retention as inherited risk — is
    strictly weaker and is declined.
- **`op:gc-answers`** (an `answer-pos-list`, no wire-delta because only the
  questioner references an answer-pos) is *"emitted from the questioner's local
  finalizer when its question representation is collected."* From *your* side, an
  "answer-pos refcount reaching zero" reported by the *remote's*
  `FinalizationRegistry` cannot be relied on to *arrive*, so its **absence** must
  never be the signal, and you must never key on *your own* finalizer. It is
  admitted **only as the sanctioned optimization hint** ("the questioner has
  provably dropped its reference, so it is safe to release *now* rather than wait
  for resolution"), never as the release fact. The residual cost is bounded: a
  peer that never fires `op:gc-answers` costs at most retention until the question
  **resolves** (`fulfill` / `break`) or the Q2 bounds fire (per-root lease,
  per-session abort), all wire facts or local bounds that emit a break.

So the batch-flush root is a **bookkeeping detail inside one daemon's formula
graph**, keyed on resolution plus the cross-peer import condition, requiring
nothing new from the OCapN wire (only a new `@endo/captp` observation seam), and
is *better understood as a specialization of the refcounted import/export drop
protocol the kernel already runs* (`deliverDropExports` / `deliverRetireExports`)
than as a new primitive.

**A documented gap to state plainly:** there is **no explicit *"nothing further is
forthcoming on this pipeline"* wire message** in the OCapN CapTP spec; the only
GC/teardown signals are `op:gc-exports`, `op:gc-answers`, and `op:abort` (session
sever). So a design that *required* an explicit quiescence marker would be
proposing a genuine protocol addition. The claim here is the opposite: the marker
is **not needed**, because the batch's flush is fully reconstructible from *(a)*
resolution (`fulfill` / `break`, after which further pipelining against that
promise is not well-formed, the **authoritative** trigger for the question edge),
*(b)* a counterparty's `op:gc-exports` / retention-set `remove` for the
cross-peer import edge, *(c)* the per-root lease and per-session admission bounds
for a question that never resolves (Q2), and *(d)* `op:abort` collapsing the whole
session's roots. (`op:gc-answers` may release a root *earlier* than (a) as the
optimization hint above, but is never the release fact.) The burden of proof is on
exhibiting a reachable pipeline state that is *neither* resolved *nor* covered by
a cross-peer drop *nor* lease/abort-bounded; absent such a state (and the spec
surface suggests there is none) **no OCapN wire addition is warranted.** If one
were ever found, it would be a per-implementation daemon signal, never an OCapN
wire primitive (next paragraph).

**And if it *were* Endo-formula-specific machinery, it should not go into OCapN.**
OCapN aims to stay a minimal, general interop layer across CapTP implementations
that may have **no notion of "formulas"** at all (or may already run an
equivalent c-list GC). An embargo-specific "batch" primitive in OCapN would push
Endo-internal retention bookkeeping into the shared protocol, the wrong layer.
The move, if anything, is to **generalize the mechanism the kernel already runs
at the c-list level**, per-implementation (which is what the new `@endo/captp`
observation seam does), not to add a primitive to the wire.

### Recommendation (Thread 5)

**Build it, but build the reframing, not the framing.** Recommend implementing
the batch-flush retention root **as a specialization of CapTP question/answer
reference-counting inside the daemon's formula graph** (a
`question:<session>:<answer-pos>`-labeled transient edge, union-find-pinned while the
question is unsettled), released on **resolution** plus the cross-peer import
condition of Q4, bounded by the three Q2 mechanisms (session-subordinate abort,
per-root lease, per-session admission cap). This:

- resolves Thread 2's ergonomics cleanly: the anonymous formula for a
  passed-live-value gets a real, protocol-defined liveness interval, with the
  formula ID never guest-observable (Thread 2's Distributed Confinement rule
  carries over unchanged: the anonymous export is still just a c-list slot to the
  guest);
- satisfies Thread 3: the authoritative liveness clock is a protocol-level fact (a
  question settling, plus a counterparty's drop message), not a local-GC artifact,
  while the Q2 bounds are honestly labeled as local policy that emit a break, not
  as protocol facts;
- needs **nothing from the OCapN wire** for the two-party case, though it does
  need a new `@endo/captp` observation seam (Q4);
- is bounded against both crashed and adversarial peers **provided the per-root
  lease bounds the whole retention interval** — including the post-resolution wait
  on a cross-peer import edge that an adversarial but non-disconnecting peer can
  otherwise pin indefinitely by resolving its question yet withholding its
  `op:gc-exports` (Q4's fourth-window shape). Without that lease extension the
  "bounded against adversarial peers" claim is false for that one input shape; the
  design commits to the extension (Q2 mechanism 2, Q4), so the bound holds as a
  bounded-retention-then-partition guarantee, not a zero-retention one. This bound
  is **not** claimed to be free of Thread 1's single-sever tax: the
  post-resolution forcible drop is a row-3 sever of a settled import, whose cost
  this design owns and confines to the *withholding* peer (a cooperative peer,
  which emits `op:gc-exports`, never triggers it — Q4's discriminator subsection);
  the pre-resolution lease and admission cap act on unsettled transients and are
  ordinary partial failure.

**Decline** the novel-primitive framing (a bespoke embargo-specific "batch"
concept) and **decline** any OCapN wire addition. **Defer** the multi-party scope
explicitly until Endo's three-party handoff embargo lifetime is an observable
protocol state (Q3); do the two-party pipelined-question case first.

This is a *recommendation to build a modest, well-bounded generalization of
existing machinery*, not a recommendation to build the proposal as literally
worded.

## Design Decisions

1. **Kill-the-worker is the backstop for already-seated direct references, not
   the preferred revocation path, and provenance is recorded at grant time.**
   Where the daemon mediates introduction, a forwarder/`named`-edge revocation
   (holder sees partition, no collateral) is better; kill-the-worker is reserved
   for the one case a caretaker cannot reach, a direct reference already in a
   worker's heap (Thread 1). Provenance (was this reference introduced through a
   host-mediated forwarder, or seated directly in a worker's heap?) is a fact
   about the **introduction event**, not a property to be re-derived by inspecting
   a worker heap later, so it is **recorded on the labeled-edge graph at grant
   time** (the export table already records whether the daemon ever seated a slot
   in a given worker, so provenance is partly decidable from data the daemon
   already holds). **Fail-safe default:** where provenance was not recorded, the
   daemon cannot prove a revoked capability is reachable only through
   host-mediated forwarders, and *unknown provenance implies kill*. Recording
   provenance at grant time makes that fail-safe an **optimization boundary that
   shrinks as more edges carry provenance**, not a permanent universal kill:
   revocation fails toward collateral, never toward silent under-revocation, but
   the set of references that hit the fail-safe narrows to those genuinely of
   unknown provenance (Thread 1; Open Question Q5).

2. **The value-to-formula-ID map is the CapTP export table, daemon-private, and
   this is a tightening the design commits to, not a laundering of existing
   exposure.** No formula ID or derived locator may appear in any guest-reachable
   value, result, or error reachable through the value-passing sugar, and no
   guest-supplied `endowments` entry may carry a formula-identifier string in lieu
   of a live presence (both directions of the call). This does **not** hold
   uniformly today: the general `GuestInterface` already exposes `identify` /
   `locate` **and** `lookupById` / `storeIdentifier` (only the least-authority
   guest withholds them), so a general guest can already redeem a formula
   identifier. That pre-existing exposure is a separate live question (Open
   Question Q6); this decision commits only that the new sugar adds no new leak
   and inherits the retention-paths host-only rule (Thread 2).

3. **The authoritative liveness signal is a protocol-level fact; local bounds
   emit a break and are labeled as such.** The batch-flush root's authoritative
   release trigger is **resolution** (`fulfill` / `break`, a wire fact) plus the
   cross-peer **retention-set `remove`** for a direct import (`manager.js:1602`,
   the daemon-graph-driven drop; `op:gc-exports` would be admissible too but
   requires `gcImports: true` and is emitted nowhere in the stock daemon, so the
   retention `remove` is the operative signal); `op:gc-answers` and any local
   finalizer are admitted **only** as
   an optimization hint that may release *earlier*, never as the release signal
   (Thread 3; Q4). The Q2 bounds (per-root lease, per-session admission cap) are
   **not** claimed to be protocol-level liveness facts: they are host-local
   clock/policy bounds whose *output* is a partition-shaped break, which is itself
   wire-visible. Authoritative *release* (wire fact) and local *bounds* (that emit
   a break) are distinct, and this decision does not overclaim that every
   mechanism is a protocol fact.

4. **Worker discipline is an explicit per-worker constraint on the incarnation
   formula, modeled as a discriminated union so incoherent combinations are
   unrepresentable.** `WorkerDiscipline` is
   `{ discipline: 'orthogonal-persistence' } | { discipline: 'durable-succession' } | { discipline: 'ephemeral' }`,
   reusing the `@endo/exo` heap/durable strata rather than a
   `persistence`/`upgrade`/`identity` product type with a request-time rejection
   function. It rides the exported `WorkerFormula`
   (`packages/daemon/src/types.d.ts`) as a **new optional field
   `discipline?: WorkerDiscipline`** — named `discipline`, not `kind`, because
   `WorkerFormula` already carries an unrelated `kind?: 'locked' | 'node'`
   (`types.d.ts:176-181`) — defaulting to `'orthogonal-persistence'` when absent
   so existing durably-persisted formula JSON stays readable. Per-edge `named`
   vs. `worker-import` identity is **not** part of this descriptor; it stays a
   grant-time per-edge choice, so one worker can hold both edge kinds. Coherence between a `durable-succession` worker and its inbound
   edges is checked **per-edge at succession time** (when the edges exist), not at
   worker-request time (when they do not). Mirrors SwingSet vat managers and
   thixotrope's three engines (Thread 4).

5. **Durable pending-promises are scoped, not solved.** Under
   `{ discipline: 'durable-succession' }` a durable promise resolves only to
   representable values and continues only through named durable handlers;
   anonymous `.then` over transient heap is transient by construction (Thread 4).

6. **The batch-flush root is a specialization of CapTP question/answer
   refcounting, not a new primitive and not an OCapN wire change**, released on a
   conjunction of three facts — **(i) resolution** (`fulfill` / `break`) *and*
   **(ii)** the absence of any cross-peer import edge (signalled by the cross-peer
   retention-set `remove`, `manager.js:1602` — **not** `op:gc-exports`, which
   requires `gcImports: true`, is engine-conditional, and fires nowhere in the
   stock daemon) *and* **(iii)** the retirement of the exporter's own answerer-side
   `answers`/export-table entry for the intermediate. Conjunct (iii) is bound to
   the **final-release mutation** (when (i) *and* (ii) both hold), **not** to the
   `question`-edge drop at resolution: `answers` is namespace-mismatched against
   every landed `CTP_DROP` path (Q1's third window), so retiring it early — while a
   cooperative peer still directly imports the intermediate — would run
   `CTP_DROP`'s last-reference branch prematurely and hang that peer. Because no
   landed `CTP_DROP` retires the entry on any configuration, conjunct (iii) needs a
   **new, bounded answer-retirement authority on `makeCapTP`**, distinct from and
   in addition to the question-*observation* seam. Bounded by
   session-subordinate abort plus a per-root lease that bounds the **whole**
   retention interval (both the pre-resolution wait *and* the post-resolution wait
   on an outstanding cross-peer import edge, closing Q4's adversarial fourth-window
   pin) plus a per-session admission cap over the transitively pinned closure whose
   check is atomic with the mint it guards (Thread 5, Q2). The release-path races
   (lease-expiry vs. resolution; admission check-then-mint) are closed by an
   idempotent single-owner edge drop and a single-mutation check-and-mint
   respectively. The daemon-internal mechanism
   is buildable today over the landed refcounted transient pin
   (`pinTransient` / `unpinTransient`), refined from single-operation to
   single-question lifetime; it depends on **two** new `@endo/captp` seams (a
   question-observation hook and the bounded answer-retirement authority, Q4) but
   on **no** unlanded guest-facing API. The separate guest-facing
   `{ id, release }` handle from the *Proposed* `makeRetainedValue` surface
   ([chat-slot-slash-commands](chat-slot-slash-commands.md)) is Thread 2's sugar,
   not a prerequisite of the mechanism.

## Test Plan

Each binding Design Decision and enumerated hazard window carries a verification
obligation, so the doc's bar ("closed by an explicit rule, not asserted away") is
checkable rather than asserted. Where the obligation is a universally-quantified
rule or a race, it is stated as a **property** (`@fast-check/ava`; `@endo/daemon`
would take the `fast-check` devDependency, already in the catalog as
`catalog:dev`), because example-based cases pin only the shapes that exist today.

1. **Partition-shape on arrival-after-collection (Q1 third window, DD6).** A
   pipelined send against a settled-and-collected anonymous answer position must
   fail **partition-shaped** — never a silent rebind to the resolved value, never
   an exporter hang, never a crash. Three cases: (a) entry retired then message
   arrives (expect a `CTP_RETURN` break); (b) message against a never-minted
   answer position (same break); (c) two live anonymous intermediates are
   distinguishable so a collected one is never serviced by its neighbour. This is
   the test that would have caught the `answers` namespace mismatch: it reddens if
   the bounded answer-retirement authority is absent or wrong.
2. **Release conjunction ordering (DD6 conjunct iii).** Retiring the exporter's
   `answers`/export-table entry must fire in the **final-release** mutation, not at
   resolution: assert that with the question resolved but a cross-peer import edge
   still present, the entry is **retained** and the peer's direct use still
   succeeds; and that it is retired exactly when the last of (i)/(ii) completes.
3. **Idempotent single-owner drop (Q2 fifth window, diamond/N-referrer).**
   `fc.property(fc.array(fc.constantFrom('resolve','lease','gcExports','abort'), {minLength:1,maxLength:8}), triggers => { apply(triggers); return collectCount === 1 && deepEqual(state, applyOnce()); })`
   — any permutation of release triggers yields one collection and the same
   terminal graph. Covers the N-way simultaneous settle.
4. **Admission-cap TOCTOU and monotonic growth (Q2 mechanism 3).**
   `fc.asyncProperty(fc.scheduler(), fc.array(mintArb, {minLength:2,maxLength:10}), async (s, reqs) => { …; await s.waitAll(); return pinnedClosureSize() <= cap; })`
   for the check-then-mint race (the scheduler shrinks to the exact interleaving),
   plus a graph-shaped property that later unions of a question-rooted group do not
   push a session over cap (the monotonic-growth hole). Boundary sweep: cap `0`,
   `<` vs `<=` at exactly-cap, a single send whose own closure exceeds cap
   (wedge-not-bound), per-session vs per-peer aggregate.
5. **Session-unique question edge (Q1/Q2).** Two concurrent sessions both at
   answer-pos 3 must produce **distinct** `question:<session>:<answer-pos>` edges;
   peer B's resolution must not drop peer A's root; a duplicate answer-pos within
   one live session is rejected.
6. **Distributed Confinement, universally quantified (DD2).**
   `fc.asyncProperty(fc.constantFrom(...guestMethodNames), fc.array(arbPassable), async (m, args) => { const out = await E(guest)[m](...args).catch(e => e); return !containsFormulaId(out); })`,
   where `containsFormulaId` deep-walks the result **and** the rejection's
   `message`/`details` for the 256-bit identifier shape (the doc names an error
   message as a leak vector). The method-name arbitrary makes a *future* method's
   leak fail on the day it is added.
7. **Lease clock is injected (Q2 mechanism 2, transplanter).** A test-injected
   clock drives lease expiry; an ambient-`setTimeout` lease on the XS target
   (delay discarded) must **not** be reachable — a regression test that the timer
   power is threaded, not ambient.
8. **Boundary catalog (corner-prober).** Lease clock discontinuities
   (suspend/resume expiring every lease at once); the release-trigger set is
   `{resolution, lease, op:abort, forcible cross-peer drop}`, not two elements;
   succession-time coherence-check failure behavior (abort vs. proceed vs. kill)
   is exercised, not left unspecified.

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-cross-peer-gc](daemon-cross-peer-gc.md) (Complete) | Supplies the retention-set plus retention-edge substrate and the `retention-accumulator` batching primitive. The cross-peer `remove` delta (`accumulator.remove`, `manager.js:1602`) is the authoritative signal that a counterparty dropped a *direct import* of an anonymous intermediate (Q4's fourth window), driven by the peer daemon's own graph — **not** captp's `op:gc-exports`, which requires `gcImports: true` and fires nowhere in the stock daemon. |
| [daemon-retention-paths](daemon-retention-paths.md) (In Progress) | Supplies the labeled-edge graph model, the `transient` root, and the host-only confinement rule this design extends with a `question:<session>:<answer-pos>` edge. |
| [ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) (In Progress) | Supplies the name hub / `named` vs. `worker-import` edges (Thread 1, Thread 4), the at-most-once abort plus tombstone machinery (Thread 5-Q2), and the lease/expiry follow-up (Thread 5-Q2). |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Supplies the "admission control eliminates embargo" pattern the per-session root cap borrows (Thread 5-Q2). |
| [chat-slot-slash-commands](chat-slot-slash-commands.md) (Proposed, Not Started) | Supplies the **not-yet-landed** `makeRetainedValue(spec)` guest-facing surface (Thread 2's sugar), whose `RetainedValueSpec` (`type: 'eval'`, `codeNames`, `endowments`) the worked example uses. The daemon-internal batch-flush edge does **not** depend on it; it is buildable over the landed `pinTransient` / `unpinTransient` pin. **Amendments this design requires of it (both recorded here so one method does not carry two signatures across two Proposed docs):** (1) split the `endowments` arm from `(PetNamePath \| FormulaIdentifier)[]` into per-facet `GuestEndowment` / `HostEndowment` (Thread 2 input side); (2) amend the **guest** arm's return from `{ id: FormulaIdentifier, release }` to a `release`/presence (no `id` string) so it does not leak a formula ID (Thread 2 output side). |
| `packages/captp` — **two** new `makeCapTP` seams | The import/export tables (`makeCapTPImportExportTables`, default binding `makeDefaultCapTPImportExportTables`, `captp.js:121`) the sugar's identity lookup keys off (Thread 2). **Prerequisites for Thread 5, both `@endo/captp` API additions (not OCapN wire changes):** (1) a **question-observation** hook — in-flight questions live in a module-local `settlers` `Map` (`captp.js:486`) and answers in a module-local `answers` `Map` (`:488`) inside `makeCapTP` (no `questions` `Map`), and `CapTPImportExportTables` exposes import/export slots only, so the daemon cannot refcount over question resolution without it (Q4); (2) a **bounded answer-retirement authority** — `answers` is namespace-mismatched against every landed `CTP_DROP` path (Q1's third window), so *no* landed call site retires an anonymous intermediate's `answers` entry on any configuration; conjunct (iii) of the release condition needs a new bounded seam to retire it in the final-release mutation. The precedent for an additive, no-wire observation seam is the landed `provideImport` — which lives in **`@endo/ocapn`** (`packages/ocapn/src/client/`), not `@endo/captp`; cited for shape only. |
| `packages/daemon` XS timer power | The per-root lease's expiry clock must be an **injected** timer power per target: the XS daemon's `setTimeout` polyfill discards its delay (`bus-xs-daemon-polyfills.js:54-60`), so an ambient-timer lease expires immediately on XS and falsifies the Q4 bound there. Precedent: `retention-accumulator.js:31` (injected clock), `manager-node-powers.js:545` (real Node timer). |
| `packages/ocapn` three-party handoff | **Blocking** for the multi-party scope of Thread 5 (Q3): the embargo lifetime must be an observable protocol state. |

## Citations to prior art

- **E promise / partition semantics.** Miller, Tribble & Shapiro, *Concurrency
  Among Strangers* (2005, TGC, LNCS 3705), §9-10: the reference-state machine
  (UNRESOLVED to RESOLVED{near, far, broken}); the `partition` transition breaks
  **all** references crossing a vat boundary in one direction *simultaneously*
  (eventual-common-knowledge); fail-stop FIFO; the `_whenBroken` /
  `_whenMoreResolved` / `_reactToLostClient` handlers and the `when` / `catch`
  surface. Establishes that E has no single-reference sever (Thread 1).
- **Caretaker / revocable forwarder.** Redell (1974) (the caretaker
  construction); Miller, Yee & Shapiro, *Capability Myths Demolished* (2003), the
  *forwarding facet* / *revoking facet* coinages behind Endo's
  `Handle`/`HandleControl` (Thread 1).
- **SwingSet c-list and refcounted drop/retire.** The GC delivery vocabulary
  `deliverDropExports` / `deliverRetireExports` / `deliverRetireImports` /
  `deliverBringOutYourDead`, `VatOneResolution` (`@agoric/swingset-liveslots`),
  and the three-separate-GC-domains discipline, as carried into MetaMask's
  `ocap-kernel` (Erik Marks, Chip Morningstar, et al.). Note Endo itself does
  **not** run kernel-style cross-vat refcount GC internally; it reclaims via
  formula-graph reachability (Threads 1, 3, 5).
- **OCapN / CapTP spec language.** *CapTP Specification.md* (kriscendobot/ocapn,
  commit `8704f69e`, Jessica Tallon): promise resolution is **`fulfill`** /
  **`break`** (no "settle" verb); GC via **`op:gc-exports`** (export-pos-list plus
  wire-delta, refcount to 0) and **`op:gc-answers`** (answer-pos-list, no
  wire-delta); session teardown via **`op:abort <reason>`**; pipelining wire form
  `<desc:answer answer-pos>` (lineage: Liskov & Shrira (1988); Bogle & Liskov,
  *Batched Futures* (1994); Udanax Gold, Miller (1992)); three-party handoff
  `deposit-gift` / 32-byte `gift-id` / `desc:handoff-give` / `desc:handoff-receive`.
  **Gap:** the library documents no CapTP *embargo* mechanism and no explicit
  "nothing-further-forthcoming" wire message (Threads 3, 5). Note also that
  CapTP tracks in-flight questions in a module-local `settlers` `Map`
  (`captp.js:486`) and answers in a module-local `answers` `Map` (`:488`) inside
  `makeCapTP` (there is no `questions` `Map`), and the injectable
  `CapTPImportExportTables` seam exposes import/export slots only, so observing
  question resolution needs a new `@endo/captp` `makeCapTP` option (Q4). A second
  `@endo/captp` seam is also needed: `answers` is keyed by the peer's `q-N`
  question id (`:743`, `:852`) while `CTP_DROP` deletes `answers.delete(reverseSlot(slotID))`
  keyed to a `+`-direction export slot (`:756-767`), so the key spaces never
  intersect and no landed path retires an anonymous intermediate's `answers` entry
  on any configuration — the release condition needs a new bounded
  answer-retirement authority, not a coupling into `CTP_DROP` (Q1, Q4, DD6).
- **Distributed Confinement.** Miller & Shapiro, *Paradigm Regained* (2003), §5
  (the Cassie/Max `[Factory, factoryMaker]` example, *"only data and no
  capabilities"*); *Capability Myths Demolished* (2003), §5.2 (the Confinement
  Myth is false in the Model-4 object-capability model, *"behavior, not
  arrangement, does the confining"*); *"only connectivity begets connectivity"*
  and the four ways to acquire a reference (Introduction, Parenthood, Endowment,
  Initial Conditions); Close's designational-integrity *y-property* (2003)
  (Thread 2).
- **Exo persistence taxonomy and orthogonal persistence.** Miller, `@endo/exo`
  docs (heap / virtual / durable; virtual does not survive upgrade, durable
  survives via baggage to a successor incarnation); *why not orthogonal
  persistence* (Kris Kowal, endojs/endo#3121, draft: an upgrade may invalidate
  heap-snapshot assumptions, so reconstruction logic is unavoidable). **Gaps:**
  the garden library has no page for a "Mathieu Hofman worker model" and none for
  "zygote" snapshots; those are cited above as the conversation's positions, not
  library-backed facts (Thread 4).
- **In-tree Endo mechanisms.** `daemon-cross-peer-gc` (retention set plus
  `retention-accumulator`), `daemon-retention-paths` (labeled-edge graph,
  `transient` root, host-only rule), the landed **refcounted transient pin**
  (`graph.js` `transientRoots`, pinned/unpinned by `pinTransient` /
  `unpinTransient`, `packages/daemon/src/graph.js:629,645`; scoped per-operation at
  **some, not every**, landed call site — the clean `try`/`finally` form at
  `directory.js:506-510`, but leaking on throw at `host.js:2069`/`2090` and
  `manager.js:6737`/`6757` (see Thread 5's "some, not every" correction) — with no
  connection-lifetime or partition-triggered release built on it),
  `ocapn-orthogonal-persistence` (name hub, at-most-once
  abort, tombstone descriptors), `daemon-xs-worker-metering` (admission control,
  budget as pre-payment).
- **Proposed (not yet landed) Endo mechanisms.** The connection-bounded
  `makeRetainedValue(spec) -> { id, release }` surface and its `release` exo
  (*"carries no reference to the target value..."*, *"disk before graph"*) are
  **Proposed** API on `EndoHost`/`EndoGuest` in
  [chat-slot-slash-commands](chat-slot-slash-commands.md) (Status: Proposed;
  README row: Not Started), **not** extant code. Thread 2's sugar consumes that
  handle; the daemon-internal batch-flush edge does not.

## Open Questions

- [ ] **Q3 blocker:** what is the current state of three-party handoff embargo in
      `packages/ocapn`? The multi-party scope of the batch-flush root is deferred
      until its embargo lifetime is an observable protocol state; the two-party
      pipelined-question case does not wait on this.
- [ ] **Q4 residual:** is there a reachable pipeline state that is *neither*
      settled *nor* covered by a cross-peer drop *nor* covered by session abort, a
      real *"nothing further forthcoming"* fact not recoverable from existing
      messages? If not (the expected answer), no OCapN wire addition is warranted;
      if so, it is a per-implementation daemon signal, still not an OCapN
      primitive. Separately, the `@endo/captp` question-observation seam is a
      confirmed prerequisite, not an open question.
- [ ] **Lease policy:** what is the default lease duration / size cap for
      question-rooted anonymous formulas, and is it per-root, per-session, or
      both? Needs a concrete number calibrated against real pipelining depth,
      analogous to the metering hard-limit calibration. (The lease now also bounds
      the post-resolution cross-peer wait per Q4, so the calibration must cover
      that interval too, not only the pre-resolution embargo.)
- [ ] **Diamond / N-referrer simultaneous-settle atomicity:** when several
      unsettled questions reference one anonymous intermediate and their
      resolutions land in the same tick, the refcount must reach zero exactly once
      and the edge drop must be a single graph mutation. Q2's idempotent
      single-owner drop is stated for the two-path (lease-vs-resolution) case;
      confirm it composes to the N-way case (N resolutions decrementing one
      refcount) without a lost-decrement or double-collect, and state the rule if
      the general case needs more than "each decrement is one mutation."
- [ ] **Gift-id replay / double-redemption (Q3):** in the three-party handoff,
      the deposited gift is single-use and Receiver-bound, but a redemption
      attempt can race a second redemption attempt or a lease expiry. What is the
      single-use guard that makes redemption atomic (redeem-and-consume as one
      graph mutation), and how does it interact with the per-root lease firing
      mid-redemption? Deferred with the rest of the multi-party scope, but named
      here so it is not lost.
- [ ] **Worker-discipline coherence checkpoint:** confirm that the per-edge
      succession-time coherence check (a `durable-succession` worker's inbound
      references that must survive succession are `named`, not `worker-import`) is
      the right checkpoint, and enumerate the concrete failing edge shapes it
      rejects. This replaces the earlier "reject incoherent
      `persistence`/`upgrade`/`identity` combinations at worker-request time,"
      which named a checkpoint at which the inbound edges do not yet exist.
- [ ] **Q5, Thread 1 boundary:** can the daemon record enough provenance at grant
      time (from the export table and labeled-edge graph) to decide, at revocation
      time, whether a target is reachable by a *direct* in-heap reference (needs
      kill-the-worker) vs. only through host-mediated forwarders (can revoke
      without collateral)? Design Decision 1 records provenance at grant time so
      the fail-safe shrinks; this question is how far that recording can go before
      the residual unknown-provenance set is negligible. Until it is, the fail-safe
      governs (unknown provenance implies kill), so this is an optimization (avoid
      needless collateral), never a soundness gap.
- [ ] **Q6, pre-existing general-guest formula-ID exposure:** the general
      `GuestInterface` wires **ten** formula-ID / locator methods, not the four an
      earlier cut named. `packages/daemon/src/guest.js:343-364` wires `identify`,
      `locate`, `lookupById`, `storeIdentifier` **plus** `reverseIdentify`,
      `reverseLocate`, `listIdentifiers`, `listLocators`, `lookupByLocator`, and
      `storeLocator`. Two of the six extras are strictly worse than the four:
      `listIdentifiers` **bulk-enumerates** formula IDs, and `lookupByLocator` is
      `provide(idFromLocator(locator))` (`guest.js:172`) — proving a locator is a
      one-line conversion to the ID, so the locator family is not a lesser
      exposure (and this doc's own input-side rule already forbids "no locator
      derived from one"). So a general guest can already reconstitute a capability
      from a formula-identifier **or locator** string, the ambient-authority "fifth
      way," and a follow-up that closes only the four leaves the channel open
      through the other six. Is that intended (general guests are trusted more than
      least-authority guests) or a live Distributed Confinement defect to close?
      This is pre-existing surface, out of scope for the value-passing sugar
      (Design Decision 2 commits only that the sugar adds no new leak), but it must
      be adjudicated on its own and over **all ten** methods.

## Prompt

> Research worker retention, revocation, and the batch-flush idea against
> ocap-kernel/SwingSet, E, and Hofman's no-orthogonal-persistence worker model,
> and produce a design document that either proposes a concrete direction or lays
> out the alternatives with their trade-offs precisely enough for the maintainer
> to decide. Reassess the daemon's kill-on-sweep revocation stance; evaluate the
> batch-flush retention root on its merits (the four numbered questions); take a
> position on worker-type-as-constraint; keep every path clear of making a formula
> identifier guest-observable (Distributed Confinement); cite the prior art. It is
> fine to conclude "not yet, because X" on any thread as long as the reasoning is
> explicit.
