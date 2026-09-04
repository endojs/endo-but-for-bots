# SturdyRefs Throughout: Agent Provide and Accept Surface

| | |
|---|---|
| **Created** | 2026-07-11 |
| **Updated** | 2026-09-04 |
| **Author** | endolinbot (prompted) |
| **Status** | Proposed |

## Summary

Endo agents (Lal, Fae, and Genie, sharing `@endo/agent-tools`) need to provide
and accept a sturdy reference (a *sturdyref*) as a value in a tool call, without
assigning it a pet name. The value is the first-class `'sturdyref'` pass-style
value defined by the parent sturdyref work (PR #539 and PR #737; see
[Dependencies](#dependencies)). It is inert data, not a remotable, and it
is *enlivened* (resolved from the opaque value into a live, message-able
presence) only by a closely held capability the daemon holds on the worker's
behalf.

There is one reference representation at this boundary: `SturdyRef`. The daemon
holds the capability that resolves a sturdyref to a presence and that associates
a sturdyref with its locator. Confined code receives neither that capability nor
a locator. A confined worker can pass a sturdyref back to a daemon method that
accepts one, which makes the sturdyref an anonymous placeholder for a formula
(the daemon's unit of persistent capability and a node in its formula graph;
defined in full under
[What is the Problem Being Solved?](#what-is-the-problem-being-solved)).

The design does not settle retention. Holding an anonymous sturdyref across a
worker turn may require a retention edge. Before implementation, the
implementation must establish whether it does, and, if so, expose the retaining
workers to the user so the user can revoke a retention edge (see
[Retention and user revocation](#retention-and-user-revocation)). Until then the
agent surface is single-turn only: a worker may present a sturdyref it received
earlier in the current turn, and no cross-turn retention is offered.

Two lifetime boundaries recur below and are not interchangeable:

- A **delivery** is a single daemon-worker CapTP message: one tool call's
  underlying daemon-method invocation. A worked flow of several tool calls is
  several deliveries.
- A **turn** is one agent activation: the span from the agent receiving a prompt
  through the sequence of tool calls it makes until control returns to the user.
  A turn contains one or more deliveries.

The boundary that governs "no retention edge required" is the **turn**, not the
delivery. Within a single turn the tool layer's render map holds the sturdyref in
process memory across deliveries, so presenting it in a later tool call of the
same turn creates no daemon-side edge. The worked flow in
[One passable representation](#one-passable-representation) (a tool result
carrying a `SturdyRef`, then a later tool call redeeming it) crosses a delivery
boundary but stays inside one turn, so it is single-turn by this definition.
Crossing a turn boundary is what the deferred retention investigation governs.

## What is the Problem Being Solved?

A **formula** is the Endo daemon's unit of persistent capability: a stored,
content-addressed recipe (a worker, a guest, a stored value, or a lookup) that the
daemon can re-incarnate into a live presence, and the node such a recipe occupies
in the daemon's formula graph. Its identity is the recipe, not any name pointed at
it, which is why a formula can be designated by a pet name, a locator, or (as
this design proposes) an anonymous sturdyref.

Throughout this document "worker" denotes the confined execution context
generally (the code held under a mediator), not the specific `worker` edge label
of the formula-graph taxonomy in
[daemon-retention-paths](daemon-retention-paths.md); where the retention
investigation below leans on that taxonomy, the distinct edge-label sense is
called out at the point of use.

Today a daemon worker normally designates a formula by a pet-name path. That
forces namespace allocation for a temporary handoff. A sturdyref permits the
same worker to keep an opaque data value and later give it back to a daemon
facet for enlivenment. (A value-producing operation that consumes a sturdyref is
a plausible future extension but is not part of the initial surface; see
[Daemon provide and accept](#daemon-provide-and-accept).)

The initial single-turn surface serves the same-turn case directly: a
multi-tool-call chain within one activation that carries a sturdyref from one
call to the next without naming it. It deliberately does not yet serve the other
common handoff shape, where an agent surfaces a candidate ("I found X, should I
act on it?") and then acts on the user's reply, because that pattern crosses a
turn boundary and so falls under the deferred retention investigation
([Retention and user revocation](#retention-and-user-revocation)) rather than the
surface shipped here. Naming that limit against the motivating example is
deliberate: the initial surface removes namespace allocation for same-turn
handoffs, and cross-turn handoffs wait on the retention answer.

This surface leans on three terms of art from the parent sturdyref work; the
sibling design [sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) defines
them in full (its `## Background`), and they are summarized here because this
document's acceptance criteria depend on them:

- A **locator** is the daemon's authority-bearing designator for a formula: the
  `endo://{peerKey}/{formulaAddress}?type=` string that anyone holding it can
  redeem to a presence through `lookupByLocator`
  (`packages/daemon/src/interfaces.js:154`). Disclosing a locator to confined
  code hands it that redemption authority directly, which is why the confinement
  rule below forbids it.
- A **formula identifier** is the daemon's internal id for a formula node in the
  formula graph, redeemable through `lookupById` (`interfaces.js:153`).
- A **swiss number** is the unguessable secret naming a capability within a
  formula graph; on the OCapN wire a sturdyref is carried as a peer locator plus
  a swiss number.

A sturdyref differs from a locator in exactly the property this design turns on:
a locator is self-redeeming for its holder, whereas a sturdyref is inert and can
be turned into a presence only by a daemon facet that holds the closely held
association capability. Preserving that difference across the marshalling
boundary is [Open Questions](#open-questions) item 1, not a settled fact (see
[Distributed confinement](#distributed-confinement)).

The relevant capability split is:

- A `SturdyRef` is a passable value in the `'sturdyref'` category. It is not a
  presence and cannot receive eventual messages.
- The daemon holds the closely held capability. That capability can enliven a
  sturdyref to a presence and can map between a locator and the corresponding
  sturdyref. It is never passed to confined code.
- A daemon facet uses that capability on behalf of a worker. Confined code does
  not receive the association capability, a locator, a formula identifier, or
  any other representation that can locate an arbitrary sturdyref.

The distinction is authority, not a second guest-specific value type. A
sturdyref is the anonymous value a daemon uses while holding the authority that
enlivens it.

## Design

### One passable representation

The agent surface accepts and returns `SturdyRef` values. It does not introduce
`SturdyRefToken` (a daemon-minted, identity-bearing remotable this design's
earlier revision proposed and the 2026-07-15 maintainer review rejected; see
[Status](#status) for why it was dropped and what that cost), a method-less
remotable, a new guest-only pass style, or a tool-layer proxy for a sturdyref.

The pass-style implementation defines how a sturdyref is recognized. The daemon,
separately, holds the closely held capability that resolves the value. The
`@endo/ocapn` package already ships this capability's operations under the names
`makeSturdyRef(location, swissNumber)` and `enlivenSturdyRef(sturdyRef)`
(`packages/ocapn/test/sturdyref.test.js:16`,
`packages/goblin-chat/src/use-goblin-chat.js:440`); this design reuses those
spellings rather than coining new ones. The capability the daemon holds is,
conceptually:

```js
// Held by the daemon, never passed to confined code.
const association = {
  // Mint. Kept on the constructing side; a worker-facing facet never holds it.
  makeSturdyRef(location, swissNumber) {},
  // Resolve to a presence. This is the only operation a worker-facing daemon
  // method needs, and it is the only one such a method is handed.
  enlivenSturdyRef(sturdyRef) {},
  // De-anonymize: sturdyRef -> its locator. This is the disclosure confined
  // code must never reach; it is not handed to any worker-facing facet.
  locatorForSturdyRef(sturdyRef) {},
};
```

Attenuating by construction matters here: a worker-facing daemon method is
handed an `enlivenSturdyRef` operation alone, never the whole `association`
object, so minting and locator disclosure are out of reach by construction
rather than by an audit obligation.

One caveat the implementation must honor. `enlivenSturdyRef` as shipped in
`@endo/ocapn` (`packages/ocapn/src/client/sturdyrefs.js`) is not a
self-contained resolver. It is curried with a `locator` (the `{ get(secret) }`
object that performs the secret-to-capability resolution), and that bound
`locator` is the actual closely held secret, not the function name. The
attenuation therefore is not merely "hand the function over"; it is: bind
`enlivenSturdyRef` to a single daemon-held resolver whose scope cannot be swapped
or widened by confined code, and hand only that pre-bound operation to the
worker-facing facet.

The confined worker must reach neither the `locator` nor an operation for
constructing or choosing a different one. The names above are the operations'
real spellings where they exist in `@endo/ocapn`; the daemon-facing method names
are proposed in [Daemon provide and accept](#daemon-provide-and-accept).

This directly supports the usual tool flow, once the marshalling dependency in
[Dependencies](#dependencies) (CapTP boxing and unboxing of sturdyrefs) is in place:

1. A tool result contains a `SturdyRef` supplied by a daemon facet.
2. The tool layer retains the value in its local render map and gives the model
   an opaque, transcript-local handle.
3. A later tool call redeems that handle before its argument guard and passes
   the same `SturdyRef` to the daemon facet.
4. The facet enlivens or otherwise resolves it with `enlivenSturdyRef`.

The text handle is only a local rendering of an already-held sturdyref. It is
not a serialization, not an authority-bearing string, and not a second kind of
reference.

### Distributed confinement

The surface follows the distributed-confinement rule that code confined by a
mediator must not gain a capability for turning arbitrary bits or values into
authority. (For the confinement vocabulary this leans on, see
[daemon-retention-paths](daemon-retention-paths.md) and
[sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) `## Background`; for the
parent sturdyref work, see PR #539.) In particular:

- A worker may hold and return a `SturdyRef` that the daemon gave it.
- A worker may not call `makeSturdyRef`, `locatorForSturdyRef`, or
  `enlivenSturdyRef` directly.
- A worker may not obtain a locator, a formula identifier, a swiss number, or a
  general operation for resolving an arbitrary sturdyref.
- A daemon method that accepts a sturdyref resolves only its supplied argument
  for that method's established authority. It does not turn the method into a
  general locator service.

This confinement property is a **target, not an achieved property of the
value**. Today the OCapN codec serializes a sturdyref by writing its location
and swiss number onto the wire and re-minting on decode
(`packages/ocapn/src/codecs/descriptors.js:315-337`), so an inbound message that
delivers a sturdyref to a confined worker carries the swiss number unless the
boundary substitutes a daemon-side index for it. Establishing that transport
rule is [Open Questions](#open-questions) item 1, and until it exists the confinement
guarantee is not yet met. This design states the property as the bar the
implementation must clear, not as something the shipped representation already
satisfies.

The confined agent surface is also **narrower than the shipped `EndoGuest`**. A
real `EndoGuest` today spreads `nameHubMethodGuards`
(`packages/daemon/src/interfaces.js:139`, guards at `:97`), which grants
`identify`, `locate`, `reverseLocate`, `listIdentifiers`, `listLocators`,
`lookupById`, `lookupByLocator`, `storeIdentifier`, and `storeLocator`, wired
live on the guest (`packages/daemon/src/guest.js:330`); `lookupByLocator` is
precisely a general locator-to-presence capability. Only the `least-authority`
null agent disallows these (`packages/daemon/src/daemon.js:3818`). So the
"confined worker" this design targets is not an `EndoGuest` as shipped: an
attenuation step must construct a facet that removes the locator-disclosing
methods before this design's third acceptance criterion can hold. That step is
called out explicitly in [Phased Work](#phased-work) (who builds it, and when).

Removing `lookupByLocator` from the attenuated facet has a consequence the design
takes on deliberately, not by oversight: the shipped mail channel delivers an
attachment as a locator and expects the recipient to resolve it through
`lookupByLocator` (`packages/daemon/src/guest.js:150`, whose own comment records
this). A confined worker on the attenuated facet therefore cannot resolve a
bare-locator mail attachment, and this is correct rather than a regression to
paper over. A resolvable locator is exactly the general locator-to-presence
authority the confinement bar withholds; a facet that kept `lookupByLocator` so
that ordinary mail attachments still resolved would forfeit the confinement
criterion this whole design pivots on. The confinement-preserving replacement for
that channel is a `SturdyRef`-carried attachment resolved through
`lookupBySturdyRef`: an attachment that must be reachable by a confined recipient
is delivered as a sturdyref (an anonymous placeholder the recipient cannot
de-anonymize), not as a self-redeeming locator. Only agents that were never
attenuated (a full `EndoGuest`, or the host) retain the bare-locator attachment
path. Phase 2 below is the step that accepts this narrowing.

### Daemon provide and accept

The daemon already spells "redeem a non-pet-name designator" as its own method
per designator kind: `lookupById(id)` and `lookupByLocator(locator)`
(`packages/daemon/src/interfaces.js:153-154`). This design follows that
convention rather than overloading `lookup`, whose argument today is a pet-name
path (`NameOrPathShape`). A new daemon method, `lookupBySturdyRef(sturdyRef)`,
resolves a sturdyref through the closely held `enlivenSturdyRef` capability. A
distinct name keeps admission visible at the call site (a caller reads
`lookupBySturdyRef` and knows it takes a sturdyref, rather than consulting a
table to learn which arguments `lookup` now accepts), keeps the portable
name-hub and filesystem guards (`packages/platform/src/fs/interfaces.js`)
untouched, and keeps a sturdyref (a fixed formula, no name-change semantics)
from sharing one method with a mutable pet-name binding.

The method list below must be derived from authority, not from input shape. Each
method named is an existing daemon or name-hub method
(`packages/daemon/src/interfaces.js`); the design adds exactly one method,
`lookupBySturdyRef`, and admits no sturdyref argument to any existing method
until an authority review clears it. Each row records whether a sturdyref may be
resolved through that surface, and why:

| Surface | SturdyRef resolution | Reason |
|---|---|---|
| `lookupBySturdyRef` (new) | Yes | The facet enlivens the supplied value through `enlivenSturdyRef`; the method exists only for this. |
| `lookup`, `maybeLookup`, `has` (`interfaces.js:597-604`) | No | These take a pet-name path today; a sturdyref is redeemed by `lookupBySturdyRef`, not by widening these guards. |
| `list` (`interfaces.js:598`, variadic over path segments) | No | `list` enumerates a directory named by a path; a sturdyref names a single formula, not a directory. |
| `identify`, `locate`, `listIdentifiers`, `listLocators` (`:99-104`) | No | These return locator or stable naming information and are not part of the confined placeholder surface. |
| Mutating name operations `storeIdentifier`, `storeLocator`, `remove`, `move`, `copy` (`:107-111`) | No | A sturdyref must not silently become authority to mutate a namespace; each row needs an explicit deny plus a negative test. |
| Reverse operations `reverseLookup` (`:106`), `reverseLocate` (`:101`), `reverseIdentify` (`:152`) | No | They would turn a value into naming or locator information; `reverseLookup` is guarded `M.call(M.any())`, so it needs an explicit deny, not just an absent guard change. |

A value-producing evaluation slot that accepts a sturdyref (for example, an
`evaluate` argument enlivened before use) is a plausible future admission, but it
is a second surface that would require its own authority-review row and negative
test per the criteria above; it is deliberately excluded from the initial
surface, which admits exactly one method. Admitting any such slot is deferred
until that review clears it.

Because `lookupBySturdyRef` is a new method, the phase that adds it must also
update the daemon's self-documenting help surface (`packages/daemon/src/help.md`
and the per-method help strings in `packages/daemon/src/help-text-data.js` that
`help("lookupBySturdyRef")` returns) so an agent discovering the method through
that entry point sees it.

The two directions the title names are not symmetric in this document, and the
asymmetry is deliberate. The **accept** direction (a confined worker handing a
`SturdyRef` back for resolution) is the new surface specified here:
`lookupBySturdyRef`, its admission row, and its acceptance criteria and phase. The
**provide** direction (where a `SturdyRef` value first originates and is returned
to a worker) is not a new method of this surface: a sturdyref is produced by the
daemon-side facet-boundary resolution of the parent sturdyref work (PR #541) and
minted by the closely held `makeSturdyRef` (PR #539), never by a worker-callable
method. Step 1 of the tool flow ("supplied by a daemon facet") refers to that
existing production path, not to a method this document introduces. This document
therefore adds a named surface for accept only; provide is carried by the render
map and the parent work's existing facet output, and needs no new admission row.

`lookupBySturdyRef` must also state its failure-mode contract, matching the
sibling `lookupById`/`lookupByLocator` methods it is named after, which reject
(throw) rather than return a sentinel when their target cannot be resolved.
`lookupBySturdyRef` follows the same convention: it rejects when the supplied
`SturdyRef` cannot be enlivened (the underlying formula was collected or revoked,
or no association for it was ever established), so the caller distinguishes a
tool-layer handle-not-found failure (raised before the daemon call, in the render
map) from a daemon-side enlivenment failure (a rejection from `lookupBySturdyRef`
itself). Neither failure returns a value that could be mistaken for a resolved
presence.

Mail and agent APIs may carry a `SturdyRef` only as a passable attachment or
tool argument. Accepting such a value must not create a pet name implicitly. An
explicit user-authorized namespace write remains a separate operation; note that
`storeLocator(petNamePath, locator)` needs a locator the confined worker does
not hold, so there is no path from an anonymous sturdyref to a pet name on the
worker's own authority.

A mail attachment is a distinct storage channel from the tool layer's render map,
and the "single-turn only" scope does not silently extend to it. The daemon
mailbox (`packages/daemon/src/mail.js`) is a persistent, formula-graph-backed
store: a message sent in one turn can sit unread and be read in a much later
turn, by the same or a different worker. A `SturdyRef` that rides a mail
attachment and is enlivened after crossing that gap is therefore a cross-turn
presentation, not the in-memory, single-turn render-map case the initial surface
admits. Mailbox storage of a sturdyref is folded into the deferred retention
investigation ([Retention and user revocation](#retention-and-user-revocation)):
until that investigation answers whether a cross-turn sturdyref needs a retention
edge and how it is revoked, the initial surface does not treat enlivening a
mail-attached sturdyref in a later turn as a retention-free operation, and a
daemon method must not resolve a sturdyref recovered from mailbox storage across
a turn boundary as though it were single-turn.

### Tool-layer escrow

LLM tool protocols carry text, so no passable value is sent through the model.
Each agent tool layer keeps a **render map**: an in-memory, single-turn table
from an opaque local handle to a `SturdyRef`. On output it renders a handle; on
input it redeems a known handle before daemon argument matching. The table is
restricted to sturdyrefs, and it is presentation state only.

The single-turn boundary is enforced, not assumed. The agent runtime this design
targets is a long-lived process: `runInboxLoop` (`packages/lal/inbox-loop.js`)
calls `runOneRound` once per inbound message in a loop against a reused
`PiAgent`, so there is no process teardown between turns to clear the map for
free. The render map must therefore be reset explicitly at the end of every turn
(each `runOneRound` completion), so that a handle rendered in round N cannot be
redeemed in round N+1. Without that reset the natural implementation (a map built
once at worker start) would silently accumulate the un-investigated cross-turn
retention this design defers, so the reset is a required Phase 4 step with its own
negative test, not an implementation nicety (see [Phased Work](#phased-work) and
[Acceptance Criteria](#acceptance-criteria)).

This render map is deliberately **not** a lifetime record. It neither mints a
fresh authority nor changes the sturdyref's pass style. Any cross-turn retention
is a separate, daemon-side concern ([Retention and user revocation](#retention-and-user-revocation)): the
daemon-side retention set, not the tool layer's render map, is the authoritative
and auditable record of what is held. Keeping the two apart means that losing the
render map to a process restart can never strand a daemon-side edge, because the
render map was never the edge's holder of record.

An unknown handle is ordinary untrusted text and must fail before reaching the
daemon facet. To keep a handle from silently colliding with a pet name (any
string lacking `/`, `\0`, and `@`; `packages/daemon/src/pet-name.js:15`), handle
syntax must be disjoint from legal pet-name syntax. Prefixing with `@` achieves
that, since a pet name cannot contain `@`. But `@` is not unclaimed space: the
daemon already uses an `@`-led grammar for reserved special names such as `@self`
and `@host` (`validSpecialNamePattern = /^@[a-z][a-z0-9-]{0,127}$/`,
`packages/daemon/src/pet-name.js:25`), so a render-map handle must be disjoint
from that special-name grammar as well.

This design pins the concrete handle grammar rather than leaving it as an
example, because its stated goal is that Lal, Fae, and Genie share one behavior:
leaving the syntax open is exactly the seam three tool-layer implementations could
diverge on. The reserved sub-sigil is `@:`. It begins with `@`, which no pet name
may contain, and its second character `:` is not the `[a-z]` the special-name
pattern requires, so it lies outside both grammars. It is pinned once in
`@endo/agent-tools` as a single exported constant that Lal, Fae, and Genie
consume rather than re-deriving the syntax, and the same package owns a test
asserting the handle grammar stays disjoint from both `pet-name.js` patterns, so
that if the daemon's name grammar is ever widened the collision is caught rather
than silently admitted. Because the tool layer still never presents a handle to
the daemon as a name, that disjointness is defence in depth: if a handle ever
leaked into a name-accepting path it could not be mistaken for a valid pet name or
special name. On an unknown handle the model sees an explicit handle-not-found
failure, not a daemon lookup on attacker-chosen text.

Lal, Fae, and Genie (sharing `@endo/agent-tools`) share this narrow behavior
rather than each inventing a reference type or allowing arbitrary remotables
through their JSON or SmallCaps boundaries.

### Retention and user revocation

On-demand enlivenment does not by itself answer whether a worker retaining a
sturdyref must keep the sturdyref's referenced formula alive. This gap is a
direct cost of dropping `SturdyRefToken`: had this surface kept an
identity-bearing remotable, a presence's own held-or-dropped lifecycle would
have carried the retention and revocation story, and this section could be far
shorter. Because the reference is now a bare value, that lifecycle must be built
here explicitly. There are two distinct cases:

1. The sturdyref is only a transient argument within a single turn (across one or
   more deliveries held in the tool-layer render map, per the boundary definition
   in [Summary](#summary)). No worker retention edge is created merely for the
   call. This is the only case the initial agent surface admits.
2. A worker keeps a sturdyref across turns. If that value must remain
   enlivenable, the daemon may need an ephemeral retention edge from that worker
   to the referenced formula. This case is deferred; it does not ship until the
   investigation below has answers.

The second case is a design prerequisite, not an implementation detail. Before
offering cross-turn retention, the implementation must answer all of these:

- Does the existing formula graph already retain the formula through another
  root, or does a cross-turn sturdyref require a new edge? The edge-label
  taxonomy in [daemon-retention-paths](daemon-retention-paths.md) (which already
  distinguishes `worker`, `petStore`, and `retention` edges in the formula
  graph) is the place to start this investigation rather than deriving it from
  scratch.
- If a new edge is needed, what precise event adds it and what precise event
  removes it? Garbage-collection observation and `FinalizationRegistry` are not
  acceptable substitutes for an auditable lifecycle.
- Is redemption holder-scoped or bearer? If any facet redeems any sturdyref
  presented to it, then revoking worker A's edge revokes nothing when worker B
  holds a copy, so per-worker revocation is not meaningful without a
  holder-scoping rule. See [Open Questions](#open-questions).
- Which user-visible surface lists every worker retaining a sturdyref for a
  formula, including the worker identity and the retention path?
- What user action revokes one listed worker's retention edge, and what happens
  to that worker's future attempts to enliven the sturdyref?
- Does revocation also terminate or partition a worker that already holds an
  enlivened presence? If not, what authority remains after the edge is removed?

Until these questions have answers, the implementation must not claim that
anonymous sturdyrefs are retention-free or that forgetting a local binding is
sufficient revocation. The daemon's existing retention-path work is the
candidate observation surface, but this design does not assume it already has
the worker-level information required here.

## Acceptance Criteria

- `passStyleOf(sturdyRef)` is `'sturdyref'`; no guest-facing reference is a
  remotable or a second pass-style category. (Current state: `passStyleOf`
  returns `'tagged'` for the in-tree shim, which `ocapnPassStyleOf` upgrades;
  this criterion is met by the pass-style dependency in [Dependencies](#dependencies), not
  by the shim.)
- A confined worker can pass a previously received sturdyref to
  `lookupBySturdyRef` and receive that method's value result. (Any additional
  value-producing operation is a future admission gated on its own authority
  review, not part of the initial surface.)
- A confined worker cannot obtain a locator, formula identifier, swiss number,
  or a general sturdyref-to-locator or sturdyref-to-presence capability. This
  criterion is contingent on the transport rule of [Open Questions](#open-questions) item 1
  and on the attenuation step of [Phased Work](#phased-work); it is not satisfied by the
  shipped `EndoGuest`.
- A negative test demonstrates that a confined worker facet cannot reach a
  locator or a swiss number through any admitted method (the single property
  this surface exists to preserve).
- Tool handles are local opaque renderings that redeem only to an already-held
  `SturdyRef`; arbitrary text never becomes a sturdyref, and a handle that
  collides with no live entry yields an explicit handle-not-found failure.
- The single-turn boundary is enforced: the render map is reset at each turn
  boundary, and a negative test presents a handle rendered in round N during round
  N+1 and gets an explicit handle-not-found failure (no cross-turn redemption).
- The reserved handle sub-sigil is a single shared constant in `@endo/agent-tools`
  consumed by Lal, Fae, and Genie, and a test asserts the handle grammar stays
  disjoint from both the pet-name and special-name patterns of
  `packages/daemon/src/pet-name.js`.
- Every admitted daemon method has an authority review proving that it does not
  disclose a locator or stable naming information, with an explicit negative
  test for each "No" row above.
- Before cross-turn sturdyref retention ships, a test demonstrates the
  user-visible listing of each retaining worker and a test demonstrates the
  corresponding user-driven revocation.

## Phased Work

1. Confirm the pass-style and closely held enlivenment contract with the
   sturdyref implementation work, and confirm the CapTP boxing/unboxing rule
   that preserves a sturdyref's meaning across the daemon-worker marshalling
   boundary (see [Dependencies](#dependencies)). Remove the prior remotable-token
   branch from the parent design.
2. Build the attenuated confined-worker facet: a guest-derived facet that removes
   the locator-disclosing name-hub methods (`locate`, `lookupByLocator`,
   `listLocators`, `reverseLocate`, `identify`, `lookupById`, `listIdentifiers`,
   `reverseIdentify`) that the shipped `EndoGuest` currently grants, so the
   confinement criterion can hold. Removing `lookupByLocator` also removes the
   bare-locator mail-attachment resolution path for a worker on this facet; an
   attachment such a worker must resolve is delivered as a `SturdyRef` instead of
   a locator (see [Distributed confinement](#distributed-confinement)). This step
   is owned by the daemon agent-surface work, not by `@endo/agent-tools`.
3. Add the new `lookupBySturdyRef` daemon method (single-turn only; it resolves a
   sturdyref presented within the current turn and creates no retention edge),
   with a confinement test and an explicit negative test for each "No" row of the
   admission table, and update the daemon help surface (`help.md` and the
   per-method help strings in `help-text-data.js`).
4. Add the narrow single-turn tool-layer render map to `@endo/agent-tools`, then
   adapt Lal, Fae, and Genie to it. Pin the reserved handle sub-sigil (`@:`) as a
   single exported constant the three agents consume, and add the cross-package
   test that the handle grammar stays disjoint from both `pet-name.js` patterns.
   Reset the render map at the end of every turn (each `runOneRound` completion),
   with a negative test that a handle rendered in round N does not redeem in round
   N+1. This ships no cross-turn retention.
5. Complete the retention investigation and design the worker-retention and
   user-revocation surfaces before allowing any cross-turn retention.

## Dependencies

| Design / PR | Relationship |
|---|---|
| SturdyRefs on demand (PR #539) | Defines the sturdyref pass style and closely held enlivenment capability this surface consumes. Its guest-token conclusion must be revised to match this document. |
| PR #737 | Implements the first-class `'sturdyref'` pass-style work that this design assumes. (Supersedes the closed PR #521, its wrong-account predecessor.) |
| CapTP box/unbox for sturdyrefs | The daemon's worker transport is `@endo/captp` plus marshal and does not depend on `@endo/ocapn` (`packages/daemon/package.json`). A sturdyref marshalled to a worker and handed back must survive the round trip with its meaning intact; this is item 2 of the sibling design and is a hard prerequisite for phase 3. |
| [sturdy-refs-endor-syscall](sturdy-refs-endor-syscall.md) | Design 2 of 2 of the competing sturdyref pair. It proposes an `endor` `retain`/`release` syscall for exactly the cross-turn retention this document defers to an investigation; the retention investigation's first question already has a competing in-tree answer there. This document's [Retention and user revocation](#retention-and-user-revocation) must be reconciled with it. |
| PR #541 | Provides daemon-side sturdyref resolution at the facet boundary. Its body currently asserts anonymous sturdyrefs are retention-free; this design treats that as an open question, so #541's retention claim must be held pending, or revised by, the retention investigation rather than taken as a settled foundation. |
| [daemon-retention-paths](daemon-retention-paths.md) | Candidate basis for showing the user the workers that retain a formula; also supplies the `worker`/`petStore`/`retention` edge-label taxonomy the retention investigation starts from. |

## Open Questions

- What exact pass-style representation and CapTP transport rule let the closely
  held association map an opaque `SturdyRef` to its locator without exposing
  that association, or the swiss number, to confined code?
- Is sturdyref redemption holder-scoped or bearer? Per-worker revocation is only
  meaningful if a redeeming facet checks the presenting worker, not merely the
  value.
- Does holding a sturdyref across a worker turn require a formula-graph retention
  edge, and, if so, what is its explicit lifecycle, including what reclaims an
  edge whose in-memory tool-layer holder was lost to a restart?
- Which existing or new UI exposes worker-specific retention and performs the
  user-authorized revocation?

## Status

This design was revised per the 2026-07-15 maintainer review of PR #695, which
corrected the earlier assumption that this value should be a daemon-minted
remotable: the proposed `SturdyRefToken` remotable was removed in favor of the
single `SturdyRef` pass-style value. Removing the token was a deliberate cost,
not an absent problem: a remotable's identity would have carried a GC-tied
lifecycle, whereas a bare `SturdyRef` value requires its retention and revocation
lifecycle to be designed and built explicitly
([Retention and user revocation](#retention-and-user-revocation)). That cost is
narrower than "retention and revocation for free," however: this design's own
retention section disqualifies a garbage-collection lifecycle as an auditable
substitute ("Garbage-collection observation and `FinalizationRegistry` are not
acceptable substitutes for an auditable lifecycle"), so the token's GC-tied
lifecycle would not have met this design's auditability bar either. What the
token removal forfeited was a convenient starting point for a lifecycle this
design would have had to make auditable regardless, not a finished retention
story. The design accepts that trade on the view that an auditable, user-visible
retention lifecycle is worth building; a remotable would not have precluded such
a lifecycle, so the honest framing is that the token was removed and the
hand-built lifecycle is its replacement cost.

## Prompt

This design covers the sturdyref effort's agent-surface bar: Endo agents can
provide and accept a sturdy reference as a value in a tool call instead of
naming it in a namespace. The 2026-07-15 maintainer review of PR #695 corrected
the earlier assumption that this value should be a daemon-minted remotable. It
requires the first-class sturdyref passable value, closely held enlivenment
authority, and an explicit investigation of retention and user-directed
revocation.
