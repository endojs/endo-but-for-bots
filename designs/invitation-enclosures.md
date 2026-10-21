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

**Bearer authority** means that possession is the whole permission: whoever
reads a formula identifier or a locator can use the capability it names, with
no further identity check.
Holding authority is not the same as keeping a formula alive, though.
A daemon's collector may delete any formula that no durable reference reaches,
and an identifier stored as plain data, such as a string in a URL or a record,
is not such a reference (section *Retention model*).
That is why a locator can delegate a coupon yet, by itself, cannot keep the
coupon in existence: the invitation formula must also hold a durable reference
to the enclosed formula while the invitation is pending.

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

minion.town already has a working alternative: its fragment-envelope coupon
path carries the coupon beside the locator, outside the invitation.
That envelope is application data, so the daemon can guarantee nothing about
it.
It cannot check that the inviter held the coupon, cannot keep the coupon alive
while the invitation is pending, and cannot tell when an intermediary has
swapped one coupon for another without invalidating the invitation.
Each consumer that wants those properties would rebuild them in its own
envelope.
Enclosures move exactly those three properties into the daemon: possession
checked at creation, retention while pending, and an acceptance that fails for
a locator whose enclosures differ from the ones its invitation minted.
They add no semantics beyond those three.

## Goals and non-goals

The mechanism must:

- carry a bounded record of named formula identifiers in an invitation locator;
- prove at invitation creation that the inviting agent holds every identifier;
- retain local enclosed formulas while the invitation is pending, and stop
  retaining them when the invitation is consumed, canceled, or superseded;
- return the same record from parsing, inspection, and successful acceptance;
- preserve the current one-argument `invite` and two-argument `accept` calls,
  and keep unenclosed invitations working between old and new daemons; and
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

Invitation.enclosures(): Promise<InvitationEnclosures>
```

Like `locate`, `enclosures` is a remotable method, so callers reach it with
eventual send:

```js
const enclosures = await E(invitation).enclosures();
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
effects do not change (cross-version daemons are covered under
*Mixed-version peers*), and JavaScript callers may continue to ignore the
fulfilled value of `accept`.
The CLI prints the status required by the guest-native design but never prints
the authority-bearing enclosure record.
If implemented before the guest-native design, TypeScript declarations change
from `Promise<void>` directly to `Promise<InvitationAcceptance>`; otherwise the
existing status union gains the successful `enclosures` field.
Ordinary `await agent.accept(...)` statements remain valid, while code that
explicitly assigns the promise to `Promise<void>` must widen that annotation.

## Retention model

The lifecycle rules below rest on four daemon facts.

- A **formula** is a durable record in a daemon's formula store, named by its
  formula identifier.
- A **retaining edge** is a durable reference to a formula: a pet-store entry,
  or a dependency field that the formula dependency extractor reports.
  Edges survive restart.
- A **transient pin** is an in-memory hold that an in-flight operation places
  on a formula.
  It keeps the collector from deleting the formula while the operation runs,
  but it is not durable: it disappears on release or on a crash.
- The **collector** may delete a formula that no pin holds and no retaining
  edge reaches from an agent's pet store.
  Collection is off by default, so a default daemon deletes nothing on its own.

An identifier stored as plain data, such as a string in a state record, is
neither an edge nor a pin.
It still conveys bearer authority to whoever reads it, but it keeps nothing
alive.

This design uses each mechanism for one job.
Pins bridge windows inside one call.
Edges hold anything that must outlive a call or a restart.
Cleanup that must happen whether or not collection runs uses an explicit
durable record and restart recovery, never the collector.

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

The **correspondent slot** is the inviting agent's durable pet-store binding
from the correspondent name to the pending invitation formula.
Writing a new invitation into the slot does two things at once: it roots the
new invitation, giving it its first retaining edge, and it supersedes
(cancels) whatever pending invitation the slot held before.

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
3. Transiently pin each resolved local identifier.
   A concurrent removal of the source pet name after resolution does not revoke
   the delegation, but cannot collect the formula in the handoff window.
