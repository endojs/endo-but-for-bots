# Invitation Retention Labels and Pin Lifecycle

| | |
|---|---|
| **Created** | 2026-09-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Invitation acceptance creates a local guest and retains its handle in the
inviter's pin directory. For a host inviter this is the visible `@pins`
directory. For a guest inviter, the proposed guest-owned invitation work in
[PR #1125](https://github.com/endojs/endo-but-for-bots/pull/1125) uses a hidden
`hostPins` directory so the guest cannot remove the host's retention decision.

The path-derived key for that entry is intentionally stable and legible. It is
injective across live name paths, converges on crash retry, and lets a later
accept for the same path overwrite and reclaim an abandoned attempt. Replacing
it with a hash or a newly minted formula identifier would lose legibility or
the overwrite-as-reclamation property.

The key is still only a pet name. It does not tell an operator who created the
retention, which invitation binding it belongs to, when it was created, or
whether the binding is live, pending retry, or superseded. The host can see a
guest's `hostPins` formula through diagnostics, but has no direct daemon or CLI
surface for listing and conditionally removing its entries. A path that is
valid as an invitation destination can also derive a pin name longer than the
255-code-unit pet-name limit, so the invitation currently fails on the
acceptor's side instead of when it is minted.

This design adds metadata and lifecycle surfaces on top of the existing key.
It does not replace the key or change which principal controls retention.

## Invariants

1. **Live bindings do not collide.** The length-prefixed multi-segment encoding
   from PR #1125 remains the source of the pin name.
2. **Retry converges.** The storage key remains a pure function of the
   invitation's request-stable name path. Timestamps, invitation identifiers,
   and minted guest identifiers never participate in the key.
3. **Supersede reclaims.** Accepting a successor for the same path overwrites
   the predecessor's entry and removes its old formula-graph edge.
4. **The inviter retains authority.** Cross-peer retention is not a substitute
   for this local pin. A guest cannot see or remove its hidden `hostPins`.
5. **Pruning is compare-and-remove.** An operator who inspected an old entry
   cannot accidentally remove a successor that reused the same key.

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
  invitation: FormulaIdentifier;
  invitingAgent: FormulaIdentifier;
  invitedName: NamePath;
  remoteHandle: FormulaIdentifier;
  pinnedAt: string; // ISO 8601 UTC
};

type RetentionReason = InvitationRetentionReason;
```

The reason is descriptive data, not a graph edge. In particular,
`invitation`, `invitingAgent`, and `remoteHandle` in this record do not retain
those formulas. The existing pet-store entry remains the sole durable edge to
the local invited guest handle.

The internal `PetStore` and `StoreController` surfaces gain reason-aware entry
operations. `storeIdentifier(name, id, reason?)` updates the reason even when
`id` is unchanged; `rename` carries the reason; `remove` deletes it; and
`listEntries()` returns sorted `{ name, id, reason? }` records. Public
`EndoDirectory.storeIdentifier` remains unchanged. Invitation code reaches the
controller through a daemon-private helper, so this feature does not grant a
guest a way to attach trusted-looking host metadata.

`accept()` writes the reason with the pin before dropping the transient pin.
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

The existing `RetentionPathSegment` shape gains an optional additive field:

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
The inviter uses its best current host-visible reverse name, falling back to a
short formula identifier. Structured fields remain available to clients, so
the summary is presentation and never needs to be parsed.

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
  list(guestLocator: string): Promise<InvitationRetentionPin[]>;
  prune(
    guestLocator: string,
    pinName: PetName,
    expectedTarget: string,
  ): Promise<'removed' | 'missing' | 'changed'>;
}

type InvitationRetentionPin = {
  name: PetName;
  target: string; // local endo:// locator
  reason?: InvitationRetentionReason;
  state: 'active' | 'pending-retry' | 'superseded' | 'unknown';
  summary: string;
};
```

`EndoHost.invitationRetentionPins()` returns this facet. Both methods reject a
non-local locator or a locator that does not identify a `guest` formula.
`list` resolves that formula's hidden `hostPins`, sorts by pin name, and returns
all entries. `prune` takes the target locator observed by `list` and removes the
entry only if the pin still names that exact target. A missing entry is
idempotent; a reused key that now names a different target returns `changed`
without mutation.

Guests created before PR #1125 have no `hostPins`. Their fallback entries live
in the creating agent's visible `@pins` directory and remain manageable with
the ordinary `endo list` and `endo remove` surfaces. The new facet reports an
empty list for those guests rather than guessing from suffix-shaped names in a
shared directory.

The CLI mirrors the facet:

```text
endo pins <guest-name-or-locator> [--locator] [--json]
endo unpin <guest-name-or-locator> <pin-name> --expect <target-locator> [--locator] [--force]
```

`endo pins` prints state, raw pin name, target, and reason summary. `endo unpin`
shows those fields and asks for confirmation. `--force` skips only the prompt;
it never skips `--expect` or compare-and-remove. `changed` is a nonzero exit
with a message to list again. Removing the last path makes the target eligible
for normal formula collection; neither command promises immediate collection
when another retention path exists.

### Mint-time key validation

Move the PR #1125 encoding into one exported pure daemon helper,
`invitationPinName(namePath)`. Both `invite()` and `accept()` call the same
helper. `invite()` computes the actual storage name before it formulates or
stores the invitation and calls `assertPetName` on it. For a legacy guest it
also validates the full fallback name including `-from-<handle-number>`.

An overlong result rejects synchronously from the caller's perspective with an
error that reports the derived length and 255-code-unit limit. No invitation
formula or name binding is written. Boundary tests cover 255 and 256 code
units, multi-segment paths, hyphens, and non-BMP characters because both the
length prefix and `isValidName` use JavaScript string length.

### Durable Set/index disposition

Do not add a general durable Set formula for this work. A per-attempt,
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
