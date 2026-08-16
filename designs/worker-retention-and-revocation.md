# Worker Retention, Revocation, and the Batch-Flush Retention Root

| | |
|---|---|
| **Created** | 2026-08-16 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

This is a **reassessment**, not a mandate to conclude. The daemon holds a
principled stance on retention and revocation; a design conversation
(2026-08-16) put that stance next to several adjacent systems (ocap-kernel /
SwingSet, E, Mathieu Hofman's no-orthogonal-persistence worker model) and
surfaced one concrete extension — a **batch-flush retention root** — worth
evaluating on its merits. Each thread below either lands a recommendation or,
where the conversation left a genuine open question, lays out the alternatives
precisely enough for the maintainer to decide. "Not yet, because X" is an
acceptable outcome on any individual thread as long as the reasoning is
explicit.

### The recorded stance under reassessment

The daemon's current invariant: a value incarnated from a formula lives only as
long as some **name** keeps it reachable — a pet-store entry, or transitive
reachability through other named formulas. Every daemon invocation sweeps
everything not reachable by name, and the sweep is enforced as **actual
revocation, not bookkeeping deletion**: if a worker process still holds a live
in-memory reference to a swept value, the sweep **kills the worker**, because
otherwise deleting the formula record would be cosmetic — the worker could keep
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
  **groups** cluster mutually-reachable formulas so that a root pins an entire
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
- **Disincarnation** (`cancelValue`, `daemon.js`): drop the in-memory exo and
  abort ongoing work for an ID **without** removing the formula JSON; the next
  access reincarnates from disk. This is the *soft* form; the *hard* form is
  killing the worker whose heap holds a swept reference.
- **The name hub** ([ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md)):
  a durable `name → (workerId, slot)` table that makes the durable unit of
  identity a *name binding* rather than a stateful code instance, so upgrade is
  succession + rebinding rather than in-place code swap. `named` export
  descriptors resolve through the hub per-delivery; `worker-import` links pin the
  origin `(workerId, slot)` forever (EQ-stable). This is the same
  petname/edge-name distinction one layer down.
- **Admission control** ([daemon-xs-worker-metering](daemon-xs-worker-metering.md)):
  the supervisor delivers a message only when the worker's remaining budget
  exceeds the hard per-crank limit — *"admission control eliminates embargo."*
  The relevant precedent for bounding an open retention root without buffering
  or rollback.

## Thread 1 — Kill-the-worker vs. surgical partition

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
slots to kernel objects). The GC is driven by explicit deliveries into each vat
— in `ocap-kernel`'s router the four GC delivery types are
**`deliverDropExports`** (a vat has no more in-heap references — decrement the
kernel refcount), **`deliverRetireExports`** / **`deliverRetireImports`** (the
object is gone — tombstone the slot so a later use fails *loudly* rather than
silently rebinding), and **`deliverBringOutYourDead`** (the vat-local finalizer
reap). This is a genuine **reference-counted distributed GC** at c-list
granularity, and it is what lets a kernel collect a cross-vat object precisely
when the last importer drops it. (The vocabulary is SwingSet/liveslots
imported verbatim — `VatOneResolution`, `bringOutYourDead` — and the discipline
keeps three GC domains strictly separate: kernel cross-vat refcount GC,
per-vat liveslots GC, and engine-level JS mark-and-sweep.)

But note *what* that machinery is for: it collects references that holders have
**voluntarily dropped** (`deliverDropExports` fires *because* the vat's own
finalizer observed the drop). Using the same c-list surgery to **involuntarily
sever** a still-held, still-working reference — revoking it out from under a
healthy holder — is a different act, and it is the act that imposes the tax. The
holder's vat is fine; its counterparty is fine; one previously-working reference
just stopped. Nothing in ordinary distributed-object programming prepares a
program for that: every eventual-send already tolerates *"my counterparty
died"* (ordinary partial failure), but *"my counterparty is fine but this one
edge went bad"* is a failure class programs do not consistently defend against.

### Refinement: E does not sever single references at all

The decisive correction to the conversation's framing comes from E's actual
reference-state machine (Miller, Tribble & Shapiro, *Concurrency Among
Strangers*, TGC 2005, Fig. 5). A reference is UNRESOLVED or RESOLVED{near, far,
**broken**}, and the transition that breaks a remote reference is
**`partition`** — which is **collective, not per-reference**: *"once a partition
occurs, all references crossing in a given direction between two vats break
simultaneously,"* and stay broken even after the partition heals
(the *eventual-common-knowledge* mechanism; messages are fail-stop FIFO). **E
has no operation that severs one live inter-vat reference while its siblings
survive.** Revocation of a *single* authority in E is done not by breaking a
reference but by the **caretaker pattern** (first described by Redell 1974;
formalized in *Capability Myths Demolished*, 2003, whose *forwarding facet* /
*revoking facet* coinages are the source of Endo's `Handle`/`HandleControl`
facet split): the holder is handed a forwarder, and dropping the forwarder makes
the holder's reference behave as an ordinary **broken reference**.

So the failure class the conversation worries about — *"a working reference just
went bad"* — is exactly the class that **neither E's partition (collective) nor
E's caretaker (holder sees a broken reference = partition-shaped) ever
produces.** It is producible only by c-list surgery on a *direct* reference, and
it is un-prepared-for precisely because the mainstream ocap tradition never
exposes it.

