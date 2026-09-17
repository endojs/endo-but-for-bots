# SturdyRefs Throughout: Agent Provide and Accept Surface

| | |
|---|---|
| **Created** | 2026-07-11 |
| **Updated** | 2026-09-17 |
| **Author** | endolinbot (prompted) |
| **Status** | Proposed |

## Summary

Endo's LLM-driven agents (Lal and Fae) need to provide and accept a sturdy
reference (a **sturdyref**) as a value in a tool call, without assigning it a
**pet name** (a user-chosen namespace label for a formula; defined in full
under [What is the Problem Being
Solved?](#what-is-the-problem-being-solved)).
The other terms of art this design turns on (locator, swiss number, and
formula) are likewise defined in full in that same section; this summary uses
them before defining them and points there for the definitions rather than
carrying the definitions inline here.
The **daemon** here is the Endo background process that stores formulas and
mediates every capability a confined worker can reach.

This design introduces a shared render map, handle grammar, and failure
messages that Lal and Fae must implement identically, so they belong in one
shared home instead of being reinvented per agent (where that home lives, and
what dependency edge it costs, is worked out under
[Dependencies](#dependencies)).

The value is the first-class `'sturdyref'` pass-style value defined by the
parent sturdyref work (PR #539 and PR #737; see [Dependencies](#dependencies)).
A **pass style** is the marshal layer's category for a passable value, the tag
`passStyleOf` returns, so `'sturdyref'` is a distinct kind of passable
alongside `'remotable'`, `'string'`, and the rest.
It is meant to be inert data, not a remotable (inertness being the **bar this
design must clear, not a property the shipped representation already has**),
and it is **enlivened** (resolved from the opaque value into a live,
message-able presence) only by a closely held capability the daemon holds on
the worker's behalf.
That the bar is not yet met is concrete: today's OCapN codec writes a
sturdyref's location and swiss number (the unguessable secret naming a
capability; defined below) onto the wire, so preserving inertness across the
daemon-worker marshalling boundary is [Open Questions](#open-questions) item 1,
not a settled fact (see [Distributed confinement](#distributed-confinement)).

The title names two directions, and only one is a new method.
**Accept** (a worker handing a sturdyref back for resolution) is the surface
specified here.
**Provide** (where a sturdyref value originates and is returned to a worker)
adds no new method: a sturdyref is produced by the parent work's existing
daemon-side facet output, carried to the model through the tool layer's render
map, and needs no admission row of its own (see [Daemon provide and
accept](#daemon-provide-and-accept)).

There is one reference representation at this boundary: `SturdyRef`.
The daemon holds the capability that resolves a sturdyref to a presence and
that associates a sturdyref with its locator (the daemon's authority-bearing
`endo://...` designator; defined below).
Confined code receives neither that capability nor a locator.
A confined worker can pass a sturdyref back to a daemon method that accepts
one, which makes the sturdyref an anonymous placeholder for a formula (the
daemon's unit of persistent capability and a node in its formula graph; defined
below).

The design does not settle retention.
Holding an anonymous sturdyref across a worker turn may require a retention
edge.
Implementation must first establish whether such a hold requires an edge, and
if so expose the retaining workers so they can be revoked (see [Retention and
user revocation](#retention-and-user-revocation)).
The initial agent surface is therefore **single-turn for model-presented
handles**: within one turn the model may present a handle the render map
rendered earlier in that same turn, and the map refuses a handle from any
earlier turn.
That property scopes the model's presentation of handles, not the confined
worker's own hold of the `SturdyRef` value: a worker that keeps the value in a
variable across turns and re-presents it is doing genuine cross-turn retention,
which this design defers to the retention investigation rather than admits as
retention-free (see [Daemon provide and accept](#daemon-provide-and-accept)).

This is **design 1 of 2 of a competing sturdyref pair.** The sibling
[sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) proposes an `endor`
`retain`/`release` worker syscall for exactly the cross-turn retention this
document defers to an investigation.
The two are presented as alternatives for the maintainer to select between
(both ship, one supersedes, or the choice is deferred); this document does not
claim to supersede its sibling.
See [Dependencies](#dependencies) for the reconciliation this selection forces
on [Retention and user revocation](#retention-and-user-revocation).

Two lifetime boundaries recur below and are not interchangeable:

- A **delivery** is a single daemon-worker CapTP message: one tool call's
  underlying daemon-method invocation.
  A worked flow of several tool calls is several deliveries.
- A **turn** is one agent activation: the span from the agent receiving a
  prompt through the sequence of tool calls it makes until control returns to
  the user.
  A turn contains one or more deliveries.

The boundary that governs "no retention edge required" is the **turn**, not the
delivery.
Within a single turn the tool layer's render map (an in-memory, single-turn
table from an opaque text handle to a held `SturdyRef`, defined in full under
[Tool-layer escrow](#tool-layer-escrow)) holds the sturdyref in process memory
across deliveries, so presenting it in a later tool call of the same turn
creates no daemon-side edge.
The worked flow in [One passable representation](#one-passable-representation)
(a tool result carrying a `SturdyRef`, then a later tool call redeeming it)
crosses a delivery boundary but stays inside one turn, so it is single-turn by
this definition.
Crossing a turn boundary is what the deferred retention investigation governs.

## What is the Problem Being Solved?

Today a daemon worker designates a formula (defined just below) by a pet-name
path, so to carry one value from one tool call to the next **within a single
turn** it must first bind a pet name to it.
That same-turn handoff is the case this surface serves, and it is the case the
motivating example below is drawn from, so the "removes the pet name" claim
lands against a handoff the initial surface actually ships rather than against
a scenario deferred to a later phase.
Binding a pet name for it is namespace allocation for a temporary handoff, and
the allocation outlasts the handoff it served: it clutters the user's namespace
with single-use labels, and each label is a durable, user-visible grant the
user must later notice and revoke rather than a transient that disappears when
the exchange ends.
A sturdyref removes that: the worker keeps an opaque data value and later gives
it back to a daemon facet for enlivenment, allocating no name and leaving
nothing in the namespace once the exchange ends.

A concrete same-turn example, in the terms the surface actually ships.
A worker running a search or listing tool receives a candidate formula back as
a sturdyref, which the tool layer renders to the model as the opaque handle
`ref@7f3a` (rather than the worker binding a pet name like `candidate-1` to
it).
Later in the same turn, the model calls the accept tool with `ref@7f3a` in its
`sturdyRef` argument (a JSON-mode tool call, since that is the only surface
where the pinned redemption position exists; see [Daemon provide and
accept](#daemon-provide-and-accept)), and the daemon enlivens that candidate.
No pet name is allocated, and nothing survives in the namespace once the turn
ends.
That handle handoff without a namespace label is the case this surface serves;
what the model does with the enlivened presence afterward (acting on it in a
later model-mediated call) is the deferred value-producing surface, because the
presence renders with no designator the model can carry forward.

It deliberately does not yet serve the other common handoff shape, where an
agent surfaces a candidate ("I found X, should I act on it?")
and then acts on the user's reply, because that pattern crosses a turn boundary
and so falls under the deferred retention investigation ([Retention and user
revocation](#retention-and-user-revocation)) rather than the surface shipped
here.
Naming that limit against the motivating example is deliberate: the initial
surface removes namespace allocation for same-turn handoffs, and cross-turn
handoffs wait on the retention answer.

This surface rests on four terms of art.
Three of them (**formula**, **worker**, and **facet**) already appear
informally above; only **mediator** is new here.
All four are defined here before the design body relies on them:

A **formula** is the Endo daemon's unit of persistent capability: a stored,
content-addressed recipe (a worker, a guest, a stored value, or a lookup) that
the daemon can re-incarnate into a live presence, and the node such a recipe
occupies in the daemon's formula graph.
Its identity is the recipe, not any name pointed at it, which is why a formula
can be designated by a pet name, a locator, or (as this design proposes) an
anonymous sturdyref.

A **mediator** is the daemon-side confinement boundary a worker runs under: the
capability that instantiates confined code and mediates every reference it can
reach, so "confined" means "able to reach only what the mediator forwards."

A **worker**, throughout this document, denotes the confined execution context
generally (the code held under a mediator), not the specific `worker` edge
label of the formula-graph taxonomy in
[daemon-retention-paths](daemon-retention-paths.md); where the retention
investigation below leans on that taxonomy, the distinct edge-label sense is
called out at the point of use.

A **facet** here is an attenuated capability view of a daemon object: the
object exposes only a chosen subset of its methods, so that less-trusted code
(a confined worker) is handed the facet in place of the full object and can
reach only what the facet forwards.
(A value-producing operation that consumes a sturdyref is a plausible future
extension but is not part of the initial surface; see [Daemon provide and
accept](#daemon-provide-and-accept).)

This surface leans on three further terms of art from the parent sturdyref
work; the sibling design
[sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) defines them in full
(its `## Background`), and they are summarized here because this document's
acceptance criteria depend on them:

- A **locator** is the daemon's authority-bearing designator for a formula: the
  `endo://{peerKey}/{formulaAddress}?type=` string that anyone holding it can
  redeem to a presence through `lookupByLocator`
  (`packages/daemon/src/interfaces.js:254`).
  Disclosing a locator to confined code hands it that redemption authority
  directly, which is why the confinement rule below forbids it.
- A **formula identifier** is the daemon's internal id for a formula node in
  the formula graph, redeemable through `lookupById` (`interfaces.js:253`).
- A **swiss number** is the unguessable secret naming a capability within a
  formula graph; on the OCapN wire a sturdyref is carried as a peer locator
  plus a swiss number.

A sturdyref differs from a locator in exactly the property this design turns
on: a locator is self-redeeming for its holder, whereas a sturdyref is inert
and can be turned into a presence only by a daemon facet that holds the closely
held association capability.
Preserving that difference across the marshalling boundary is the unsettled
transport question stated canonically in the [Summary](#summary) ([Open
Questions](#open-questions) item 1).

The relevant capability split is:

- A `SturdyRef` is a passable value in the `'sturdyref'` category.
  It is not a presence and cannot receive eventual messages.
- The daemon holds the closely held capability.
  That capability can enliven a sturdyref to a presence and can map between a
  locator and the corresponding sturdyref.
  It is never passed to confined code.
- A daemon facet uses that capability on behalf of a worker.
  Confined code does not receive the association capability, a locator, a
  formula identifier, or any other representation that can locate an arbitrary
  sturdyref.

The distinction is authority, not a second guest-specific value type.
A sturdyref is the anonymous value a daemon uses while holding the authority
that enlivens it.

## Design

### One passable representation

The agent surface accepts and returns `SturdyRef` values.
It does not introduce `SturdyRefToken`, a method-less remotable, a new
guest-only pass style, or a tool-layer proxy for a sturdyref.
`SturdyRefToken` was a daemon-minted, identity-bearing remotable this design's
earlier revision proposed and the 2026-07-15 maintainer review of PR #695
rejected; the cost of dropping it (a retention lifecycle that must now be
hand-built rather than inherited from a remotable's own held-or-dropped
identity) is discussed once, canonically, in [Retention and user
revocation](#retention-and-user-revocation).

The pass-style implementation defines how a sturdyref is recognized.
The daemon, separately, holds the closely held capability that resolves the
value.
The `@endo/ocapn` package already ships this capability's operations under the
names `makeSturdyRef(location, secret)` and `enlivenSturdyRef(...)`
(`packages/ocapn/src/client/sturdyrefs.js:56`, `:73`); this design reuses those
spellings **tentatively**, pending the transport rule below and in [Open
Questions](#open-questions) item 1, which may require the daemon to resolve by
a different operation entirely.
The mint's second argument is spelled `secret` and typed `string | Uint8Array`
in the shipped signature (`packages/ocapn/src/client/sturdyrefs.js:110`).
It is a swiss number in the term-of-art sense, but this document uses the
shipped parameter name where it cites the operation.
The capability the daemon holds is, conceptually:

```js
// Held by the daemon, never passed to confined code.
const association = harden({
  // Mint. Kept on the constructing side; a worker-facing facet never holds it.
  makeSturdyRef(location, secret) {},
  // Resolve to a presence. This is the only operation a worker-facing daemon
  // method needs, and it is the only one such a method is handed. Its shipped
  // arity is wider than this line implies; see the attenuation caveat below.
  enlivenSturdyRef(sturdyRef) {},
  // De-anonymize: sturdyRef -> its locator. This is the disclosure confined
  // code must never reach; it is not handed to any worker-facing facet.
  locatorForSturdyRef(sturdyRef) {},
});
```

Attenuating by construction matters here: a worker-facing daemon method is
handed an `enlivenSturdyRef` operation alone, never the whole `association`
object, so minting and locator disclosure are out of reach by construction
rather than by an audit obligation.

Two caveats the implementation must honor.

**The reuse of `enlivenSturdyRef` is tentative because the shipped operation
cannot resolve a value that arrived by marshalling.** As shipped in
`@endo/ocapn`, `makeSturdyRef` returns `makeTagged('ocapn-sturdyref',
undefined)` and keeps the location and secret in a *process-local* `WeakMap`
(`packages/ocapn/src/client/sturdyrefs.js:42-71`); `getSturdyRefDetails` reads
that map (`:45`), and `enlivenSturdyRef` throws before either resolution branch
when the value is not in *this* process's table.
The only transport that preserves a sturdyref's meaning across a process
boundary is the OCapN Syrup codec (`packages/ocapn/src/codecs/descriptors.js`),
which re-mints on decode.
But the daemon-worker CapTP path this surface rides is `@endo/captp` plus
marshal, **not** `@endo/ocapn`: the worker-transport files
(`packages/daemon/src/client.js`, `bus-worker-xs.js`, `connection.js`,
`residence.js`) all import `@endo/captp`, none imports `@endo/ocapn`.
(The daemon *manifest* does list `@endo/ocapn` as a direct dependency, but that
edge exists for host-to-host networking in
`packages/daemon/src/networks/ocapn.js`, not for the worker transport this
surface rides; see [Dependencies](#dependencies).)
So a sturdyref that reaches the daemon from a worker will not be in the
daemon's `WeakMap` and `enlivenSturdyRef` as written would throw.
Phase 3 therefore needs a **daemon-held index** keyed by whatever the CapTP
boxing actually transports, and "reuses those spellings" above is a caveat, not
a settled reuse.
The daemon-held index is not a free win, though: the marshalled value carries
*no* payload of its own (the tag's body is `undefined`), so as a plain copy it
gives the daemon **nothing to key an index on** across the boundary.
That leaves a tension the transport rule must resolve, not a strengthened index
option: (1) key the index on the copy value, and a payload-free tagged copy has
no marshal-level identity for the daemon to key on; (2) add a wire payload that
*is* the swiss number, and that payload is the bearer secret in confined hands,
which [Distributed confinement](#distributed-confinement) forbids; (3) box the
value pass-by-reference so the daemon side gets a stable identity, and that
reintroduces the identity-bearing remotable the 2026-07-15 review rejected.
Option (2) does not exclude a fourth candidate. (4) Add a wire payload that is
a **daemon-minted opaque correlation token**, generated at mint time solely to
key the daemon's own private index and carrying no derivable path to the
locator or the swiss number, so a confined worker holding it cannot turn it
into authority any more than it can the in-process render-map handle
(`ref@7f3a`, [Tool-layer escrow](#tool-layer-escrow)).
Option (4) is not, however, simply the render-map handle "pushed onto the
wire": the render-map handle never leaves the tool-layer process, whereas a
correlation token is in confined hands on the wire, so its safety rests on the
daemon's private index being unforgeable and non-correlatable rather than on
the token never being held by confined code.
It is therefore a *candidate* to weigh, not an already-trusted shape; and
whether a marshalling constraint forces the added payload to be the literal
secret (collapsing (4) back into (2)), or whether a correlation token survives
as a distinct resolution, is the open part of the question.
This tension is stated as [Open Questions](#open-questions) item 1, not
resolved here.

**The `enlivenSturdyRef` attenuation is wider than a single bound argument.**
Its shipped signature is `enlivenSturdyRef(sturdyRef, provideSession,
isSelfLocation, secretResolver)`
(`packages/ocapn/src/client/sturdyrefs.js:73`), and it takes **two** distinct
capability arguments, one per resolution branch.
When `isSelfLocation(location)` is true it resolves locally through
`secretResolver.get(secret)`, where `secretResolver` is the `@endo/ocapn` `{
get(secret) }` resolver object (this is the parameter the shipped source spells
`locator`; this document renames it `secretResolver` at its own boundary to
avoid a second, unrelated sense of the word "locator," which elsewhere means
the daemon's authority-bearing `endo://...` designator string).
When `isSelfLocation(location)` is false it never consults `secretResolver` at
all: it calls `provideSession(location)` and fetches the capability from that
session's remote bootstrap by the on-wire secret.
So binding only `secretResolver` bounds the local branch alone; the remote
branch's authority is `provideSession`, and a bound operation that left
`provideSession` swappable would resolve any remote `(location, secret)` pair
the confined code could name.
The attenuation is therefore: pre-bind `enlivenSturdyRef` to **both** a single
daemon-held `secretResolver` and a single daemon-held `provideSession` (and a
fixed `isSelfLocation`), none of which confined code can swap or widen, and
hand only that fully pre-bound operation to the worker-facing facet.
Whether confined code can obtain or fabricate a sturdyref whose location is
remote (and so aim the remote branch at a location of its choosing) is [Open
Questions](#open-questions) item 1, on which the remote-branch bound ultimately
rests; the pre-binding here closes the operation's own arguments, not that
transport question.

The confined worker must reach neither `secretResolver`, nor `provideSession`,
nor an operation for constructing or choosing a different one.
The names above are the operations' real spellings where they exist in
`@endo/ocapn`; the daemon-facing method names are proposed in [Daemon provide
and accept](#daemon-provide-and-accept).

This directly supports the usual tool flow, once the marshalling dependency in
[Dependencies](#dependencies) (CapTP boxing and unboxing of sturdyrefs) is in
place.
With the reserved handle grammar pinned in [Tool-layer
escrow](#tool-layer-escrow) (an opaque token that embeds `@`, such as
`ref@7f3a`):

1. A daemon facet returns a `SturdyRef` as a tool result.
2. The tool layer stores it in the render map and shows the model the rendered
   handle `ref@7f3a` in place of the value.
3. Later in the same turn, the model calls a tool passing `ref@7f3a` back
   verbatim.
4. The tool layer redeems `ref@7f3a` to the held `SturdyRef` before the
   argument guard runs, and the facet enlivens it with `enlivenSturdyRef` (or,
   per the transport caveat above, whatever daemon-held index resolution Phase
   3 settles on).

The text handle is only a local rendering of an already-held sturdyref.
It is not a serialization, not an authority-bearing string, and not a second
kind of reference.

### Distributed confinement

The surface follows the distributed-confinement rule that code confined by a
mediator must not gain a capability for turning arbitrary bits or values into
authority.
(For the confinement vocabulary this leans on, see
[daemon-retention-paths](daemon-retention-paths.md) and
[sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) `## Background`; for
the parent sturdyref work, see PR #539.)
In particular:

- A worker may hold and return a `SturdyRef` that the daemon gave it.
- A worker may not call `makeSturdyRef`, `locatorForSturdyRef`, or
  `enlivenSturdyRef` directly.
- A worker may not obtain a locator, a formula identifier, a swiss number, or a
  general operation for resolving an arbitrary sturdyref.
- A daemon method that accepts a sturdyref resolves only the single argument it
  was handed, and only within the authority that method already carries.
  It does not turn the method into a general locator service.
- A confined worker cannot **fabricate or enumerate** a sturdyref value (or the
  wire token keying its resolution) that `lookupBySturdyRef` will resolve.
  As shipped, `makeSturdyRef` returns `makeTagged('ocapn-sturdyref', undefined)`
  (`packages/ocapn/src/client/sturdyrefs.js:56`), a tag any confined code can
  mint for itself, so the confinement bar is not the tag's presence but the
  daemon index's refusal of any key it did not itself issue.
  Whatever wire representation [One passable
  representation](#one-passable-representation) settles on, its index key must
  be daemon-minted, unforgeable (an entropy floor), and non-enumerable, so a
  worker submitting a fabricated or enumerated value is rejected by
  `lookupBySturdyRef` rather than served.
  Without this, `lookupBySturdyRef` degrades into exactly the general resolution
  service the bullet above forbids; this exposure exists for the local index
  branch, not only the remote branch [Open Questions](#open-questions) item 1
  raises, and is stated as an explicit requirement here rather than left to the
  wire representation to imply.

This confinement property is a **target, not an achieved property of the
value**.
Today the OCapN codec serializes a sturdyref by writing its location and swiss
number onto the wire and re-minting on decode
(`packages/ocapn/src/codecs/descriptors.js`), so an inbound message that
delivers a sturdyref to a confined worker carries the swiss number unless the
boundary substitutes a daemon-side index for it.
Establishing that transport rule is [Open Questions](#open-questions) item 1,
and until it exists the confinement guarantee is not yet met.
This design states the property as the bar the implementation must clear, not
as something the shipped representation already satisfies.

#### The attenuated facet is a new confinement level, not a change to Lal or Fae

The confined agent surface is **narrower than the shipped `EndoGuest`**.
An `EndoGuest` is the daemon's existing capability object for a less-trusted
agent: a facet (in the sense above) that the daemon hands to guest code,
exposing a name hub plus mail methods.
It is the closest shipped analog to the "confined worker" this design targets,
which is why the design measures its narrower surface against it, not
against the full host.
A real `EndoGuest` today spreads `nameHubMethodGuards`
(`packages/daemon/src/interfaces.js:99`, whose read surface
`readableNameHubMethodGuards` is at
`packages/platform/src/fs/interfaces.js:61`), which grants `identify`,
`locate`, `reverseLocate`, `listIdentifiers`, `listLocators`, `lookupById`,
`lookupByLocator`, `storeIdentifier`, and `storeLocator`, wired live on the
guest (`packages/daemon/src/guest.js`); `lookupByLocator` is precisely a
general locator-to-presence capability.
Only the `least-authority` null agent (`leastAuthority()`,
`packages/daemon/src/interfaces.js:976`; formula type `least-authority`,
`packages/daemon/src/manager.js:634`) disallows these.
So the "confined worker" this design targets is not an `EndoGuest` as shipped:
an attenuation step must construct a facet that removes the locator-disclosing
methods before this design's confinement acceptance criterion can hold.
That step is called out explicitly in [Phased Work](#phased-work) (who builds
it, and when).

Removing those methods is a breaking change for any code that calls them, so
this design is explicit about who runs on the attenuated facet and who does
not.
**The attenuated facet is a new, more-confined capability level for a new class
of confined worker; Lal and Fae as shipped are not migrated onto it and
continue to run on the full `EndoGuest`.** Both agents actively depend on the
very methods Phase 2 removes:

- `locate` is a shipped, model-facing Lal tool: Lal registers it
  (`packages/lal/tools/meta.js:28`), dispatches it
  (`packages/lal/tool-dispatch.js:353`), and its own system prompt teaches the
  model to call `locate(["@self"])` (`packages/lal/prompts/system.js:17`).
  Lal also calls `locate('@self')` (`packages/lal/agent.js:181`) and adopts
  message attachments through `lookupById` (`packages/lal/agent.js:240`).
- Fae's subagent spawn and credential paths call `locate` directly
  (`packages/fae/src/subagent-host.js:207,220,247`,
  `packages/fae/src/credentials.js:243`).

Attenuating the facet Lal and Fae themselves run on would break these shipped
paths.
The design therefore does **not** move Lal and Fae onto the attenuated facet;
the confinement acceptance criterion below (a worker that cannot reach a
locator or swiss number) is verified against a **purpose-built confined worker
on the attenuated facet**, not against Lal or Fae.
Whether a future revision migrates either agent onto a more-confined facet is a
separate, larger change with its own consumer accounting, out of scope here.

Removing `lookupByLocator` from the attenuated facet has a further consequence
the design takes on deliberately, not by oversight: the shipped mail channel
delivers an attachment as a locator and expects the recipient to resolve it
through `lookupByLocator` (`packages/daemon/src/guest.js:168-174`, whose own
comment records this).
A confined worker on the attenuated facet therefore cannot resolve a
bare-locator mail attachment, and this is correct rather than a regression to
paper over.
A resolvable locator is exactly the general locator-to-presence authority the
confinement bar withholds; a facet that kept `lookupByLocator` so that ordinary
mail attachments still resolved would forfeit the confinement criterion this
whole design pivots on.
The confinement-preserving replacement for that channel is a
`SturdyRef`-carried attachment resolved through `lookupBySturdyRef`: an
attachment that must be reachable by a confined recipient would be delivered as
a sturdyref (an anonymous placeholder the recipient cannot de-anonymize), not
as a self-redeeming locator.
Only agents that were never attenuated (a full `EndoGuest`, or the host) retain
the bare-locator attachment path.

That replacement is the intended direction, but naming it does not schedule it,
and this design does not implement it.
The outbound-message serialization in `packages/daemon/src/mail.js`
(`externalizeForMessage` and `externalizeMessage`) today converts a formula
identifier to a locator for a message's `ids` and attachments regardless of
recipient.
Delivering an attachment as a sturdyref to a confined recipient (and as a
locator to an unattenuated one) would make that pipeline
recipient-confinement-aware, which is new daemon-side logic that none of the
phases in [Phased Work](#phased-work) owns and that PR #541's facet-boundary
resolution (see [Dependencies](#dependencies)) may or may not cover.
This surface therefore scopes attenuated-worker mail attachments **out**: Phase
2 removes `lookupByLocator` (which is what creates the narrowing), and until a
separate daemon mail-pipeline change lands the recipient-aware serialization, a
confined worker on the attenuated facet simply has no resolvable
mail-attachment path rather than a working sturdyref one.
The replacement is asserted as the shape the follow-on must take, not as work
this surface completes.

### Daemon provide and accept

The daemon already spells "redeem a non-pet-name designator" as its own method
per designator kind: `lookupById(id)` and `lookupByLocator(locator)`
(`packages/daemon/src/interfaces.js:253-254`).
This design follows that convention instead of overloading `lookup`, whose
argument today is a pet-name path (`NameOrPathShape`).
A new daemon method, `lookupBySturdyRef(sturdyRef)`, resolves a sturdyref
through the closely held `enlivenSturdyRef` capability and **returns the
enlivened value**: a live, message-able presence, the same kind of result
`lookupById` and `lookupByLocator` already return.
A distinct name keeps admission visible at the call site (a caller reads
`lookupBySturdyRef` and knows it takes a sturdyref, rather than consulting a
table to learn which arguments `lookup` now accepts), keeps the portable
name-hub and filesystem guards (`packages/platform/src/fs/interfaces.js`)
untouched, and keeps a sturdyref (a fixed formula, no name-change semantics)
from sharing one method with a mutable pet-name binding.

That `lookupBy*` family coherence justifies the **daemon method** name, but it
must not be copied through to the **model-visible tool name** unexamined.
The daemon method's siblings (`lookupById`, `lookupByLocator`) resolve
caller-held, arbitrarily reusable designators drawn from a directory-like
namespace; the model-visible accept surface resolves a `ref@`-form handle that
[Tool-layer escrow](#tool-layer-escrow) spends its length establishing is
turn-scoped, non-enumerable, and refused outside its one pinned argument
position.
"Lookup" signals a repeatable, general-purpose query, which is exactly the
wrong mental model for a one-render escrowed handle that is not a name and
expires at the turn boundary.
Because the model-visible tool name is a separate pinned constant from the
daemon method name (a divergence seam the shared constant exists to close; see
[Tool-layer escrow](#tool-layer-escrow)), Phase 4 pins a single model-visible
verb that signals **redemption/consumption**: `redeemSturdyRef`, matching the
"accept" framing used everywhere else in this document, rather than defaulting
to the daemon method's own `lookupBy*` spelling.
The verb is pinned as one constant, not offered as a choice, because a
divergence-closing constant cannot itself ship as an unresolved alternative.
The daemon method stays `lookupBySturdyRef` for family coherence with its
siblings; the model reads and calls `redeemSturdyRef`.

**What the result is to the model, and why the accept surface is a JSON-mode
tool.** The accept operation's result is a presence, and the shipped renderer
turns a presence into a description with no designator the model can carry
forward (`packages/fae/src/tool-makers.js`).
The render map defined below escrows *sturdyrefs* (the inputs), not presences
(the outputs), so it does not by itself give the model a handle for the
enlivened presence to name in a later tool call.

The accept surface is therefore a **JSON-mode tool**, not a code-mode one.
The model calls `redeemSturdyRef` (the pinned model-visible accept-tool name of
[Tool-layer escrow](#tool-layer-escrow), which the tool layer dispatches to the
`lookupBySturdyRef` daemon method) and the render map
redeems the handle in that tool's pinned `sturdyRef` parameter, an argument
position that exists in the JSON tool-schema loops both agents actually run
(Lal `runOneRound`, `packages/lal/agent.js:126`; Fae `runAgenticLoop` over
`initialSchemas`/`toolMap`, `packages/fae/agent.js:415`).
Code-mode is **not** the initial consumer, and scoping the surface to it would
name no shipped agent path.
The `@endo/agentry` code-mode preset strips all built-in tools to a single
`evaluate` (`packages/agentry/README.md:394`;
`packages/agent-tools/src/code-mode/evaluate-tool.js:70`), so it exposes no
`sturdyRef` tool parameter for the pinned redemption position to live in; a
handle the model typed in code-mode would land inside `evaluate`'s source
string, which is precisely a non-accept position the redemption rule below
requires to fail.
Neither Lal nor Fae runs a code-mode loop today, so the motivating same-turn
flow is realizable only on the JSON tool surface.

What the model does with the *returned* presence is the honest limit of the
initial surface, and it is a real limit stated plainly: because the presence
renders with no model-carryable designator and the `storeValue` deny closes the
pet-name fallback, the shipped increment's only model-usable outcome of an
accept is an inspection **description** of the enlivened presence, not a handle
the model can act on in a later call.
The initial surface is therefore an infrastructure milestone: it removes
namespace allocation for the same-turn handoff, but it does not yet deliver an
end-to-end agent capability that acts on the accepted candidate.
The end-to-end "enliven the candidate and then act on the presence in a later
model-mediated call" flow ships only with a value-producing accept operation (a
method that both accepts a sturdyref and acts on the enlivened presence within
the one call), which is the future admission deferred later in this section and
gated on its own authority review.
An output-side render map that gives the model a re-addressable handle for a
returned presence is a distinct surface, also out of scope here.
The reason it is deferred is **not** that such a handle necessarily outlives
the turn: a *turn-scoped* presence handle minted by the same per-activation
epoch mechanism this design specifies for the input side would expire at the
turn boundary exactly as an input handle does, and case 1 of [Retention and
user revocation](#retention-and-user-revocation) (the producing root stays
reachable for the turn) applies to it unchanged, so a within-turn output handle
carries no new retention question.
It is deferred because it is added surface this initial increment does not
build, and because a presence handle the model could carry *across* turns would
be exactly the cross-turn hold the retention investigation governs.
The input side (render a sturdyref to a handle, redeem it in a later same-turn
call) is what this surface ships; the disposition of the output presence is
deferred, and the shipped increment's only model-usable outcome is the
inspection description named above.

The method list below must be derived from authority, not from input shape.
Each method named is an existing daemon or name-hub method
(`packages/daemon/src/interfaces.js`); the design adds exactly one method,
`lookupBySturdyRef`, and admits no sturdyref argument to any existing method
until an authority review clears it.
Each row records whether a sturdyref may be resolved through that surface, and
why:

| Surface | SturdyRef resolution | Reason |
|---|---|---|
| `lookupBySturdyRef` (new) | Yes | The facet enlivens the supplied value through `enlivenSturdyRef`; the method exists only for this. |
| `lookup`, `maybeLookup`, `has` (the guest read surface from `readableNameHubMethodGuards`, `packages/platform/src/fs/interfaces.js:61`, spread onto the guest at `packages/daemon/src/interfaces.js:90`) | No | These take a pet-name path today; a sturdyref is redeemed by `lookupBySturdyRef`, not by widening these guards. (The `MountInterface` methods of the same name are the filesystem mount, a different object, not the attenuated guest surface.) |
| `list` (also `readableNameHubMethodGuards`, variadic over path segments) | No | `list` enumerates a directory named by a path; a sturdyref names a single formula, not a directory. |
| `storeValue` (`packages/daemon/src/interfaces.js:321`, guarded `M.call(M.any(), NameOrPathShape)`, live on the guest at `packages/daemon/src/guest.js:330`) | No | This marshals **any** passable (a `SturdyRef` included) under a pet name, and it is a model-facing tool today (Fae's `store` tool, `packages/fae/src/tool-makers.js:850,880`). It survives the Phase 2 attenuation, which removes only locator-disclosing methods, so left unaddressed it is a direct path from an anonymous sturdyref to a durable pet name that bypasses the render map and its single-turn redemption window entirely (the turn-epoch mechanism enforcing that window is defined under [Tool-layer escrow](#tool-layer-escrow)). It needs an explicit deny of a sturdyref-typed value **anywhere in its argument passable graph** (not only the top-level value), plus negative tests; cross-turn persistence of a stored sturdyref is folded into the retention investigation exactly as mailbox storage is (see [Retention and user revocation](#retention-and-user-revocation)). |
| `identify`, `locate`, `listIdentifiers`, `listLocators` (`nameHubMethodGuards`, `packages/daemon/src/interfaces.js:99`) | No | These return locator or stable naming information and are not part of the confined placeholder surface. |
| Mutating name operations `storeIdentifier`, `storeLocator`, `remove`, `move`, `copy` (`nameHubMethodGuards`) | No | A sturdyref must not silently become authority to mutate a namespace; each row needs an explicit deny plus a negative test. |
| Reverse operations `reverseLookup` (`interfaces.js:108`), `reverseLocate` (`:103`), `reverseIdentify` (`:252`) | No | They would turn a value into naming or locator information; `reverseLookup` is guarded `M.call(M.any())`, so it needs an explicit deny, not just an absent guard change. |

A general rule follows from the `storeValue` row, because a shipped method that
marshals `M.any()` is not the only such method and more may be added: **the
tool layer's render map redeems a handle in exactly one argument position (the
`sturdyRef` argument of `lookupBySturdyRef`, and any future accept method its
own authority-review row admits) and nowhere else.** Because a handle can be
nested, the redemption is over the whole passable graph of that one argument.
The rule that guards the *other* positions keys on identity with a live or
recorded entry, not on the `ref@` grammar, so it does not turn ordinary content
into a failure: a string that **equals a live or recorded handle entry**,
appearing anywhere *outside* the admitted `sturdyRef` argument (in another tool
parameter, or nested inside a structured argument to a non-accept method), does
not redeem and fails before the daemon call, so the render map cannot be used to
smuggle a live sturdyref into a persisting method even where that method's guard
would accept the value.
A string that merely matches the `ref@` grammar but equals no live or recorded
entry is treated as ordinary data in a non-accept position: it passes through
unchanged, so a file line, a grep result, a commit message, or model prose that
happens to contain `ref@...` is not a handle the tool layer minted and neither
redeems nor aborts the call.
This bounds handle redemption to the single-turn accept surface by construction
rather than by auditing every `M.any()`-guarded method for sturdyref leakage.
It does not by itself stop confined code that already holds the `SturdyRef`
value from calling `storeValue` with it directly; that path is what the
`storeValue` deny row and its negative tests close.

Two distinct admission axes meet in this section and must not be read as one
restated rule.
The admission *table* above governs which **daemon methods** may resolve a
sturdyref at all, an authority question about the method.
This redemption-position rule governs which **tool argument** the render map
will turn a model-presented handle back into a value in, a question about the
model-facing surface that stands above those methods.
This paragraph is the canonical statement of the redemption-position rule;
where the [Acceptance Criteria](#acceptance-criteria) and [Tool-layer
escrow](#tool-layer-escrow) mention it again they restate it as a testable
checklist item, not as a second independent rule.

Two situations do reach a failure, and their model-facing **messages** must not
collapse into one, because the design's own principle is that failure reasons
split by remediation ([Tool-layer escrow](#tool-layer-escrow)): "move the
handle into the accept tool's `sturdyRef` argument" is a different instruction
from "stop inventing handles."
A syntactically valid, live handle (one that *would* redeem in the admitted
position this same turn) submitted as a tool argument in some *other* position
is classified **misplaced**, with the remediation "this is a real handle, but
only the accept tool's `sturdyRef` argument redeems it".
Text submitted in the **accept** position that matches no live or recorded
entry is **unknown**, with the remediation "stop inventing handles"; fabricating
a handle cannot conjure a capability, which is the "arbitrary text never becomes
a sturdyref" bar.
The two are distinguished by position: **misplaced** requires a string equal to
a live entry in a non-accept position, whereas **unknown** requires the accept
position.
Handle-shaped text that equals no entry and sits in a non-accept position is
neither: it is ordinary data and is not classified or failed at all (see the
redemption-position rule above).
"Misplaced" is therefore deliberately scoped to a *live* handle that reaches
the redemption boundary as a tool-call argument in a non-accept position: a
handle the model merely quotes back in its own free-text or reasoning output is
never submitted for redemption, is not classified at all, and does not fail a
call.
The classification governs argument positions the tool layer actually inspects,
not text the model narrates.
Misplaced is the fourth model-facing reason alongside **unknown**, **stale**,
and the daemon-side **enlivenment-failure**, and its message is pinned as a
shared constant on the same footing (see [Tool-layer
escrow](#tool-layer-escrow) and [Acceptance Criteria](#acceptance-criteria)).
Classifying it as misplaced discloses nothing an attacker could exploit (it
only confirms the handle the confined code already holds is live), while
withholding the correct remediation would strand a model that merely put a good
handle in the wrong slot.

A value-producing evaluation slot that accepts a sturdyref (for example, an
`evaluate` argument enlivened before use) is a plausible future admission, but
it is a second surface that would require its own authority-review row and
negative test per the criteria above; it is deliberately excluded from the
initial surface, which admits exactly one method.
Admitting any such slot is deferred until that review clears it.

Because `lookupBySturdyRef` is a new method, the phase that adds it must also
update the daemon's self-documenting help surface
(`packages/daemon/src/help.md` and the per-method help strings in
`packages/daemon/src/help-text-data.js` that `help("lookupBySturdyRef")`
returns) so an agent discovering the method through that entry point sees it.

The two directions the title names are not symmetric in this document, and the
asymmetry is deliberate.
The **accept** direction (a confined worker handing a `SturdyRef` back for
resolution) is the new surface specified here: `lookupBySturdyRef`, its
admission row, and its acceptance criteria and phase.
The **provide** direction (where a `SturdyRef` value first originates and is
returned to a worker) is not a new method of this surface: a sturdyref is
produced by the daemon-side facet-boundary resolution of the parent sturdyref
work (PR #541) and minted by the closely held `makeSturdyRef` (PR #539), never
by a worker-callable method.
Step 1 of the tool flow ("a daemon facet returns a `SturdyRef`") refers to that
existing production path, not to a method this document introduces.
This document therefore adds a named surface for accept only; provide is
carried by the render map and the parent work's existing facet output, and
needs no new admission row.

The asymmetry is not that the provide direction is ungoverned, but that its
governing rule is different in kind, and the difference is worth stating so the
render map's "walk any tool result and replace every `SturdyRef` with a handle"
is not mistaken for the accept side's per-method audit relaxed.
**Rendering is authority-reducing; accepting is authority-conferring.** Turning
a `SturdyRef` into an opaque `ref@` handle strictly *removes* what the model
can do with the value: the model gets text it can only pass back verbatim into
the one admitted accept position, and it can no longer reach the underlying
value's structure, its locator, or its swiss number (which it never had, and
the handle does not add).
So the render map admits *by construction* on the output side too (a handle
grants strictly less than the value it replaces), and that is exactly why it
can walk an arbitrary output passable graph and render a `SturdyRef` found at
any nesting depth, from any method, without a per-method admission table: no
output path can turn rendering into an authority the value did not already
carry.
The accept side needs its per-row audit precisely because it runs the other
way, turning a handle back into an enlivenable value.
What the provide direction does *not* own (which daemon methods are permitted
to hand a confined worker a `SturdyRef` in the first place) is the parent
work's admission-source question (PR #541's facet-boundary resolution),
deferred there deliberately, not silently skipped here; the render map governs
only the authority-reducing rendering step, and governs it by the construction
argument above rather than by audit.

`lookupBySturdyRef` must also state its failure-mode contract, matching the
sibling `lookupById`/`lookupByLocator` methods it is named after, which reject
(throw) instead of returning a sentinel when their target cannot be resolved.
`lookupBySturdyRef` follows the same convention: it rejects when the supplied
`SturdyRef` cannot be enlivened (the underlying formula was collected or
revoked, or no association for it was ever established), so the caller
distinguishes a tool-layer handle-not-found failure (raised before the daemon
call, in the render map) from a daemon-side enlivenment failure (a rejection
from `lookupBySturdyRef` itself).
Neither failure returns a value that could be mistaken for a resolved presence.

The "single-turn only" property is a property of the **model-mediated handle
surface**, not of `lookupBySturdyRef` itself.
The daemon has no turn concept: the method enlivens any well-formed sturdyref
it is handed, whenever it is handed one.
What is turn-scoped is the render map that stands between the model and the
method.
It will only redeem a handle stamped with the current epoch, so the *model*
cannot present a prior-turn handle.
But the confined worker holds the `SturdyRef` value itself (the render map
escrows it only from the model), so nothing in `lookupBySturdyRef` stops the
worker from keeping that value in a variable across turns and re-presenting it,
and that is genuine cross-turn retention.
This design does not claim the daemon method refuses it; it claims only that
the initial *agent surface* admits sturdyref presentation single-turn, through
the render map, and that every cross-turn holding path (a worker-held value
re-presented later, a `storeValue`-persisted value, a mailbox attachment) is
deferred to the retention investigation ([Retention and user
revocation](#retention-and-user-revocation)) rather than admitted as
retention-free.
Giving the daemon method its own turn or holder scoping is one candidate
outcome of that investigation (the holder-scoping question below), not a
property the shipped method has by default.

These two facts name two different principals, and the design guards each with
a different mechanism rather than expecting one to cover both.
The single-turn render-map property defends against the **model** (the
untrusted text-emitter that could quote a prior-turn handle), and the confined
**worker** is the principal every confinement section here treats (the
attenuated facet, the `storeValue` deny, the deferred retention investigation).
The render map does not confine the worker (it holds the real value); the facet
and the deny do.
Reading the single-turn property as the worker's confinement boundary would
mistake a model-facing presentation limit for a capability-level one, which is
exactly why cross-turn worker holds are routed to the retention investigation
and not called retention-free.

Mail and agent APIs may carry a `SturdyRef` only as a passable attachment or
tool argument.
Accepting such a value must not create a pet name implicitly.
An explicit user-authorized namespace write remains a separate operation.
`storeLocator(petNamePath, locator)` needs a locator the confined worker does
not hold, so it is not a path from an anonymous sturdyref to a pet name.
But `storeValue(value, petNamePath)` is: it marshals any passable (a
`SturdyRef` included) under a pet name, needs no locator, and is a shipped,
model-facing method on the guest surface (see the admission table above).
It is therefore not enough to observe that `storeLocator` is closed; the
attenuated facet must also deny a sturdyref-typed value to `storeValue` (with a
negative test), and because `storeValue` marshals an arbitrary passable graph,
the deny must be **recursive**: `storeValue({ x: sturdyRef }, name)` and
`storeValue([sturdyRef], name)` must be rejected exactly as a top-level
`storeValue(sturdyRef, name)` is.
Any persistence of a sturdyref that survives to a later turn (whether through
`storeValue` or through mailbox storage) is deferred to the retention
investigation rather than admitted as a retention-free operation.

A mail attachment is a distinct storage channel from the tool layer's render
map, and the "single-turn only" scope does not silently extend to it.
The daemon mailbox (`packages/daemon/src/mail.js`) is a persistent,
formula-graph-backed store: a message sent in one turn can sit unread and be
read in a much later turn, by the same or a different worker.
A `SturdyRef` that rides a mail attachment and is enlivened after crossing that
gap is therefore a cross-turn presentation, not the in-memory, single-turn
render-map case the initial surface admits.
Mailbox storage of a sturdyref is folded into the deferred retention
investigation ([Retention and user
revocation](#retention-and-user-revocation)): until that investigation answers
whether a cross-turn sturdyref needs a retention edge and how it is revoked,
the initial surface does not treat enlivening a mail-attached sturdyref in a
later turn as a retention-free operation, and a daemon method must not resolve
a sturdyref recovered from mailbox storage across a turn boundary as though it
were single-turn.

### Tool-layer escrow

LLM tool protocols carry text, so no passable value is sent through the model.
Each agent tool layer keeps a **render map**: an in-memory, turn-scoped escrow
from an opaque local handle to a `SturdyRef`.
On output it renders a handle in place of each `SturdyRef` in a tool result; on
input it redeems a known handle back to its `SturdyRef` before daemon argument
matching.
The table is restricted to sturdyrefs.

The render map keys its entries by the **object identity** of the held
`SturdyRef`, not by the value's structure.
This matters because every sturdyref is structurally identical: `makeSturdyRef`
returns `makeTagged('ocapn-sturdyref', undefined)`
(`packages/ocapn/src/client/sturdyrefs.js:56`), so a structural key would
collapse all sturdyrefs to one handle and violate "two sturdyrefs never
collapse."
Identity keying is well-defined within a turn because the worker holds the same
`SturdyRef` object in process memory across that turn's deliveries (the render
map is where it is held), so the same object rendered twice yields the same
handle and two distinct objects yield two handles.
It does not need identity to survive a decode, because the model-mediated flow
the map serves stays within one turn and never round-trips the value back
through the codec between rendering and redemption.

Calling this map "presentation state only" would understate it: the same
structure is both the rendering table (handle to value and back) and the
enforcer of the redemption window (through the epoch stamp described just
below), so it does carry lifetime policy.
Two mechanisms could each close that window (the per-entry epoch stamp checked
at redemption, and the per-activation map lifetime that discards every entry on
return), and to keep an implementer from having to guess which is load-bearing
this design names exactly one: the **per-entry epoch stamp** is the enforcer,
because it is the value redemption actually reads and it is what lets the
bounded classification record tell **stale** from **unknown** after a map is
discarded.
The per-activation map lifetime is defense in depth, not a second enforcer: it
bounds accumulation and makes a forgotten wrap fail loud, but a handle's
redeemability is decided by its stamped epoch, never by which map object happens
to hold it.
What it is *not* is a lifetime record of what the daemon retains: it mints no
authority, changes no pass style, and is not the holder of record for any
daemon-side edge.
It is a turn-scoped escrow of presentation handles, not a retention ledger.

The rendered form is pinned instead of left to each agent, so a result
carrying more than one sturdyref stays legible.
Each `SturdyRef` in a tool result renders as its own distinct handle (two
sturdyrefs never collapse to one handle; one sturdyref rendered twice within a
turn yields the same handle), and each handle is emitted in the value's own
position within the result structure rather than as bare free text, so the
model can tell which field a handle stands in for.
A handle carries no describing text of its own; where the model must
distinguish two handles by role, the surrounding tool result supplies that
context in its own fields, exactly as it would for any other opaque value.

The single-turn boundary is enforced, not assumed, and it is enforced as a fact
recorded on the render-map entry rather than inferred from where any one
agent's host loop happens to return control.
The redeemable window of a handle is a property the render map itself carries:
the map stamps every entry with a monotonic **turn epoch** (a counter the tool
layer advances once per turn) in force when the handle was rendered, and
redemption refuses any handle whose stamped epoch is not the current one.
"How long is this handle redeemable?"
is then a fact checked against a value the map holds, not an inference from
control-flow shape, so it stays correct even if a runtime pipelines turns,
streams partial responses, or processes deliveries out of loop-call order.

The epoch is deliberately stamped on the map entry, not carried inside the
`SturdyRef` value, and that placement is the point rather than an accident: the
value is an inert copy the worker holds and re-presents, so a turn number
written into it would be worker-mutable, would travel wherever the worker
copied the value, and would make the value itself a carrier of lifetime policy,
exactly the retention-ledger role this map is kept out of.
Keeping the epoch on the tool-layer's own entry (and the bounded classification
record, below, on the tool layer too) confines every lifetime decision to state
the tool layer owns and discards, so the inert value stays inert and carries no
policy.

The epoch counter and a small classification record are the tool layer's, and
outlive any one turn's map.
The agent runtime this design targets is a long-lived process, so there is no
process teardown between turns to clear the map for free.
Rather than leave the epoch advance as per-agent call-site edits that each fail
*open* (a forgotten advance yields an ever-growing map, exactly the cross-turn
retention this design defers), the shared tool layer hands out the render map
**per activation**: the shared helper that a tool layer wraps its per-turn
dispatch in mints a fresh turn-scoped map (equivalently, a fresh epoch) for
that activation and discards it when the activation returns.
The loud failure this buys is a property Phase 4 must implement, not one the
shipped renderer already exhibits: the render step must treat the *absence* of
a per-activation map as an error rather than lazily creating one (a
lazily instantiated map would reintroduce exactly the silently unbounded,
never-discarded map this scheme exists to prevent).
With that render-step rule in place, a forgotten wrap yields *no* map for that
turn (handles fail to render at all, a loud failure) rather than a silently
unbounded one, matching the by-construction attenuation this design prefers
elsewhere over an audit obligation.

Discarding the per-activation map raises a lifecycle question that the
stale-versus-unknown distinction below depends on: if the whole map is thrown
away each turn, what lets the next turn tell a real prior-turn handle from
fabricated text?
Two pieces of state deliberately outlive the map and are owned by the tool
layer, not by any single activation's map:

- The **monotonic turn epoch counter** itself, so a fresh map for turn N+1 is
  stamped with a strictly greater epoch than turn N's discarded map and no
  prior-turn handle can ever match again.
- A **bounded classification record** of recently rendered handle identifiers
  and their epoch (the handle string and its epoch, and **never** the
  `SturdyRef` value).
  This record holds no value, so it grants no cross-turn *redemption* and
  creates no retention edge; it exists only so a handle presented after its map
  was discarded can be classified as **stale** (a real prior-turn handle)
  rather than **unknown** (never a handle).
  It is bounded (a fixed-size recent window), so it is not itself an unbounded
  accumulation.

These two pieces of state outlive any one turn's *map*, but "owned by the tool
layer" above must not be read as "a process-global module singleton," and the
implementation must state their instantiation scope explicitly: the epoch
counter and the classification record are scoped to a **single worker-loop
activation context**, one instance per concurrently running loop, not shared
across a process.
This scoping is forced by a concurrency shape Lal already ships, not a
hypothetical: `runInboxLoop` fires `spawnWorkerLoop(guest, ...)` per sub-agent
(`packages/lal/agent.js:272`), tracked in `activeWorkers` and not awaited
(`workerP.catch(...)`), so one Lal process runs several `runOneRound` turns
concurrently.
If the epoch counter were a module-level singleton shared across those loops,
one sub-agent's turn advancing the shared epoch would wrongly reclassify a
*different*, still-in-progress sub-agent's current-turn handle as **stale**
mid-turn, breaking the central acceptance criterion (a handle rendered earlier
in the same turn stays redeemable) for a shape that already exists.
The counter and record must therefore be created once per worker-loop instance
and never straddle two concurrent loops.
(Fae's subagent path provisions a separate formula/worker, not an
in-process loop (`makeUnconfined`, `packages/fae/src/subagent-host.js`), so
each Fae worker has its own process and its own counter by construction; the
explicit per-loop scoping is what makes Lal's in-process case safe too.)

Each agent must still wrap its own actual turn-completion unit, and that unit
differs between the two agents:

- **Lal** completes a turn at each `runOneRound` return: `runInboxLoop`
  (`packages/lal/inbox-loop.js`) calls `runOneRound`
  (`packages/lal/agent.js:126`) once per inbound message against a reused
  `PiAgent`.
- **Fae**'s per-activation unit is `runAgenticLoop`
  (`packages/fae/agent.js:415`, documented in-tree as running the agentic loop
  for a single incoming message), **not** `runAgent`.
  `runAgent` (`packages/fae/agent.js:511`) is Fae's process-lifetime inbox
  loop: a `while (true)` over `followMessages` (`:754`) that returns only on
  cancellation or stream end, with exactly one `runAgenticLoop` call site
  inside that loop body (`:650`), once per inbound message.
  The epoch therefore advances per `runAgenticLoop` pass; advancing it per
  `runAgent` return would advance it once per process lifetime (effectively
  never), leaving the accumulating map above.

Without this per-activation map the natural implementation (a map built once at
worker start) would silently accumulate the un-investigated cross-turn
retention this design defers, so the per-activation lifecycle is a required
Phase 4 step with its own negative test **run against each of Lal's and Fae's
actual loop shape**, not an implementation nicety asserted from Lal's loop
shape alone (see [Phased Work](#phased-work) and [Acceptance
Criteria](#acceptance-criteria)).

This render map is deliberately **not** a lifetime record of daemon retention.
It neither mints a fresh authority nor changes the sturdyref's pass style.
Any cross-turn retention is a separate, daemon-side concern ([Retention and
user revocation](#retention-and-user-revocation)): the daemon-side retention
set, not the tool layer's render map, is the authoritative and auditable record
of what is held.
Keeping the two apart means that losing the render map to a process restart can
never strand a daemon-side edge, because the render map was never the edge's
holder of record.

An unknown handle is ordinary untrusted text and must fail before reaching the
daemon facet.
To keep a handle from silently colliding with a pet name (any string lacking
`/`, `\0`, and `@`; `packages/daemon/src/pet-name.js:15,19`), handle syntax
must be disjoint from legal pet-name syntax.
Any form that contains `@` achieves that, since a pet name cannot contain `@`
anywhere.
But `@` is not unclaimed space in two ways.
First, the daemon reserves an `@`-*led* grammar for special names such as
`@self` and `@host` (`validSpecialNamePattern = /^@[a-z][a-z0-9-]{0,127}$/`,
`packages/daemon/src/pet-name.js:25`), so a handle must be disjoint from that
grammar too.
Second (and this is the reader the parser check misses), the actual reader of a
handle is the model, and Lal's own system prompt teaches the model to *type*
`@self` and `@host` as names it composes
(`packages/lal/prompts/system.js:17,26-27`).
A handle that led with `@` would differ from those composable names by as
little as one character in the second position, inviting the model to treat an
opaque, never-invent handle as a member of the name family it was told it may
write.
Disjointness to the parser is not enough; the reserved form must also not
*look* to the model like a name.
The form this design pins therefore embeds `@` without leading with it.

This design pins the concrete handle grammar instead of leaving it as an
example, because its stated goal is that Lal and Fae share one behavior:
leaving the syntax open is exactly the seam two tool-layer implementations
could diverge on.
The reserved grammar is a `ref@` prefix followed by an opaque identifier,
rendered for example as `ref@7f3a`.

The `ref@` prefix is fixed, but the opaque identifier after it is not left to
each agent to generate: the shared constant pins its generation, not only its
syntax, because a grammar without a generation rule is not a security boundary.
The identifier is drawn from a cryptographically unguessable source with an
entropy floor no smaller than 128 bits (the four-hex-digit `ref@7f3a` is an
illustrative rendering, not the pinned length), and it is **unique within the
render map that mints it**, so no two live entries and no entry recorded in the
bounded classification record share an identifier.
Two properties follow, and both are load-bearing.
First, a confined worker (which composes tool arguments, not only the model)
cannot enumerate `ref@1`, `ref@2`, and so on to redeem an entry of the current
turn's map it was never shown: a sequential or low-entropy identifier would make
the map a liveness-and-enumeration oracle, and the **misplaced** classification
(a liveness signal on a *live* entry) would compound that, so unguessability is
what keeps **misplaced** from disclosing anything an attacker can search for.
Second, per-map uniqueness plus the entropy floor forecloses a collision the
turn epoch cannot catch: a transcript-quoted prior-turn handle that happened to
match a live current-turn identifier would otherwise redeem to the wrong
capability (a confused deputy the stale/unknown/misplaced taxonomy cannot
detect), and requiring the identifier to be unique within its minting map
removes that case by construction rather than leaving it to chance.
This generation contract is part of the same pinned handle-contract record as
the grammar, so the two agents cannot diverge on it, and the per-map scoping is
what makes the concurrent-loop case safe (two loops minting the same identifier
string for different sturdyrefs is impossible once each identifier is unique
within, and unguessable across, its own map).

It contains `@`, which no pet name may contain, so it is disjoint from pet-name
syntax; it does not begin with `@`, so it is disjoint from the special-name
grammar and carries no family resemblance to the `@`-led names (`@self`,
`@host`) the model is taught to compose.
It is pinned once in the shared tool layer as a single exported constant that
Lal and Fae consume instead of re-deriving the syntax, and the same layer owns
a test asserting the handle grammar stays disjoint from both `pet-name.js`
patterns, so that if the daemon's name grammar is ever widened the collision is
caught rather than silently admitted.
Because the tool layer still never presents a handle to the daemon as a name,
that disjointness is defense in depth: if a handle ever leaked into a
name-accepting path it could not be mistaken for a valid pet name or special
name.
On a handle that does not redeem, the model sees an explicit failure, not a
daemon lookup on attacker-chosen text.

That failure distinguishes two operationally distinct situations, because they
carry different remediations for whoever is debugging a stuck agent.
A handle whose syntax never matched the `ref@` grammar, or that names no entry
in the current map and no entry in the classification record above, is
**unknown**: text the model fabricated that was never a valid handle, and the
remediation is that the string was never a reference.
A syntactically valid handle whose epoch (in the classification record) is a
prior turn's is **stale**: it named a real entry that has since fallen out of
scope at the turn boundary, and the remediation is to re-fetch the value
because the redemption window closed.
Both are refused before the daemon facet is called and neither yields a
resolved presence, matching the same failure-mode granularity this surface
already draws between a tool-layer handle-not-found and a daemon-side
enlivenment failure ([Daemon provide and accept](#daemon-provide-and-accept));
the two just report different reasons.

Because the classification record is bounded, the stale-versus-unknown split
has a known, bounded imprecision the implementation must own rather than leave
undocumented: a *genuinely stale* handle (a real prior-turn entry) that has
aged out of the fixed-size window is no longer distinguishable from fabricated
text, so it degrades to **unknown** and the model is told "the string was never
a reference" when the correct remediation was still "re-fetch."
This is a deliberate trade of the classification record's memory bound against
remediation precision, not an oversight.
The window must therefore be sized against the model's retained-transcript
horizon (the span of prior turns whose handles the model can still quote), so
that a handle old enough to have evicted is also old enough that re-quoting it
is itself unlikely; the eviction boundary is a named Phase 4 test (a handle
rendered exactly at and just past the window edge, and the resulting
classification), and its acceptance is called out in [Acceptance
Criteria](#acceptance-criteria).
Sizing the window and choosing whether an evicted-stale handle should bias
toward the **stale** message (favoring re-fetch) rather than **unknown** is
left to that phase, but the degradation itself is stated here so it is not
discovered as a surprise.

Because the stale-versus-unknown distinction is the only signal the model has
for choosing "re-fetch the value" over "I hallucinated this" (the transcript
retains prior-turn handles that look identical to live ones), the two failure
messages are model-facing prose the model must act on, and so are pinned by the
same rule as the disclosure fragment below.
The daemon-side enlivenment failure carries a third, distinct remediation (the
formula was revoked or collected, so do **not** re-fetch) and is likewise
surfaced to the model by the tool layer, so it is pinned too.
A fourth reason, **misplaced** (a live handle presented outside the accept
tool's `sturdyRef` argument; see [Daemon provide and
accept](#daemon-provide-and-accept)), carries its own remediation ("move the
handle into the `sturdyRef` argument") and is pinned on the same footing.
The **unknown**, **stale**, **misplaced**, and **enlivenment-failure** message
texts are four shared constants in the shared tool layer, consumed verbatim by
both agents rather than re-worded per agent, and named as such in Phase 4 and
the acceptance criteria.

Pinning the grammar as a shared constant closes divergence at the value layer,
but the model never reads the constant; it reads the tool-call description that
discloses the handle contract at the point of use (a handle is opaque
`ref@`-form text, must be passed back verbatim, and must never be invented).
If each agent worded that description independently, the divergence the shared
constant closes at the value layer would reappear at the prompt-description
layer.
The disclosure text is therefore pinned the same way the grammar is: a single
shared description fragment in the shared tool layer, consumed verbatim by Lal
and Fae in the schema or description of any tool that renders or accepts a
handle, rather than re-authored per agent.
Because Fae renames daemon methods at its tool boundary (`storeValue` becomes
the tool `store`, `packages/fae/src/tool-makers.js:850`), the shared constants
pin the **model-visible tool name and parameter name** of the accept tool, not
only the underlying `lookupBySturdyRef` daemon method and its `sturdyRef`
parameter: pinning the daemon spelling alone would leave the model-facing
spelling as the very divergence seam the shared constant exists to close.
Phase 4 and the acceptance criteria require the shared description, the shared
model-visible tool/parameter names, and the four shared failure messages, not
only the shared grammar constant.

These pinned strings are not eight loose exports the two agents each import by
name; they are one exported **handle-contract record**, a single frozen object
in the shared tool layer bundling the handle grammar, the disclosure fragment,
the model-visible accept-tool and parameter names, and the four
**unknown**/**stale**/**misplaced**/**enlivenment-failure** messages, which Lal
and Fae consume as a whole.
Bundling them into one record makes the shared surface a single import both
agents depend on rather than a checklist of individually importable constants
any one agent could partially adopt, so a new divergence seam cannot open by an
agent picking up the grammar but re-wording a message.

Lal and Fae (sharing the tool layer through `@endo/agent-tools` and
`@endo/agentry` as described in [Dependencies](#dependencies)) share this
narrow behavior instead of each inventing a reference type or allowing
arbitrary remotables through their JSON or SmallCaps boundaries.
(**SmallCaps** here is the marshal layer's compact JSON encoding of passables,
the format an agent's tool boundary would otherwise have to admit a remotable
through.)

### Retention and user revocation

On-demand enlivenment does not by itself answer whether a worker retaining a
sturdyref must keep the sturdyref's referenced formula alive.
This gap is the direct cost of dropping `SturdyRefToken`, and it is the one
place this document states that cost, canonically: with an identity-bearing
remotable, a presence's own held-or-dropped identity would have been a
convenient *starting point* for a retention and revocation lifecycle.
It would **not** have delivered an auditable lifecycle for free: a remotable's
lifecycle is garbage-collection-tied, and this section disqualifies
garbage-collection observation and `FinalizationRegistry` as acceptable
substitutes for an auditable lifecycle.
So what the token removal forfeited is a convenient starting point for a
lifecycle this design would have had to make auditable regardless, not a
finished retention story.
Because the reference is now a bare value, that auditable lifecycle must be
built here explicitly.
There are two distinct cases:

1. The sturdyref is only a transient argument within a single turn (across one
   or more deliveries held in the tool-layer render map, per the boundary
   definition in [Summary](#summary)).
   No worker retention edge is created merely for the call.
   This does not lean on garbage-collection timing to keep the referenced
   formula alive across the turn: the sturdyref originates from a daemon-side
   facet within the same turn, and whatever formula-graph root produced it (the
   presence it was minted for, or the existing edge that surfaced it) stays
   reachable for the turn's duration through that pre-existing root, not
   through the anonymous value happening to survive collection.
   The claim is only that the confined worker's transient hold adds no *new*
   edge, not that a formula with zero edges would nonetheless persist; the
   latter would be exactly the garbage-collection substitute case 2 below
   disqualifies.
   This is the only case the initial agent surface admits.
2. A worker keeps a sturdyref across turns.
   If that value must remain enlivenable, the daemon may need an ephemeral
   retention edge from that worker to the referenced formula.
   This case is deferred; it does not ship until the investigation below has
   answers.

The second case is a design prerequisite, not an implementation detail.
Before offering cross-turn retention, the implementation must answer all of
these:

- Does the existing formula graph already retain the formula through another
  root, or does a cross-turn sturdyref require a new edge?
  The edge-label taxonomy in
  [daemon-retention-paths](daemon-retention-paths.md) (which already
  distinguishes `worker`, `petStore`, and `retention` edges in the formula
  graph) is the place to start this investigation instead of deriving it from
  scratch.
- If a new edge is needed, what precise event adds it and what precise event
  removes it?
  Garbage-collection observation and `FinalizationRegistry` are not acceptable
  substitutes for an auditable lifecycle.
- Is redemption holder-scoped or bearer-scoped?
  If any facet redeems any sturdyref presented to it, then revoking worker A's
  edge revokes nothing when worker B holds a copy, so per-worker revocation is
  not meaningful without a holder-scoping rule.
  See [Open Questions](#open-questions).
- Which user-visible surface lists every worker retaining a sturdyref for a
  formula, including the worker identity and the retention path?
- What user action revokes one listed worker's retention edge, and what happens
  to that worker's future attempts to enliven the sturdyref?
- Does revocation also terminate or partition a worker that already holds an
  enlivened presence?
  If not, what authority remains after the edge is removed?

Until these questions have answers, the implementation must not claim that
anonymous sturdyrefs are retention-free or that forgetting a local binding is
sufficient revocation.
The daemon's existing retention-path work is the candidate observation surface,
but this design does not assume it already has the worker-level information
required here.

These two deferrals are not the same act and are ordered: the retention
*investigation* above (does a cross-turn hold require a formula-graph edge, and
what is its auditable lifecycle) is a prerequisite for any cross-turn retention
regardless of which sibling ships, and the *sibling selection* (whether the
`endor` `retain`/`release` syscall of
[sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) is chosen to answer
that same question) is a separate maintainer decision.
The maintainer selection governs *which mechanism* provides cross-turn
retention; the investigation governs *what that mechanism must prove* before it
ships.
If the sibling syscall is selected, it supplies the retention answer and this
section's questions are discharged against that syscall's lifecycle rather than
re-derived; if it is not, the answers are built here.
Either way the investigation's questions gate the ship, and the selection
decides the vehicle; this surface's initial, single-turn scope depends on
neither being resolved first.

## Acceptance Criteria

- `passStyleOf(sturdyRef)` is `'sturdyref'`; no guest-facing reference is a
  remotable or a second pass-style category.
  (Current state: `passStyleOf` returns `'tagged'` for the in-tree shim, which
  `ocapnPassStyleOf` upgrades; this criterion is met by the pass-style
  dependency in [Dependencies](#dependencies), not by the shim.)
- A confined worker can pass a previously received sturdyref to the
  `redeemSturdyRef` accept tool (which dispatches to the `lookupBySturdyRef`
  daemon method), a JSON-mode tool whose `sturdyRef` parameter is the pinned
  redemption position, verified against the JSON tool-schema loops Lal and Fae
  actually run, not against a code-mode loop, which neither agent runs and which
  exposes only `evaluate`, and receive that method's enlivened value result (a
  presence).
  Because the presence renders with no model-carryable designator, a
  model-addressable handle for the returned presence, and any value-producing
  operation that acts on the presence within the accept call, are future
  admissions gated on their own authority review, not part of the initial
  surface.
- The attenuated facet denies a sturdyref-typed value to `storeValue` (guarded
  `M.call(M.any(), ...)`, so an explicit check, not an absent guard), and the
  deny is **recursive over the argument's passable graph**: negative tests
  demonstrate that a confined worker cannot persist a sturdyref under a pet
  name whether it is passed top-level (`storeValue(sturdyRef, name)`) or nested
  (`storeValue({ x: sturdyRef }, name)`, `storeValue([sturdyRef], name)`).
- The tool layer's render map redeems a handle only in the `sturdyRef` argument
  of `lookupBySturdyRef` (and any future accept method its own authority-review
  row admits); a handle presented in any other tool parameter, or nested inside
  a structured argument to a non-accept method, does not redeem and fails
  before the daemon call.
  Tests demonstrate that a handle placed in a non-accept parameter, and a
  handle nested in a non-accept argument, do not redeem.
  A live, current-epoch handle so placed is reported as **misplaced**
  (remediation: move it into the accept tool's `sturdyRef` argument), distinct
  from the **unknown** reason given for fabricated text; a test demonstrates
  the two reasons differ for an out-of-position live handle versus fabricated
  text.
- A confined worker cannot obtain a locator, formula identifier, swiss number,
  or a general sturdyref-to-locator or sturdyref-to-presence capability.
  This criterion is verified against a **purpose-built confined worker on the
  attenuated facet** (not against Lal or Fae, which run on the full
  `EndoGuest`; see [Distributed confinement](#distributed-confinement)).
  It is contingent on the transport rule of [Open Questions](#open-questions)
  item 1 and on the attenuation step of [Phased Work](#phased-work); it is not
  satisfied by the shipped `EndoGuest`.
- A negative test demonstrates that a confined worker facet cannot reach a
  locator or a swiss number through any admitted method (the single property
  this surface exists to preserve).
- A negative test demonstrates that a **worker-fabricated or enumerated**
  sturdyref value (or wire token) that the daemon never issued is refused by
  `lookupBySturdyRef` rather than resolved, so the method is not a general
  resolution service.
  This is the value-layer counterpart of the unknown-handle test above (the
  handle layer's "arbitrary text never becomes a sturdyref"), covers the local
  index branch as well as the remote one, and is contingent on the
  daemon-minted, unforgeable, non-enumerable index key of [Open
  Questions](#open-questions) item 1.
- Tool handles are local opaque renderings that redeem only to an already-held
  `SturdyRef`; arbitrary text never becomes a sturdyref, and a handle that
  collides with no live entry yields an explicit handle-not-found failure.
  An unknown handle (fabricated text, never a valid entry) and a stale handle
  (a real entry from a prior turn epoch, classified through the retained epoch
  record) report distinct failures, not one merged not-found.
- The bounded classification record's eviction behavior is tested at its edge:
  a handle rendered exactly at, and just past, the record's fixed-size window
  is presented and its classification asserted, documenting that a genuinely
  stale handle aged out of the window degrades to **unknown** (the known,
  bounded imprecision of the stale-versus-unknown split; see [Tool-layer
  escrow](#tool-layer-escrow)).
  The window is sized against the model's retained-transcript horizon so an
  evicted handle is also one the model is unlikely to re-quote.
- The single-turn boundary is enforced as a value-level epoch stamped on the
  render map: each entry carries the turn epoch it was rendered in, redemption
  refuses any entry not stamped with the current epoch, and the shared tool
  layer hands out a fresh turn-scoped map per activation (with the monotonic
  epoch counter and a bounded handle-epoch classification record outliving each
  map) so a forgotten wrap yields no map rather than an unbounded one.
  The epoch counter and classification record are scoped per worker-loop
  activation context, not a process/module singleton: a test with two
  concurrent worker loops in one process (the shape Lal's unawaited
  `spawnWorkerLoop`, `packages/lal/agent.js:272`, already produces)
  demonstrates that one loop advancing its epoch does not stale a
  still-in-progress handle in the other loop's current turn.
  Each agent wraps its own per-activation unit (Lal `runOneRound`; Fae
  `runAgenticLoop`, not the lifetime `runAgent`).
  A negative test, run against each of Lal's and Fae's actual loop shape,
  presents a handle rendered in turn N during turn N+1 and gets an explicit
  failure (no cross-turn redemption).
- The reserved handle grammar (a `ref@`-prefixed opaque token that embeds `@`
  without leading with it, so disjoint from both pet names and the `@`-led
  special-name family the model composes), together with its
  identifier-generation rule (cryptographically unguessable, unique within its
  minting map, with an entropy floor), is a single shared constant in the shared
  tool layer consumed by Lal and Fae.
- The shared disclosure set (a single description fragment; the shared
  model-visible accept-tool name `redeemSturdyRef` and its `sturdyRef` parameter
  name, not the daemon method's `lookupBy*` spelling, see [Daemon provide and
  accept](#daemon-provide-and-accept); and the four shared
  **unknown**/**stale**/**misplaced**/**enlivenment-failure** messages)
  discloses the handle contract and its failure modes to the model across both
  agents.
- A test asserts the handle grammar stays disjoint from both the pet-name and
  special-name patterns of `packages/daemon/src/pet-name.js`.
- Every admitted daemon method has an authority review proving that it does not
  disclose a locator or stable naming information, with an explicit negative
  test for each "No" row above.
- Before cross-turn sturdyref retention ships, a test demonstrates the
  user-visible listing of each retaining worker and a test demonstrates the
  corresponding user-driven revocation.

## Phased Work

1. Confirm the pass-style and closely held enlivenment contract with the
   sturdyref implementation work, and **settle** the CapTP boxing/unboxing rule
   that preserves a sturdyref's meaning across the daemon-worker marshalling
   boundary ([Open Questions](#open-questions) item 1).
   This is "settle", not "confirm": [One passable
   representation](#one-passable-representation) rejects three of the four
   candidate representations and marks the fourth (the daemon-minted correlation
   token) as a candidate to weigh, not an already-trusted shape, so this phase
   owns vetting option (4) (proving its index key can be daemon-minted,
   unforgeable, and non-enumerable without collapsing back into the on-wire
   secret) and stating what happens to the whole surface if all four candidates
   fail, since the confinement acceptance criterion is contingent on the answer
   (see [Dependencies](#dependencies)).
   Remove the prior remotable-token branch from the parent design.
2. Build the attenuated confined-worker facet: a guest-derived facet that
   removes the locator-disclosing name-hub methods (`locate`,
   `lookupByLocator`, `listLocators`, `reverseLocate`, `identify`,
   `lookupById`, `listIdentifiers`, `reverseIdentify`) that the shipped
   `EndoGuest` currently grants, so the confinement criterion can hold.
   This facet is a **new confinement level for a new class of confined
   worker**, not a change to the facet Lal or Fae run on: both agents call
   `locate`/`lookupById` on their live guest (see [Distributed
   confinement](#distributed-confinement)), so they keep the full `EndoGuest`
   and are not migrated here.
   Removing `lookupByLocator` also removes the bare-locator mail-attachment
   resolution path for a worker on this new facet.
   This surface stops there: making the daemon mail pipeline
   (`externalizeForMessage`/`externalizeMessage` in
   `packages/daemon/src/mail.js`) deliver a confined recipient's attachments as
   sturdyrefs instead of locators is recipient-confinement-aware serialization
   owned by a separate daemon mail-pipeline change, not by this step and not by
   the shared tool layer (see [Distributed
   confinement](#distributed-confinement)).
   This step is owned by the daemon agent-surface work.
3. Add the new `lookupBySturdyRef` daemon method.
   The daemon method itself has no turn concept and enlivens any sturdyref
   presented; the single-turn property is enforced above it by the tool-layer
   render map, so the method's presentation is bounded there, not in the
   daemon.
   Resolution goes through the daemon-held index the transport caveat requires,
   not a bare `enlivenSturdyRef` on a marshalled-in value (see [One passable
   representation](#one-passable-representation)).
   Add a confinement test and an explicit negative test for each "No" row of
   the admission table, including the `storeValue` row, whose negative tests
   demonstrate that the attenuated facet rejects a sturdyref-typed value
   argument top-level and nested.
   Add the forgery negative test: a worker-fabricated or enumerated sturdyref
   value (or wire token) the daemon never issued is refused by
   `lookupBySturdyRef`, which requires the daemon index key to be daemon-minted,
   unforgeable, and non-enumerable (see [One passable
   representation](#one-passable-representation) and [Open
   Questions](#open-questions) item 1).
   Update the daemon help surface (`help.md` and the per-method help strings in
   `help-text-data.js`).
4. Add the narrow single-turn tool-layer render map to the shared tool layer
   (`@endo/agent-tools`, consumed by Lal directly today and to be consumed by
   Fae once this phase adds that dependency edge through `@endo/agentry`; see
   [Dependencies](#dependencies)), then adapt Lal and Fae to it.
   Pin the reserved handle grammar (a `ref@`-prefixed opaque token, embedding
   `@` without leading with it) and its identifier-generation rule
   (cryptographically unguessable, unique within its minting map, with an
   entropy floor) as a single exported constant both agents consume.
   Pin a single shared description fragment disclosing the handle contract
   (opaque, verbatim, never-invented), the shared model-visible accept-tool name
   `redeemSturdyRef` and its `sturdyRef` parameter name (the redemption verb,
   not the daemon method's `lookupBy*` spelling), and the four shared
   **unknown**/**stale**/**misplaced**/**enlivenment-failure** messages.
   Both agents place these shared constants in the schema or description of any
   handle-bearing tool.
   Add the cross-package test that the handle grammar stays disjoint from both
   `pet-name.js` patterns.
   Have the shared tool layer hand out the render map per activation (a fresh
   turn-scoped map and epoch minted when the activation's dispatch is entered
   and discarded when it returns, with the epoch counter and the bounded
   handle-epoch classification record outliving each map but scoped per
   worker-loop activation context, not a process/module singleton), stamp each
   entry with the monotonic turn epoch, and refuse redemption of any entry
   whose epoch is not current, wiring the per-activation lifecycle to each
   agent's own turn-completion unit (Lal `runOneRound`; Fae `runAgenticLoop`,
   not the lifetime `runAgent`).
   Redeem a handle only in the `sturdyRef` argument of `lookupBySturdyRef`, not
   in any other tool parameter or nested position.
   Add a negative test, run against each agent's actual loop shape, that a
   handle rendered in turn N does not redeem in turn N+1; a concurrency test
   that two worker loops in one process (Lal's unawaited `spawnWorkerLoop`
   shape) do not stale each other's current-turn handles; a test that an
   unknown handle, a stale (prior-epoch) handle, and a misplaced (live handle
   in a non-accept position) handle report the distinct pinned failures; a test
   of the classification record's eviction edge (a stale handle aged past the
   bounded window degrades to unknown); and a test that a handle placed in a
   non-accept parameter does not redeem.
   This ships no cross-turn retention.
5. Complete the retention investigation and design the worker-retention and
   user-revocation surfaces before allowing any cross-turn retention.

## Dependencies

The shared render map, handle grammar, and failure messages this design pins
are not a surface both agents already consume, and this design does not claim
they are.
Lal depends on `@endo/agent-tools` directly (`packages/lal/package.json:41`)
and on `@endo/agentry` (`:42`).
Fae depends only on `@endo/agentry` (`packages/fae/package.json:56`); its sole
`@endo/agentry` import is `@endo/agentry/edit-text`
(`packages/fae/src/tool-makers.js:9`), and it runs a JSON tool-schema loop
(`runAgenticLoop` over `initialSchemas`/`toolMap`, `packages/fae/agent.js:415`)
that never enters `@endo/agentry/code-mode`, the only `@endo/agentry` surface
built on `@endo/agent-tools`.
So Fae does **not** consume `@endo/agent-tools` today.
Placing the shared constants in `@endo/agent-tools` (or any package Fae does
not yet import) therefore adds a new dependency edge for Fae: the shared tool
layer is a home the two agents must be *made* to share, and Phase 4 owns adding
that edge.
The by-construction argument for pinning the constants in one place stands on
its own; only the claim that the home costs no new dependency was wrong, and
this revision drops it.
(The retired `@endo/genie` package is not a third agent here; it was removed on
2026-08-13 by commit `42bc7d5161`, "chore: retire @endo/genie," and this design
does not target it.)

| Design / PR | Relationship |
|---|---|
| SturdyRefs on demand (PR [#539](https://github.com/endojs/endo-but-for-bots/pull/539)) | Defines the sturdyref pass style and closely held enlivenment capability this surface consumes. Its guest-token conclusion must be revised to match this document. |
| PR [#737](https://github.com/endojs/endo-but-for-bots/pull/737) | Implements the first-class `'sturdyref'` pass-style work that this design assumes. (Supersedes the closed PR [#521](https://github.com/endojs/endo-but-for-bots/pull/521), its wrong-account predecessor.) |
| CapTP box/unbox for sturdyrefs | The daemon's worker transport is `@endo/captp` plus marshal: the worker-transport files (`packages/daemon/src/client.js`, `bus-worker-xs.js`, `connection.js`, `residence.js`) import `@endo/captp`, not `@endo/ocapn`. (The daemon manifest lists `@endo/ocapn` as a direct dependency, but only for host-to-host networking in `packages/daemon/src/networks/ocapn.js`, a path unrelated to the worker transport.) A sturdyref marshalled to a worker and handed back must survive the round trip with its meaning intact; this is item 2 of the sibling design and is a hard prerequisite for Phase 3. |
| [sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) | design 2 of 2 of a competing sturdyref pair. It proposes an `endor` `retain`/`release` syscall for exactly the cross-turn retention this document defers to an investigation. **Selection disposition:** the two designs are presented as alternatives for the maintainer to choose between; this document does not claim to supersede its sibling, and its [Retention and user revocation](#retention-and-user-revocation) must be reconciled with that syscall answer once the maintainer selects (both ship, one supersedes, or the choice is deferred). |
| PR [#541](https://github.com/endojs/endo-but-for-bots/pull/541) | Provides daemon-side sturdyref resolution at the facet boundary. Its body currently asserts anonymous sturdyrefs are retention-free; this design treats that as an open question, so #541's retention claim must be held pending, or revised by, the retention investigation rather than taken as a settled foundation. |
| [daemon-retention-paths](daemon-retention-paths.md) | Candidate basis for showing the user the workers that retain a formula; also supplies the `worker`/`petStore`/`retention` edge-label taxonomy the retention investigation starts from. |

## Open Questions

1. What exact pass-style representation and CapTP transport rule let the
   closely held association map an opaque `SturdyRef` to its locator without
   exposing that association, or the swiss number, to confined code?
   The four-way tension this rule must resolve is stated once, with its
   reasoning, in [One passable
   representation](#one-passable-representation), and is not re-enumerated
   here: key the index on a payload-free copy (no marshal-level identity to key
   on), put the swiss number on the wire (the forbidden
   bearer-secret-in-confined-hands case), box pass-by-reference (reintroducing
   the rejected identity-bearing remotable), or carry a daemon-minted opaque
   correlation token (whose own open part is whether marshalling forces it to
   collapse back into the secret).
   This question also bounds the remote branch of `enlivenSturdyRef`: whether
   confined code can obtain or fabricate a sturdyref whose location is remote
   and so aim that branch at a location of its choosing (see [One passable
   representation](#one-passable-representation)).
2. Is sturdyref redemption holder-scoped or bearer-scoped?
   Per-worker revocation is only meaningful if a redeeming facet checks the
   presenting worker, not merely the value.
3. Does holding a sturdyref across a worker turn require a formula-graph
   retention edge, and, if so, what is its explicit lifecycle, including what
   reclaims an edge whose in-memory tool-layer holder was lost to a restart?
4. Which existing or new UI exposes worker-specific retention and performs the
   user-authorized revocation?

## Prompt

> This design covers the sturdyref effort's agent-surface bar: Endo agents can
> provide and accept a sturdy reference as a value in a tool call instead of
> naming it in a namespace. It requires the first-class sturdyref passable value,
> closely held enlivenment authority, and an explicit investigation of retention
> and user-directed revocation.

Source: the 2026-07-15 maintainer review of
[endojs/endo-but-for-bots#695](https://github.com/endojs/endo-but-for-bots/pull/695)
(an earlier revision of this same document's PR), which corrected the earlier
assumption that this value should be a daemon-minted remotable.
