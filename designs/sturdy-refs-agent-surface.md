# SturdyRefs Throughout: Agent Provide and Accept Surface

| | |
|---|---|
| **Created** | 2026-07-11 |
| **Updated** | 2026-07-15 |
| **Author** | endolinbot (prompted) |
| **Status** | Proposed |

## Summary

Endo agents (Lal, Fae, Genie, and `@endo/agent-tools`) need to provide and
accept a sturdy reference (a *sturdyref*) as a value in a tool call, without
assigning it a pet name. The value is the first-class `'sturdyref'` pass-style
value defined by the sturdyref work. It is inert data, not a remotable, and it
is *enlivened* (resolved from the opaque value into a live, message-able
presence) only by a closely held capability of the relevant CapTP network.

This revision, made per the 2026-07-15 maintainer review of PR #695 (which
corrected the earlier assumption that this value should be a daemon-minted
remotable; see the `## Prompt` section), deliberately removes the proposed
`SturdyRefToken` remotable. There is one reference representation at this
boundary: `SturdyRef`. The daemon holds the capability that associates a
sturdyref with its locator; that same capability can also obtain a sturdyref
from a locator. Confined code receives neither that capability nor a locator. It
can pass a sturdyref back to a daemon method that accepts one, which makes the
sturdyref an anonymous placeholder for a formula.

The design does not settle retention. Holding an anonymous sturdyref across a
worker turn may require a retention edge. Before implementation, the daemon
must establish whether it does, and, if so, expose the retaining workers to the
user so the user can revoke them. The previous draft's claim that this surface
needs no retention machinery is withdrawn.

Removing `SturdyRefToken` is not cost-free, and this design does not pretend
otherwise. A remotable's identity carries a GC-tied lifecycle that is itself a
ready-made retention-and-revocation story: a Presence lives while it is held and
is reclaimed when it is dropped. A bare `SturdyRef` value has no such lifecycle,
so the retention and revocation machinery the token would have supplied for free
must instead be designed and built explicitly (see `## Retention and user
revocation`). This design accepts that trade, on the view that an
auditable, user-visible retention lifecycle is worth more than a GC-observation
one, but records it as a deliberate cost, not an absent problem.

## What Is Being Solved?

Today a daemon worker normally designates a formula by a pet-name path. That
forces namespace allocation for a temporary handoff. A sturdyref permits the
same worker to keep an opaque data value and later give it back to a daemon
facet for enlivenment or a value-producing operation.

The relevant capability split is:

- A `SturdyRef` is a passable value in the `'sturdyref'` category. It is not a
  presence and cannot receive eventual messages.
- The CapTP-network layer owns the locator association. Its closely held
  capability can enliven a sturdyref and can map between a locator and the
  corresponding sturdyref.
- A daemon facet is allowed to use that capability on behalf of a worker.
  Confined code is not allowed to receive the locator association capability,
  a locator, a formula identifier, or another representation that can be used
  to locate an arbitrary sturdyref.

The distinction is authority, not a second guest-specific value type. A
sturdyref is the anonymous value a daemon uses while holding the authority that
enlivens it.

## Design

### One passable representation

The agent surface accepts and returns `SturdyRef` values. It does not introduce
`SturdyRefToken`, a method-less remotable, a new guest-only pass style, or a
tool-layer proxy for a sturdyref.

The pass-style implementation defines how a sturdyref is recognized. The
CapTP-network layer, separately, constructs the value and keeps the locator
association. The interface available to a confined worker has this shape
conceptually:

```js
// Held by the daemon, never passed to confined code.
const sturdyRefLocator = {
  sturdyRefForLocator(locator) {},
  locatorForSturdyRef(sturdyRef) {},
  enlivenSturdyRef(sturdyRef) {},
};

// Available to a confined worker through a daemon facet.
const workerFacet = {
  lookup(sturdyRef) {},
  maybeLookup(sturdyRef) {},
  list(sturdyRef) {}, // pending confirmation; see the admission table below
};
```

The names above describe authority boundaries, not a proposed public module or
method names. The daemon may use its closely held capability to resolve the
argument, but no worker receives any of the first object's operations.

This directly supports the usual tool flow:

1. A tool result contains a `SturdyRef` supplied by a daemon facet.
2. The tool layer retains the value in its local passable-value table and gives
   the model an opaque, transcript-local handle.
3. A later tool call redeems that handle before its argument guard and passes
   the same `SturdyRef` to the daemon facet.
4. The facet enlivens or otherwise resolves it with its closely held
   capability.

The text handle is only a local rendering of an already-held sturdyref. It is
not a serialization, not an authority-bearing string, and not a second kind of
reference.

### Distributed confinement