Endo already has names for both of its own mechanisms here, and they are the
right lens: **revocation-by-withdrawal** (the library's *"fourth revocation
mechanism,"* alongside inline caretakers, revocation lists, and expiry) —
withdrawing a *formula* cascades into disincarnation of the live reference,
*"immediate, local, requires no distributed protocol"* — is the sweep; and
**cohort-destruction** is the kill-the-worker choice. The library frames
cohort-destruction as Endo's deliberate *position between two poles*: Waterken
(partition-blind, masks failure) and E (per-reference defensive). Endo lands at
**exposed per-cohort**: a *cohort* (a capability plus its transitive live-
reference dependencies) is destroyed collectively on partition, then offered
**reconstruction on demand** — the *"pass by construction"* property. That is
precisely kill-the-worker: collateral within the cohort, partition-shaped
failure at the boundary, reconstruction from formulas afterward.

So the design axis is sharper than "kill-the-worker vs. partition." It is:

| Revocation mechanism | Failure the holder sees | Tax |
|---|---|---|
| Caretaker / revocable forwarder (E; Redell 1974; Endo `Handle`/`HandleControl`) | Broken reference = **partition-shaped** | None beyond ordinary partial-failure handling — **but** requires the forwarder to have been interposed *at introduction time* |
| E `partition` (collective break of all refs between two vats) | Broken reference to **everything** across that boundary = **partition-shaped** | None novel — it *is* ordinary partial failure |
| C-list surgery on a direct reference (involuntary single-reference sever) | *"A working reference just went bad"* — **novel** failure class | Pervasive defensiveness, not upheld in practice |
| Kill the worker (Endo cohort-destruction) | Broken reference to **everything** that worker held = **partition-shaped**; reconstruction on demand | Collateral damage to co-held capabilities |

### Conclusion (Thread 1): confirm, with a sharpened reason

The kill-the-worker choice is defensible, and the sharpened reason is stronger
than the original one. Both the caretaker and kill-the-worker collapse
revocation to partition-shaped failure; neither pays the pervasive-defensiveness
tax. The caretaker's precondition is that a forwarder was interposed **when the
reference was introduced** — which the daemon *cannot* guarantee for a reference
a worker **already holds directly in its own heap** (defense (a): the heap is a
second, uncontrolled source of liveness truth, and you cannot retroactively
interpose a caretaker on a slot already seated in someone else's memory). Given
that constraint, killing the worker is the only lever that reaches the direct
in-heap reference *without* introducing the novel failure class. Its distinctive
cost is **collateral** — everything else the worker legitimately held dies too —
and its distinctive benefit is that it needs no cooperation from the worker and
no forwarder to have been pre-positioned.

The honest residual: this argues for kill-the-worker **as the backstop for
already-seated direct references**, not as the *preferred* revocation path.
Where the daemon controls introduction, a caretaker/forwarder (revoke by
dropping a host-side forwarder, holder sees partition) is strictly better — no
collateral — and the daemon's own `named` edges through the name hub are already
this shape (rebinding a name reroutes without waking or killing a worker). The
recommendation is therefore: **prefer forwarder-mediated revocation wherever the
daemon mediates the introduction (named edges, host-side presences); keep
kill-the-worker as the only sound backstop for a direct reference already seated
in a worker's heap.** These are not in tension — they cover different reference
provenances.

## Thread 2 — Ergonomic value-passing vs. hidden formula identifiers

**Want:** pass a live value directly as a dependency of a new formula and let it
stand for the formula identifier behind it, instead of first binding it to a pet
name only to satisfy the by-name construction API.

**Hard constraint (Distributed Confinement; Miller & Shapiro, *Paradigm
Regained*, 2003, §5; erights.org):** guests must **never** observe the daemon's
cryptographic formula identifiers. The object-capability model confines *because*
capabilities are **non-discretionary** — there are no principals and no ambient
namespace, so *"only connectivity begets connectivity"* (Miller, *An Ode to the
Granovetter Diagram* / the four ways to acquire a reference: Introduction,
Parenthood, Endowment, Initial Conditions). A formula identifier a guest could
serialize or print is an **ambient-authority channel** — the illicit "fifth
way" — that lets authority be reconstituted without introduction, dissolving the
formal teeth confinement depends on. *Paradigm Regained*'s own resolution is that
**"behavior, not arrangement, does the confining"** (the Model-4 object-
capability answer to the Lampson/Boebert confinement objection): the confined
subject's state holds *"only data and no capabilities,"* which is exactly the
property a leaked formula ID would break.

### These are not in conflict — and the daemon already proves it

The resolution is that the value → formula-ID mapping is done **entirely on the
daemon's trusted side**, keyed off an object identity the guest's representation
cannot serialize. The daemon already has exactly this seam:

- Over the host–worker (and peer) CapTP boundary, a presence is seated in the
  **import/export tables** (`makeCapTPImportExportTables`,
  `packages/captp/src/captp.js`; `convertSlotToVal` /`convertValToSlot`). The
  guest holds an opaque **slot number scoped to its own c-list** — never the
  formula ID. The daemon side holds the export-table entry, and from it can
  resolve to the formula record.
- The daemon already resolves *"which formula is this presence"* internally:
  `host.identify(...namePath)` → locator, `locate()` → formula, and
  `listRetentionPaths(locator)` is **host-only, never on `EndoGuest` or the
  CapTP gateway** ([daemon-retention-paths](daemon-retention-paths.md) §"Why
  host-only"), precisely so a guest cannot enumerate host structure. The `endo
  paths` CLI resolves a pet name to a locator on the *host* side before calling
  the daemon; the locator string never crosses to a guest.

So the answer to *"is there a stable daemon-side identity for a live presence
that daemon-internal code can key off, across the eventual-send boundary?"* is
**yes: the export-table entry** (equivalently, the far-reference's slot on the
daemon's side of the c-list, which the daemon maps to a formula ID). The naive
implementation that would **leak** the identifier is any path that puts the
formula ID (or a locator string derived from it) into a *value the guest can
marshal* — a return value, an argument echoed back, an error message, a
debug/inspect surface reachable from the guest facet. The design rule:

> **The value → formula-ID resolution is a lookup in a daemon-private
> identity-keyed map (the export table), performed only by host/daemon code.
> No formula ID and no locator derived from one may appear in any value, error,
> or method result reachable through the guest facet or the CapTP gateway.**

This is the same rule the retention-paths design already enforces; the
value-passing sugar must inherit it. Any implementation that instead threads a
formula ID through guest-visible marshalling is a **Distributed Confinement
defect**, not merely an ergonomics wart.

### Conclusion (Thread 2)

Ergonomic value-passing is achievable within the constraint, because the
trusted-side identity (export table entry → formula record) already exists and
the guest already only ever sees an opaque per-c-list slot. What the sugar needs
is not a new identity mechanism but a **liveness interval** for the anonymous
formula it implies — which is exactly what Thread 5 supplies.

## Thread 3 — Heap-pressure heterogeneity forbids local-GC-timing liveness signals

**Principle to state explicitly:** a host's local garbage-collector timing (heap
size, generational behavior, when a major GC actually runs) is a property of
*that host*, not of the object graph. Keying a **distributed** liveness signal on
local GC / `FinalizationRegistry` timing lets **the laziest collector in the
network set retention policy for everyone downstream** — a large-heap host can
oblige a small-heap host to retain something the small host would have collected.
This is the standard argument for explicit refcounted import/export protocols
(SwingSet's `dropImports` / `retireExports`) over local-GC-driven distributed GC,
and it is the same reason the daemon's **sweep-by-name-reachability**
(deterministic, host-independent) is preferable to any scheme keyed on when a
particular process's GC happens to run.

`FinalizationRegistry` may act **only** as a *local optimization hint* — "this
local reference is provably gone, so it is safe to send the release/`dropImport`
message **now** rather than at the next sweep" — never as the authoritative
signal. The authoritative signal is always a **protocol-level fact** (a name
binding, a c-list refcount reaching zero via an explicit drop message, a
question settling), never a local-timing artifact.

**The test every mechanism in this document must pass:**

> Is the liveness signal a *protocol-level fact* (derivable identically by every
> peer from messages on the wire and durable state), or a *local-timing artifact
> wearing a protocol-level costume* (derivable only from when some process's GC,
> scheduler, or heap happened to reach a state)?

Applied here:

- **Name reachability** — protocol-level fact. ✅ (host-independent, deterministic)
- **Cross-peer retention set** — protocol-level fact: the publisher's authoritative
  set, streamed as explicit add/remove deltas, reconciled by re-send on reconnect
  ([daemon-cross-peer-gc](daemon-cross-peer-gc.md)). ✅
- **Batch-flush root (Thread 5)** — **must be** a protocol-level fact ("this
  question settled; no outstanding question references this export"), *not*
  "the pipeline's `FinalizationRegistry` fired." The whole appeal of Thread 5 is
  that a batch's flush is a fact about **message delivery**. The design must
  hold that line (see Thread 5, Q4): if "batch flushed" turned out to be
  derivable only from a local GC firing, it would fail this test and should be
  rejected.

## Thread 4 — No-orthogonal-persistence worker model and worker-type-as-constraint

The worker discipline the conversation attributes to Mathieu Hofman (this is the
conversation's attribution — the garden library has no page for it, so it is
cited here as a *position*, not a library-backed fact): a worker retains **no
heap or stack between message deliveries**; all durable state is explicitly
captured into durable storage between deliveries. Zygote snapshots remain usable
as a cold-start / performance optimization at an arbitrary checkpoint, never as
the definition of durable truth. Motivation: on-chain vat **upgrade** needs new
code to operate over old durable state without depending on heap/bytecode-layout
compatibility across versions — which orthogonal persistence (heap snapshot as
ground truth) cannot give you.

The library *does* ground the underlying claim. The Endo exo taxonomy (Miller,
`@endo/exo` docs) already stratifies exactly this: **heap** state *"dies with the
process,"* **virtual** state is externalized *"but does not survive upgrade,"*
and only **durable** state *"can survive upgrade, and so can be passed in
baggage to a successor vat-incarnation."* And the *"why not orthogonal
persistence"* material (Kris Kowal, endojs/endo#3121, draft) states the sharp
edge directly: *"An upgrade may invalidate assumptions encoded in a heap
snapshot; the program must reconstruct its working state from durable inputs
afterward … the orthogonal persistence machinery provides comfort during normal
operation but does not eliminate the need for reconstruction logic. Formula
Persistence accepts this reality as a starting point rather than discovering it
as a consequence."* This is precisely the coupling
[ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) §"Upgrade
without breaking orthogonality" refuses: it makes the durable unit of identity a
**name binding** and keeps vats pure, immortal-code, and disposable, so upgrade
is succession + rebind rather than in-place code swap over stable memory
(ICP canisters) or baggage (Agoric vats).

### Is this the same defensiveness axis as Thread 1?

The conversation frames it as the **same defend-pervasively-vs-fail-cleanly
axis, one layer down** (within-worker instead of across-worker): missing durable
state fails **immediately and reproducibly** at the point of omission, whereas
insufficient partition-defense fails **intermittently**, timing/load-dependent,
and can stay latent a long time. That framing is *mostly* right and is a real
argument for the coherence of the direction — but it needs one honest
qualification.

**Where the framing holds:** *omission* is loud. A durable field that was never
written is absent on the next delivery, and the code that needed it faults at a
deterministic point regardless of timing or load. That is genuinely a better
failure mode than latent partition-defense debt.

**Where it does not:** *staleness / wrongness* is **not** loud. A durable write
that is **present but subtly wrong or stale** — written under an old invariant,
or written from a value that a since-upgraded code path would compute
differently — fails exactly like insufficient partition-defense: intermittently,
data-dependently, and latently. The no-orthogonal-persistence model converts
*"heap didn't survive"* (loud, at the checkpoint) into *"durable state is
present but semantically off"* (quiet, arbitrarily later). So the correct claim
is narrower: **the model makes the *dominant* failure (omission) loud and
reproducible, but it does not make *all* failures loud** — it relocates a class
of them (staleness) into the same quiet regime as the partition tax. The
direction is still coherent, because omission dominates in practice and the
model at least makes the *contract* explicit (every durable field is named and
written on purpose), but the design should not oversell it as strictly
fail-clean.

### Worker-type-as-constraint

**Proposal:** rather than one persistence/upgrade discipline daemon-wide, let a
worker's discipline be a **constraint expressed at request time** — what
upgrade/continuity guarantee does this workload actually need — analogous to
SwingSet already shipping more than one **vat manager** (local, xsnap,
node-subprocess) and to thixotrope already shipping **three engines** (journal
replay, snapshotting replay, XS snapshots;
[ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) §"The engine
seam"). The precedent is real and on both sides of the fence, so the shape is
right. The library states the exact separation this relies on: Formula
Persistence is the *user agent's* choice (fast convergence, user agency over
retention, timely revocation), while *"the Agoric chain uses Endo components with
orthogonal persistence to ensure all honest validators produce the same
deterministic computation"* — and, decisively, *"the Daemon can host a worker
that is itself constrained to determinism and keeps its own replay transcript."*
That last sentence is worker-type-as-constraint already latent in the design
corpus: the daemon hosts a worker **without imposing its own persistence model on
the worker's internals**. Making that latent capability an explicit request-time
constraint is the whole of this proposal.

**Where the constraint lives.** It belongs on the **worker/incarnation formula**
— the descriptor that already parameterizes how a worker is brought up — set at
worker-request time, not negotiated per-message. A first-cut vocabulary:

```
WorkerDiscipline = {
  // How state survives between deliveries and across restart.
  persistence: 'orthogonal'        // engine heap snapshot is ground truth (thixotrope XS)
             | 'explicit-durable'   // Hofman model: only named durable writes survive
             | 'none',              // ephemeral: dies with the host, no durable claim

  // What upgrade guarantee the workload needs.
  upgrade: 'none'                    // immortal code, disposable vat (thixotrope default)
         | 'succession',             // new vat + app-designed handoff + name rebind

  // Identity continuity for inbound references (mirrors named vs worker-import edges).
  identity: 'eq-stable'              // direct link, EQ survives; no behavior swap
          | 'named',                 // resolves through the name hub per delivery; upgradable
}
```

The three fields are **not** independent — `upgrade: 'succession'` is only
meaningful with `identity: 'named'` for the references that must survive the
succession (a `worker-import` link pins the origin `(workerId, slot)` forever and
cannot be rerouted), and `persistence: 'orthogonal'` with `upgrade: 'succession'`
is the thixotrope name-hub plan exactly. The daemon should **validate the
combination** at request time and reject incoherent ones (e.g. `upgrade:
'succession'` with every inbound edge `eq-stable`, which cannot actually reroute
anything). This mirrors the petname/edge-name and named/worker-import choices the
system already forces at grant time — it is not a new concept, it is the existing
choice made **explicit and per-worker** instead of implicit and global.

### Durable promises are the sharp edge

A pending promise's continuation is a closure over arbitrary reachable state
**plus** a position in the engine's own microtask machinery. There is no obvious
durable-data representation for *"resume this `.then` chain"* without either (i)
restricting what a continuation may close over (an explicit
continuation-passing / named-handler vocabulary), or (ii) accepting that
unsettled promises are simply **lost** across a checkpoint — today's on-chain
vat-upgrade status quo, and thixotrope's explicit stance ("no upgrade, by
design"; unsettled cross-session promises reject via tombstone descriptors on
retirement).

**Recommendation:** treat general durable pending-promises as **not solvable**,
and instead **scope** what a durable pending-promise may represent under
`persistence: 'explicit-durable'`:

- A durable promise may resolve **only** to a value the durable-data vocabulary
  can already represent (a passable, a named presence resolvable through the name
  hub) — never to an arbitrary in-heap continuation.
- Its pending continuation must be expressed as a **named durable handler**
  (an explicit reaction registered in durable storage), not an anonymous `.then`
  closure. Resolution re-dispatches to the named handler after restart.
- Anything that does not fit — a `.then` over transient heap state — is
  **transient by construction**: it lives only within a delivery and is lost at
  the checkpoint, and the model's own loudness (Thread 4 above) makes that
  omission fault at a deterministic point if the app wrongly relied on it.

Be explicit that this **relocates rather than removes** the defensiveness tax: it
becomes *"handle your pending promise not surviving upgrade,"* structurally the
same shape as Thread 1's partition-defense tax and Thread 5's stuck-batch abort.
That is acceptable — a relocated, *named*, statically-visible tax is better than
a pervasive latent one — but it should be named as such, not hidden.

## Thread 5 — The batch-flush retention root (priority thread)

**Proposal.** When a batch of pipelined messages between two peers is in flight
(embargoed — held pending resolution before further delivery, as in
three-party-handoff-style promise pipelining), the daemon treats the **batch's
existence as a temporary GC root**. Anonymous, unnamed intermediate formulas
minted to shepherd values through the pipeline stay alive for exactly the
batch's lifetime and become collectible the moment the batch fully flushes
(delivered and settled, no outstanding continuations) — unless something durable
claimed a name for one of them along the way.

This is attractive because it gives Thread 2's *"implicit unnamed formula"* a
real, **protocol-defined interval** to exist in (long enough to be useful as
value-passing sugar, short enough not to require eager naming), and its liveness
clock is a **fact about message delivery** — protocol-visible, deterministic,
host-independent — exactly the property Thread 3 demands.

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
> and becomes collectible when the last such question settles — which is already
> observable in the import/export tables the daemon maintains.

Under this reframing the "batch-flush retention root" is not a novel embargo
primitive; it is a **specialization of the reference-counted import/export drop
protocol the kernel already runs at the c-list level** (SwingSet's
`deliverDropExports` / `deliverRetireExports`; CapTP's `op:gc-exports` /
`op:gc-answers`). The anonymous formula gets a graph edge from the question
table (a new labeled edge kind, e.g. `question`, alongside the existing `pet:`,
field, `retention`, and `transient` labels in
[daemon-retention-paths](daemon-retention-paths.md)); union-find pins its
cluster while the question is open; resolution (`fulfill`/`break`) removes the
edge; the next mark-and-sweep collects it if nothing durable claimed a name.

Crucially, the daemon **already has this pattern at connection granularity** —
the **captp-bounded transient pin** (`graph.js` `transientRoots`;
`makeRetainedValue(spec) → { id, release }`). It lets a CapTP peer hold a
formula alive without granting persistence; the pin is in-memory only, its
*"lifetime bounded by the captp connection,"* and **the CapTP partition signal
intrinsically releases it**. The `release` exo deliberately *"carries no
reference to the target value, the target's worker, or the daemon's internal
graph,"* and release ordering is *"disk before graph."* The batch-flush root is
this exact mechanism **refined from whole-connection lifetime to single-question
lifetime**: instead of "pinned until the peer disconnects," it is "pinned until
this question resolves." Everything the pin already guarantees — no persistence,
no confinement leak in the `release` handle, partition-triggered release —
carries over unchanged; only the release *trigger* narrows from `op:abort` to
`op:gc-answers`/resolution.

Now the four questions.

#### Q1 — What exactly delimits "the batch"

**Do not** scope it as *"the full causal cone of a top-level request"* — under
sustained or recursive pipelining that root never closes (a reply triggers
further pipelined sends, possibly a third party, and the cone grows without
bound). **Do** scope it per-question, at the granularity CapTP already tracks:

- An anonymous intermediate is rooted iff it is referenced by **at least one
  unsettled question/answer** in the export table. This is a refcount, not a
  span: fan-out (one reply triggers several pipelined sends) is *several
  questions*, each independently rooting what it references; a chain (A's answer
  pipelines into B) is B's question rooting the intermediate that A's settlement
  would otherwise have released, with the refcount handing off cleanly. Nothing
  is collected while a *later hop of the same logical operation still holds a
  question against it*, because that hop's question is a live edge; nothing stays
  rooted once *no* question references it, however deep the original cone was.

This is the standard resolution: the "batch" is not a bounded time window, it is
the **transitive closure of unsettled questions**, which closes exactly when the
last one settles.

#### Q2 — The stuck-batch / non-flushing case (the resource-exhaustion vector)

This is the hazard the whole reassessment must answer without hand-waving: a peer
that disappears mid-pipeline, or a permanently-embargoed message, leaves the root
open indefinitely — reintroducing, at the batch layer, exactly the
unbounded-retention hazard kill-the-worker exists to foreclose at the worker
layer. Worse, a counterparty can **deliberately** force retention by keeping a
pipeline artificially open. Three complementary bounds, each already precedented
in the tree:

1. **Session-subordinate, not session-independent.** The anonymous root is
   scoped to the **CapTP session**, not global. When the session aborts (peer
   disconnect), the existing **at-most-once abort machinery**
   ([ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md): live holders
   reject via session abort, restarted holders via tombstone descriptors) rejects
   every outstanding question → every question-edge drops → the anonymous roots
   release on the next sweep. The disappeared-peer case is thus handled by
   machinery that already exists: a dead session cannot hold a root open.

2. **Lease / expiry on the root** for the *live-but-stalled* peer (connected,
   but the question never settles). This is the **same follow-up thixotrope
   already names** for edge staleness ("lease/expiry policy on names"). A
   question-rooted anonymous formula carries a lease; on expiry the daemon
   **rejects the question locally** (the holder sees a broken reference —
   partition-shaped failure, per Thread 1) and drops the edge. The lease turns
   "permanently embargoed" into "bounded embargo then partition," which is a
   failure class the program already tolerates.

3. **Admission control on root creation** for the *adversarial* case. Borrow the
   metering insight directly ([daemon-xs-worker-metering](daemon-xs-worker-metering.md):
   *"admission control eliminates embargo"*): cap the number and/or aggregate size
   of outstanding anonymous roots **per session**, and when the cap is hit,
   **refuse further pipelining** (backpressure — buffer or reject the send) rather
   than mint another unbounded root. A counterparty cannot force retention past
   the cap because the daemon stops minting roots, exactly as the supervisor stops
   delivering messages when budget is exhausted. This is the piece that makes the
   root safe against a hostile peer rather than merely a crashed one.

With all three, the stuck-batch hazard is bounded by (1) session lifetime, (2) a
per-root lease, and (3) a per-session admission cap — no single one is load-bearing
alone, and none requires buffering outbound messages or rolling back effects.

#### Q3 — Two-party vs. multi-party scope

The motivating cases (a live value standing in for a formula dependency)
plausibly arise as often from **three-party introductions** as direct exchanges,
and embargo semantics are already the hardest part of three-party handoff (a
*gift* held at the introducer, embargoed until the third party accepts). A root
scoped to a single peer **pair** may not cover them.

The right move is to **attach the root to the handoff's own gift lifetime**, not
to invent a pairwise-only construct. OCapN's three-party handoff (spec: CapTP
Specification.md, Jessica Tallon) is Gifter → Exporter → Receiver: the Gifter
`op:deliver`s a **`deposit-gift`** to the Exporter's bootstrap object carrying a
**32-byte random `gift-id`** and the reference, then hands the Receiver a signed
**`desc:handoff-give`** certificate, which the Receiver wraps as
**`desc:handoff-receive`** and presents to the Exporter to withdraw the gift.
The deposited gift held at the Exporter *is* an anonymous intermediate with a
well-defined lifetime — rooted from `deposit-gift` until the Receiver redeems it
(or the handoff aborts). That is the same "rooted by an outstanding obligation"
shape, with the obligation being the un-redeemed gift rather than an unsettled
question. So Q3 does not need a different mechanism; it needs the root to be
defined over the **gift's deposit-to-redeem interval**, of which the two-party
pipelined-question case is the degenerate (single-hop) instance.

Two honest caveats here:

- **Confinement note:** the 32-byte `gift-id` *is* observed by the Receiver
  guest — but that is legitimate, and does **not** violate Thread 2. A `gift-id`
  is a freshly-minted **unguessable swiss-number** handed over *as* an
  introduction ("only connectivity begets connectivity"); it names no
  pre-existing capability out of band. It is categorically different from a
  daemon **formula identifier**, which designates an existing capability and
  whose leak would be the ambient-authority channel Distributed Confinement
  forbids. The design must keep formula IDs off the wire; it need not (and
  cannot) keep swiss-number gift-ids off the wire.
- **Dependency / gap:** the garden library documents the handoff's *descriptor*
  vocabulary but has **no CapTP promise-resolution / handoff *embargo* mechanism
  on record** — the classic "hold deliveries to a resolved promise until the
  three-party embargo lifts" is not in the ingested spec. So the multi-party
  scope of this thread is **blocked on whatever embargo discipline Endo's
  three-party handoff actually implements** once it lands, and should be deferred
  explicitly: build the two-party pipelined-question root first; extend to the
  gift interval when the handoff (and its embargo semantics) are observable
  protocol state. This is a legitimate "not yet, because X."

#### Q4 — Portability across CapTP implementations; does it motivate an OCapN change?

The decisive question. **Is "batch flushed" locally derivable by each peer from
resolve/settle traffic that already exists on the wire, or does it require a new
explicit boundary signal?**

**For the two-party pipelined-question case: locally derivable — no OCapN change.**
The relevant wire facts already exist. A promise resolves via **`fulfill`** (a
value) or **`break`** (an error) — note there is no separate "settle" verb; that
is the resolution event. Reference counting rides two GC operations:
**`op:gc-exports`** (an `export-pos-list` with per-ref `wire-delta`s that
decrement the exporter's refcount; *"when a reference count reaches 0, the
corresponding object can be garbage collected"*) and **`op:gc-answers`** (an
`answer-pos-list`, needing *no* wire-delta because only the questioner references
an answer-pos, so there is no concurrent in-flight reference the exporter is
unaware of; emitted from the questioner's local finalizer when its question
representation is collected). *"No outstanding question references this anonymous
export"* is therefore an **answer-pos refcount reaching zero** — computable
entirely from `fulfill`/`break` plus `op:gc-answers`/`op:gc-exports`, messages
each peer already sends and receives. So the batch-flush root is a **bookkeeping
detail inside one daemon's formula graph**, requiring nothing new from OCapN, and
is *better understood as a specialization of the refcounted import/export drop
protocol the kernel already runs* (`deliverDropExports`/`deliverRetireExports`)
than as a new primitive.

**A documented gap to state plainly:** there is **no explicit *"nothing further
is forthcoming on this pipeline"* wire message** in the OCapN CapTP spec — the
only GC/teardown signals are `op:gc-exports`, `op:gc-answers`, and `op:abort`
(session sever). So a design that *required* an explicit quiescence marker
would be proposing a genuine protocol addition. The claim here is the opposite:
the marker is **not needed**, because the batch's flush is fully reconstructible
from *(a)* resolution (`fulfill`/`break`, after which further pipelining against
that promise is not well-formed), *(b)* the answer-pos refcount hitting zero via
`op:gc-answers`, and *(c)* `op:abort` collapsing the whole session's roots. The
burden of proof is on exhibiting a reachable pipeline state that is *neither*
resolved *nor* GC-dropped *nor* session-aborted; absent such a state — and the
spec surface suggests there is none — **no OCapN addition is warranted.** If one
were ever found, it would be a per-implementation daemon signal, never an OCapN
wire primitive (next paragraph).

**And if it *were* Endo-formula-specific machinery, it should not go into OCapN.**
OCapN aims to stay a minimal, general interop layer across CapTP implementations
that may have **no notion of "formulas"** at all (or may already run an
equivalent c-list GC). An embargo-specific "batch" primitive in OCapN would push
Endo-internal retention bookkeeping into the shared protocol — the wrong layer.
The move, if anything, is to **generalize the mechanism the kernel already runs
at the c-list level**, per-implementation, not to add a primitive to the wire.

### Recommendation (Thread 5)

**Build it — but build the reframing, not the framing.** Recommend implementing
the batch-flush retention root **as a specialization of CapTP question/answer
reference-counting inside the daemon's formula graph** (a `question`-labeled
transient edge, union-find-pinned while the question is unsettled), bounded by the
three Q2 mechanisms (session-subordinate abort, per-root lease, per-session
admission cap). This:

- resolves Thread 2's ergonomics cleanly — the anonymous formula for a
  passed-live-value gets a real, protocol-defined liveness interval, with the
  formula ID never guest-observable (Thread 2's Distributed Confinement rule
  carries over unchanged: the anonymous export is still just a c-list slot to the
  guest);
- satisfies Thread 3 — the liveness clock is a protocol-level fact (a question
  settling), not a local-GC artifact;
- needs **nothing from OCapN** for the two-party case (Q4);
- is bounded against both crashed and adversarial peers (Q2).

**Decline** the novel-primitive framing (a bespoke embargo-specific "batch"
concept) and **decline** any OCapN wire addition. **Defer** the multi-party scope
explicitly until Endo's three-party handoff embargo lifetime is an observable
protocol state (Q3) — do the two-party pipelined-question case first.

This is a *recommendation to build a modest, well-bounded generalization of
existing machinery*, not a recommendation to build the proposal as literally
worded.

## Design Decisions

1. **Kill-the-worker is the backstop for already-seated direct references, not
   the preferred revocation path.** Where the daemon mediates introduction, a
   forwarder/`named`-edge revocation (holder sees partition, no collateral) is
   better; kill-the-worker is reserved for the one case a caretaker cannot reach
   — a direct reference already in a worker's heap (Thread 1).

2. **The value → formula-ID map is the CapTP export table, daemon-private.** No
   formula ID or derived locator may appear in any guest-reachable value, result,
   or error. Value-passing sugar inherits the retention-paths design's host-only
   rule (Thread 2).

3. **Liveness signals are protocol-level facts; `FinalizationRegistry` is a hint,
   never authority.** Every mechanism here is checked against the Thread 3 test;
   the batch-flush root passes only because "question settled" is a wire fact
   (Thread 3, Thread 5-Q4).

4. **Worker discipline is an explicit per-worker constraint on the incarnation
   formula**, validated for coherence (`persistence`/`upgrade`/`identity`), not a
   global daemon setting — mirroring SwingSet vat managers and thixotrope's three
   engines (Thread 4).

5. **Durable pending-promises are scoped, not solved.** Under
   `persistence: 'explicit-durable'` a durable promise resolves only to
   representable values and continues only through named durable handlers;
   anonymous `.then` over transient heap is transient by construction (Thread 4).

6. **The batch-flush root is a specialization of CapTP question/answer
   refcounting, not a new primitive and not an OCapN change**, bounded by
   session-subordinate abort + per-root lease + per-session admission cap
   (Thread 5).

## Dependencies

| Design | Relationship |
|---|---|
| [daemon-cross-peer-gc](daemon-cross-peer-gc.md) (Complete) | Supplies the retention-set + retention-edge substrate and the `retention-accumulator` batching primitive the batch-flush root reuses. |
| [daemon-retention-paths](daemon-retention-paths.md) (In Progress) | Supplies the labeled-edge graph model, the `transient` root, and the host-only confinement rule this design extends with a `question` edge. |
| [ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) (In Progress) | Supplies the name hub / `named` vs `worker-import` edges (Thread 1, Thread 4), the at-most-once abort + tombstone machinery (Thread 5-Q2), and the lease/expiry follow-up (Thread 5-Q2). |
| [daemon-xs-worker-metering](daemon-xs-worker-metering.md) | Supplies the "admission control eliminates embargo" pattern the per-session root cap borrows (Thread 5-Q2). |
| `packages/captp` (`makeCapTPImportExportTables`) | The question/answer/import/export tables the batch-flush root refcounts over (Thread 2, Thread 5). |
| `packages/ocapn` three-party handoff | **Blocking** for the multi-party scope of Thread 5 (Q3): the embargo lifetime must be an observable protocol state. |

## Citations to prior art

- **E promise / partition semantics.** Miller, Tribble & Shapiro, *Concurrency
  Among Strangers* (TGC 2005, LNCS 3705), §9–10: the reference-state machine
  (UNRESOLVED → RESOLVED{near, far, broken}); the `partition` transition breaks
  **all** references crossing a vat boundary in one direction *simultaneously*
  (eventual-common-knowledge); fail-stop FIFO; the `_whenBroken` /
  `_whenMoreResolved` / `_reactToLostClient` handlers and the `when`/`catch`
  surface. Establishes that E has no single-reference sever (Thread 1).
- **Caretaker / revocable forwarder.** Redell 1974 (the caretaker construction);
  Miller, Yee & Shapiro, *Capability Myths Demolished* (2003) — the *forwarding
  facet* / *revoking facet* coinages behind Endo's `Handle`/`HandleControl`
  (Thread 1).
- **SwingSet c-list and refcounted drop/retire.** The GC delivery vocabulary
  `deliverDropExports` / `deliverRetireExports` / `deliverRetireImports` /
  `deliverBringOutYourDead`, `VatOneResolution` (`@agoric/swingset-liveslots`),
  and the three-separate-GC-domains discipline, as carried into MetaMask's
  `ocap-kernel` (Erik Marks, Chip Morningstar, et al.). Note Endo itself does
  **not** run kernel-style cross-vat refcount GC internally; it reclaims via
  formula-graph reachability (Threads 1, 3, 5).
- **OCapN / CapTP spec language.** *CapTP Specification.md* (kriscendobot/ocapn,
  commit `8704f69e`, Jessica Tallon): promise resolution is **`fulfill`** /
  **`break`** (no "settle" verb); GC via **`op:gc-exports`** (export-pos-list +
  wire-delta, refcount→0) and **`op:gc-answers`** (answer-pos-list, no
  wire-delta); session teardown via **`op:abort <reason>`**; pipelining wire form
  `<desc:answer answer-pos>` (lineage: Liskov & Shrira 1988; Bogle & Liskov
  *Batched Futures* 1994; Udanax Gold, Miller 1992); three-party handoff
  `deposit-gift` / 32-byte `gift-id` / `desc:handoff-give` / `desc:handoff-receive`.
  **Gap:** the library documents no CapTP *embargo* mechanism and no explicit
  "nothing-further-forthcoming" wire message (Threads 3, 5).
- **Distributed Confinement.** Miller & Shapiro, *Paradigm Regained* (2003), §5
  (the Cassie/Max `[Factory, factoryMaker]` example, *"only data and no
  capabilities"*); *Capability Myths Demolished* §5.2 (the Confinement Myth is
  false in the Model-4 object-capability model — *"behavior, not arrangement,
  does the confining"*); *"only connectivity begets connectivity"* and the four
  ways to acquire a reference (Introduction, Parenthood, Endowment, Initial
  Conditions); Close's designational-integrity *y-property* (2003) (Thread 2).
- **Exo persistence taxonomy & orthogonal persistence.** Miller, `@endo/exo`
  docs (heap / virtual / durable; virtual does not survive upgrade, durable
  survives via baggage to a successor incarnation); *why not orthogonal
  persistence* (Kris Kowal, endojs/endo#3121, draft: an upgrade may invalidate
  heap-snapshot assumptions, so reconstruction logic is unavoidable). **Gaps:**
  the garden library has no page for a "Mathieu Hofman worker model" and none
  for "zygote" snapshots — those are cited above as the conversation's positions,
  not library-backed facts (Thread 4).
- **In-tree Endo mechanisms.** `daemon-cross-peer-gc` (retention set +
  `retention-accumulator`), `daemon-retention-paths` (labeled-edge graph,
  `transient` root, host-only rule), the **captp-bounded-transient-pin**
  (`graph.js` `transientRoots`, `makeRetainedValue`, connection-bounded lifetime),
  `ocapn-orthogonal-persistence` (name hub, at-most-once abort, tombstone
  descriptors), `daemon-xs-worker-metering` (admission control, budget as
  pre-payment).

## Open Questions

- [ ] **Q3 blocker:** what is the current state of three-party handoff embargo in
      `packages/ocapn`? The multi-party scope of the batch-flush root is deferred
      until its embargo lifetime is an observable protocol state; the two-party
      pipelined-question case does not wait on this.
- [ ] **Q4 residual:** is there a reachable pipeline state that is *neither*
      settled *nor* GC-dropped *nor* covered by session abort — a real
      *"nothing further forthcoming"* fact not recoverable from existing
      messages? If not (the expected answer), no OCapN addition is warranted; if
      so, it is a per-implementation daemon signal, still not an OCapN primitive.
- [ ] **Lease policy:** what is the default lease duration / size cap for
      question-rooted anonymous formulas, and is it per-root, per-session, or
      both? Needs a concrete number calibrated against real pipelining depth,
      analogous to the metering hard-limit calibration.
- [ ] **Worker-discipline validation:** the exact set of incoherent
      `persistence`/`upgrade`/`identity` combinations to reject at worker-request
      time, and whether `identity` should be per-edge (as `named` vs
      `worker-import` already is) rather than per-worker.
- [ ] **Thread 1 boundary:** can the daemon detect, at revocation time, whether a
      target is reachable by a *direct* in-heap reference (needs kill-the-worker)
      vs. only through host-mediated forwarders (can revoke without collateral)?
      If so, kill-the-worker fires only when genuinely necessary.

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
