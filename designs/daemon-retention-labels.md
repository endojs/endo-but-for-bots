# Invitation Retention Labels and Pin Lifecycle

| | |
|---|---|
| **Created** | 2026-09-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Two agents take part in an invitation: one **issues** it and a remote party
**accepts** it.
Throughout this design, *inviter* names the local party that **issued** the
invitation (the agent that called `invite()`), on whose side all retention
state lives.
A **pin** is the durable pet-store entry the inviter keeps so the newly minted
local guest handle survives the accept-time garbage collection that the next
paragraph explains.
The pin, the derived pet name it is stored under, and the name-path binding
that acceptance rebinds all belong to the inviting agent's formula
(`manager.js`'s invitation exo in [PR
#1125](https://github.com/endojs/endo-but-for-bots/pull/1125)), not to the
remote party that redeems the invitation.
#1125 leaves the redeeming side untouched.
This matches the record fields (`invitingAgent`, `invitingHandle`) and existing
daemon usage (`inviterMemberId` in `channel.js`), where *invit-* always denotes
the issuing side.
Endo models the inviting principal as either a **host** (a full agent with its
own visible pet-store directory) or a **guest** (a more restricted agent whose
retention state the host holds on its behalf and which the guest itself cannot
remove); "host inviter" and "guest inviter" name those two cases below.

When an invitation is accepted, the daemon collects any formula nothing refers
to, so the inviter durably pins the newly minted local guest handle under a
path-derived pet name to keep that connection alive.
That pin has two gaps.
First, it carries no first-class metadata: it does not record who created the
retention, which invitation binding it belongs to, when it was created, or
whether the binding is live, pending retry, or superseded, and there is no
daemon or CLI surface for listing and conditionally removing these entries.
Second, and separately, a name path that is valid as an invitation destination
can derive a pin name longer than the 255-code-unit pet-name limit, so today
the invitation fails on the acceptor's side at accept time rather than being
rejected when it is minted.
The rest of this section explains why the underlying key is shaped the way it
is; the design that follows closes both gaps without changing the key.

For a host inviter the pin directory is the visible `@pins` directory.
For a guest inviter, the proposed guest-owned invitation work in [PR
#1125](https://github.com/endojs/endo-but-for-bots/pull/1125) uses a hidden
`hostPins` directory so the guest cannot remove the host's retention decision.

The path-derived key for that entry is intentionally stable and legible.
It is injective across live name paths, converges on crash retry, and lets a
later accept for the same path overwrite and reclaim an abandoned attempt.
Replacing it with a hash or a newly minted formula identifier would lose
legibility or the overwrite-as-reclamation property.

Concretely, PR #1125 keeps a single-segment path as its exact `guest-<name>`
key (so `bob` derives `guest-bob`, the operator-navigable slot that callers and
legacy databases already hold), and encodes a multi-segment path by prefixing
each segment with its JavaScript string length and an underscore, then joining
the length-prefixed segments under the `guest-` prefix.
The two-segment path `team-a/bob` therefore derives `guest-6_team-a3_bob`.
The length prefix is what makes the multi-segment form injective across
hyphen-bearing segments, where a bare `join('-')` would collide: `a/b-c` and
`a-b/c` both flatten to `a-b-c`, but their length-prefixed forms
`guest-1_a3_b-c` and `guest-3_a-b1_c` stay distinct.
This is the exact encoding whose invariants the present design preserves; see
PR #1125 for its authoritative definition.

One residual collision lives in that encoding: because a single-segment path is
exempt from length-prefixing, a one-segment pet name that is itself
length-prefix-shaped collides with a real multi-segment path.
`['6_team-a3_bob']` and `['team-a', 'bob']` both derive `guest-6_team-a3_bob`,
and `isValidName` permits the digit/underscore leaf.
This design does not alter #1125's length-prefix *encoding*, but it does not
carry the collision forward as a mere test obligation either: the mint-time
validation this design already adds (see *Mint-time key validation*) is the
natural place to close it, and does.
The new `invitationPinName` helper is where the encoding is computed, and
`invite()` already validates its result before persisting anything; rejecting a
single-segment leaf that matches `^\d+_` there is a one-line addition to a
check this design introduces regardless, so injectivity is *enforced* at mint
rather than only asserted.
The rejection reports the offending leaf and points at the length-prefixed
multi-segment form it would otherwise shadow.

A second, already-shipped collision is closed by the same helper.
The host-inviter `accept()` in `packages/daemon/src/host.js` derives its
durable pin today as `['@pins', 'guest-<leaf>']` using **only the trailing
segment** of the guest name path (`host.js:2218`), discarding the rest.
Two different invitations at `alice/bob` and `carol/bob` therefore both derive
`guest-bob` and silently overwrite each other's pin today: a live bug in the
shipped `endo invite` / `endo accept` commands (multi-segment `NameOrPath` is
already accepted input, `interfaces.js`), independent of #1125.
Phase 1 routes this shipped `host.js` invite/accept pair through
`invitationPinName(namePath)` too (a migration that does **not** depend on
#1125 merging), so the length-prefixed, path-derived key replaces the bare-leaf
key and the `alice/bob` vs `carol/bob` collision is removed rather than left
standing for invitations minted after the migration.
Invariant 1 and the Test Plan below are stated against that migrated behavior.

The migration fixes the derivation going forward; it does not repair entries a
running database already stored under the old bare-leaf key, and the design
accepts that as debt rather than reconciling it automatically.
A `@pins` entry that a pre-migration `alice/bob` and `carol/bob` already
collided onto is the surviving overwrite of two distinct invitations; after the
migration a fresh accept for either path computes a different length-prefixed
key and no longer overwrites it, so Invariant 3 (supersede reclaims) stops
applying to that stranded pre-migration entry and it becomes an ordinary,
reason-less `@pins` name.
This design deliberately does **not** add a one-time backfill or audit that
rewrites or flags such entries: the entry lives in a **host** inviter's visible
`@pins` directory, which is fully manageable with the ordinary `endo list` and
`endo remove` surfaces (the same surfaces this design routes a host locator to
below), so an operator can already inspect and remove it by hand, and a
migration that rewrote historical keys under it would itself have to reason
about which of two collided invitations the survivor represents, information
the old scheme discarded and cannot recover.
Automatic reconciliation is therefore out of scope; the collision is closed for
all newly minted pins, and the small population of already-collided host
`@pins` entries stays operator-managed through the pre-existing surface rather
than being silently "fixed" into a state the derivation cannot justify.

This design adds metadata and lifecycle surfaces on top of the existing key.
It does not replace the key or change which principal controls retention.

## Invariants

1. **Live bindings do not collide.**
   The length-prefixed multi-segment encoding from PR #1125 remains the source
   of the pin name; injectivity holds across multi-segment paths.
   The one residual case that the bare encoding admits (a length-prefix-shaped
   single-segment leaf) is closed at mint by the validation in *Mint-time key
   validation*, which rejects a `^\d+_`-shaped single-segment leaf, and the
   shipped host-inviter `host.js` path is migrated onto the same
   `invitationPinName` helper so its former bare-`guest-<leaf>` key (which
   collided across `alice/bob` and `carol/bob`) no longer applies to newly
   minted pins.
   Both are covered by the Test Plan.
   Entries a running database already stored under the old bare-leaf key are
   not retroactively reconciled; see the accepted-debt note in *What is the
   Problem Being Solved?*.

> **Unsettled dependency.**
> PR #1125 is still an open draft, and its encoding was already revised once
> mid-review to eliminate cross-purpose collisions.
> Its `<len>_<segment>` scheme could change again before it lands.
> This design layers on top of that encoding but does not freeze it: Phase 1
> (`invitationPinName` and mint-time validation) lands *with* the guest-owned
> invitation work of #1125 and re-verifies against #1125's finally merged shape
> before the `retention_reason` column (Phase 2) and any helper are cut.
> If #1125's key format is revised, only the worked example above and the
> `invitationPinName` helper move with it.
> Invariants 1-3 are stated in terms of the encoding's *properties* (injectivity,
> retry convergence, overwrite reclamation), which any successor encoding #1125
> adopts must still satisfy, so the reason record, lifecycle states, and CLI
> surface are unaffected.
2. **Retry converges.**
   The storage key remains a pure function of the invitation's request-stable
   name path.
   Timestamps, invitation identifiers, and minted guest identifiers never
   participate in the key.
3. **Supersede reclaims.**
   Accepting a successor for the same path overwrites the predecessor's entry
   and removes its old formula-graph edge.
4. **The inviter retains authority.**
   Cross-peer retention is not a substitute for this local pin.
   A guest cannot see or remove its hidden `hostPins`.
5. **Pruning is compare-and-remove.**
   An operator who inspected an old entry cannot accidentally remove a
   successor that reused the same key.
   The delete itself is a single guarded statement (*removed* vs *not-removed*
   is atomic), not a read-then-delete pair; distinguishing the two not-removed
   outcomes (`missing` vs `changed`) is a follow-up advisory read outside that
   atomic boundary.
   The primitive is named in the *Host browse and prune surface* section below.

## Design

### Retention reason records

`pet_store_entry` gains a nullable `retention_reason` JSON column.
Existing entries read as having no reason.
The database startup migration checks `pragma_table_info('pet_store_entry')`,
adds the column when absent, and bumps the schema version.
The entry's formula identifier and reason are written by one SQLite statement,
so a crash cannot pair a new target with an old reason.

The record separates the one identifier the pin durably retains from the
descriptive identifiers it stores only for display.
A `WeakFormulaIdentifier` is a `FormulaIdentifier` branded to mark that the
daemon may have since collected the formula it names, so a consumer that
reaches for it is forced by the type to treat it as possibly-dangling rather
than assuming it resolves like the retained target.
The first reason variant is:

```typescript
// A descriptive identifier stored for display only. Unlike a plain
// FormulaIdentifier that the pin durably retains, a WeakFormulaIdentifier may
// name a formula the daemon has already collected, so every consumer must apply
// the reverse-name-or-raw-identifier fallback and must never assume it resolves.
type WeakFormulaIdentifier = FormulaIdentifier & { readonly __weak: unique symbol };

type InvitationRetentionReason = {
  kind: 'invitation';
  invitation: WeakFormulaIdentifier; // descriptive only; may have been collected
  invitingAgent: WeakFormulaIdentifier; // descriptive only; may have been collected
  invitedName: NamePath; // the binding acceptance rebinds
  localGuestHandle: FormulaIdentifier; // the pin's own durable target; prune compares this
  remoteHandle: WeakFormulaIdentifier; // descriptive only; invitedName's post-accept target
  pinnedAt: string; // ISO 8601 UTC
};

type RetentionReason = InvitationRetentionReason;
```

The reason is descriptive data, not a graph edge.
In particular, `invitation`, `invitingAgent`, and `remoteHandle` in this record
are typed `WeakFormulaIdentifier` precisely because they do not retain those
formulas and may point at formulas the daemon has since collected; only
`localGuestHandle` keeps the plain `FormulaIdentifier` type, marking it as the
one field a consumer may assume resolves.
The pin is written once naming the **local guest handle** (`localGuestHandle`),
and it is that binding, not `remoteHandle`, that the pet-store entry durably
retains.
`remoteHandle` names the *remote* guest handle that `accept()` rebinds the
separate `invitedName` binding to; it is retained only by that binding, so an
operator who removes the ordinary `invitedName` name makes it collectable while
the pin lives.
Any consumer that renders `invitation`, `invitingAgent`, or `remoteHandle` must
therefore apply the same reverse-name-or-raw-identifier fallback the summary
uses, and must never assume they resolve; the `WeakFormulaIdentifier` type now
makes that discipline checkable rather than only documented.
Only `localGuestHandle`, the pin's own target, is guaranteed resolvable while
the pin exists; it is the identifier that `prune`'s compare-and-remove guards.
The existing pet-store entry remains the sole durable edge to the local invited
guest handle.

The internal `PetStore` and `StoreController` surfaces gain reason-aware entry
operations.
At that daemon-private layer `storeIdentifier(name, id, reason)` takes the
third argument as a **required, non-optional** parameter typed `RetentionReason
| null | 'preserve'`, deliberately not a bare `reason?`, so every caller must
state intent: `null` clears the reason, `'preserve'` leaves an existing reason
untouched while updating `id`, and a `RetentionReason` value replaces it.
A plain overwrite therefore can neither silently downgrade a pin to `unknown`
nor silently leave a reason describing a target that has moved.
Because the parameter is required rather than defaulted, there is no omission
case to reason about; instead the ~20 existing two-argument internal call sites
(`directory.js`, `guest.js`, `channel.js`, `mail.js`, `host.js`) are migrated
mechanically in Phase 2 to pass the explicit `'preserve'` sentinel, which
reproduces their current "overwrite the identifier, leave any reason alone"
behavior exactly: a compile-time-checked, enumerated migration, not a silent
default.
Public `EndoDirectory.storeIdentifier` keeps its existing two-argument
signature and forwards `'preserve'` to the controller, so no code outside the
daemon changes and the public surface never gains a way to attach a reason.
`removeIfIdentifier(name, expectedId)` is the guarded compare-and-remove used
by `prune` (defined under *Host browse and prune surface*); `rename` carries
the reason; `remove` deletes the entry (reason included); and `listEntries()`
returns sorted `{ name, id, reason? }` records.
Invitation code reaches the controller through a daemon-private helper, so this
feature does not grant a guest a way to attach trusted-looking host metadata.

`accept()` writes the pin **once**, naming the newly minted local guest handle,
and writes its reason record in the same serialized step.
The pin is never swapped; there is no pre-swap "transient pin."
What acceptance *does* swap is the inviting agent's separate `invitedName`
binding: the name-path slot that named the pending `invitation` formula before
acceptance and is rebound to the `remoteHandle` as the consuming step
(`storeLocator(invitedName, remoteHandle)` in PR #1125).
Reading that `invitedName` binding is how the lifecycle state below is derived;
the pin itself holds a stable target throughout.
(PR #1125's in-memory `pinTransient`/`unpinTransient` around the mint is an
unrelated formula-graph root mechanism that protects the handle from collection
mid-accept; it is not this durable pin.)
The stable pin key still controls overwrite and collection.
`pinnedAt` means the time this daemon durably installed the pin during the
serialized accept; it is not a claim that every later step completed.

### Derived lifecycle state

The daemon derives state at list time rather than persisting a second mutable
status field.
A single pure function, `deriveInvitationRetentionState(reason,
observedBinding)`, is the *sole* implementation of the table below: it takes
the reason record and the observed `invitedName` binding and returns one of the
four states.
Both read surfaces that expose lifecycle state,
`InvitationRetentionPins.list()`'s `InvitationRetentionPin.state` and the
retention-path surface's `RetentionPathEdgeReason.state`, call this one
function rather than each re-deriving the comparison, so the two surfaces
cannot drift (for example one treating a malformed reason as `unknown` while
the other throws).
It reads the inviting agent's current binding at the reason's `invitedName`
name path and compares it to the reason's recorded identifiers:

| Observed `invitedName` binding | State | Meaning |
|---|---|---|
| equals `remoteHandle` | `active` | Acceptance consumed the invitation and the rebound binding remains live. |
| equals `invitation` | `pending-retry` | A crash or error left the durable pin before the final consume rebind. Retrying accept will overwrite it. |
| missing, or any other identifier | `superseded` | The recorded binding no longer owns this name path. The pin is a prune candidate. |

When the reason is absent or malformed the derivation above cannot run, and the
pin's state is reported as `unknown` (legacy or damaged metadata); the target
is still shown and the pin may be pruned explicitly.

This derived state is **advisory and host-side**, and (importantly) is read
from a binding that may be owned by a *different* principal than the one
`prune` mutates.
For a guest inviter the `invitedName` binding lives in the **guest's** own,
freely renameable pet store, while the pin and its reason live in the host-held
`hostPins`.
A guest that renames or removes its own `invitedName` can therefore drive the
*rendered* state to `superseded`, but it cannot cause a spurious prune: `prune`
is a compare-and-remove against the **pin's own** durable target
(`localGuestHandle`, host-controlled), never against the guest-owned
`invitedName` binding, so a guest-induced state change is presentation only.
The compare-and-remove rule below, not this table, is the concurrency and
authority boundary.

### Retention path output

The existing `RetentionPathSegment` shape gains an optional field:

```typescript
type RetentionPathEdgeReason = {
  label: string; // the matching `pet:<name>` label
  reason: RetentionReason;
  state: 'active' | 'pending-retry' | 'superseded' | 'unknown';
  summary: string;
};

type RetentionPathSegment = {
  // existing fields remain unchanged
  edgeReasons?: RetentionPathEdgeReason[];
};
```

`listRetentionPaths` already resolves a pet-store edge into every matching
`pet:<name>` label.
During that same controller lookup it attaches the reason for each annotated
binding.
The summary is derived at read time, for example `invited as team-a/bob by
alice, pinned 2026-09-14T20:45:00Z (active)`.
The summary uses the `invitingAgent`'s best current host-visible reverse name,
falling back to a short formula identifier.
Structured fields remain available to clients, so the summary is presentation
and never needs to be parsed.

`followRetentionPaths` carries the same extended snapshots and deltas.
Existing clients remain compatible because `edgeReasons` is optional.
`endo paths` prints the summary after the matching pet-name edge and includes
the structured record under `--json`.

The formula inspector adds an "Invitation retentions" table to a guest formula
when `hostPins` is present.
Each row shows lifecycle state, summary, raw pin name, and a link to the
retained target formula.
The inspector uses the host management facet below; the hidden directory is not
exposed to the guest.

### Host browse and prune surface

`EndoHost` gains one narrow management facet rather than adding unrelated
methods directly to its already large interface:

```typescript
interface InvitationRetentionPins {
  help(): string;
  list(guestLocator: string): Promise<InvitationRetentionPinList>;
  prune(
    guestLocator: string,
    pinName: PetName,
    expectedTargetId: FormulaIdentifier,
  ): Promise<'removed' | 'missing' | 'changed'>;
}

// A modern guest (with hostPins) returns { kind: 'pins', pins }, where an
// empty array genuinely means "no retained invitations." A guest that predates
// hostPins returns { kind: 'legacy' } so the caller can tell "this surface does
// not cover this guest" from "this guest is clean."
type InvitationRetentionPinList =
  | { kind: 'pins'; pins: InvitationRetentionPin[] }
  | { kind: 'legacy' };

type InvitationRetentionPin = {
  name: PetName;
  target: string; // local endo:// locator, for display
  targetId: FormulaIdentifier; // internal formula_id; the value prune compares
  reason?: InvitationRetentionReason;
  state: 'active' | 'pending-retry' | 'superseded' | 'unknown';
  summary: string;
};
```

`EndoHost.invitationRetentionPins()` returns this facet.
It is a fresh top-level accessor rather than a method under the existing
`diagnostics()` entry point because `diagnostics()` is explicitly read-only,
whereas `prune()` mutates durable retention state; keeping the mutating surface
out of the read-only diagnostics facet preserves that facet's guarantee, at the
cost of one more accessor an operator must learn.
`help()` returns the facet's self-description, matching every other
host-reachable capability (`EndoChannel`, `EndoDiagnostics`, `EndoTraces`,
`EndoDirectory`), so an agent that discovers the facet through the ordinary
`E(host).invitationRetentionPins().help()` path gets the same introspection it
gets everywhere else.
Both `list` and `prune` reject a non-local locator or a locator that does not
identify a `guest` formula.
Because the surface name `endo pins` gives no hint that it is guest-only, that
rejection is not a bare "wrong kind" error: its message names the correct
alternate surface, routing a host locator to `endo list`/`endo remove` (where a
host inviter's `@pins` entries are already fully manageable), so the operator
learns where to go from the error rather than only from this design's prose.
For a guest that has a `hostPins` directory, `list` resolves it, sorts by pin
name, and returns `{ kind: 'pins', pins }` with all entries.
Each pin's `name` is the bare `PetName`; the retention-path surface's
`RetentionPathEdgeReason.label` carries the same pin name with the `pet:`
prefix that edge labels use, so the two records describe one identity in each
surface's native form.

`prune` takes the internal formula identifier observed by `list` (its
`targetId`, not the display `target` locator) and removes the entry only if the
pin still names that exact identifier.
The distinction is load-bearing, and it is a distinction between two concrete
string forms of the *same* target: the bare identifier `formatId` produces (for
example `targetId: "abc123"`, stored in `pet_store_entry.formula_id`) versus
the `endo://`-prefixed locator `formatLocator` produces from it (for example
`target: "endo://abc123"`, shown to the operator).
`internalizeLocator` maps the locator form back to the identifier and
`externalizeId` maps the identifier out to a locator; the codebase keeps both
directions, plus a separate `synced_store_entry.locator` column, precisely
because the two are not interchangeable.
So the compare is expressed against the identifier the column actually holds
(`abc123`) and never against the locator (`endo://abc123`).
The compare and the removal are performed by a new reason-aware pet-store
operation, `removeIfIdentifier(name, expectedId)`, exposed through
`StoreController`.
Its atomicity primitive is a single guarded SQLite statement (`DELETE FROM
pet_store_entry WHERE store_number = ? AND store_type = ? AND name = ? AND
formula_id = ?`) with a rows-affected check, not a read-then-delete pair.
Crucially, `removeIfIdentifier` is **not** a bare row delete: when the guarded
`DELETE` removes a row it then discharges the same bookkeeping the existing
`StoreController.remove` / `PetStore.remove` path does: `idsToPetNames.delete`,
`publishNameRemoval` to subscribers, and `removeEdgeIfUnreferenced` calling
`formulaGraph.onPetStoreRemove` (`packages/daemon/src/store-controller.js:78`,
`packages/daemon/src/pet-store.js:194`).
Routing the guarded delete through this operation is load-bearing: a raw
`DELETE` would leave the in-memory `idsToPetNames` mapping stale (the pin still
resolves until restart), never notify subscribers, and orphan the formula-graph
edge, so the design's own promise that "removing the last path makes the target
eligible for normal formula collection" would fail and pruning would *leak*
rather than collect.

The zero-rows guarantee follows from the guard alone, independent of any lock:
a concurrent supersede that overwrites the pin between an operator's `list` and
their `prune` changes `formula_id`, so the guarded `DELETE` matches zero rows,
`prune` reports `changed`, and it mutates nothing rather than deleting the
fresh entry.
(PR #1125 serializes each invitation's `accept()` on a per-invitation
`makeSerialJobs()` queue, not on `withFormulaGraphLock`; the zero-rows
conclusion needs no lock claim.)
The guarded statement alone distinguishes only *removed* from *not-removed*
(rows-affected 1 vs 0).
To report the tri-state, `removeIfIdentifier` disambiguates a zero-row result
with a follow-up, non-atomic read of the row declared explicitly **outside**
the atomicity boundary and advisory only (absent means `missing`; present with
a different `formula_id` means `changed`).
The atomic guarantee is exactly removed-vs-not-removed; the follow-up read
merely labels a not-removed outcome for the operator and cannot cause a wrong
deletion.

Returning this `'removed' | 'missing' | 'changed'` tri-state rather than
throwing is a deliberate deviation from the sibling `remove` operations
(`EndoDirectory.remove`, `PetStore.remove`), which signal "not found" by
rejecting.
Here `missing` and `changed` are the *expected*, non-exceptional outcomes of a
compare-and-remove issued against a possibly raced snapshot (they are how the
operator learns the observed state is stale), so they are surfaced as ordinary
return values a caller inspects, not as errors it must catch.
Genuinely exceptional inputs (a non-local or non-`guest` locator) still throw,
as the surface's convention expects.

This facet is deliberately scoped to a *guest* inviter's hidden `hostPins`,
which has no other management surface.
A **host** inviter's own invitation pins live in its visible `@pins` directory
(`['@pins', 'guest-<leaf>']`) and are already fully manageable with the
ordinary `endo list` and `endo remove` surfaces, so `list`/`prune` rejecting a
non-`guest` locator withholds no management authority: it routes the operator
to the surface that already covers those pins.
A future revision may widen the facet to accept a host locator and present
host-inviter pins with the same reason and state annotations; this design does
not, to keep the first cut narrow.

Guests created before PR #1125 have no `hostPins`.
(A *legacy guest* is exactly this: a guest predating the `hostPins` directory.)
Their fallback entries live in the creating agent's visible `@pins` directory
and remain manageable with the ordinary `endo list` and `endo remove` surfaces.
For such a guest `list` returns `{ kind: 'legacy' }` rather than an empty
`pins` array, so an operator can tell "this guest predates `hostPins`, check
`endo list`/`endo remove`" from "this modern guest genuinely has no retained
invitations"; the two must not collapse to the same empty shape.
`endo pins` renders the `legacy` case as an explicit note pointing at `endo
list`/`endo remove`, and the facet never guesses from suffix-shaped names in
the shared `@pins` directory.

The CLI mirrors the facet:

```text
endo pins <guest-name-or-locator> [--as <agent>] [--locator] [--json]
endo unpin <guest-name-or-locator> <pin-name> --expect <target-locator> [--as <agent>] [--force] [-f]
```

Flags follow the established `endo` conventions: `--locator` marks the
positional `<guest>` argument as an `endo://` locator rather than a pet name
(as on `endo paths`); `--json` emits the structured record; `--as <agent>`
scopes the command to another agent as every agent-scoped command already
allows; and `--force` (with the sibling `-f` short form) skips the confirmation
prompt only.
On `endo unpin` the `<guest>` positional is the only locator-or-name argument
`--locator` governs, since `--expect` is always an `endo://` locator by its own
definition.

`endo pins` prints each pin's state, raw pin name, target, and reason summary.
The operator-facing surface stays locator-shaped: because operators work in
`endo://` locators while the daemon stores bare formula identifiers, `--expect`
accepts an `endo://` locator and `endo unpin` internalizes it to the stored
formula identifier (the daemon's existing `internalizeLocator` step) before
calling `prune` with the resulting `expectedTargetId`.
`endo unpin` echoes the pin's state, name, and target and asks for
confirmation.
`--force` skips only the prompt; it never skips `--expect` or
compare-and-remove.

The two guards are not redundant, and this is why `unpin` carries both when its
plainer sibling `endo remove` carries neither.
`--expect` is a *correctness* guard against a raced snapshot: it stops the
operator from removing a successor pin that silently reused the same key
between their `list` and their `unpin` (Invariant 5).
The prompt is a distinct *intent* guard: `unpin` removes a retention decision
that keeps a live cross-agent connection from being collected, so an operator
who typed the right (still-current) `--expect` but mistook *which* pin they
meant still gets one chance to abort.
`endo remove` operates on ordinary operator-owned names in the operator's own
store, where a wrong deletion is locally recoverable and no
compare-against-a-stale-view hazard exists, so it needs neither; the
confirmation-only precedent set by `endo purge` (which removes a whole agent's
storage without a compare target) motivates only the prompt, not the compare
guard, since purge has no target to compare against.
`--force` exists so a scripted caller that has already resolved the exact
target can opt out of the interactive prompt while keeping the compare guard.
A `changed` result is a nonzero exit with a message to list again.
Removing the last retention path makes the target eligible for normal formula
collection; neither command promises immediate collection when another
retention path exists.

### Mint-time key validation

The PR #1125 encoding moves into one exported pure daemon helper,
`invitationPinName(namePath)`.
Both `invite()` and `accept()` call the same helper, and the already-shipped
host-inviter `invite()`/`accept()` pair in `packages/daemon/src/host.js` is
migrated onto it as well (replacing its current bare-`guest-<leaf>` key, which
discards all but the trailing segment and so collides across paths such as
`alice/bob` and `carol/bob`).
That migration is independent of #1125 merging: it is a same-branch change to
shipped code, and it is why Invariant 1 can claim collision-freedom for the
host-inviter path and not only for #1125's guest-inviter path.
`invite()` computes the actual storage name, validates it with `assertPetName`,
and only then formulates and stores the invitation, so the check runs before
anything is persisted.

The helper also closes the one residual collision the bare encoding admits (a
length-prefix-shaped single-segment leaf, `['6_team-a3_bob']` shadowing the
multi-segment `['team-a', 'bob']`; see *What is the Problem Being Solved?*):
`invitationPinName` rejects a single-segment leaf matching `^\d+_` before it is
persisted, so the collision is enforced away at mint rather than merely
asserted absent.
Because both `invite()` and `accept()` route through the one helper, the
rejection covers minting and redemption alike.

Both the modern and the legacy pin names are fully determined at mint, so both
are validated in `invite()`; no second, late validation site in `accept()` is
required.
A legacy guest retains its invited connection under a fallback name in the
creating agent's visible `@pins` directory carrying a `-from-<handle-number>`
suffix, and `<handle-number>` is the **inviting** agent's handle number
(`parseId(invitingHandleId).number` in PR #1125).
That number is a `formulateInvitation` parameter fixed at `invite()` time, not
the not-yet-minted invited guest's handle.
Whether an invitation takes the modern `hostPins` branch or the legacy `@pins`
branch is likewise decided by the inviting agent's immutable formula, readable
at mint.
`invite()` therefore validates the exact fallback name it will later persist,
and the design does not re-introduce the very accept-time failure path it
exists to remove.

Validation is by `assertPetName`, so it enforces more than length:
`assertPetName` also rejects a leaf that is not a valid name (for example a
non-leaf special-name segment such as `@main`, which derives a name containing
`@`).
The error therefore reports the offending name path and the derived name
alongside the derived length and 255-code-unit limit, so the length-prefix
mapping is legible whichever rejection class fires.
An overlong or otherwise invalid result is rejected synchronously from the
caller's perspective; no invitation formula or name binding is written.
Boundary tests cover 255 and 256 code units, multi-segment paths, hyphens,
special-name segments, and non-BMP characters because both the length prefix
and `isValidName` use JavaScript string length.

### Durable Set formula disposition

The design prompt (see the Prompt section at the end of this document) asks
whether this retention work should be built on a **general durable Set
formula** (a new, reusable daemon formula type that stores a mutable collection
of identifiers) rather than on the existing pet store.
This section weighs and rejects that alternative.

This design does not add a general durable Set formula for this work.
A per-attempt, identifier-keyed set breaks retry convergence and supersede
reclamation: after a crash the retry knows only the request-stable name path,
not the fresh identifier the crashed attempt minted, so it cannot find the
orphaned attempt's entry to overwrite it, and the abandoned identifier leaks.
A request-keyed set with overwrite semantics is the pet store already in use.

The existing cross-peer retention table is the valid contrasting case: one peer
is the authoritative writer and can recompute and snapshot-replace its whole
set.
A future general primitive should be proposed only with a second concrete
consumer that has all three properties: one authoritative writer, an
authoritative recomputation source, and a replace-whole-set repair operation.
Until then the cross-peer table remains purpose-built and no new formula type
is introduced.

## Phased Implementation

1. Land `invitationPinName` and mint-time validation, and route the shipped
   host-inviter `host.js` invite/accept onto the helper (closing the bare-leaf
   collision, independent of #1125).
   The guest-inviter encoding lands with the guest-owned invitation work of
   #1125.
2. Migrate `pet_store_entry`, add reason-aware internal controller operations
   (mechanically updating the existing two-argument `storeIdentifier` call
   sites to pass `'preserve'`, per *Retention reason records*), and write
   invitation reasons during accept.
3. Extend retention-path results and the `endo paths` renderer.
4. Add `InvitationRetentionPins`, `endo pins`, and compare-and-remove `endo
   unpin`.
5. Add the formula-inspector table when the Chat formula-view surface consumes
   host diagnostics.

Phase 3 is the only phase that stacks on a second dependency.
The retention-path *surface* is already scaffolded on the base branch: the
`EndoHost` method, `DaemonCore['listRetentionPaths']`, and the `endo paths`
command all exist, with `listRetentionPaths` currently a stub returning `[]`
(`packages/daemon/src/host.js`, `packages/cli/src/commands/paths.js`).
What Phase 3 depends on the [Retention Paths
Inspector](daemon-retention-paths.md) design ([PR
#284](https://github.com/endojs/endo-but-for-bots/pull/284), stalled upstream
and unmerged for weeks with an unknown landing timeline) to supply is the
*real* graph traversal behind that stub and `followRetentionPaths`; Phase 3
then adds optional edge reasons on top.
That dependency is confined to Phase 3 by construction: Phases 1, 2, and 4
(mint-time validation, the `retention_reason` column and reason-aware
controller operations, and the `InvitationRetentionPins` facet with `endo
pins`/`endo unpin`) touch only the pet store and the host facet, none of the
retention-path traversal.
If #284 continues to stall, ship Phases 1-2 and 4 independently and hold Phase
3 (and its Phase-5 inspector consumer) until the traversal lands, rather than
blocking the whole feature on it.

## Test Plan

- Database tests open a pre-migration database, preserve unannotated entries,
  and exercise atomic overwrite, rename, remove, and same-target reason update.
- Invitation tests assert active, pending-retry, superseded, and legacy-unknown
  records; retry and supersede still collect the displaced target.
- Retention-path tests cover multiple names from one store and verify each
  reason remains paired with its own `pet:<name>` label in snapshot and follow
  output.
- Management tests reject remote and non-guest locators and prove a stale
  `--expect` cannot remove a concurrently replaced pin, and that `prune` routes
  through `removeIfIdentifier` so a successful removal also drops the
  formula-graph edge and publishes the name removal (a bare row delete would
  leave the pin resolvable until restart).
- An authority-boundary test proves the guest-vs-host split named in *Derived
  lifecycle state*: a guest that renames or removes its own `invitedName`
  binding drives the rendered state to `superseded` yet `prune` still refuses
  to remove a pin whose host-controlled `localGuestHandle` is unchanged, so the
  guest cannot puppet the host into a spurious prune (the compare-and-remove is
  against `localGuestHandle`, never the guest-owned `invitedName`).
- Encoding tests cover the single-segment length-prefix-shaped collision case
  (`['6_team-a3_bob']` vs `['team-a', 'bob']`): the mint-time validation
  rejects the `^\d+_`-shaped single-segment leaf, so the injectivity claim is
  enforced rather than silently violated.
  A concurrent supersede-vs-prune interleaving on one path is also covered.
- A regression test for the previously-shipped host-inviter collision: two
  invitations at `alice/bob` and `carol/bob` derive distinct pin names once
  `host.js` routes through `invitationPinName` (they collided on `guest-bob`
  before this change), proving the migration off the bare-leaf key.
- CLI tests snapshot prose and JSON output, confirmation refusal, successful
  prune, and the `changed` exit path.
- Formula-view registry and component tests render labeled rows and target
  links without exposing the facet through `EndoGuest`.
- Mint tests prove overlong keys fail before any invitation formula or binding
  is persisted.

## Dependencies

| Design or change | Relationship |
|---|---|
| [PR #1125](https://github.com/endojs/endo-but-for-bots/pull/1125) | Supplies guest-owned invitations, hidden `hostPins`, and the stable path-derived key this design preserves. |
| [Retention Paths Inspector](daemon-retention-paths.md) | Supplies `listRetentionPaths`, `followRetentionPaths`, and `endo paths`; this design adds optional edge reasons. |
| [Formula Inspector](formula-inspector.md) | Supplies the host-only formula view that embeds the invitation-retention table. |
| [Daemon Cross-Peer Garbage Collection](daemon-cross-peer-gc.md) | Supplies the authoritative-recomputation contrast for the rejected general Set formula. |

## Design Decisions

1. Keep the path-derived key.
   Metadata enriches it but does not participate in identity.
2. Store reasons on pet-store bindings, because that is the durable edge whose
   existence the reason explains.
3. Derive lifecycle state from the inviter's current binding instead of
   maintaining a second state machine.
4. Make prune compare-and-remove against the observed target.
5. Keep all browse and mutation authority host-only.
6. Defer a general durable Set formula until an independently justified,
   authoritatively recomputable consumer exists.

## Prompt

> Design first-class retention-reason metadata for invitation pins, expose it
> through retention paths and the formula inspector, add a host CLI surface to
> browse and prune a guest's hidden `hostPins`, validate derived pin-key length
> at invitation mint time, and decide whether a general durable Set formula is
> warranted. Preserve the path-derived key's collision, retry, reclamation, and
> legibility invariants identified in the review of PR #1125.

