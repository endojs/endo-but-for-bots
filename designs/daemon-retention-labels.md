# Invitation Retention Labels and Pin Lifecycle

| | |
|---|---|
| **Created** | 2026-09-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Throughout this design, *inviter* names the local party that **accepts** an
invitation and hosts the resulting guest (the principal that owns and controls
the retention decision), not the remote party who issued the invitation. Where
the issuing side matters it is named explicitly. Endo models that local
principal as either a **host** (a full agent with its own visible pet-store
directory) or a **guest** (a more restricted agent whose retention state the
host holds on its behalf and which the guest itself cannot remove); "host
inviter" and "guest inviter" name those two cases below.

Invitation acceptance retains the new guest's handle under a path-derived pet
name in the inviter's pin directory, and that pin has two gaps. First, it
carries no first-class metadata: it does not record who created the retention,
which invitation binding it belongs to, when it was created, or whether the
binding is live, pending retry, or superseded, and there is no daemon or CLI
surface for listing and conditionally removing these entries. Second, and
separately, a name path that is valid as an invitation destination can derive a
pin name longer than the 255-code-unit pet-name limit, so today the invitation
fails on the acceptor's side at accept time rather than being rejected when it
is minted. The rest of this section explains why the underlying key is shaped
the way it is; the design that follows closes both gaps without changing the
key.