The surface follows the distributed-confinement rule (see
[daemon-retention-paths](daemon-retention-paths.md) and the parent sturdyref
design #539 for the confinement vocabulary this leans on) that code confined by
a mediator must not gain a capability for turning arbitrary bits or values into
authority. In particular:

- A worker may hold and return a `SturdyRef` that the daemon gave it.
- A worker may not call `locatorForSturdyRef`, `sturdyRefForLocator`, or
  `enlivenSturdyRef` directly.
- A worker may not obtain a locator, a formula identifier, a swiss number (the
  unguessable secret that names a capability within a formula graph), or a
  general operation for resolving an arbitrary sturdyref.
- A daemon method that accepts a sturdyref resolves only its supplied argument
  for that method's established authority. It does not turn the method into a
  general locator service.

This permits the daemon to use a sturdyref as an anonymous pet name while
keeping locator and enlivenment authority outside the worker's reach. It also
avoids the false premise that a remotable's identity is necessary for this
boundary: the sturdyref passable value is the intended designation. The cost of
that choice, that the token's GC-tied lifecycle no longer supplies retention
and revocation for free, is weighed in `## Retention and user revocation`.

### Daemon provide and accept

Existing read-side methods that are safe to use with a designated value may
accept `SturdyRef` alongside a pet-name path. Their guards use the sturdyref
pass-style recognizer and the facet resolves the value through the closely held
capability.

The final method list must be derived from authority, not from input shape. The
methods below are the daemon's existing surface (`lookup`, `maybeLookup`, and
`list` are the read/enumerate methods a worker already calls; `identify`,
`locate`, `listIdentifiers`, and `listLocators` are the naming- and
locator-disclosing methods, all defined in
`packages/daemon/src/interfaces.js`); each row records whether that method may
additionally accept a `SturdyRef` argument, and why:

| Surface | SturdyRef input | Reason |
|---|---|---|
| `lookup`, `maybeLookup`, and value-producing evaluation slots | Yes | The facet designates or enlivens the supplied value. |
| `list` when its existing path argument identifies the directory to list | No, pending investigation | The implementation must verify that the result does not reveal locator authority before this can become Yes. |
| `identify`, `locate`, `listIdentifiers`, and `listLocators` | No | These return stable naming or locator information and are not part of the confined placeholder surface. |
| Mutating name operations (`write`, `remove`, `move`, `copy`) | No | A sturdyref must not silently become authority to mutate a namespace. |
| Reverse lookup operations | No | They would turn a value into naming information. |

Because the accepted-argument shape of `lookup`/`maybeLookup` (and possibly
`list`) changes, the phase that admits these inputs must also update the
daemon's self-documenting help surface (`packages/daemon/src/help.md` and the
per-method help strings that `help("lookup")` returns) so an agent discovering
the method through that entry point sees the new `SturdyRef` argument shape.

Mail and agent APIs may carry a `SturdyRef` only as a passable attachment or
tool argument. Accepting such a value must not create a pet name implicitly.
An explicit user-authorized namespace write remains a separate operation.

### Tool-layer escrow

LLM tool protocols carry text, so no passable value is sent through the model.
Each agent tool layer may keep an in-memory table from an opaque local handle
to a `SturdyRef`. On output it renders a handle; on input it redeems a known
handle before daemon argument matching. The table is restricted to sturdyrefs.

This is transport presentation only. It neither mints a fresh authority nor
changes the sturdyref's pass style. An unknown handle is ordinary untrusted
text and must fail before reaching the daemon facet.

Lal, Fae, Genie, and `@endo/agent-tools` should share this narrow behavior
rather than each inventing a reference type or allowing arbitrary remotables
through their JSON or SmallCaps boundaries.

### Retention and user revocation

On-demand enlivenment does not by itself answer whether a worker retaining a
sturdyref must keep its referenced formula alive. Nor is this a free
consequence of the earlier decision to drop `SturdyRefToken`: had this surface
kept an identity-bearing remotable, a Presence's own held-or-dropped lifecycle
would have carried the retention and revocation story, and this section could
be far shorter. Because the reference is now a bare value, that lifecycle must
be built here explicitly. There are two distinct cases:

1. The sturdyref is only a transient argument. No worker retention edge should
   be created merely for the call.
2. A worker keeps a sturdyref across turns. If that value must remain
   enlivenable, the daemon may need an ephemeral retention edge from that
   worker to the referenced formula.

The second case is a design prerequisite, not an implementation detail. Before
adding the agent surface, the implementation must answer all of these:

- Does the existing formula graph already retain the formula through another
  root, or does a cross-turn sturdyref require a new edge? The edge-label
  taxonomy in [daemon-retention-paths](daemon-retention-paths.md) (which already
  distinguishes `worker`, `petStore`, and `retention` edges in the formula
  graph) is the place to start this investigation rather than deriving it from
  scratch.
