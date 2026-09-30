# SturdyRefs in the Agent API (layer 9)

| | |
|---|---|
| **Created** | 2026-09-30 |
| **Updated** | 2026-09-30 |
| **Author** | kriscendobot (prompted) |
| **Status** | Proposed |

## Summary

This is layer 9 of the SturdyRef layering stack that kriskowal requested on
[#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512)
(arc: [kriscendobot/garden#47](https://github.com/kriscendobot/garden/issues/47)).
Layers 1 through 8 build the substrate:

- a global, first-wins `SturdyRef` constructed with an `enliven` handler;
- SES, pass-style, and marshal support for it;
- CapTP and OCapN minting, carrying, constructing, and enlivening SturdyRefs;
- the daemon's `sturdyRefForFormula(id)`, which mints a SturdyRef for a
  formula without incarnating it.

This layer changes the daemon's Agent API (the `EndoHost` and `EndoGuest`
methods that create formulas) in three ways:

1. **Produce.** A method that creates a formula can return a SturdyRef for
   it instead of an incarnated value. The formula is incarnated only when
   someone enlivens the ref.
2. **Accept.** Any argument that names an existing formula by pet name or
   path also accepts a SturdyRef for that formula.
3. **Retain.** If a worker's heap holds a SturdyRef for a formula, the
   formula is retained until that worker terminates or garbage collection
   drops the reference.

This document replaces the framing in
[#695](https://github.com/endojs/endo-but-for-bots/pull/695)
(`designs/sturdy-refs-agent-surface.md`). That design was written against
the pre-layering representation: an inert `'sturdyref'` pass-style record
from #737, a daemon-held enlivener, and a model-facing escrow. The layered
substrate settles most of what that design left open, and the
[#695 mapping](#what-carries-over-from-695) below records what carries
over and what is dropped.

## What is the problem being solved?

Today every formula-creating Agent method has one of two outcomes:

- It **names** the new formula under a pet name, which retains it, and
  returns the incarnated value.
- Or it takes no name (`evaluate(undefined, ...)`,
  `makeUnconfined(undefined, ...)`), creates a formula that is transiently
  pinned, and returns the incarnated value. When that value is released, the
  formula may be collected.

Neither outcome lets a caller hold a formula **durably without a name and
without incarnating it**. An agent that composes capabilities (it creates a
worker, evaluates code in it, and passes the result to another evaluation)
has to either spend pet names as scratch storage or keep live presences
around. A live presence keeps a worker running even when nobody is using it.

A SturdyRef closes this gap. It is a passable value that designates the
formula. Holding it retains the formula, and enlivening it incarnates the
formula on demand. The layer-8 kit already mints such refs. What's missing
is Agent API methods that produce and accept them, and retention accounting
for refs held in a worker's heap.

## Design

### Produce: an unnamed formula comes back as a SturdyRef

**Recommended rule:** when a formula-creating method is called **without a
pet name**, it returns a SturdyRef for the new formula
(`sturdyRefForFormula(id)`), not an incarnated value. When it is called
**with** a pet name, it keeps its current behavior: it names the formula and
returns the incarnated value.

Why this rule:

- It changes nothing for callers that pass a name, and every CLI path passes
  a name.
- It answers the question an unnamed formula raises today, "what retains
  it?", with a real answer: the SturdyRef retains it, as long as someone
  holds it.
- The "don't incarnate" behavior is limited to the case where the caller
  has not already asked for a durable name.

The alternative rules are listed under [Open questions](#open-questions)
(question 1).

Methods in scope. These are the `EndoHost` and `EndoGuest` methods that
create a formula and accept an optional or required pet name (see
`packages/daemon/src/interfaces.js`):

| Group | Methods |
|---|---|
| Evaluation | `evaluate`, `makeUnconfined`, `makeArchive`, `makeFromTree`, `makeUnconfinedFromTree` |
| Agents and workers | `provideWorker`, `provideGuest`, `provideHost` |
| Storage | `storeValue`, `storeBlob`, `storeTree` |
| Mounts and adapters | `provideMount`, `provideScratchMount`, `provideSubMount`, `provideGit`, `provideGitRemote`, `provideGitClone`, `provideShell`, `provideHttpClient`, `provideHostPath` |
| Misc | `makeChannel`, `makeTimer`, credential providers |

Where a method's pet-name argument is required today, layer 9 makes it
optional (`M.or(NameOrPathShape, M.undefined())`, the shape `evaluate`
already uses). `provide*` methods are idempotent by name. Without a name
they always create a new formula, which the method's doc comment must say.

The returned SturdyRef crosses the daemon-to-worker CapTP connection under
layer 5's `s+` slot kind. The worker receives a SturdyRef that its CapTP
minted, and enlivening it asks the daemon's export to enliven the daemon's
ref. That calls `provide(id)`, which incarnates the formula. The worker
never sees the formula identifier. It stays inside the layer-8 kit's
closure and `formulaIdOf` WeakMap.

### Accept: a SturdyRef wherever a formula is named

Every argument position that resolves a pet name or path to a formula
identifier also accepts a SturdyRef. That includes the evaluate endowment
list, the worker argument of `evaluate`/`makeUnconfined`, the powers argument
of `makeUnconfined`, the `storeIdentifier`-style targets, and the `endow`
and `sendValue` values. Concretely:

- The guard shape `NameOrPathShape` gains a sibling,
  `NameOrPathOrSturdyRefShape = M.or(NameOrPathShape, SturdyRefShape)`, where
  `SturdyRefShape` matches `passStyleOf(x) === 'sturdyRef'` (layer 3). Only
  argument positions that resolve an **existing** formula switch to it.
  Positions that write a **new** name don't.
- The daemon's name-resolution helper gains one branch. A SturdyRef resolves
  through `formulaIdOf(ref)`, which returns the identifier only for refs the
  daemon's own kit minted.
- A SturdyRef the daemon did not mint (from a peer, or constructed from data
  by layer 6) has no local formula identifier. It is accepted **only** where
  the method already accepts a live value (`storeValue`, `endow`,
  `sendValue`), and it is stored as the peer-formula it already represents
  (layer 7 enlivens it through the bootstrap and nonce locator). Everywhere
  else it is rejected with a message that names the argument. It is never
  silently enlivened.

Accepting a ref grants nothing new. The caller had to hold the ref, and
holding the ref already carries the authority to enliven it. Accepting it in
place of a name just skips the pet-store round trip.

### Retain: a SturdyRef in a worker's heap retains its formula

The daemon's formula graph already has per-agent **retention edges**
(`formulaGraph.addRetention(agentId, formulaId)` /
`removeRetention`, used today for peer-held OCapN references, with
persistence through `persistencePowers.writeRetention`). Layer 9 reuses
them. Each worker CapTP connection is the retaining agent, keyed by the
worker's formula identifier.

1. **Export adds an edge.** When the daemon exports a SturdyRef minted by
   its own kit over a worker's connection (a new `s+` slot),
   `formulaIdOf(ref)` gives the target id, and the daemon calls
   `addRetention(workerId, targetId)`.
2. **Drop removes the edge.** When the worker's heap drops its last
   reference to an `s-` import, CapTP's FinalizationRegistry path sends
   `CTP_DROP` for the slot. That only happens if the import is collectable,
   and today it isn't: `@endo/captp` defaults `gcImports = false`, and the
   daemon's connections (`packages/daemon/src/connection.js`) keep that
   default (see the note in `directory.js`). So layer 9 turns on weak
   imports for `s-` slots on worker connections. The narrowest form is a
   CapTP option that weakens only SturdyRef imports and leaves `o-`/`p-`
   imports strong, so turning it on doesn't change the lifetime of any
   existing presence. The daemon side maps the slot back to `targetId` and calls
   `removeRetention(workerId, targetId)`, and the next sweep may collect the
   formula.
3. **Termination removes all edges.** When the worker formula is cancelled
   or its process exits, the daemon removes every retention edge keyed on
   that worker (`replaceRetention(workerId, [])`).

Edges are a set per `(worker, target)` pair. The same formula can be
exported to the same worker more than once, and CapTP interns exports per
value, so re-exporting the *same* ref reuses its slot. To keep exactly one
slot per `(worker, target)`, the daemon memoizes the ref it mints per
formula id: `sturdyRefForFormula` returns the same ref for the same id while
that ref is alive (a WeakRef-valued map). Two different ref objects for one
target would produce two slots, and the first `CTP_DROP` would remove an
edge the second slot still needs. Memoizing avoids that without a reference
count.

Retention edges held by a worker are **not persisted** across daemon
restarts. A worker does not survive a restart, so the heap that held the
ref is gone too. Peer retention (OCapN) keeps its existing persistence.

The one existing guarantee this has to respect is the formula graph's
collection rule: a formula reachable only through a retention edge from a
worker must survive a sweep until the edge is removed. That is how peer
retention already works, so the collection rule does not change.

### What does not change

- CLI and pet-name users see no difference. Every named call behaves as it
  does today.
- The formula identifier stays closely held. No API returns it for a
  SturdyRef. `identify`/`locate` on a SturdyRef are out of scope (question
  3).
- The model-facing tool layer (Lal, Fae, `@endo/agent-tools`) is a
  consumer, not part of this layer. See [question 4](#open-questions).

## What carries over from #695

| #695 element | Disposition |
|---|---|
| One passable representation, `'sturdyref'` pass-style record (via #737) | **Replaced** by the layer-1 `SturdyRef` object recognized as `'sturdyRef'` by layer 3. It is not inert data. It is an opaque object whose enliven behavior belongs to its minter. |
| Inertness across the daemon-worker marshal boundary (#695 open question 1) | **Resolved** by layers 4–5. The wire carries an `s+` slot, not a location and swiss number, so the worker holds no secret. |
| Daemon-held enlivener, confined code gets neither enlivener nor locator | **Kept**, in the new form: the enlivener is the daemon-side export behind the worker's `s-` import, and the formula id stays in the layer-8 kit. |
| Accept surface (a new method to hand a sturdyref back) | **Generalized.** No new method. Every formula-naming argument accepts a SturdyRef. |
| Provide surface (sturdyref produced by existing facet output) | **Made explicit.** Unnamed formula creation returns a SturdyRef. |
| Distributed confinement, attenuated facet as a new confinement level | **Deferred** to a follow-up. It is independent of the substrate and should be reviewed on its own. |
| Tool-layer escrow, render map, handle grammar | **Deferred** to a follow-up consumer design (question 4). |
| Retention and user revocation | **Retention redefined** as worker-heap retention above. User revocation (cancelling the target formula) is unchanged: a SturdyRef to a cancelled formula fails to enliven. |

## Build plan

The build is one draft PR stacked on this design, in reviewable commits:

1. **Memoize refs per formula.** `makeFormulaSturdyRefKit` returns one live
   ref per id (WeakRef map plus a FinalizationRegistry to prune it), with a
   test that asserts same-id identity and that a collected ref is re-minted.
2. **Accept.** Add `SturdyRefShape` and `NameOrPathOrSturdyRefShape`, switch
   the existing-formula argument positions, and add a SturdyRef branch to
   name resolution through `formulaIdOf`. Test each switched position with a
   kit-minted ref, a foreign ref (rejected or stored, per the rule above),
   and a non-ref.
3. **Produce.** Make the pet-name argument optional on the in-scope methods,
   and return `sturdyRefForFormula(id)` when it is omitted. Test that no
   incarnation happens until enliven, using an `evaluate` whose code records
   a side effect.
4. **Retain.** Add worker-connection retention edges on `s+` export, drop
   them on `CTP_DROP` and on worker termination, with tests:
   - a held ref survives `collect`;
   - a ref dropped in the worker (forced GC under `--expose-gc`) lets
     `collect` reclaim the formula;
   - terminating the worker reclaims it.

   This commit depends on weak `s-` imports on worker connections (see
   Retain, step 2). The CapTP option that weakens only SturdyRef imports is
   a small change to `@endo/captp`'s import table. It can land as a
   `fixup!` on layer 5 (#1394) or as the first commit here. Question 5 asks
   which.
5. **Docs.** Document the unnamed-returns-SturdyRef rule in the daemon README
   and the `EndoHost`/`EndoGuest` type docs, and add a changeset for
   `@endo/daemon`.

Test material worth mining (never rebase these): #871's
`packages/agent-tools/test/sturdyref-escrow.test.js` (for the deferred
tool-layer follow-up), and the #701–#704 daemon mint/export and three-party
round-trip tests, which cover the retention path across OCapN peers.

## Security considerations

- **No new authority.** Producing a SturdyRef instead of a live value gives
  the caller strictly less immediate reach: they must enliven before they
  can use it. Accepting a SturdyRef where a name was accepted requires
  already holding it.
- **Identifier secrecy.** The formula id never leaves the daemon. The worker
  sees an `s-` slot, and `formulaIdOf` only answers for refs this daemon's
  kit minted, so a forged or foreign ref cannot designate a local formula.
- **Retention as a resource.** A worker can now keep formulas alive by
  holding refs. That is the intended semantics, but it means a misbehaving
  guest can pin storage until its worker is terminated. Terminating the
  worker (or cancelling the guest) always releases every edge it holds,
  which bounds the damage.
- **Enlivening a cancelled formula** rejects (layer 8's `provide` rejects on
  a missing formula). It does not resurrect the formula.

## Open questions

1. **Produce rule.** This design recommends "unnamed returns a SturdyRef;
   named behaves as today." The alternatives are:
   - **(b)** Every formula-creating method returns a SturdyRef, and callers
     that want a live value enliven it. This is a breaking change for every
     programmatic caller.
   - **(c)** An options bag, `{ sturdy: true }`. This is additive but
     doubles every signature's surface.

   Which should the build take?
2. **Named calls that also want a ref.** Should a named call be able to get
   a SturdyRef back (for example, `provideWorker('w', { sturdy: true })`),
   or is `named then pass the name` enough?
3. **`identify`/`locate` on a SturdyRef.** Should the directory methods
   accept a SturdyRef and return its locator? That exposes the formula id,
   which layer 8 deliberately closely holds, so this design says no. Confirm.
4. **Tool-layer consumer.** Should the Lal/Fae/`@endo/agent-tools` handling
   (render map, handle grammar, escrow, from #695 and #871) be a separate
   follow-up design on top of this layer, or folded into the layer-9 build?
   This design recommends a separate follow-up so the daemon surface is
   reviewed first.

5. **Where does the weak-`s-`-import CapTP option land?** Recommendation:
   as a commit on layer 5 (#1394), because that layer owns the `s+`/`s-`
   slot kind. The alternative is the first commit of the layer-9 build.

## Stack index

1. [#774](https://github.com/endojs/endo-but-for-bots/pull/774) shim with handler/enliven construction (design contract [#1389](https://github.com/endojs/endo-but-for-bots/pull/1389))
2. [#1391](https://github.com/endojs/endo-but-for-bots/pull/1391) ses: permit and propagate a pre-lockdown SturdyRef
3. [#1392](https://github.com/endojs/endo-but-for-bots/pull/1392) pass-style: recognize a SturdyRef as passable
4. [#1393](https://github.com/endojs/endo-but-for-bots/pull/1393) marshal: represent a SturdyRef in each encoding
5. [#1394](https://github.com/endojs/endo-but-for-bots/pull/1394) captp/ocapn: mint and carry SturdyRefs over the wire
6. [#1396](https://github.com/endojs/endo-but-for-bots/pull/1396) captp/ocapn: construct a SturdyRef from its data
7. [#1397](https://github.com/endojs/endo-but-for-bots/pull/1397) ocapn: enliven through the bootstrap and nonce locator
8. [#1398](https://github.com/endojs/endo-but-for-bots/pull/1398) daemon: a SturdyRef for a formula without incarnation
9. **This design**: the Agent API produces, accepts, and retains SturdyRefs