Acceptance retains the guest's handle in the inviter's pin directory. For a
host inviter this is the visible `@pins` directory. For a guest inviter, the
proposed guest-owned invitation work in
[PR #1125](https://github.com/endojs/endo-but-for-bots/pull/1125) uses a hidden
`hostPins` directory so the guest cannot remove the host's retention decision.

The path-derived key for that entry is intentionally stable and legible. It is
injective across live name paths, converges on crash retry, and lets a later
accept for the same path overwrite and reclaim an abandoned attempt. Replacing
it with a hash or a newly minted formula identifier would lose legibility or
the overwrite-as-reclamation property.

Concretely, PR #1125 keeps a single-segment path as its exact `guest-<name>` key
(so `bob` derives `guest-bob`, the operator-navigable slot callers and legacy
databases already hold), and encodes a multi-segment path by prefixing each
segment with its JavaScript string length and an underscore, then joining the
length-prefixed segments under the `guest-` prefix. The two-segment path
`team-a/bob` therefore derives `guest-6_team-a3_bob`. The length prefix is what
makes the multi-segment form injective across hyphen-bearing segments, where a
bare `join('-')` would collide: `a/b-c` and `a-b/c` both flatten to `a-b-c`, but
their length-prefixed forms `guest-1_a3_b-c` and `guest-3_a-b1_c` stay distinct.
This is the exact encoding whose invariants the present design preserves; see
PR #1125 for its authoritative definition.

This design adds metadata and lifecycle surfaces on top of the existing key.
It does not replace the key or change which principal controls retention.

## Invariants

1. **Live bindings do not collide.** The length-prefixed multi-segment encoding
   from PR #1125 remains the source of the pin name.

   > **Unsettled dependency.** PR #1125 is still an open draft, and its encoding
   > was already revised once mid-review to eliminate cross-purpose collisions.
   > Its `<len>_<segment>` scheme could change again before it lands. This design
   > layers on top of that encoding but does not freeze it: Phase 1 (`invitationPinName`
   > and mint-time validation) lands *with* the guest-owned invitation work of
   > #1125 and re-verifies against #1125's finally-merged shape before the
   > `retention_reason` column (Phase 2) and any helper are cut. If #1125's key
   > format is revised, only the worked example above and the `invitationPinName`
   > helper move with it. Invariants 1-3 are stated in terms of the encoding's
   > *properties* (injectivity, retry convergence, overwrite reclamation), which
   > any successor encoding #1125 adopts must still satisfy, so the reason record,
   > lifecycle states, and CLI surface are unaffected.
2. **Retry converges.** The storage key remains a pure function of the
   invitation's request-stable name path. Timestamps, invitation identifiers,
   and minted guest identifiers never participate in the key.
3. **Supersede reclaims.** Accepting a successor for the same path overwrites
   the predecessor's entry and removes its old formula-graph edge.
4. **The inviter retains authority.** Cross-peer retention is not a substitute
   for this local pin. A guest cannot see or remove its hidden `hostPins`.
5. **Pruning is compare-and-remove.** An operator who inspected an old entry
   cannot accidentally remove a successor that reused the same key. This is a
   single-statement guarded delete, not a read-then-delete pair; the atomic
   primitive is named in the *Host browse and prune surface* section below.

## Design

### Retention reason records

`pet_store_entry` gains a nullable `retention_reason` JSON column. Existing
entries read as having no reason. The database startup migration checks
`pragma_table_info('pet_store_entry')`, adds the column when absent, and bumps
the schema version. The entry's formula identifier and reason are written by
one SQLite statement, so a crash cannot pair a new target with an old reason.

The first reason variant is:

```typescript
type InvitationRetentionReason = {
  kind: 'invitation';
  invitation: FormulaIdentifier; // descriptive only; may have been collected
  invitingAgent: FormulaIdentifier; // descriptive only; may have been collected
  invitedName: NamePath;
  remoteHandle: FormulaIdentifier; // the pin's live target; resolvable while the pin exists
  pinnedAt: string; // ISO 8601 UTC
};

type RetentionReason = InvitationRetentionReason;
```

The reason is descriptive data, not a graph edge. In particular,
`invitation` and `invitingAgent` in this record do not retain those formulas
and may point at formulas the daemon has since collected; `remoteHandle` is the
exception, because after `accept()`'s swap it is the durable pin's own target
and stays resolvable as long as the pin exists. Any consumer that renders
`invitation` or `invitingAgent` must therefore apply the same reverse-name-or-raw-identifier
fallback the summary uses, never assume they resolve. The existing pet-store
entry remains the sole durable edge to the local invited guest handle.

The internal `PetStore` and `StoreController` surfaces gain reason-aware entry
operations. `storeIdentifier(name, id, reason?)` updates the reason even when
`id` is unchanged; `rename` carries the reason; `remove` deletes it; and
`listEntries()` returns sorted `{ name, id, reason? }` records. Public
`EndoDirectory.storeIdentifier` remains unchanged. Invitation code reaches the
controller through a daemon-private helper, so this feature does not grant a
guest a way to attach trusted-looking host metadata.

`accept()`'s two-phase write first installs the durable pin naming the
`invitation` formula, then swaps that binding to the `remoteHandle` once the
invitation is consumed; the first, pre-swap binding is the *transient pin*
referred to here. `accept()` writes the reason together with the durable pin in
the same serialized step, before the swap that clears the transient state.
The stable pin key still controls overwrite and collection. `pinnedAt` means
the time this daemon durably installed the pin during the serialized accept;
it is not a claim that every later step completed.

### Derived lifecycle state

The daemon derives state when it lists a pin rather than persisting a second
mutable status field. It reads the inviter's current binding at `invitedName`:

| Current binding | State | Meaning |
|---|---|---|
| `remoteHandle` | `active` | Acceptance consumed the invitation and the original binding remains live. |
| `invitation` | `pending-retry` | A crash or error left the durable pin before the final consume. Retrying accept will overwrite it. |
| missing or any other identifier | `superseded` | The original binding no longer owns this name path. The pin is a prune candidate. |
| reason absent or malformed | `unknown` | Legacy or damaged metadata. The target is still shown and may be pruned explicitly. |

This state is advisory. The compare-and-remove rule below is the concurrency
boundary.

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
`pet:<name>` label. During that same controller lookup it attaches the reason
for each annotated binding. The summary is derived at read time, for example
`invited as team-a/bob by alice, pinned 2026-09-14T20:45:00Z (active)`.
The summary uses the `invitingAgent`'s best current host-visible reverse name,
falling back to a short formula identifier. Structured fields remain available
to clients, so the summary is presentation and never needs to be parsed.

`followRetentionPaths` carries the same extended snapshots and deltas. Existing
clients remain compatible because `edgeReasons` is optional. `endo paths`
prints the summary after the matching pet-name edge and includes the structured
record under `--json`.

The formula inspector adds an "Invitation retentions" table to a guest formula
when `hostPins` is present. Each row shows lifecycle state, summary, raw pin
name, and a link to the retained target formula. The inspector uses the host
management facet below; the hidden directory is not exposed to the guest.

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

`EndoHost.invitationRetentionPins()` returns this facet. It is a fresh
top-level accessor rather than a method under the existing `diagnostics()`
entry point because `diagnostics()` is explicitly read-only, whereas `prune()`
mutates durable retention state; keeping the mutating surface out of the
read-only diagnostics facet preserves that facet's guarantee, at the cost of
one more accessor an operator must learn. `help()` returns the facet's
self-description, matching every other host-reachable capability
(`EndoChannel`, `EndoDiagnostics`, `EndoTraces`, `EndoDirectory`), so an agent
that discovers the facet through the ordinary `E(host).invitationRetentionPins().help()`
path gets the same introspection it gets everywhere else. Both `list` and `prune`
reject a non-local locator or a locator that does not identify a `guest` formula.
For a guest that has a `hostPins` directory, `list` resolves it, sorts by pin
name, and returns `{ kind: 'pins', pins }` with all entries. Each pin's `name`
is the bare `PetName`; the retention-path
surface's `RetentionPathEdgeReason.label` carries the same pin name with the
`pet:` prefix that edge labels use, so the two records describe one identity in
each surface's native form.

`prune` takes the internal formula identifier observed by `list` (its
`targetId`, not the display `target` locator) and removes the entry only if the
pin still names that exact identifier. The distinction is load-bearing: in the
daemon's schema `pet_store_entry.formula_id` stores the bare identifier produced
by `formatId`, while a locator is the distinct `endo://`-prefixed string produced by
`formatLocator` (the codebase keeps `internalizeLocator`/`externalizeId` and a
separate `synced_store_entry.locator` column precisely because the two are not
interchangeable), so the compare is expressed against the identifier the column
actually holds and never against the locator. The compare and the removal are one
atomic SQLite statement (`DELETE FROM pet_store_entry WHERE store_number = ? AND
store_type = ? AND name = ? AND formula_id = ?`) with a rows-affected check, not
a read-then-delete pair. Because `accept()` is serialized under the formula-graph
lock, a concurrent supersede that overwrites the pin between an operator's `list`
and their `prune` simply leaves the guarded `DELETE` matching zero rows: `prune`
reports `changed` and mutates nothing rather than deleting the fresh entry. A
missing entry likewise matches zero rows and is idempotent (`missing`).

Returning this `'removed' | 'missing' | 'changed'` tri-state rather than throwing
is a deliberate deviation from the sibling `remove` operations
(`EndoDirectory.remove`, `PetStore.remove`), which signal "not found" by
rejecting. Here `missing` and `changed` are the *expected*, non-exceptional
outcomes of a compare-and-remove issued against a possibly-raced snapshot (they
are how the operator learns the observed state is stale), so they are surfaced as
ordinary return values a caller inspects, not as errors it must catch. Genuinely
exceptional inputs (a non-local or non-`guest` locator) still throw, as the
surface's convention expects.

Guests created before PR #1125 have no `hostPins`. Their fallback entries live
in the creating agent's visible `@pins` directory and remain manageable with
the ordinary `endo list` and `endo remove` surfaces. For such a guest `list`
returns `{ kind: 'legacy' }` rather than an empty `pins` array, so an operator
can tell "this guest predates `hostPins`, check `endo list`/`endo remove`" from
"this modern guest genuinely has no retained invitations"; the two must not
collapse to the same empty shape. `endo pins` renders the `legacy` case as an
explicit note pointing at `endo list`/`endo remove`, and the facet never guesses
from suffix-shaped names in the shared `@pins` directory.

The CLI mirrors the facet:

```text
endo pins <guest-name-or-locator> [--locator] [--json]
endo unpin <guest-name-or-locator> <pin-name> --expect <target-locator> [--locator] [--force]
```

`endo pins` prints state, raw pin name, target, and reason summary. So the
operator-facing surface stays locator-shaped, `--expect` accepts an `endo://`
locator and `endo unpin` internalizes it to the stored formula identifier (the
daemon's existing `internalizeLocator` step) before calling `prune` with the
resulting `expectedTargetId`. `endo unpin` shows those fields and asks for
confirmation. `--force` skips only the prompt; it never skips `--expect` or
compare-and-remove. `changed` is a nonzero exit with a message to list again. Removing the last path makes the target eligible
for normal formula collection; neither command promises immediate collection
when another retention path exists.

### Mint-time key validation

The PR #1125 encoding moves into one exported pure daemon helper,
`invitationPinName(namePath)`. Both `invite()` and `accept()` call the same
helper. `invite()` computes the actual storage name, calls `assertPetName` on
it, and only then formulates and stores the invitation, so the check runs before
anything is persisted.

A *legacy guest* here is a guest created before PR #1125, which has no hidden
`hostPins` directory and instead retains handles under a fallback name in the
creating agent's visible `@pins` directory. That fallback name carries a
`-from-<handle-number>` suffix (`<handle-number>` being the invited guest's
handle identifier) to keep it distinct within the shared directory. That handle
number does not exist until acceptance mints the guest handle, so `invite()`
cannot pre-validate it; the suffix-inclusive length check for the legacy
fallback name therefore runs in `accept()`, at the point the full name is first
known and still before the fallback binding is persisted. `invite()` validates
the modern `hostPins` name, whose length is fully determined by the invited
path alone. Either way the check runs before its own binding is written, so an
overlong name is rejected rather than failing late.

An overlong result is rejected synchronously from the caller's perspective with
an error that reports the derived length and 255-code-unit limit. No invitation
formula or name binding is written. Boundary tests cover 255 and 256 code
units, multi-segment paths, hyphens, and non-BMP characters because both the
length prefix and `isValidName` use JavaScript string length.

### Durable Set/index disposition

The design prompt (see the Prompt section at the end of this document) asks
whether this retention work should be built on a **general
durable Set formula** (a new, reusable daemon formula type that stores a mutable
collection of identifiers) rather than on the existing pet store. This section
weighs and rejects that alternative.

This design does not add a general durable Set formula for this work. A per-attempt,
identifier-keyed set breaks retry convergence and supersede reclamation because
the retry cannot name the orphaned attempt's identifier. A request-keyed set
with overwrite semantics is the pet store already in use.

The existing cross-peer retention table is the valid contrasting case: one
peer is the authoritative writer and can recompute and snapshot-replace its
whole set. A future general primitive should be proposed only with a second
concrete consumer that has all three properties: one authoritative writer, an
authoritative recomputation source, and a replace-whole-set repair operation.
Until then the cross-peer table remains purpose-built and no new formula type
is introduced.

## Phased Implementation

1. Land `invitationPinName` and mint-time validation with the guest-owned
   invitation work.
2. Migrate `pet_store_entry`, add reason-aware internal controller operations,
   and write invitation reasons during accept.
3. Extend retention-path results and the `endo paths` renderer.
4. Add `InvitationRetentionPins`, `endo pins`, and compare-and-remove
   `endo unpin`.
5. Add the formula-inspector table when the Chat formula-view surface consumes
   host diagnostics.

Phase 3 is the only phase that stacks on a second unlanded dependency: it extends
`listRetentionPaths`/`followRetentionPaths` and the `endo paths` renderer from the
[Retention Paths Inspector](daemon-retention-paths.md) design, whose PR #284 has
been stalled and unmerged for weeks with an unknown landing timeline. That
dependency is confined to Phase 3 by construction: Phases 1, 2, and 4 (mint-time
validation, the `retention_reason` column and reason-aware controller operations,
and the `InvitationRetentionPins` facet with `endo pins`/`endo unpin`) touch only
the pet store and the host facet, none of the retention-path surface. If #284
continues to stall, ship Phases 1-2 and 4 independently and hold Phase 3 (and its
Phase-5 inspector consumer) until the retention-path surface lands, rather than
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
  `--expect` cannot remove a concurrently replaced pin.
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

1. Keep the path-derived key. Metadata enriches it but does not participate in
   identity.
2. Store reasons on pet-store bindings, because that is the durable edge whose
   existence the reason explains.
3. Derive lifecycle state from the inviter's current binding instead of
   maintaining a second state machine.
4. Make prune compare-and-remove against the observed target.
5. Keep all browse and mutation authority host-only.
6. Defer a general durable Set primitive until an independently justified,
   authoritatively recomputable consumer exists.

## Prompt

> Design first-class retention-reason metadata for invitation pins, expose it
> through retention paths and the formula inspector, add a host CLI surface to
> browse and prune a guest's hidden `hostPins`, validate derived pin-key length
> at invitation mint time, and decide whether a general durable Set formula is
> warranted. Preserve the path-derived key's collision, retry, reclamation, and
> legibility invariants identified in the review of PR #1125.