4. Under the formula-graph lock, in one synchronous formula-store transaction,
   write a durable **creation intent** (the inviting agent, the correspondent
   name, and the new invitation's formula number), persist the
   `InvitationFormula`, and install its `enclosure:<name>` edges.
   Transiently pin the new invitation formula as well: until step 5 it has
   outgoing edges but no incoming one.
   Nothing observable has changed yet: no name refers to the new formula and no
   locator has been returned.
5. Commit by running the deferred correspondent slot write.
   It installs the invitation's first incoming retaining edge and supersedes any
   prior pending invitation exactly as it does today.
6. Delete the creation intent, then release every pin.

Every formula this sequence touches is therefore pinned or rooted at every
moment: the enclosures by their pins and then by the invitation's edges, and the
invitation by its pin until the slot write roots it.

Rollback follows from that order.
A failure in steps 1 through 3 releases every pin and leaves the store as it
was.
A failure in step 4 aborts its transaction, so nothing was written.
A failure in step 5 removes the formula, its edges, and the creation intent in
one transaction before leaving the lock, then releases every pin; the prior slot
binding was never touched, so the superseded invitation is still pending.

A crash loses the pins but not the creation intent.
On restart, before any agent serves requests, the daemon reads each creation
intent.
If the named correspondent slot binds the intent's formula, creation committed
and the daemon deletes only the intent.
Otherwise it removes the formula, its edges, and the intent in one transaction.
This recovery does not depend on the collector, so an uncommitted creation
neither leaks its formula nor retains its enclosures in a daemon with collection
off.

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
and cancellation or supersession does the same, so in every case the edges stop
retaining when the invitation stops being pending.
Nothing takes over their retention: the acceptance receipt (section *Inspection
and acceptance*) records identifiers as plain data.
Releasing retention never revokes an identifier; it only stops this invitation
from keeping the formula alive.
An acceptor that needs an enclosure after acceptance retains it itself before
accepting, for example by writing the identifier it parsed from the locator
into its own pet store.
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
`enclosures()` is inspection for a pending invitation; acceptance does not
depend on it.

The authoritative comparison happens inside the inviter's consume step, so it
covers a first acceptance and a re-drive alike.
The internal `Invitation.accept` gains an optional record argument:

```ts
Invitation.accept(handleLocator, expectedEnclosures?): Promise<AcceptOutcome>
```

In the same synchronous formula-store transaction as its consume check, the
inviter compares `expectedEnclosures` exactly with its authoritative record.
For a `pending` invitation, the authoritative record is the formula's snapshot;
for an `accepted` invitation, it is the acceptance receipt below.
Missing keys, extra keys, or different identifiers reject the call with
`enclosure mismatch` and change no state.
The rejection reveals neither record.

The comparison is unconditional.
An omitted `expectedEnclosures` means the empty record, and it is compared like
any other: it matches an unenclosed invitation and mismatches an enclosed one.
No caller can skip the check by leaving the argument out.

**Mixed-version peers.**
Enclosures are deliberately incompatible with pre-enclosure daemons, in both
directions, and every incompatible combination fails closed before any state
changes:

- *Older acceptor, enclosed locator.*
  The older strict `parseLocator` rejects the `enc.*` parameter as unknown, so
  `accept` fails at step 1 below, before any namespace or routing write.
  An enclosed locator therefore requires an enclosure-aware acceptor; the
  inviter learns nothing, and the invitation stays pending.
- *Newer acceptor, older inviter.*
  Only an enclosure-aware daemon mints `enc.*` parameters, so an older inviter's
  locators always parse to the empty record.
  For an empty record the newer acceptor calls `Invitation.accept` with one
  argument, exactly as today, which the older inviter's interface guard
  accepts.
  It passes the second argument only for a non-empty record, and that case
  implies an enclosure-aware inviter.
- *Unenclosed locators* parse identically on both versions and use the
  one-argument call, so invitations that use no enclosures keep working across
  every version pair.

There is no protocol-version negotiation.
An inviter that must reach older acceptors omits enclosures, and a consumer such
as minion.town keeps its fragment-envelope path for those peers.

The shared `acceptInvitation` path performs these steps:

1. Parse and validate the complete locator before any namespace or routing
   write.
2. For a remote daemon, add the same bounded speculative peer route that
   `acceptInvitation` already adds to provision an unenclosed invitation, and no
   other route.
3. Provision the invitation, bind the correspondent speculatively, and call
   `E(invitation).accept(handleLocator, parsedEnclosures)`, or
   `E(invitation).accept(handleLocator)` when `parsedEnclosures` is empty (see
   *Mixed-version peers*).
   Apply the existing rollback and ambiguous-timeout rules; an
   `enclosure mismatch` rolls back the bind and the speculative route like any
   other rejection.
4. Map the inviter's outcome through the existing status contract.
   Return `harden({ status: 'joined', enclosures: parsedEnclosures })` on a new
   join, or the corresponding `already-joined` record on the accepting agent's
   idempotent re-drive.
   The inviter has just confirmed that the parsed record equals its own, so
   either copy is authoritative.

A re-drive after either daemon restarts reaches the inviter exactly as
[Guest-Native Invitation and Acceptance](guest-native-invitations.md) re-drives
an `accepting` record, and makes the same `accept` call.
It never needs the consumed invitation's pending object.

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
- *Replay*: `Invitation.accept` compares a re-drive's record with the receipt
  and answers `already-joined`, including after the invitation formula's edge is
  released and after a restart, so the record is identical to the one `joined`
  returned.
- *Retention*: the receipt stores identifiers as plain data and installs no
  retaining edges, so its lifetime keeps no enclosed formula alive.
  It is not a new authority holder either: the inviter already held every
  identifier it records.
- *Discard*: the receipt lives and dies with the invitation's state record,
  which the guest-native design owns; this design adds no discard rule.

The acceptor's durable copy is its `accepting` record, which holds the locator
and therefore every enclosure identifier as bearer authority.
This design requires that record to drop the locator when it reaches `joined`
or a terminal refusal, so the acceptor keeps no authority-bearing copy after
the handshake unless its application stores one deliberately.
Like the receipt, it is plain data and retains nothing.

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
Acceptance performs no peer-table write, has the local invitation compare the
parsed record while consuming it once, and returns the record.

Across daemons, the invitation's existing hints establish the route to the
inviting daemon.
The acceptor provisions the remote invitation, which compares the parsed record
during consumption, and returns the same identifiers.
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

The visitor's flow uses two independent paths.
The invitation route, from the locator's hints, reaches the inviting daemon and
is used only by `accept`.
The bootstrap entry channel is the connection every minion.town visitor already
opens to the minion.town daemon to reach its unauthenticated bootstrap; it
needs no invitation and no peer route.

The shell reads `parseLocator(locator).enclosures.coupon` before acceptance.
If the visitor needs a guest, it presents that identifier to minion.town's
restricted `redeemCoupon` bootstrap, whose own issuer-membership check remains
the authority boundary for redemption.

A fresh visitor has no peer routes and needs none for this step.
The coupon is an `eval` formula over the coupon-issuer caplet that
minion.town's root host runs, placed into the inviting guest's coupon book,
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

- Mechanism: provision the invitation and run the existing consume-once
  handshake, passing the parsed record for the inviter to compare.
- Policy: the acceptor chooses the correspondent name and whether to use the
  returned enclosures.
- Durable state: each daemon owns its own pet store and peer routes; the
  inviting daemon owns the acceptance receipt; the accepting daemon owns its
  `accepting` record, whose locator carries the enclosures until the handshake
  ends.
- Commit authority: the inviting invitation owns the comparison and consume, and
  writes the receipt in the same transaction; the accepting daemon owns commit
  or rollback of its local bind.
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

Every durable copy of an enclosure has one owner and one release condition:

| Copy | Owner | Retains? | Released when |
|---|---|---|---|
| `InvitationFormula` edges | inviting daemon | yes | invitation consumed, canceled, or superseded |
| creation intent | inviting daemon | no | creation commits or recovery removes it |
| acceptance receipt | inviting daemon | no | the guest-native state record is discarded |
| `accepting` locator | accepting daemon | no | the handshake reaches `joined` or a refusal |
| application copy | the application | its choice | the application decides |

Only the pending invitation's edges keep an enclosed formula alive.
The enclosed capability's subsystem remains the sole owner of its own durable
state.

The daemon commits or discards invitation creation and the peer-binding
handshake.
It never commits or discards an operation on an enclosure.

The inviter's daemon reincarnates the formula and its edges, replays creation
intents, and keeps the receipt after restart.
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
- `packages/daemon/src/manager.js`: persist enclosures and the creation intent
  before the slot commit, pin the formulation handoff, add graph edges, recover
  creation intents on restart, compare and write the acceptance receipt inside
  the consume transaction, drop the locator from a finished `accepting` record,
  format invitation locators, and return the result.
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
A concurrent removal during formulation cannot collect a transiently pinned
local formula, and the completed invitation's graph retains it while pending.
With collection enabled, a test forces a collection between persistence and
the slot write and asserts that both the new invitation and its local
enclosures survive.

Fault-injection tests make formula persistence, edge installation, and the
correspondent slot write each throw in turn, with a pending invitation already
under the same name.
Each case asserts that every transient pin is released, that no orphan formula
or edge remains, and that the earlier invitation is still pending and
acceptable.
With collection disabled, a crash injected between persistence and the slot
write leaves no name bound to the new formula; after restart, recovery has
removed that formula, its edges, and its creation intent, and the earlier
invitation is still pending.
A crash injected between the slot write and intent deletion leaves the new
invitation pending and acceptable after restart, with no intent remaining.

Non-leakage tests inspect the locator, `Invitation.enclosures()`, the acceptance
result, formula-inspector output, thrown errors, and captured diagnostics.
They contain exactly the selected identifiers and names, never sibling pet
names, values, formula types, the full authority-bearing URL, or enclosure
identifier values in errors.

Acceptance tests cover host and guest acceptors in all same-daemon and
cross-daemon combinations.
They assert exact records on success, no peer write for same-daemon acceptance,
and rollback for a locator whose enclosure is added, removed, or changed, both
on a first acceptance and on a same-agent re-drive after consumption.
Mixed-version tests use an acceptor whose parser and guard match the
pre-enclosure daemon.
It rejects an enclosed locator at parsing, with no namespace or route write, and
the invitation stays pending; it still accepts an unenclosed locator from a newer
inviter.
A newer acceptor accepts an older inviter's locator through the one-argument
call.
A direct `Invitation.accept(handleLocator)` call with the argument omitted
mismatches an enclosed invitation and leaves it pending.
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
returns the identical record checked against the receipt, and that the
acceptor's `joined` record no longer holds the locator.
With collection enabled, they assert that consumption ends the invitation's
retention of a local enclosure, and that an acceptor which stored the
identifier before accepting still holds it.

The minion.town integration test creates a generic `eval` coupon, invites with
`coupon`, obtains it from the `endo://` locator, redeems it through the restricted
bootstrap, accepts as the new guest, and observes the same identifier in the
acceptance result.
It runs the visitor from a fresh client with an empty peer table and no
preconfigured routes, and also asserts that a coupon identifier naming another
node fails closed at the bootstrap.
The existing-agent branch ignores the coupon and still accepts.

## Dependencies and phased implementation

- [Guest-Native Invitation and Acceptance](guest-native-invitations.md)
  supplies the shared host/guest formulation and acceptance paths, along with
  the durable invitation state record that this design extends.
- The daemon locator and formula-graph code supply the existing identifier
  grammar, strict locator parser, persistence, and retention edges.
- [minion.town guest coupons](https://github.com/kriscendobot/minion.town/pull/144)
  is the first consumer and the cross-repository integration test, not a daemon
  semantic dependency.

One implementation PR should deliver the feature in three ordered commits or
reviewable slices:

1. locator grammar, limits, types, and pure parser/formatter tests;
2. invitation formulation, authority checks, persistence, inspection, and graph
   retention; and
3. acceptance comparison/results plus same-daemon, cross-daemon, replay,
   restart, and minion.town consumer coverage.

The daemon implementation must land before minion.town enables `coupon` inside
an `endo://` invitation.
minion.town's existing fragment-envelope coupon path does not depend on this
work.

## Design decisions

1. Enclosures are a record, not a new formula type.
   The daemon transports authority without learning application semantics.
2. Inputs are pet-name paths, not identifiers.
   This makes possession checkable at the inviting agent boundary.
3. Values are full formula identifiers, not nested locators.
   The record stays small and generic; reachability remains a consumer concern.
4. Unknown valid names round-trip.
   A registry would make every new consumer a daemon compatibility change.
5. The inviter compares the locator's record inside its consume step.
   A modified URL cannot masquerade as the locator that the invitation minted,
   on a first acceptance or a re-drive, and omitting the record cannot skip the
   comparison.
6. Acceptance returns but does not bind enclosures.
   Ignoring a capability is safe and backward-compatible; inventing pet names is
   an ambient effect.
7. Invitation and enclosure lifecycles remain independent.
   Sharing delegates both capabilities, while consuming one does not consume the
   others.
   Only retention is coupled, and only while the invitation is pending: its
   edges keep local enclosures alive, and consumption, cancellation, or
   supersession ends that retention without revoking anything.

## Prompt

> Design the optional phase-2 daemon mechanism from minion.town guest coupons:
> a generic `InvitationFormula.enclosures` record whose entries travel in an
> `endo://` invitation locator and round-trip through `locate` and invitation
> acceptance without making coupons a daemon formula type.
> Settle encoding, authority, malformed input, compatibility, same-daemon and
> cross-daemon behavior, the coupon consumer, ownership, and tests for parsing,
> authority, non-leakage, and replay.
