# Invitation Enclosures

| | |
|---|---|
| **Created** | 2026-10-21 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | [minion.town#144 directive][source], [approved][approval] |

[source]: https://github.com/kriscendobot/minion.town/pull/144#discussion_r4333035650
[approval]: https://github.com/kriscendobot/minion.town/pull/144#pullrequestreview-5594963376

## What is the Problem Being Solved?

An Endo invitation locator carries the authority to accept an invitation and
the routing information needed to reach its daemon.
Some invitation protocols also need to delegate a small, named set of other
capabilities.
The motivating consumer is minion.town: an invitation can carry a guest coupon
that a newcomer redeems before accepting the invitation as the resulting guest.

The daemon must not acquire coupon semantics or a coupon formula type.
It needs a generic **enclosure** mechanism: an inviter selects capabilities it
already holds, the invitation retains and names their formula identifiers, and
its `endo://` locator transports those identifiers as bearer authority.
The receiving application decides whether an enclosure name means anything.

The existing seams are:

- `EndoHost.invite` and `EndoGuest.invite` in `host.js` and `guest.js` formulate
  an `InvitationFormula` through `formulateInvitation` in `manager.js`;
- `Invitation.locate` constructs the invitation locator with `type`, `from`, and
  optional `fromNode` query parameters;
- `parseLocator` in `locator.js` rejects every other query parameter and returns
  the formula type, node, number, and connection hints; and
- `EndoHost.accept` and `EndoGuest.accept` share `acceptInvitation`, which parses
  the locator, provisions the remote invitation, binds the correspondent, and
  asks `Invitation.accept` to consume it.

This design extends those paths.
It does not add a daemon hook for any particular enclosure name.

## Goals and non-goals

The mechanism must:

- carry a bounded record of named formula identifiers in an invitation locator;
- prove at invitation creation that the inviting agent holds every identifier;
- retain local enclosed formulas while the invitation is pending and, after
  acceptance, while its durable acceptance receipt exists;
- return the same record from parsing, inspection, and successful acceptance;
- preserve the current one-argument `invite` and two-argument `accept` calls; and
- work for host and guest agents, on one daemon or across daemons.

An enclosure is not confidential, identity-bound, or coupled to invitation
consumption.
Anyone who receives the locator receives every enclosed bearer capability.
Accepting, canceling, or replaying the invitation does not invoke, revoke, or
consume an enclosed capability.
The enclosure also carries no connection hints of its own: it delegates
authority, not guaranteed reachability.

## Public contract

The invitation methods gain these types, expressed here in TypeScript notation:

```ts
type InvitationEnclosures = Readonly<Record<string, FormulaIdentifier>>;
type InvitationEnclosureNames = Readonly<Record<string, NameOrPath>>;

type InvitationOptions = Readonly<{
  enclosures?: InvitationEnclosureNames;
}>;

type InvitationAcceptance =
  | Readonly<{
      status: 'joined' | 'already-joined';
      enclosures: InvitationEnclosures;
    }>
  | Readonly<{
      status:
        | 'already-consumed'
        | 'peer-conflict'
        | 'name-in-use'
        | 'revoked';
    }>;
```

The public records are string-keyed so that callers can write
`{ coupon: [...] }` and read `.enclosures.coupon` without a type assertion.
The daemon validates every key at the runtime boundary (the interface guard,
`invite`, and `parseLocator`); an internal `EnclosureName` brand may mark keys
after that check, but it never appears in a public signature.
The wire and API grammar of an enclosure name is `/^[a-z][a-z0-9-]{0,31}$/`:
one to 32 lowercase ASCII characters, beginning with a letter.
There is no Unicode normalization, case folding, or semantic registry.
`coupon` is an ordinary valid name.

`FormulaIdentifier` keeps its existing exact form:
`<64 lowercase hexadecimal formula number>:<64 lowercase hexadecimal node>`.
The node is the formula's actual daemon or agent key, not the invitation's node
and not a relative abbreviation.
An enclosure value is an identifier, not a nested locator, so it carries no
formula type or transport hints.

The methods become:

```ts
EndoHost.invite(correspondentName, options?): Promise<Invitation>
EndoGuest.invite(correspondentName, options?): Promise<Invitation>

EndoHost.accept(invitationLocator, correspondentName):
  Promise<InvitationAcceptance>
EndoGuest.accept(invitationLocator, correspondentName):
  Promise<InvitationAcceptance>

Invitation.enclosures(): InvitationEnclosures
```

The optional `options` argument is an exact passable copy record; unknown option
keys are rejected by the interface guard.
An omitted `options`, an omitted `enclosures`, and an empty enclosure record all
mean the same thing.
This result extends the discriminated `{ status }` contract in
[Guest-Native Invitation and Acceptance](guest-native-invitations.md), rather
than replacing it.
`joined` and the same-agent idempotent `already-joined` return an `enclosures`
field, using an empty hardened record for a legacy or unenclosed invitation.
Outcomes that did not join this agent return no enclosure field.

Existing callers remain compatible: their argument lists and invitation side
effects do not change, and JavaScript callers may continue to ignore the
fulfilled value of `accept`.
The CLI prints the status required by the guest-native design but never prints
the authority-bearing enclosure record.
If implemented before the guest-native design, TypeScript declarations change
from `Promise<void>` directly to `Promise<InvitationAcceptance>`; otherwise the
existing status union gains the successful `enclosures` field.
Ordinary `await agent.accept(...)` statements remain valid, while code that
explicitly assigns the promise to `Promise<void>` must widen that annotation.

## Creation and authority

`invite` accepts enclosure **pet-name paths**, never raw formula identifiers.
The host and guest implementations resolve each path with that same agent's
`identify` operation.
This is the authority check: an identifier can enter the formula only by being
reachable through the inviting agent's own namespace at creation time.
The daemon does not consult the root host, another agent, or the formula graph to
find an authority the inviter did not designate.

An identifier is **local** when its node is the inviting daemon's own node, so
this daemon stores the formula and its collector decides when the formula dies.
It is **remote** when its node names another daemon: the inviter's pet store
holds it because the inviter received that capability from a peer.
`identify` returns whichever kind the pet name holds; it does not translate one
into the other.
Holding a remote identifier means holding bearer authority whose formula,
lifetime, and collection belong to the daemon that hosts it.
That is why the invitation retains local enclosures below and only records
remote ones.

Creation is all-or-nothing, and its single commit point is the correspondent
slot write.
Today `formulateInvitation` runs the deferred slot write before `formulate`, and
that write already supersedes (cancels) any pending invitation under the same
name, so a later persistence failure could not be undone.
For this design the order changes:

1. Validate the options record, enclosure names, entry count, and name paths.
2. Resolve every path in sorted enclosure-name order.
   An absent name or a value that is not a valid `FormulaIdentifier` rejects the
   whole call before the correspondent slot or any formula is changed.
3. Transiently pin each resolved local identifier until the invitation formula
   is durable and its graph edges are installed.
   A concurrent removal of the source pet name after resolution does not revoke
   the delegation, but cannot collect the formula in the handoff window.
4. Under the formula-graph lock, persist the `InvitationFormula` and install its
   `enclosure:<name>` edges, then release the transient pins.
   Nothing observable has changed yet: no name refers to the new formula and no
   locator has been returned.
5. Commit by running the deferred correspondent slot write, which supersedes any
   prior pending invitation exactly as it does today.

Rollback follows from that order.
A failure in steps 1 through 3 releases every pin and leaves the store as it
was.
A failure in step 4 or 5 releases every pin and, before leaving the lock,
removes the orphan formula and its edges; the prior slot binding was never
touched, so the superseded invitation is still pending.
A crash before step 5 leaves at most an orphan formula that no name references
and whose locator nobody holds.
It grants nothing, and the collector discards it when collection is enabled.

The persisted shape is:

```ts
type InvitationFormula = {
  type: 'invitation';
  invitingAgent?: FormulaIdentifier;
  invitingHandle?: FormulaIdentifier;
  guestName: NameOrPath;
  enclosures?: InvitationEnclosures;
  // Existing legacy hostAgent and hostHandle fields remain readable.
};
```

New formulas omit `enclosures` when it is empty, so old and new empty records
have the same incarnation behavior.
The formula dependency extractor adds one labeled edge
`enclosure:<name> -> <identifier>` per local enclosure.
While the invitation is pending, those edges retain local enclosed formulas.
Acceptance releases the pet-store edge to the invitation formula, as
[Guest-Native Invitation and Acceptance](guest-native-invitations.md) requires,
so the invitation formula can no longer be what keeps an enclosure alive.
The acceptance receipt (section *Inspection and acceptance*) therefore carries
the same `enclosure:<name>` edges and takes over their retention.
Cancellation or supersession of a pending invitation releases the edges.
Releasing retention never revokes an identifier; it only stops this invitation
from keeping the formula alive.
A holder that relies on an enclosure after that point must retain it itself.
Remote identifiers are recorded but do not become local graph edges because
their hosting daemon owns their lifetime.

The privileged formula inspector exposes `enclosures` as a `reference-list`.
It exposes no new guest-side enumeration surface.

## Locator encoding and parsing

`Invitation.locate` emits the existing query fields first, followed by enclosure
entries sorted by enclosure name:

```text
endo://<daemon-node>/<invitation-number>@<hints>
  ?type=invitation
  &from=<inviting-handle-number>
  &fromNode=<optional-inviting-agent-node>
  &enc.coupon=<formula-number>%3A<formula-node>
```

The line breaks above are illustrative only.
The actual locator is one URL.
`URLSearchParams` performs the encoding, so the identifier's colon has canonical
form `%3A` and enclosure names need no special escaping under their grammar.

`parseLocator` gains an `enclosures` field containing a hardened copy record.
Its existing returned fields and the public formatter signatures do not change,
so callers that destructure only `formulaType`, `node`, `number`, or `hints`
continue to work.
Only `type=invitation` may carry an `enc.` parameter.

The limits are deliberately small and exact:

- at most eight enclosure entries;
- at most 32 characters per enclosure name;
- exactly 129 decoded ASCII characters per formula identifier, validated by
  `assertValidId`; and
- at most 4096 characters in the complete raw query string of any locator that
  contains an `enc.` parameter.

The formatter cannot approach the query limit with eight canonical entries, but
the parser limit also bounds malicious percent-encoding and repeated-parameter
inputs.
Legacy locators without enclosure parameters keep their present size behavior.

Every query key is a singleton.
The parser rejects duplicate `type`, `from`, `fromNode`, or enclosure keys even
when their values are identical.
It also rejects an empty or invalid enclosure name, an invalid identifier, an
enclosure on a non-invitation locator, too many entries, an over-limit query, and
every unknown parameter outside the `enc.<valid-name>` namespace.

A syntactically valid enclosure name is not "unknown" to the daemon.
There is intentionally no allowlist: the parser preserves it, acceptance returns
it, and an application that does not understand it ignores it.
This lets future consumers compose without a daemon release.

Locator validation errors must not interpolate the locator or an enclosure
identifier into an exception message or diagnostic.
Both are bearer authority.
Errors name only the rejected field or rule, such as `duplicate enclosure name`
or `invalid enclosure identifier`.

## Inspection and acceptance

An invitation incarnation reads `formula.enclosures ?? {}` once and uses that
hardened record for both `locate()` and `enclosures()`.
`enclosures()` returns identifiers only.
It neither resolves them, reports their formula types, nor reveals any other
name in the inviter's namespace.

The shared `acceptInvitation` path performs these steps:

1. Parse and validate the complete locator before any namespace or routing
   write.
2. For a remote daemon, add the same bounded speculative peer route that
   `acceptInvitation` already adds to provision an unenclosed invitation, and no
   other route.
3. Provision the invitation and call `E(invitation).enclosures()`.
   Compare that authoritative record exactly with the parsed locator record.
   Missing keys, extra keys, or different identifiers reject acceptance and
   roll back the speculative route.
4. Bind the correspondent speculatively, consume the invitation with
   `E(invitation).accept(handleLocator)`, and apply the existing rollback and
   ambiguous-timeout rules.
5. Map the inviter's outcome through the existing status contract.
   Return
   `harden({ status: 'joined', enclosures: authoritativeEnclosures })` on a new
   join, or the corresponding `already-joined` record on the accepting agent's
   idempotent re-drive.

The inviter knows which agent is accepting from the handle locator that
`acceptInvitation` passes to `Invitation.accept`.
The consume commit binds the correspondent slot to that handle, and a later
`accept` compares its own handle with the bound one: equal handles are the same
agent re-driving (`already-joined`); different handles are a different agent
(`already-consumed`).

**The acceptance receipt.**
The pending invitation's retention is released at consumption, so an
`already-joined` re-drive after consumption or restart cannot read the record
from the pending invitation object.
The guest-native design already records the invitation's state durably in the
formula store, moving it from `pending` to `accepted` with the acceptor's handle
identifier in one synchronous transaction.
This design adds the authoritative enclosure snapshot to that `accepted` state
record, written in the same transaction, so it is an immutable terminal
**acceptance receipt**: the accepting handle plus the enclosures.

- *Persistence*: the inviter's daemon writes the receipt only at the consume
  commit and never rewrites it.
- *Replay*: `Invitation.accept` answers `already-joined` from the receipt,
  including after the invitation formula's edge is released and after a
  restart, so the record is identical to the one `joined` returned.
  The acceptor's durable `accepting` record keeps the locator, so a re-drive
  after an acceptor restart still compares the parsed record with the receipt.
- *Discard*: the receipt lives as long as the invitation's state record, and
  only the inviter's daemon may discard it, when it discards that state record.
  The receipt holds the `enclosure:<name>` edges, so discarding it is the point
  where the invitation stops retaining its local enclosures.

The comparison makes `locate -> parse -> accept` a checked round trip.
A third party can still append a capability it already holds to a copied URL,
but that modified URL is not accepted as the original invitation.
This is not an identity signature: each enclosed formula identifier is itself
the delegated bearer authority.

No enclosure is automatically written into the accepting agent's pet store.
Doing so would require the daemon to invent local names and would turn unknown
enclosure keys into ambient namespace effects.
The caller may explicitly store or use an identifier after applying its own
policy.

Only `joined` and the same-agent idempotent `already-joined` outcome return the
record.
A replay by a different agent returns `already-consumed` without an enclosure
field.
This does not retract the identifiers already visible in the locator; enclosure
delegation occurs when the locator is shared, not when it is accepted.

## Same-daemon, cross-daemon, and coupon flows

On one daemon, `locate` and `parseLocator` preserve each full identifier.
Acceptance performs no peer-table write, compares against the local invitation
object, consumes the invitation once, and returns the record.

Across daemons, the invitation's existing hints establish the route to the
inviting daemon.
The acceptor provisions the remote invitation, obtains its authoritative record,
compares it, and returns the same identifiers.
The daemon does not dial or `provide` any enclosed formula.
An enclosure hosted elsewhere therefore works only when its consumer already
has a route or a service that can resolve it.

For minion.town, a guest invites with:

```js
const invitation = await E(guest).invite('newcomer', {
  enclosures: { coupon: ['coupon-book', couponName] },
});
const locator = await E(invitation).locate();
```

The shell reads `parseLocator(locator).enclosures.coupon` before acceptance.
If the visitor needs a guest, it presents that identifier to minion.town's
restricted `redeemCoupon` bootstrap, whose own issuer-membership check remains
the authority boundary for redemption.

A fresh visitor has no peer routes and needs none for this step.
The coupon is an `eval` formula over the coupon-issuer caplet that
minion.town's root host runs, air-dropped into the inviting guest's coupon book,
so its identifier names the minion.town daemon that also serves the
unauthenticated `redeemCoupon` bootstrap.
The visitor reaches that bootstrap over minion.town's own entry channel, the
same one an unenclosed visitor already uses, and passes the identifier as data.
The bootstrap resolves the identifier against its local formula store and
issuer; it never dials the identifier's node.
An identifier whose node is not local to the bootstrap's daemon fails closed as
an unknown coupon.
That resolution is minion.town's contract, not daemon provisioning, and the
daemon gains no route or resolver for enclosures.
After redemption it calls `E(newGuest).accept(locator, correspondentName)` and
may confirm that the successful result contains the same `coupon` identifier.
An existing Endo agent accepts immediately and may ignore `coupon` and every
other enclosure.

The daemon never calls `redeem`, recognizes `coupon`, provisions a guest, or
binds the coupon to the invitation lifecycle.
Coupon replay, expiry, and consume-once behavior remain entirely in the coupon
consumer and ledger.

## Ownership map

**Inviting agent -> invitation formulation.**

- Mechanism: resolve caller-supplied pet-name paths and persist identifiers.
- Policy: the inviter selects names; the daemon enforces shape, bounds, and
  possession.
- Durable state: the inviter's pet store owns names; the invitation formula
  owns the pending enclosure snapshot.
- Commit authority: the daemon commits creation at the correspondent slot
  write; the inviter may later cancel or supersede a pending invitation.
- Value crossing: `InvitationEnclosureNames` in, `InvitationEnclosures` out.

**Invitation formula -> locator holder.**

- Mechanism: canonical `enc.<name>` formatting and strict parsing.
- Policy: none semantic; sharing the locator delegates every enclosed
  capability.
- Durable state: the inviting daemon owns the formula and its edges.
- Commit authority: invitation accept and cancel control only the invitation
  and its retaining edges.
- Value crossing: an `endo://` URL and the parsed identifier record.

**Accepting daemon -> inviting daemon.**

- Mechanism: provision the invitation, compare `enclosures()`, then run the
  existing consume-once handshake.
- Policy: the acceptor chooses the correspondent name and whether to use the
  returned enclosures.
- Durable state: each daemon owns its own pet store and peer routes; the
  inviting daemon owns the acceptance receipt.
- Commit authority: the inviting invitation owns consume and writes the receipt
  in the same transaction; the accepting daemon owns commit or rollback of its
  local bind.
- Value crossing: the handle locator toward the inviter; the authoritative
  enclosure record toward the acceptor.

**Application -> enclosed capability.**

- Mechanism: application-specific resolution and invocation.
- Policy: the application recognizes a key and decides whether to act.
- Durable state: the enclosed capability's subsystem owns its state; the daemon
  stores no derived state.
- Commit authority: the enclosed capability owns redemption, revocation, and
  replay.
- Value crossing: one named `FormulaIdentifier`; for minion.town, `coupon`.

The inviting daemon owns the durable `InvitationFormula`, the acceptance
receipt, and the graph edges each holds.
The acceptor persists no enclosure record of its own unless its application
explicitly does so; its replay reads the inviter's receipt.
The enclosed capability's subsystem remains the sole owner of its own durable
state.

The daemon commits or discards invitation creation and the peer-binding
handshake.
It never commits or discards an operation on an enclosure.

The inviter's daemon reincarnates the formula, the receipt, and their edges
after restart.
The invitation state machine owns acceptance replay through the receipt; the
enclosed capability independently owns invocation replay.

The locator parser classifies syntax, and the invitation classifies its own
acceptance as successful, rejected, or already consumed.
Only the application can classify what using an enclosure accomplished.

Naming check: `InvitationEnclosures` describes data at the invitation boundary.
It does not import outer application lifecycle words such as redemption,
provisioning, commit, replay, or persistence into the daemon mechanism.

## Implementation ownership

- `packages/daemon/src/types.d.ts` and `interfaces.js`: add the records, the
  optional invite argument, the acceptance result, and the
  `Invitation.enclosures` guard.
- `packages/daemon/src/host.js` and `guest.js`: resolve enclosure paths only
  through the inviting agent, and keep both facets behaviorally identical.
- `packages/daemon/src/manager.js`: persist enclosures before the slot commit,
  pin the formulation handoff, add graph edges, write the acceptance receipt,
  format invitation locators, compare on acceptance, and return the result.
- `packages/daemon/src/locator.js`: parse bounded `enc.*` parameters, reject
  duplicates and malformed records, and stop echoing bearer locators in errors.
- `packages/daemon/src/formula-record.js`: render enclosures as a privileged
  `reference-list`.
- Daemon help and declarations: document the optional input and acceptance
  result without teaching coupon semantics.
- minion.town: recognize only `coupon`, validate it through `redeemCoupon`, and
  ignore every other enclosure.

## Test plan

Parser and formatter tests cover a zero-entry legacy locator, one and eight
entries, sorted canonical output, percent-encoded colons, and exact
`locate -> parse` equality.
They reject duplicate scalar and enclosure keys, empty/uppercase/overlength
names, malformed or uppercase identifiers, nine entries, an over-limit query,
an enclosure on a non-invitation locator, and an unrelated query parameter.

Authority tests attempt host and guest invitations with an absent path, a path
that resolves to malformed stored data, and mixed valid/invalid entries.
Every failure leaves the correspondent name and formula store unchanged.
A removal racing formulation cannot collect a transiently pinned local formula,
and the completed invitation's graph retains it while pending.

Fault-injection tests make formula persistence, edge installation, and the
correspondent slot write each throw in turn, with a pending invitation already
under the same name.
Each case asserts that every transient pin is released, that no orphan formula
or edge remains, and that the earlier invitation is still pending and
acceptable.
A crash injected between persistence and the slot write leaves no name bound to
the new formula, and after restart the earlier invitation is still pending.

Non-leakage tests inspect the locator, `Invitation.enclosures()`, the acceptance
result, formula-inspector output, thrown errors, and captured diagnostics.
They contain exactly the selected identifiers and names, never sibling pet
names, values, formula types, the full authority-bearing URL, or enclosure
identifier values in errors.

Acceptance tests cover host and guest accepters in all same-daemon and
cross-daemon combinations.
They assert exact records on success, no peer write for same-daemon acceptance,
and rollback for a locator whose enclosure is added, removed, or changed.
An unrecognized valid enclosure round-trips and does not trigger a lookup or
method call.

Replay tests race two accepts against each other and against cancellation.
Exactly one agent can receive the enclosure record; that agent's idempotent
re-drive receives the identical record with `already-joined`, while a different
agent receives `already-consumed` without an enclosure field.
Neither path invokes or revokes the enclosed test capability.
Restart tests prove formula reincarnation preserves the record and dependency
edges before acceptance.
After consumption, they restart both daemons and assert that the re-drive still
returns the identical record from the receipt, and that the receipt's edges
still retain the local enclosed formula with collection enabled.

The minion.town integration test creates a generic `eval` coupon, invites with
`coupon`, obtains it from the `endo://` locator, redeems it through the restricted
bootstrap, accepts as the new guest, and observes the same identifier in the
acceptance result.
It runs the visitor from a fresh client with an empty peer table and no
preconfigured routes, and also asserts that a coupon identifier naming another
node fails closed at the bootstrap.
The existing-agent branch ignores the coupon and still accepts.

## Dependencies and phased implementation

| Dependency | Relationship |
|---|---|
| [Guest-Native Invitation and Acceptance](guest-native-invitations.md) | Supplies the shared host/guest formulation and acceptance paths this extends |
| daemon locator and formula-graph code | Supplies the existing identifier grammar, strict locator parser, persistence, and retention edges |
| [minion.town guest coupons](https://github.com/kriscendobot/minion.town/pull/144) | First consumer and cross-repository integration test; not a daemon semantic dependency |

One implementation PR should deliver the feature in three ordered commits or
reviewable slices:

1. locator grammar, limits, types, and pure parser/formatter tests;
2. invitation formulation, authority checks, persistence, inspection, and graph
   retention; and
3. acceptance comparison/results plus same-daemon, cross-daemon, replay,
   restart, and minion.town consumer coverage.

The daemon implementation must land before minion.town enables `coupon` inside
an `endo://` invitation.
Its existing fragment-envelope coupon path does not depend on this work.

## Design decisions

1. Enclosures are a record, not a new formula type.
   The daemon transports authority without learning application semantics.
2. Inputs are pet-name paths, not identifiers.
   This makes possession checkable at the inviting agent boundary.
3. Values are full formula identifiers, not nested locators.
   The record stays small and generic; reachability remains a consumer concern.
4. Unknown valid names round-trip.
   A registry would make every new consumer a daemon compatibility change.
5. Acceptance compares the locator with the invitation formula.
   A modified URL cannot masquerade as the locator that invitation minted.
6. Acceptance returns but does not bind enclosures.
   Ignoring a capability is safe and backward-compatible; inventing pet names is
   an ambient effect.
7. Invitation and enclosure lifecycles remain independent.
   Sharing delegates both capabilities, while consuming one does not consume the
   others.
   Only retention is coupled: the invitation, and then its acceptance receipt,
   keeps local enclosures alive, and discarding them ends that retention without
   revoking anything.

## Prompt

> Design the optional phase-2 daemon mechanism from minion.town guest coupons:
> a generic `InvitationFormula.enclosures` record whose entries travel in an
> `endo://` invitation locator and round-trip through `locate` and invitation
> acceptance without making coupons a daemon formula type.
> Settle encoding, authority, malformed input, compatibility, same-daemon and
> cross-daemon behavior, the coupon consumer, ownership, and tests for parsing,
> authority, non-leakage, and replay.