- If a new edge is needed, what precise event adds it and what precise event
  removes it? Garbage-collection observation and `FinalizationRegistry` are
  not an acceptable substitute for an auditable lifecycle.
- What happens when the tool-layer escrow table (explicitly in-memory, with no
  durability claim; see `## Tool-layer escrow`) is lost to a process restart
  or session end while a durable daemon-side retention edge added on its behalf
  still exists? The design must state which side is authoritative and how a
  now-holderless edge is reclaimed or released, so an evicted tool layer cannot
  strand an edge no live holder can exercise.
- Which user-visible surface lists every worker retaining a sturdyref for a
  formula, including the worker identity and the retention path?
- What user action revokes one listed worker's retention, and what happens to
  its future attempts to enliven the sturdyref?
- Does revocation also terminate or partition a worker that already holds an
  enlivened presence? If not, what authority remains after the edge is removed?

Until these questions have answers, the implementation must not claim that
anonymous sturdyrefs are retention-free or that forgetting a local binding is
sufficient revocation. The daemon's existing retention-path work is the
candidate observation surface, but this design does not assume it already has
the worker-level information required here.

## Acceptance Criteria

- `passStyleOf(sturdyRef)` is `'sturdyref'`; no guest-facing reference is a
  remotable or a second pass-style category.
- A confined worker can pass a previously received sturdyref to an admitted
  daemon operation and receive that operation's value result.
- A confined worker cannot obtain a locator, formula identifier, swiss number,
  or a general sturdyref-to-locator or sturdyref-to-presence capability.
- Tool handles are local opaque renderings that redeem only to an already-held
  `SturdyRef`; arbitrary text never becomes a sturdyref.
- Every admitted daemon method has an authority review proving that it does not
  disclose a locator or stable naming information. `list` is not admitted (its
  table row stays "No, pending investigation") until that review clears; its
  own acceptance criterion is that the review demonstrates the list result
  reveals no locator authority.
- Before cross-turn sturdyref retention ships, a test demonstrates the
  user-visible listing of each retaining worker and a test demonstrates the
  corresponding user-driven revocation.

## Phased Work

1. Confirm the pass-style and closely held locator-association contract with
   the sturdyref implementation work. Remove the prior remotable-token branch
   from the parent design.
2. Audit daemon methods and add only the admitted `SturdyRef` inputs, with
   confinement tests for each method, and update the daemon help surface
   (`help.md` and the per-method help strings) to document the new argument
   shape.
3. Add the narrow tool-layer escrow to `@endo/agent-tools`, then adapt Lal,
   Fae, and Genie to it.
4. Complete the retention investigation and design the worker-retention and
   user-revocation surfaces before allowing cross-turn retention.

## Dependencies

| Design / PR | Relationship |
|---|---|
| SturdyRefs on demand design (PR #539) | Defines the sturdyref pass style and closely held enlivenment capability this surface consumes. Its guest-token conclusion must be revised to match this document. Note the conflict: #541 (below) currently states retention is already resolved as retention-free, the exact premise this design's `## Retention and user revocation` withdraws; that dependency is gated on the retention investigation's outcome and must be revised if it concludes otherwise. |
| PR #737 | Implements the first-class `'sturdyref'` pass-style work that this design assumes. (Supersedes the closed PR #521, its wrong-account predecessor.) |
| PR #541 | Provides daemon-side sturdyref resolution at the facet boundary. Its body currently asserts anonymous sturdyrefs are retention-free; this design treats that as an open question, so #541's retention claim must be held pending, or revised by, the retention investigation rather than taken as a settled foundation. |
| [daemon-retention-paths](daemon-retention-paths.md) | Candidate basis for showing the user the workers that retain a formula; also supplies the `worker`/`petStore`/`retention` edge-label taxonomy the retention investigation starts from. |

## Open Questions

- What exact pass-style representation and CapTP transport rule lets the
  closely held network associate an opaque `SturdyRef` with its locator without
  exposing that association to confined code?
- Does holding a sturdyref across a worker turn require a formula-graph
  retention edge, and, if so, what is its explicit lifecycle, including what
  reclaims an edge whose in-memory tool-layer holder was lost to a restart?
- Which existing or new UI exposes worker-specific retention and performs the
  user-authorized revocation?

## Prompt

This design covers the sturdyref effort's agent-surface bar: Endo agents can
provide and accept a sturdy reference as a value in a tool call instead of
naming it in a namespace. The 2026-07-15 maintainer review of PR #695 corrected
the earlier assumption that this value should be a daemon-minted remotable. It
requires the first-class sturdyref passable value, closely held locator and
enlivenment authority, and an explicit investigation of retention and
user-directed revocation.
